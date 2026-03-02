import { Hono } from "hono";
import type { AppEnv } from "../env";
import { type TokenRecord, tokenAuth } from "../middleware/tokenAuth";
import {
	type CallTokenItem,
	selectCallToken,
} from "../services/call-token-selector";
import { listCallTokens } from "../services/channel-call-token-repo";
import {
	type ChannelMetadata,
	parseChannelMetadata,
	resolveMappedModel,
	resolveProvider,
} from "../services/channel-metadata";
import {
	type ChannelRecord,
	createWeightedOrder,
	extractModels,
} from "../services/channels";
import {
	applyGeminiModelToPath,
	buildUpstreamChatRequest,
	buildUpstreamEmbeddingRequest,
	buildUpstreamImageRequest,
	detectDownstreamProvider,
	detectEndpointType,
	type NormalizedChatRequest,
	type NormalizedEmbeddingRequest,
	type NormalizedImageRequest,
	normalizeChatRequest,
	normalizeEmbeddingRequest,
	normalizeImageRequest,
	type ProviderType,
	parseDownstreamModel,
	parseDownstreamStream,
} from "../services/provider-transform";
import { recordUsage } from "../services/usage";
import { jsonError } from "../utils/http";
import { safeJsonParse } from "../utils/json";
import { extractReasoningEffort } from "../utils/reasoning";
import { normalizeBaseUrl } from "../utils/url";
import {
	type NormalizedUsage,
	parseUsageFromHeaders,
	parseUsageFromJson,
	parseUsageFromSse,
} from "../utils/usage";
import { adaptChatResponse } from "../services/chat-response-adapter";

const proxy = new Hono<AppEnv>();

type ExecutionContextLike = {
	waitUntil: (promise: Promise<unknown>) => void;
};

function channelSupportsModel(
	channel: ChannelRecord,
	model?: string | null,
): boolean {
	if (!model) {
		return true;
	}
	const models = extractModels(channel);
	if (models.some((entry) => entry.id === model)) {
		return true;
	}
	const metadata = parseChannelMetadata(channel.metadata_json);
	return Boolean(metadata.model_mapping[model] ?? metadata.model_mapping["*"]);
}

export function selectCandidateChannels(
	allowedChannels: ChannelRecord[],
	downstreamModel: string | null,
): ChannelRecord[] {
	const modelChannels = allowedChannels.filter((channel) =>
		channelSupportsModel(channel, downstreamModel),
	);
	if (modelChannels.length > 0) {
		return modelChannels;
	}
	// Fallback to all allowed channels. Downstream protocol should not restrict
	// upstream channel selection.
	return allowedChannels;
}

function hasExplicitModelMapping(
	metadata: ChannelMetadata,
	downstreamModel: string | null,
): boolean {
	if (downstreamModel) {
		return (
			metadata.model_mapping[downstreamModel] !== undefined ||
			metadata.model_mapping["*"] !== undefined
		);
	}
	return metadata.model_mapping["*"] !== undefined;
}

export function resolveUpstreamModelForChannel(
	channel: ChannelRecord,
	metadata: ChannelMetadata,
	downstreamModel: string | null,
): { model: string | null; autoMapped: boolean } {
	const mapped = resolveMappedModel(metadata.model_mapping, downstreamModel);
	if (!downstreamModel || hasExplicitModelMapping(metadata, downstreamModel)) {
		return { model: mapped, autoMapped: false };
	}

	const declaredModels = extractModels(channel).map((entry) => entry.id);
	if (declaredModels.length === 0) {
		return { model: mapped, autoMapped: false };
	}
	if (declaredModels.includes(downstreamModel)) {
		return { model: downstreamModel, autoMapped: false };
	}
	return { model: declaredModels[0] ?? mapped, autoMapped: true };
}

function filterAllowedChannels(
	channels: ChannelRecord[],
	tokenRecord: TokenRecord,
): ChannelRecord[] {
	const allowed = safeJsonParse<string[] | null>(
		tokenRecord.allowed_channels,
		null,
	);
	if (!allowed || allowed.length === 0) {
		return channels;
	}
	const allowedSet = new Set(allowed);
	return channels.filter((channel) => allowedSet.has(channel.id));
}

function resolveChannelBaseUrl(channel: ChannelRecord): string {
	return normalizeBaseUrl(channel.base_url);
}

function mergeQuery(
	base: string,
	querySuffix: string,
	overrides: Record<string, string>,
): string {
	const [path, rawQuery] = base.split("?");
	const params = new URLSearchParams(rawQuery ?? "");
	if (querySuffix) {
		const suffix = querySuffix.startsWith("?")
			? querySuffix.slice(1)
			: querySuffix;
		const suffixParams = new URLSearchParams(suffix);
		suffixParams.forEach((value, key) => {
			params.set(key, value);
		});
	}
	for (const [key, value] of Object.entries(overrides)) {
		params.set(key, value);
	}
	const query = params.toString();
	return query ? `${path}?${query}` : path;
}

function buildUpstreamHeaders(
	baseHeaders: Headers,
	provider: ProviderType,
	apiKey: string,
	overrides: Record<string, string>,
): Headers {
	const headers = new Headers(baseHeaders);
	headers.delete("x-admin-token");
	headers.delete("x-api-key");
	if (provider === "openai") {
		headers.set("Authorization", `Bearer ${apiKey}`);
		headers.set("x-api-key", apiKey);
	} else if (provider === "anthropic") {
		headers.delete("Authorization");
		headers.set("x-api-key", apiKey);
		headers.set("anthropic-version", "2023-06-01");
	} else {
		headers.delete("Authorization");
		headers.set("x-goog-api-key", apiKey);
	}
	for (const [key, value] of Object.entries(overrides)) {
		headers.set(key, value);
	}
	return headers;
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	if (timeoutMs <= 0) {
		return fetch(url, init);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, {
			...init,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Multi-provider proxy handler.
 */
proxy.all("/*", tokenAuth, async (c) => {
	const tokenRecord = c.get("tokenRecord") as TokenRecord;
	let requestText = await c.req.text();
	const parsedBody = requestText
		? safeJsonParse<Record<string, unknown> | null>(requestText, null)
		: null;
	const downstreamProvider = detectDownstreamProvider(c.req.path);
	const endpointType = detectEndpointType(downstreamProvider, c.req.path);
	const downstreamModel = parseDownstreamModel(
		downstreamProvider,
		c.req.path,
		parsedBody,
	);
	const isStream = parseDownstreamStream(
		downstreamProvider,
		c.req.path,
		parsedBody,
	);
	const reasoningEffort = extractReasoningEffort(parsedBody);
	if (
		downstreamProvider === "openai" &&
		isStream &&
		parsedBody &&
		typeof parsedBody === "object"
	) {
		const streamOptions = (parsedBody as Record<string, unknown>)
			.stream_options;
		if (!streamOptions || typeof streamOptions !== "object") {
			(parsedBody as Record<string, unknown>).stream_options = {
				include_usage: true,
			};
		} else if (
			(streamOptions as Record<string, unknown>).include_usage !== true
		) {
			(streamOptions as Record<string, unknown>).include_usage = true;
		}
		requestText = JSON.stringify(parsedBody);
	}

	let normalizedChat: NormalizedChatRequest | null = null;
	let normalizedEmbedding: NormalizedEmbeddingRequest | null = null;
	let normalizedImage: NormalizedImageRequest | null = null;
	if (endpointType === "chat" || endpointType === "responses") {
		normalizedChat = normalizeChatRequest(
			downstreamProvider,
			endpointType,
			parsedBody,
			downstreamModel,
			isStream,
		);
	}
	if (endpointType === "embeddings") {
		normalizedEmbedding = normalizeEmbeddingRequest(
			downstreamProvider,
			parsedBody,
			downstreamModel,
		);
	}
	if (endpointType === "images") {
		normalizedImage = normalizeImageRequest(
			downstreamProvider,
			parsedBody,
			downstreamModel,
		);
	}

	const channelResult = await c.env.DB.prepare(
		"SELECT * FROM channels WHERE status = ?",
	)
		.bind("active")
		.all();
	const activeChannels = (channelResult.results ?? []) as ChannelRecord[];
	const callTokenRows = await listCallTokens(c.env.DB, {
		channelIds: activeChannels.map((channel) => channel.id),
	});
	const callTokenMap = new Map<string, CallTokenItem[]>();
	for (const row of callTokenRows) {
		const entry: CallTokenItem = {
			id: row.id,
			channel_id: row.channel_id,
			name: row.name,
			api_key: row.api_key,
		};
		const list = callTokenMap.get(row.channel_id) ?? [];
		list.push(entry);
		callTokenMap.set(row.channel_id, list);
	}
	const allowedChannels = filterAllowedChannels(activeChannels, tokenRecord);
	const candidates = selectCandidateChannels(allowedChannels, downstreamModel);

	if (candidates.length === 0 && allowedChannels.length > 0) {
		console.warn("[proxy:no_compatible_channels]", {
			path: c.req.path,
			model: downstreamModel,
			downstream_provider: downstreamProvider,
			allowed_channels: allowedChannels.length,
		});
	}
	if (candidates.length === 0) {
		return jsonError(c, 503, "no_available_channels", "no_available_channels");
	}

	const ordered = createWeightedOrder(candidates);
	const targetPath = c.req.path;
	const querySuffix = c.req.url.includes("?")
		? `?${c.req.url.split("?")[1]}`
		: "";
	const upstreamTimeoutMs = Math.max(
		1000,
		Number(c.env.PROXY_UPSTREAM_TIMEOUT_MS ?? "30000"),
	);
	let lastResponse: Response | null = null;
	let lastChannel: ChannelRecord | null = null;
	let lastRequestPath = targetPath;
	const start = Date.now();
	let selectedChannel: ChannelRecord | null = null;
	let selectedUpstreamProvider: ProviderType | null = null;
	let selectedUpstreamModel: string | null = null;
	for (const channel of ordered) {
		lastChannel = channel;
		const metadata = parseChannelMetadata(channel.metadata_json);
		const upstreamProvider = resolveProvider(metadata.site_type);
		const resolvedModel = resolveUpstreamModelForChannel(
			channel,
			metadata,
			downstreamModel,
		);
		const upstreamModel = resolvedModel.model;
		if (
			upstreamProvider === "gemini" &&
			!upstreamModel &&
			endpointType !== "passthrough"
		) {
			continue;
		}
		const baseUrl = resolveChannelBaseUrl(channel);
		const tokens = callTokenMap.get(channel.id) ?? [];
		const selectedToken = tokens.length > 0 ? selectCallToken(tokens) : null;
		const apiKey = selectedToken?.api_key ?? channel.api_key;
		const headers = buildUpstreamHeaders(
			new Headers(c.req.header()),
			upstreamProvider,
			String(apiKey),
			metadata.header_overrides,
		);
		headers.delete("host");
		headers.delete("content-length");
		let upstreamRequestPath = targetPath;
		let upstreamFallbackPath: string | undefined;
		let upstreamBodyText = requestText || undefined;
		let absoluteUrl: string | undefined;
		const sameProvider = upstreamProvider === downstreamProvider;
		if (endpointType === "passthrough") {
			if (!sameProvider) {
				continue;
			}
			if (upstreamProvider === "gemini") {
				upstreamRequestPath = applyGeminiModelToPath(
					upstreamRequestPath,
					upstreamModel,
				);
			} else if (upstreamModel && parsedBody) {
				upstreamBodyText = JSON.stringify({
					...parsedBody,
					model: upstreamModel,
				});
			}
		} else if (sameProvider && parsedBody) {
			if (upstreamProvider === "gemini") {
				upstreamRequestPath = applyGeminiModelToPath(
					upstreamRequestPath,
					upstreamModel,
				);
			} else if (upstreamModel) {
				upstreamBodyText = JSON.stringify({
					...parsedBody,
					model: upstreamModel,
				});
			}
			if (endpointType === "chat" || endpointType === "responses") {
				if (metadata.endpoint_overrides.chat_url && normalizedChat) {
					const request = buildUpstreamChatRequest(
						upstreamProvider,
						normalizedChat,
						upstreamModel,
						endpointType,
						isStream,
						metadata.endpoint_overrides,
					);
					if (request) {
						upstreamRequestPath = request.path;
						absoluteUrl = request.absoluteUrl;
						upstreamFallbackPath = request.absoluteUrl
							? undefined
							: request.fallbackPath;
					}
				} else if (
					endpointType === "responses" &&
					upstreamProvider === "openai"
				) {
					upstreamFallbackPath = "/responses";
				}
			}
			if (
				endpointType === "embeddings" &&
				metadata.endpoint_overrides.embedding_url
			) {
				if (normalizedEmbedding) {
					const request = buildUpstreamEmbeddingRequest(
						upstreamProvider,
						normalizedEmbedding,
						upstreamModel,
						metadata.endpoint_overrides,
					);
					if (request) {
						upstreamRequestPath = request.path;
						absoluteUrl = request.absoluteUrl;
					}
				}
			}
			if (
				endpointType === "images" &&
				metadata.endpoint_overrides.image_url
			) {
				if (normalizedImage) {
					const request = buildUpstreamImageRequest(
						upstreamProvider,
						normalizedImage,
						upstreamModel,
						metadata.endpoint_overrides,
					);
					if (request) {
						upstreamRequestPath = request.path;
						absoluteUrl = request.absoluteUrl;
					}
				}
			}
		} else {
			let built: {
				request: {
					path: string;
					fallbackPath?: string;
					absoluteUrl?: string;
					body: Record<string, unknown> | null;
				};
				bodyText?: string;
			} | null = null;
			if (endpointType === "chat" || endpointType === "responses") {
				if (!normalizedChat) {
					return jsonError(c, 400, "invalid_body", "invalid_body");
				}
				const request = buildUpstreamChatRequest(
					upstreamProvider,
					normalizedChat,
					upstreamModel,
					endpointType,
					isStream,
					metadata.endpoint_overrides,
				);
				if (!request) {
					continue;
				}
				built = {
					request,
					bodyText: request.body ? JSON.stringify(request.body) : undefined,
				};
			} else if (endpointType === "embeddings") {
				if (!normalizedEmbedding) {
					return jsonError(c, 400, "invalid_body", "invalid_body");
				}
				const request = buildUpstreamEmbeddingRequest(
					upstreamProvider,
					normalizedEmbedding,
					upstreamModel,
					metadata.endpoint_overrides,
				);
				if (!request) {
					continue;
				}
				built = {
					request,
					bodyText: request.body ? JSON.stringify(request.body) : undefined,
				};
			} else if (endpointType === "images") {
				if (!normalizedImage) {
					return jsonError(c, 400, "invalid_body", "invalid_body");
				}
				const request = buildUpstreamImageRequest(
					upstreamProvider,
					normalizedImage,
					upstreamModel,
					metadata.endpoint_overrides,
				);
				if (!request) {
					continue;
				}
				built = {
					request,
					bodyText: request.body ? JSON.stringify(request.body) : undefined,
				};
			}
			if (!built) {
				continue;
			}
			upstreamRequestPath = built.request.path;
			absoluteUrl = built.request.absoluteUrl;
			upstreamFallbackPath = built.request.absoluteUrl
				? undefined
				: built.request.fallbackPath;
			upstreamBodyText = built.bodyText;
		}
		const targetBase = absoluteUrl ?? `${baseUrl}${upstreamRequestPath}`;
		const target = mergeQuery(
			targetBase,
			querySuffix,
			metadata.query_overrides,
		);

		try {
			let response = await fetchWithTimeout(
				target,
				{
					method: c.req.method,
					headers,
					body: upstreamBodyText || undefined,
				},
				upstreamTimeoutMs,
			);
			let responsePath = upstreamRequestPath;
			if (
				(response.status === 400 || response.status === 404) &&
				upstreamFallbackPath
			) {
				const fallbackTargetBase = absoluteUrl
					? absoluteUrl
					: `${baseUrl}${upstreamFallbackPath}`;
				const fallbackTarget = mergeQuery(
					fallbackTargetBase,
					querySuffix,
					metadata.query_overrides,
				);
				response = await fetchWithTimeout(
					fallbackTarget,
					{
						method: c.req.method,
						headers,
						body: upstreamBodyText || undefined,
					},
					upstreamTimeoutMs,
				);
				responsePath = upstreamFallbackPath;
			}

			lastResponse = response;
			lastRequestPath = responsePath;
			if (response.ok) {
				selectedChannel = channel;
				selectedUpstreamProvider = upstreamProvider;
				selectedUpstreamModel = upstreamModel;
				break;
			}
		} catch (error) {
			const isTimeout =
				error instanceof Error &&
				(error.name === "AbortError" || error.message.includes("upstream_timeout"));
			console.error("[proxy:upstream_exception]", {
				channel_id: channel.id,
				upstream_provider: upstreamProvider,
				path: upstreamRequestPath,
				model: downstreamModel,
				upstream_model: upstreamModel,
				timeout_ms: upstreamTimeoutMs,
				reason: isTimeout ? "timeout" : "exception",
				error: error instanceof Error ? error.message : String(error),
			});
			lastResponse = null;
		}
	}

	const latencyMs = Date.now() - start;
	if (!selectedChannel && lastResponse && !lastResponse.ok) {
		console.warn("[proxy:upstream_exhausted]", {
			path: targetPath,
			model: downstreamModel,
			status: lastResponse.status,
			last_channel_id: lastChannel?.id ?? null,
			last_request_path: lastRequestPath,
		});
	}

	if (!lastResponse) {
		console.error("[proxy:unavailable]", {
			path: targetPath,
			model: downstreamModel,
			latency_ms: latencyMs,
			last_channel_id: lastChannel?.id ?? null,
		});
		await recordUsage(c.env.DB, {
			tokenId: tokenRecord.id,
			model: downstreamModel,
			requestPath: lastRequestPath,
			totalTokens: 0,
			latencyMs,
			firstTokenLatencyMs: isStream ? null : latencyMs,
			stream: isStream,
			reasoningEffort,
			status: "error",
		});
		return jsonError(c, 502, "upstream_unavailable", "upstream_unavailable");
	}

	const channelForUsage = selectedChannel ?? lastChannel;
	if (channelForUsage && lastResponse) {
		const record = async (
			usage: NormalizedUsage | null,
			firstTokenLatencyMs?: number | null,
		) => {
			const normalized = usage ?? {
				totalTokens: 0,
				promptTokens: 0,
				completionTokens: 0,
			};
			const resolvedFirstTokenLatencyMs =
				firstTokenLatencyMs ?? (isStream ? null : latencyMs);
			await recordUsage(c.env.DB, {
				tokenId: tokenRecord.id,
				channelId: channelForUsage.id,
				model: downstreamModel,
				requestPath: lastRequestPath,
				totalTokens: normalized.totalTokens,
				promptTokens: normalized.promptTokens,
				completionTokens: normalized.completionTokens,
				cost: 0,
				latencyMs,
				firstTokenLatencyMs: resolvedFirstTokenLatencyMs,
				stream: isStream,
				reasoningEffort,
				status: lastResponse.ok ? "ok" : "error",
			});
		};
		const headerUsage = parseUsageFromHeaders(lastResponse.headers);
		let jsonUsage: NormalizedUsage | null = null;
		if (
			!isStream &&
			lastResponse.ok &&
			lastResponse.headers.get("content-type")?.includes("application/json")
		) {
			const data = await lastResponse
				.clone()
				.json()
				.catch(() => null);
			jsonUsage = parseUsageFromJson(data);
		}
		const immediateUsage = jsonUsage ?? headerUsage;

		if (isStream) {
			const executionCtx = (c as { executionCtx?: ExecutionContextLike })
				.executionCtx;
			const task = parseUsageFromSse(lastResponse.clone())
				.then((streamUsage) => {
					const usageValue = immediateUsage ?? streamUsage.usage;
					return record(usageValue, streamUsage.firstTokenLatencyMs);
				})
				.catch(() => undefined);
			if (executionCtx?.waitUntil) {
				executionCtx.waitUntil(task);
			} else {
				task.catch(() => undefined);
			}
		} else {
			await record(immediateUsage, latencyMs);
		}
	}

	if (selectedUpstreamProvider && endpointType === "chat") {
		const transformed = await adaptChatResponse({
			response: lastResponse,
			upstreamProvider: selectedUpstreamProvider,
			downstreamProvider,
			model: selectedUpstreamModel ?? downstreamModel,
			isStream,
		});
		if (transformed !== lastResponse) {
			return transformed;
		}
	}

	return lastResponse;
});

export default proxy;
