import { Hono } from "hono";
import type { AppEnv } from "../env";
import { type TokenRecord, tokenAuth } from "../middleware/tokenAuth";
import type { CallTokenItem } from "../services/call-token-selector";
import { listCallTokens } from "../services/channel-call-token-repo";
import {
	type ChannelMetadata,
	parseChannelMetadata,
	resolveMappedModel,
	resolveProvider,
} from "../services/channel-metadata";
import {
	listCoolingDownChannelsForModel,
	listVerifiedModelsByChannel,
} from "../services/channel-model-capabilities";
import {
	type ChannelRecord,
	createWeightedOrder,
	extractModels,
} from "../services/channels";
import { adaptChatResponse } from "../services/chat-response-adapter";
import {
	applyGeminiModelToPath,
	buildUpstreamChatRequest,
	buildUpstreamEmbeddingRequest,
	buildUpstreamImageRequest,
	detectDownstreamProvider,
	detectEndpointType,
	type EndpointType,
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
import {
	buildActiveChannelsKey,
	buildCallTokensIndexKey,
	buildResponsesAffinityKey,
	buildStreamOptionsCapabilityKey,
	readHotJson,
	writeHotJson,
} from "../services/hot-kv";
import { getCacheConfig, getProxyRuntimeSettings } from "../services/settings";
import {
	getUsageLimiterStub,
	reserveUsageQueue,
	trackUsageQueue,
	type UsageQueueTrackKind,
} from "../services/usage-limiter";
import {
	processUsageQueueEvent,
	type UsageQueueEvent,
} from "../services/usage-queue";
import { recordRuntimeEvent } from "../services/runtime-events";
import { jsonError } from "../utils/http";
import { safeJsonParse } from "../utils/json";
import { extractReasoningEffort } from "../utils/reasoning";
import { normalizeBaseUrl } from "../utils/url";
import {
	type NormalizedUsage,
	parseUsageFromHeaders,
	parseUsageFromJson,
	parseUsageFromSse,
	type StreamUsageMode,
	type StreamUsageOptions,
	StreamUsageParseError,
} from "../utils/usage";

const proxy = new Hono<AppEnv>();

type ExecutionContextLike = {
	waitUntil: (promise: Promise<unknown>) => void;
};

function scheduleDbWrite(
	c: { executionCtx?: ExecutionContextLike },
	task: Promise<void>,
): void {
	if (c.executionCtx?.waitUntil) {
		c.executionCtx.waitUntil(task);
	} else {
		task.catch(() => undefined);
	}
}

type ErrorDetails = {
	upstreamStatus: number | null;
	errorCode: string | null;
	errorMessage: string | null;
	errorMetaJson?: string | null;
};

type ResponsesRequestHints = {
	previousResponseId: string | null;
	functionCallOutputIds: string[];
	hasFunctionCallOutput: boolean;
};

type ResponsesAffinityRecord = {
	channelId: string;
	tokenId: string | null;
	model: string | null;
	updatedAt: string;
};

type StreamOptionsCapabilityRecord = {
	supported: boolean;
	updatedAt: string;
};

const STREAM_USAGE_UNKNOWN_PARSE_ERROR_CODE =
	"usage_stream_parse_unknown_error";
const STREAM_USAGE_NON_ERROR_THROWN_CODE =
	"usage_stream_parse_non_error_thrown";
const PROXY_UPSTREAM_TIMEOUT_ERROR_CODE = "proxy_upstream_timeout";
const PROXY_UPSTREAM_FETCH_ERROR_CODE = "proxy_upstream_fetch_exception";
const INTERNAL_USAGE_RESERVE_TIMEOUT_MS = 600;
const INTERNAL_USAGE_QUEUE_SEND_TIMEOUT_MS = 1500;
const INTERNAL_USAGE_RESERVE_BREAKER_MS = 60_000;
const INTERNAL_USAGE_ERROR_MESSAGE_MAX_LENGTH = 320;
const INTERNAL_COOLDOWN_HTTP_STATUSES = [408, 429];
const INTERNAL_COOLDOWN_MIN_STATUS = 500;
const HOT_KV_ACTIVE_CHANNELS_TTL_SECONDS = 60;
const HOT_KV_CALL_TOKENS_TTL_SECONDS = 60;
const RESPONSES_TOOL_CALL_NOT_FOUND_SNIPPET =
	"no tool call found for function call output";
const STREAM_OPTIONS_UNSUPPORTED_SNIPPET = "unsupported parameter";
const STREAM_OPTIONS_PARAM_NAME = "stream_options";
const INTERNAL_COOLDOWN_ERROR_CODES = [
	"timeout",
	"exception",
	PROXY_UPSTREAM_TIMEOUT_ERROR_CODE,
	PROXY_UPSTREAM_FETCH_ERROR_CODE,
];

let activeStreamUsageParsers = 0;

function normalizeMessage(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	return trimmed;
}

function normalizeStringField(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function extractResponsesRequestHints(
	body: Record<string, unknown> | null,
): ResponsesRequestHints | null {
	if (!body) {
		return null;
	}
	const previousResponseId = normalizeStringField(
		body.previous_response_id ?? body.previousResponseId,
	);
	const outputIds: string[] = [];
	const scanInputItem = (item: unknown): void => {
		if (!item || typeof item !== "object") {
			return;
		}
		const itemRecord = item as Record<string, unknown>;
		const itemType = normalizeStringField(itemRecord.type)?.toLowerCase();
		if (itemType !== "function_call_output") {
			return;
		}
		const callId = normalizeStringField(
			itemRecord.call_id ?? itemRecord.tool_call_id ?? itemRecord.toolCallId,
		);
		if (!callId) {
			return;
		}
		outputIds.push(callId);
	};
	const rawInput = body.input;
	if (Array.isArray(rawInput)) {
		for (const item of rawInput) {
			scanInputItem(item);
		}
	} else {
		scanInputItem(rawInput);
	}
	return {
		previousResponseId,
		functionCallOutputIds: outputIds,
		hasFunctionCallOutput: outputIds.length > 0,
	};
}

function isResponsesToolCallNotFoundMessage(message: string | null): boolean {
	const normalized = normalizeMessage(message)?.toLowerCase();
	if (!normalized) {
		return false;
	}
	return normalized.includes(RESPONSES_TOOL_CALL_NOT_FOUND_SNIPPET);
}

type ToolSchemaValidationIssue = {
	code: "invalid_function_parameters";
	message: string;
	param: string;
	errorMetaJson: string;
};

function validateRequiredArrayInSchema(
	schema: unknown,
	basePath: string,
): string | null {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return null;
	}
	const record = schema as Record<string, unknown>;
	if (
		Object.prototype.hasOwnProperty.call(record, "required") &&
		record.required !== undefined &&
		!Array.isArray(record.required)
	) {
		return `${basePath}.required`;
	}
	if (
		Object.prototype.hasOwnProperty.call(record, "properties") &&
		record.properties !== undefined
	) {
		const properties = record.properties;
		if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
			return `${basePath}.properties`;
		}
		for (const [key, child] of Object.entries(
			properties as Record<string, unknown>,
		)) {
			const nestedPath = validateRequiredArrayInSchema(
				child,
				`${basePath}.properties.${key}`,
			);
			if (nestedPath) {
				return nestedPath;
			}
		}
	}
	if (
		Object.prototype.hasOwnProperty.call(record, "items") &&
		record.items !== undefined
	) {
		const items = record.items;
		if (Array.isArray(items)) {
			for (let i = 0; i < items.length; i += 1) {
				const nestedPath = validateRequiredArrayInSchema(
					items[i],
					`${basePath}.items[${i}]`,
				);
				if (nestedPath) {
					return nestedPath;
				}
			}
		} else if (items && typeof items === "object") {
			const nestedPath = validateRequiredArrayInSchema(items, `${basePath}.items`);
			if (nestedPath) {
				return nestedPath;
			}
		} else if (items !== true && items !== false) {
			return `${basePath}.items`;
		}
	}
	for (const key of ["allOf", "anyOf", "oneOf"] as const) {
		if (
			Object.prototype.hasOwnProperty.call(record, key) &&
			record[key] !== undefined
		) {
			const group = record[key];
			if (!Array.isArray(group)) {
				return `${basePath}.${key}`;
			}
			for (let i = 0; i < group.length; i += 1) {
				const nestedPath = validateRequiredArrayInSchema(
					group[i],
					`${basePath}.${key}[${i}]`,
				);
				if (nestedPath) {
					return nestedPath;
				}
			}
		}
	}
	return null;
}

function validateToolSchemasInBody(
	body: Record<string, unknown> | null,
): ToolSchemaValidationIssue | null {
	if (!body || !Array.isArray(body.tools)) {
		return null;
	}
	for (let i = 0; i < body.tools.length; i += 1) {
		const rawTool = body.tools[i];
		if (!rawTool || typeof rawTool !== "object" || Array.isArray(rawTool)) {
			continue;
		}
		const toolRecord = rawTool as Record<string, unknown>;
		const toolType = normalizeStringField(toolRecord.type)?.toLowerCase();
		let functionName = normalizeStringField(toolRecord.name);
		let parameters: unknown = undefined;
		let paramPath: string | null = null;
		const nestedFunction = toolRecord.function;
		if (
			toolType === "function" &&
			nestedFunction &&
			typeof nestedFunction === "object" &&
			!Array.isArray(nestedFunction)
		) {
			const fnRecord = nestedFunction as Record<string, unknown>;
			functionName = normalizeStringField(fnRecord.name) ?? functionName;
			parameters = fnRecord.parameters;
			paramPath = `tools[${i}].function.parameters`;
		} else if (toolType === "function" || "parameters" in toolRecord) {
			parameters = toolRecord.parameters;
			paramPath = `tools[${i}].parameters`;
		}
		if (!paramPath || parameters === undefined) {
			continue;
		}
		const issuePath =
			parameters === null ||
			typeof parameters !== "object" ||
			Array.isArray(parameters)
				? paramPath
				: validateRequiredArrayInSchema(parameters, paramPath);
		if (!issuePath) {
			continue;
		}
		const message = issuePath.endsWith(".required")
			? `Invalid schema for function '${functionName ?? "unknown"}': required is not of type 'array'.`
			: `Invalid schema for function '${functionName ?? "unknown"}': ${issuePath} is invalid.`;
		return {
			code: "invalid_function_parameters",
			message,
			param: issuePath,
			errorMetaJson: JSON.stringify({
				type: "local_validation",
				param: issuePath,
				status: 400,
			}),
		};
	}
	return null;
}

function extractOpenAiResponseIdFromJson(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") {
		return null;
	}
	const record = payload as Record<string, unknown>;
	const objectType = normalizeStringField(record.object)?.toLowerCase();
	if (objectType && objectType !== "response") {
		return null;
	}
	return normalizeStringField(record.id);
}

async function extractOpenAiResponseIdFromSse(
	response: Response,
	maxBytes = 64 * 1024,
	timeoutMs = 2_000,
): Promise<string | null> {
	if (!response.body) {
		return null;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const startedAt = Date.now();
	let bytesRead = 0;
	let buffer = "";
	try {
		while (Date.now() - startedAt <= timeoutMs) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			bytesRead += value?.byteLength ?? 0;
			if (bytesRead > maxBytes) {
				await reader.cancel();
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (!line.startsWith("data:")) {
					newlineIndex = buffer.indexOf("\n");
					continue;
				}
				const payload = line.slice(5).trim();
				if (!payload || payload === "[DONE]") {
					newlineIndex = buffer.indexOf("\n");
					continue;
				}
				const parsed = safeJsonParse<Record<string, unknown> | null>(
					payload,
					null,
				);
				if (!parsed) {
					newlineIndex = buffer.indexOf("\n");
					continue;
				}
				const responseObj =
					parsed.response && typeof parsed.response === "object"
						? (parsed.response as Record<string, unknown>)
						: null;
				const responseId =
					normalizeStringField(responseObj?.id) ??
					(normalizeStringField(parsed.object)?.toLowerCase() === "response"
						? normalizeStringField(parsed.id)
						: null);
				if (responseId) {
					await reader.cancel();
					return responseId;
				}
				newlineIndex = buffer.indexOf("\n");
			}
		}
		return null;
	} catch {
		return null;
	} finally {
		reader.releaseLock();
	}
}

function isStreamOptionsUnsupportedMessage(message: string | null): boolean {
	const normalized = normalizeMessage(message)?.toLowerCase();
	if (!normalized) {
		return false;
	}
	return (
		normalized.includes(STREAM_OPTIONS_UNSUPPORTED_SNIPPET) &&
		normalized.includes(STREAM_OPTIONS_PARAM_NAME)
	);
}

function hasUsageHeaders(headers: Headers): boolean {
	const candidates = [
		"x-usage",
		"x-openai-usage",
		"x-usage-total-tokens",
		"x-openai-usage-total-tokens",
		"x-usage-prompt-tokens",
		"x-openai-usage-prompt-tokens",
		"x-usage-completion-tokens",
		"x-openai-usage-completion-tokens",
	];
	return candidates.some((name) => {
		const value = headers.get(name);
		return typeof value === "string" && value.trim().length > 0;
	});
}

function hasUsageJsonHint(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") {
		return false;
	}
	const record = payload as Record<string, unknown>;
	return (
		record.usage !== undefined ||
		record.usageMetadata !== undefined ||
		record.usage_metadata !== undefined
	);
}

function transformOpenAiStreamOptions(
	bodyText: string | undefined,
	mode: "inject" | "strip",
): {
	bodyText: string | undefined;
	injected: boolean;
	stripped: boolean;
} {
	if (!bodyText) {
		return { bodyText, injected: false, stripped: false };
	}
	const body = safeJsonParse<Record<string, unknown> | null>(bodyText, null);
	if (!body || typeof body !== "object") {
		return { bodyText, injected: false, stripped: false };
	}
	if (mode === "strip") {
		if (!("stream_options" in body)) {
			return { bodyText, injected: false, stripped: false };
		}
		const nextBody = { ...body };
		delete nextBody.stream_options;
		return {
			bodyText: JSON.stringify(nextBody),
			injected: false,
			stripped: true,
		};
	}
	const streamOptions = body.stream_options;
	let injected = false;
	const nextBody = { ...body };
	if (!streamOptions || typeof streamOptions !== "object") {
		nextBody.stream_options = { include_usage: true };
		injected = true;
	} else {
		const mapped = { ...(streamOptions as Record<string, unknown>) };
		if (mapped.include_usage !== true) {
			mapped.include_usage = true;
			injected = true;
		}
		nextBody.stream_options = mapped;
	}
	return {
		bodyText: JSON.stringify(nextBody),
		injected,
		stripped: false,
	};
}

function parseCloudflareErrorPage(
	html: string,
	statusHint: number,
): {
	errorCode: string | null;
	errorMessage: string | null;
	errorMetaJson: string | null;
} | null {
	const normalized = html.toLowerCase();
	if (!normalized.includes("cloudflare") || !normalized.includes("error code")) {
		return null;
	}
	const codeMatch =
		html.match(/Error code\s*(\d{3})/i) ??
		html.match(/<title>[^<|]+\|\s*(\d{3})\s*:/i);
	const errorCodeNum = codeMatch ? Number(codeMatch[1]) : statusHint;
	if (!Number.isInteger(errorCodeNum) || errorCodeNum < 500 || errorCodeNum > 599) {
		return null;
	}
	const rayId = normalizeStringField(
		html.match(/Cloudflare Ray ID:\s*<strong[^>]*>([^<]+)<\/strong>/i)?.[1] ??
			null,
	);
	const host =
		normalizeStringField(
			html.match(/id="cf-host-status"[\s\S]*?<span[^>]*>([^<]+)<\/span>/i)?.[1] ??
				null,
		) ??
		normalizeStringField(html.match(/<title>\s*([^|<]+)\|/i)?.[1] ?? null);
	const detail = {
		type: "cloudflare_5xx",
		error_code: errorCodeNum,
		ray_id: rayId,
		host,
	};
	return {
		errorCode: `upstream.cloudflare.${errorCodeNum}`,
		errorMessage: `cloudflare_${errorCodeNum}: host=${host ?? "-"}, ray_id=${rayId ?? "-"}`,
		errorMetaJson: JSON.stringify(detail),
	};
}

function formatUsageErrorMessage(
	code: string,
	detail: string | null,
	maxLength: number,
): string {
	const safeMaxLength = Math.max(1, Math.floor(maxLength));
	const normalized = normalizeMessage(detail);
	if (!normalized) {
		return code;
	}
	const combined = `${code}: ${normalized}`;
	if (combined.length <= safeMaxLength) {
		return combined;
	}
	return `${combined.slice(0, safeMaxLength - 1)}…`;
}

function classifyStreamUsageParseError(
	error: unknown,
	maxLength: number,
): {
	errorCode: string;
	errorMessage: string;
} {
	if (error instanceof StreamUsageParseError) {
		return {
			errorCode: error.code,
			errorMessage: formatUsageErrorMessage(
				error.code,
				error.detail,
				maxLength,
			),
		};
	}
	if (error instanceof Error) {
		const errorCode = STREAM_USAGE_UNKNOWN_PARSE_ERROR_CODE;
		return {
			errorCode,
			errorMessage: formatUsageErrorMessage(
				errorCode,
				normalizeMessage(error.message) ?? error.name,
				maxLength,
			),
		};
	}
	const errorCode = STREAM_USAGE_NON_ERROR_THROWN_CODE;
	return {
		errorCode,
		errorMessage: errorCode,
	};
}

function normalizeUpstreamErrorCode(
	errorCode: string | null,
	status: number,
): string {
	const normalized = normalizeMessage(errorCode);
	if (normalized) {
		return normalized;
	}
	return `upstream_http_${status}`;
}

function getStreamUsageOptions(settings: {
	stream_usage_mode: string;
	stream_usage_max_bytes: number;
}): StreamUsageOptions {
	return {
		mode: settings.stream_usage_mode as StreamUsageMode,
		maxBytes: Math.max(0, Math.floor(settings.stream_usage_max_bytes)),
	};
}

function getStreamUsageMaxParsers(settings: {
	stream_usage_max_parsers: number;
}): number {
	const maxParsers = Math.max(0, Math.floor(settings.stream_usage_max_parsers));
	if (maxParsers === 0) {
		return Number.POSITIVE_INFINITY;
	}
	return maxParsers;
}

function withTimeout<T>(
	task: Promise<T>,
	timeoutMs: number,
	timeoutCode: string,
): Promise<T> {
	if (timeoutMs <= 0) {
		return task;
	}
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(timeoutCode));
		}, timeoutMs);
		task.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function hashFNV1a32(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function shouldDirectWriteByRatio(
	dispatchKey: string,
	directRatio: number,
): boolean {
	if (directRatio <= 0) {
		return false;
	}
	if (directRatio >= 1) {
		return true;
	}
	const bucket = hashFNV1a32(dispatchKey) / 0x1_0000_0000;
	return bucket < directRatio;
}

function createUsageEventScheduler(
	c: { env: AppEnv["Bindings"]; executionCtx?: ExecutionContextLike },
	settings: {
		usage_queue_enabled: boolean;
		usage_queue_daily_limit: number;
		usage_queue_direct_write_ratio: number;
	},
	diagnostics: {
		requestPath?: string | null;
		method?: string | null;
		tokenId?: string | null;
		model?: string | null;
		requestSeed?: string | null;
	},
): (event: UsageQueueEvent) => void {
	const queue = c.env.USAGE_QUEUE;
	const queueBound = Boolean(queue);
	const queueEnabled = settings.usage_queue_enabled && queueBound;
	const limiter = c.env.USAGE_LIMITER
		? getUsageLimiterStub(c.env.USAGE_LIMITER)
		: null;
	const directRatio = settings.usage_queue_direct_write_ratio;
	const dailyLimit = settings.usage_queue_daily_limit;
	const reserveTimeoutMs = INTERNAL_USAGE_RESERVE_TIMEOUT_MS;
	const queueSendTimeoutMs = INTERNAL_USAGE_QUEUE_SEND_TIMEOUT_MS;
	const reserveBreakerMs = INTERNAL_USAGE_RESERVE_BREAKER_MS;
	const requestSeed = diagnostics.requestSeed ?? String(Date.now());
	let overLimit = false;
	let reserveBreakerUntil = 0;
	let dispatchSequence = 0;
	const emitRuntimeEvent = (
		level: "info" | "warning" | "error",
		code: string,
		message: string,
		context: Record<string, unknown>,
	) => {
		const task = recordRuntimeEvent(c.env.DB, {
			level,
			code,
			message,
			requestPath: diagnostics.requestPath ?? null,
			method: diagnostics.method ?? null,
			tokenId: diagnostics.tokenId ?? null,
			model: diagnostics.model ?? null,
			context,
		}).catch(() => undefined);
		scheduleDbWrite(c, task);
	};

	const trackQueueMetric = (kind: UsageQueueTrackKind): void => {
		if (!limiter) {
			return;
		}
		const task = withTimeout(
			trackUsageQueue(limiter, { kind }),
			reserveTimeoutMs,
			"usage_track_timeout",
		)
			.then(() => undefined)
			.catch(() => undefined);
		scheduleDbWrite(c, task);
	};

	const buildDispatchKey = (event: UsageQueueEvent): string => {
		dispatchSequence += 1;
		return [
			requestSeed,
			diagnostics.tokenId ?? "anonymous",
			diagnostics.requestPath ?? "-",
			diagnostics.model ?? "-",
			event.type,
			String(dispatchSequence),
		].join(":");
	};

	type QueueDecision = {
		useQueue: boolean;
		reason:
			| "queue_disabled"
			| "over_limit"
			| "reserve_breaker"
			| "direct_ratio"
			| "reserve_failed"
			| "allowed";
	};

	const shouldUseQueue = async (
		dispatchKey: string,
	): Promise<QueueDecision> => {
		if (!queueEnabled) {
			return {
				useQueue: false,
				reason: "queue_disabled",
			};
		}
		if (overLimit) {
			return {
				useQueue: false,
				reason: "over_limit",
			};
		}
		if (Date.now() < reserveBreakerUntil) {
			return {
				useQueue: false,
				reason: "reserve_breaker",
			};
		}
		if (shouldDirectWriteByRatio(dispatchKey, directRatio)) {
			return {
				useQueue: false,
				reason: "direct_ratio",
			};
		}
		if (!limiter || dailyLimit <= 0) {
			return {
				useQueue: true,
				reason: "allowed",
			};
		}
		try {
			const result = await withTimeout(
				reserveUsageQueue(limiter, {
					limit: dailyLimit,
					amount: 1,
				}),
				reserveTimeoutMs,
				"usage_reserve_timeout",
			);
			if (!result.allowed) {
				overLimit = true;
				emitRuntimeEvent(
					"warning",
					"usage_limiter_reserve_over_limit",
					"usage_limiter_reserve_over_limit",
					{ limit: dailyLimit },
				);
			}
			return {
				useQueue: result.allowed,
				reason: result.allowed ? "allowed" : "over_limit",
			};
		} catch (error) {
			reserveBreakerUntil = Date.now() + reserveBreakerMs;
			emitRuntimeEvent(
				"warning",
				"usage_limiter_reserve_failed",
				"usage_limiter_reserve_failed",
				{
					error: error instanceof Error ? error.message : String(error),
					breaker_ms: reserveBreakerMs,
				},
			);
			return {
				useQueue: false,
				reason: "reserve_failed",
			};
		}
	};

	return (event: UsageQueueEvent) => {
		const task = (async () => {
			const dispatchKey = buildDispatchKey(event);
			const decision = await shouldUseQueue(dispatchKey);
			if (decision.useQueue && queue) {
				try {
					await withTimeout(
						queue.send(event),
						queueSendTimeoutMs,
						"usage_queue_send_timeout",
					);
					trackQueueMetric("enqueue_success");
					return;
				} catch (error) {
					trackQueueMetric("queue_send_failed");
					trackQueueMetric("fallback_direct");
					emitRuntimeEvent(
						"warning",
						"usage_queue_send_failed",
						"usage_queue_send_failed",
						{
							error: error instanceof Error ? error.message : String(error),
							fallback: "direct_write",
						},
					);
				}
			} else {
				if (decision.reason === "reserve_failed") {
					trackQueueMetric("reserve_failed");
				} else if (decision.reason === "over_limit") {
					trackQueueMetric("reserve_over_limit");
				} else {
					trackQueueMetric("direct");
				}
			}
			await processUsageQueueEvent(
				c.env.DB,
				event,
			);
		})().catch((error) => {
			emitRuntimeEvent(
				"error",
				"usage_event_schedule_failed",
				"usage_event_schedule_failed",
				{
					event_type: event.type,
					error: error instanceof Error ? error.message : String(error),
				},
			);
		});
		scheduleDbWrite(c, task);
	};
}

async function extractErrorDetails(
	response: Response,
): Promise<{
	errorCode: string | null;
	errorMessage: string | null;
	errorMetaJson: string | null;
}> {
	const extractJsonError = (
		payload: Record<string, unknown>,
	): {
		errorCode: string | null;
		errorMessage: string | null;
		errorMetaJson: string | null;
	} => {
		const raw = payload as Record<string, unknown>;
		const error =
			raw.error && typeof raw.error === "object"
				? (raw.error as Record<string, unknown>)
				: raw;
		const errorCode =
			typeof error.code === "string"
				? error.code
				: typeof error.type === "string"
					? error.type
					: null;
		const errorMessage =
			typeof error.message === "string"
				? error.message
				: typeof raw.message === "string"
					? raw.message
					: null;
		const param =
			typeof error.param === "string"
				? error.param
				: typeof raw.param === "string"
					? raw.param
					: null;
		return {
			errorCode,
			errorMessage: normalizeMessage(errorMessage),
			errorMetaJson: JSON.stringify({
				type: "json_error",
				param,
				status: response.status,
			}),
		};
	};

	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		const payload = await response
			.clone()
			.json()
			.catch(() => null);
		if (payload && typeof payload === "object") {
			return extractJsonError(payload as Record<string, unknown>);
		}
	}
	const text = await response
		.clone()
		.text()
		.catch(() => "");
	const payloadFromText = safeJsonParse<Record<string, unknown> | null>(
		text,
		null,
	);
	if (payloadFromText && typeof payloadFromText === "object") {
		return extractJsonError(payloadFromText);
	}
	const cloudflare = parseCloudflareErrorPage(text, response.status);
	if (cloudflare) {
		return cloudflare;
	}
	return {
		errorCode: null,
		errorMessage: normalizeMessage(text),
		errorMetaJson: null,
	};
}

export function shouldCooldown(
	upstreamStatus: number | null,
	errorCode: string | null,
): boolean {
	const normalizedCode = normalizeMessage(errorCode)?.toLowerCase() ?? "";
	const cooldownErrorCodes = new Set(
		INTERNAL_COOLDOWN_ERROR_CODES.map((item) => item.trim().toLowerCase()),
	);
	if (normalizedCode && cooldownErrorCodes.has(normalizedCode)) {
		return true;
	}
	const cooldownStatuses = new Set(
		INTERNAL_COOLDOWN_HTTP_STATUSES.map((item) =>
			Math.floor(Number(item)),
		).filter((item) => Number.isInteger(item) && item >= 0),
	);
	if (upstreamStatus !== null && cooldownStatuses.has(upstreamStatus)) {
		return true;
	}
	const minStatus = Math.max(0, Math.floor(INTERNAL_COOLDOWN_MIN_STATUS));
	if (upstreamStatus !== null && minStatus > 0 && upstreamStatus >= minStatus) {
		return true;
	}
	return false;
}

function channelSupportsModel(
	channel: ChannelRecord,
	model: string | null,
	verifiedModelsByChannel: Map<string, Set<string>>,
): boolean {
	if (!model) {
		return true;
	}
	const verified = verifiedModelsByChannel.get(channel.id);
	const declaredModels = extractModels(channel).map((entry) => entry.id);
	const metadata = parseChannelMetadata(channel.metadata_json);
	const mapped = resolveMappedModel(metadata.model_mapping, model);
	const hasExplicitMapping = hasExplicitModelMapping(metadata, model);
	const declaredAllows =
		declaredModels.length > 0
			? (mapped ? declaredModels.includes(mapped) : false) ||
				declaredModels.includes(model)
			: null;
	const verifiedAllows =
		verified && verified.size > 0
			? (mapped ? verified.has(mapped) : false) || verified.has(model)
			: null;
	if (hasExplicitMapping) {
		if (verified && verified.size > 0) {
			return Boolean(verifiedAllows);
		}
		if (declaredModels.length > 0) {
			return Boolean(declaredAllows);
		}
		return true;
	}
	if (declaredModels.length > 0 && !declaredAllows) {
		return false;
	}
	if (verified && verified.size > 0) {
		return Boolean(verifiedAllows);
	}
	if (declaredModels.length > 0) {
		return true;
	}
	return false;
}

export function selectCandidateChannels(
	allowedChannels: ChannelRecord[],
	downstreamModel: string | null,
	verifiedModelsByChannel: Map<string, Set<string>> = new Map(),
): ChannelRecord[] {
	const modelChannels = allowedChannels.filter((channel) =>
		channelSupportsModel(channel, downstreamModel, verifiedModelsByChannel),
	);
	return modelChannels;
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
	verifiedModelsByChannel: Map<string, Set<string>> = new Map(),
): { model: string | null; autoMapped: boolean } {
	const mapped = resolveMappedModel(metadata.model_mapping, downstreamModel);
	if (!downstreamModel || hasExplicitModelMapping(metadata, downstreamModel)) {
		return { model: mapped, autoMapped: false };
	}

	const verified = verifiedModelsByChannel.get(channel.id);
	const declaredModels = verified
		? Array.from(verified)
		: extractModels(channel).map((entry) => entry.id);
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

const normalizeTokenModels = (raw?: string | null): string[] | null => {
	const parsed = safeJsonParse<string[] | null>(raw ?? null, null);
	if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
		return null;
	}
	return parsed.map((item) => String(item));
};

const selectTokenForModel = (
	tokens: CallTokenItem[],
	model: string | null,
): { token: CallTokenItem | null; hasModelList: boolean } => {
	if (tokens.length === 0) {
		return { token: null, hasModelList: false };
	}
	if (!model) {
		return { token: tokens[0], hasModelList: false };
	}
	const tokensWithModels = tokens.map((token) => ({
		token,
		models: normalizeTokenModels(token.models_json),
	}));
	const hasModelList = tokensWithModels.some((entry) => entry.models);
	if (!hasModelList) {
		return { token: tokens[0], hasModelList: false };
	}
	const match = tokensWithModels.find((entry) => entry.models?.includes(model));
	return { token: match?.token ?? null, hasModelList };
};

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
	const db = c.env.DB;
	const tokenRecord = c.get("tokenRecord") as TokenRecord;
	const requestStart = Date.now();
	const withTraceHeader = (response: Response): Response => response;
	const jsonErrorWithTrace = (
		status: Parameters<typeof jsonError>[1],
		message: string,
		code?: string,
	): Response => jsonError(c, status, message, code);
	const [cacheConfig, runtimeSettings] = await Promise.all([
		getCacheConfig(db, c.env.CACHE_VERSION_STORE),
		getProxyRuntimeSettings(db),
	]);
	const requestText = await c.req.text();
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
	const responsesRequestHints =
		downstreamProvider === "openai"
			? extractResponsesRequestHints(parsedBody)
			: null;
	const reasoningEffort = extractReasoningEffort(parsedBody);
	const scheduleRuntimeEvent = (
		level: "info" | "warning" | "error",
		code: string,
		message: string,
		context: Record<string, unknown>,
	) => {
		const channelId = normalizeStringField(context.channel_id ?? null);
		const task = recordRuntimeEvent(db, {
			level,
			code,
			message,
			requestPath: c.req.path,
			method: c.req.method,
			channelId,
			tokenId: tokenRecord.id,
			model: downstreamModel,
			context,
		}).catch(() => undefined);
		scheduleDbWrite(c, task);
	};
	const scheduleUsageEvent = createUsageEventScheduler(c, runtimeSettings, {
		requestPath: c.req.path,
		method: c.req.method,
		tokenId: tokenRecord.id,
		model: downstreamModel,
		requestSeed: String(requestStart),
	});
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

	const recordEarlyUsage = (options: {
		status: number;
		code: string;
		message?: string | null;
		failureStage?: string | null;
		failureReason?: string | null;
		usageSource?: string | null;
		errorMetaJson?: string | null;
	}) => {
		const latencyMs = Date.now() - requestStart;
		const errorMessage = options.message ?? options.code;
		scheduleUsageEvent({
			type: "usage",
			payload: {
				tokenId: tokenRecord.id,
				channelId: null,
				model: downstreamModel,
				requestPath: c.req.path,
				totalTokens: 0,
				latencyMs,
				firstTokenLatencyMs: isStream ? null : latencyMs,
				stream: isStream,
				reasoningEffort,
				status: "error",
				upstreamStatus: options.status,
				errorCode: options.code,
				errorMessage,
				failureStage: options.failureStage ?? "request",
				failureReason: options.failureReason ?? options.code,
				usageSource: options.usageSource ?? "none",
				errorMetaJson: options.errorMetaJson ?? null,
			},
		});
	};
	const recordAttemptUsage = (options: {
		channelId: string | null;
		requestPath: string;
		latencyMs: number;
		firstTokenLatencyMs: number | null;
		usage: NormalizedUsage | null;
		status: "ok" | "error";
		upstreamStatus: number | null;
		errorCode?: string | null;
		errorMessage?: string | null;
		failureStage?: string | null;
		failureReason?: string | null;
		usageSource?: string | null;
		errorMetaJson?: string | null;
	}) => {
		const normalized = options.usage ?? {
			totalTokens: 0,
			promptTokens: 0,
			completionTokens: 0,
		};
		scheduleUsageEvent({
			type: "usage",
			payload: {
				tokenId: tokenRecord.id,
				channelId: options.channelId,
				model: downstreamModel,
				requestPath: options.requestPath,
				totalTokens: normalized.totalTokens,
				promptTokens: normalized.promptTokens,
				completionTokens: normalized.completionTokens,
				cost: 0,
				latencyMs: options.latencyMs,
				firstTokenLatencyMs: options.firstTokenLatencyMs,
				stream: isStream,
				reasoningEffort,
				status: options.status,
				upstreamStatus: options.upstreamStatus,
				errorCode: options.errorCode ?? null,
				errorMessage: options.errorMessage ?? null,
				failureStage: options.failureStage ?? null,
				failureReason: options.failureReason ?? options.errorCode ?? null,
				usageSource:
					options.usageSource ?? (options.usage ? "computed" : "none"),
				errorMetaJson: options.errorMetaJson ?? null,
			},
		});
	};
	const toolSchemaIssue = validateToolSchemasInBody(parsedBody);
	if (toolSchemaIssue) {
		scheduleRuntimeEvent(
			"warning",
			"invalid_function_parameters_precheck",
			"invalid_function_parameters_precheck",
			{
				param: toolSchemaIssue.param,
			},
		);
		recordEarlyUsage({
			status: 400,
			code: toolSchemaIssue.code,
			message: toolSchemaIssue.message,
			failureStage: "request_validation",
			failureReason: toolSchemaIssue.code,
			usageSource: "none",
			errorMetaJson: toolSchemaIssue.errorMetaJson,
		});
		return jsonErrorWithTrace(400, toolSchemaIssue.message, toolSchemaIssue.code);
	}

	const activeChannelsCacheKey = buildActiveChannelsKey(
		cacheConfig.version_channels,
	);
	let activeChannelRows = await readHotJson<ChannelRecord[]>(
		c.env.KV_HOT,
		activeChannelsCacheKey,
	);
	if (!Array.isArray(activeChannelRows)) {
		const activeChannels = await db
			.prepare("SELECT * FROM channels WHERE status = ?")
			.bind("active")
			.all<ChannelRecord>();
		activeChannelRows = (activeChannels.results ?? []) as ChannelRecord[];
		void writeHotJson(
			c.env.KV_HOT,
			activeChannelsCacheKey,
			activeChannelRows,
			HOT_KV_ACTIVE_CHANNELS_TTL_SECONDS,
		);
	}
	const channelIds = activeChannelRows.map((channel) => channel.id);
	const callTokensCacheKey = buildCallTokensIndexKey(
		cacheConfig.version_call_tokens,
		cacheConfig.version_channels,
	);
	const cachedCallTokenRows = await readHotJson<
		Array<{
			id: string;
			channel_id: string;
			name: string;
			api_key: string;
			models_json?: string | null;
		}>
	>(c.env.KV_HOT, callTokensCacheKey);
	let callTokenRows: Array<{
		id: string;
		channel_id: string;
		name: string;
		api_key: string;
		models_json?: string | null;
	}> = [];
	if (Array.isArray(cachedCallTokenRows)) {
		callTokenRows = cachedCallTokenRows;
	} else {
		callTokenRows = await listCallTokens(db, {
			channelIds,
		});
		void writeHotJson(
			c.env.KV_HOT,
			callTokensCacheKey,
			callTokenRows,
			HOT_KV_CALL_TOKENS_TTL_SECONDS,
		);
	}
	const callTokenMap = new Map<string, CallTokenItem[]>();
	for (const row of callTokenRows) {
		const entry: CallTokenItem = {
			id: row.id,
			channel_id: row.channel_id,
			name: row.name,
			api_key: row.api_key,
			models_json: row.models_json ?? null,
		};
		const list = callTokenMap.get(row.channel_id) ?? [];
		list.push(entry);
		callTokenMap.set(row.channel_id, list);
	}
	const allowedChannels = filterAllowedChannels(activeChannelRows, tokenRecord);
	const verifiedModelsByChannel = await listVerifiedModelsByChannel(
		db,
		allowedChannels.map((channel) => channel.id),
	);
	let candidates = selectCandidateChannels(
		allowedChannels,
		downstreamModel,
		verifiedModelsByChannel,
	);
	const canResolveResponsesAffinity = Boolean(c.env.KV_HOT);
	let responsesPinnedChannelId: string | null = null;
	if (
		canResolveResponsesAffinity &&
		responsesRequestHints?.hasFunctionCallOutput &&
		!responsesRequestHints.previousResponseId
	) {
		const code = "responses_previous_response_id_required";
		recordEarlyUsage({
			status: 409,
			code,
			message:
				"responses_previous_response_id_required: function_call_output requires previous_response_id for routed channels",
		});
		return jsonErrorWithTrace(409, code, code);
	}
	if (
		canResolveResponsesAffinity &&
		responsesRequestHints?.previousResponseId
	) {
		const affinityKey = buildResponsesAffinityKey(
			responsesRequestHints.previousResponseId,
		);
		const affinity = await readHotJson<ResponsesAffinityRecord>(
			c.env.KV_HOT,
			affinityKey,
		);
		const candidateChannelId = normalizeStringField(affinity?.channelId);
		const affinityTokenId = normalizeStringField(affinity?.tokenId);
		if (
			candidateChannelId &&
			(!affinityTokenId || affinityTokenId === tokenRecord.id)
		) {
			responsesPinnedChannelId = candidateChannelId;
		}
	}
	if (
		canResolveResponsesAffinity &&
		responsesRequestHints?.hasFunctionCallOutput &&
		responsesRequestHints.previousResponseId &&
		!responsesPinnedChannelId
	) {
		const code = "responses_affinity_missing";
		recordEarlyUsage({
			status: 409,
			code,
			message: `responses_affinity_missing: previous_response_id=${responsesRequestHints.previousResponseId}`,
		});
		return jsonErrorWithTrace(409, code, code);
	}
	if (responsesPinnedChannelId) {
		const isActivePinnedChannel = activeChannelRows.some(
			(channel) => channel.id === responsesPinnedChannelId,
		);
		if (!isActivePinnedChannel) {
			const code = "responses_affinity_channel_disabled";
			recordEarlyUsage({
				status: 409,
				code,
				message: `responses_affinity_channel_disabled: previous_response_id=${responsesRequestHints?.previousResponseId ?? "-"}, channel_id=${responsesPinnedChannelId}`,
			});
			return jsonErrorWithTrace(409, code, code);
		}
		const isAllowedPinnedChannel = allowedChannels.some(
			(channel) => channel.id === responsesPinnedChannelId,
		);
		if (!isAllowedPinnedChannel) {
			const code = "responses_affinity_channel_not_allowed";
			recordEarlyUsage({
				status: 409,
				code,
				message: `responses_affinity_channel_not_allowed: previous_response_id=${responsesRequestHints?.previousResponseId ?? "-"}, channel_id=${responsesPinnedChannelId}`,
			});
			return jsonErrorWithTrace(409, code, code);
		}
		candidates = candidates.filter(
			(channel) => channel.id === responsesPinnedChannelId,
		);
		if (candidates.length === 0) {
			const code = "responses_affinity_channel_model_unavailable";
			recordEarlyUsage({
				status: 409,
				code,
				message: `responses_affinity_channel_model_unavailable: previous_response_id=${responsesRequestHints?.previousResponseId ?? "-"}, channel_id=${responsesPinnedChannelId}, model=${downstreamModel ?? "-"}`,
			});
			return jsonErrorWithTrace(409, code, code);
		}
		if (downstreamModel) {
			const pinnedCooldownMinutes = Math.max(
				0,
				Math.floor(runtimeSettings.model_failure_cooldown_minutes),
			);
			const pinnedCooldownSeconds = pinnedCooldownMinutes * 60;
			const pinnedCooldownThreshold = Math.max(
				1,
				Math.floor(runtimeSettings.model_failure_cooldown_threshold),
			);
			if (pinnedCooldownSeconds > 0) {
				const coolingChannels = await listCoolingDownChannelsForModel(
					db,
					[responsesPinnedChannelId],
					downstreamModel,
					pinnedCooldownSeconds,
					pinnedCooldownThreshold,
				);
				if (coolingChannels.has(responsesPinnedChannelId)) {
					const code = "responses_affinity_channel_cooldown";
					recordEarlyUsage({
						status: 409,
						code,
						message: `responses_affinity_channel_cooldown: previous_response_id=${responsesRequestHints?.previousResponseId ?? "-"}, channel_id=${responsesPinnedChannelId}, model=${downstreamModel}`,
					});
					return jsonErrorWithTrace(409, code, code);
				}
			}
		}
	}
	const cooldownMinutes = Math.max(
		0,
		Math.floor(runtimeSettings.model_failure_cooldown_minutes),
	);
	const cooldownSeconds = cooldownMinutes * 60;
	const cooldownFailureThreshold = Math.max(
		1,
		Math.floor(runtimeSettings.model_failure_cooldown_threshold),
	);
	const responsesAffinityTtlSeconds = Math.max(
		60,
		Math.floor(runtimeSettings.responses_affinity_ttl_seconds),
	);
	const streamOptionsCapabilityTtlSeconds = Math.max(
		60,
		Math.floor(runtimeSettings.stream_options_capability_ttl_seconds),
	);
	const usageErrorMessageMaxLength = INTERNAL_USAGE_ERROR_MESSAGE_MAX_LENGTH;
	const streamUsageParseTimeoutMs = Math.max(
		0,
		Math.floor(runtimeSettings.stream_usage_parse_timeout_ms),
	);
	if (
		!responsesPinnedChannelId &&
		downstreamModel &&
		cooldownSeconds > 0 &&
		candidates.length > 0
	) {
		const coolingChannels = await listCoolingDownChannelsForModel(
			db,
			candidates.map((channel) => channel.id),
			downstreamModel,
			cooldownSeconds,
			cooldownFailureThreshold,
		);
		if (coolingChannels.size > 0) {
			candidates = candidates.filter(
				(channel) => !coolingChannels.has(channel.id),
			);
			if (candidates.length === 0) {
				scheduleRuntimeEvent(
					"warning",
					"proxy_model_cooldown",
					"proxy_model_cooldown",
					{
						path: c.req.path,
						model: downstreamModel,
						cooldown_minutes: cooldownMinutes,
						cooldown_threshold: cooldownFailureThreshold,
						blocked_channels: coolingChannels.size,
					},
				);
				recordEarlyUsage({
					status: 503,
					code: "upstream_cooldown",
					message: "upstream_cooldown",
				});
					return jsonErrorWithTrace(503, "upstream_cooldown", "upstream_cooldown");
			}
		}
	}

	if (candidates.length === 0 && allowedChannels.length > 0) {
		scheduleRuntimeEvent(
			"warning",
			"proxy_no_compatible_channels",
			"proxy_no_compatible_channels",
			{
				path: c.req.path,
				model: downstreamModel,
				downstream_provider: downstreamProvider,
				allowed_channels: allowedChannels.length,
			},
		);
	}
	if (candidates.length === 0) {
		recordEarlyUsage({
			status: 503,
			code: "no_available_channels",
			message: "no_available_channels",
		});
		return jsonErrorWithTrace(503, "no_available_channels", "no_available_channels");
	}
	const targetPath = c.req.path;
	const querySuffix = c.req.url.includes("?")
		? `?${c.req.url.split("?")[1]}`
		: "";

	const maxRetries = Math.max(
		0,
		Math.floor(Number(runtimeSettings.retry_max_retries ?? 3)),
	);
	const ordered = createWeightedOrder(candidates).slice(0, maxRetries + 1);
	const upstreamTimeoutMs = Math.max(
		0,
		Math.floor(Number(runtimeSettings.upstream_timeout_ms ?? 30000)),
	);
	const nowSeconds = Math.floor(Date.now() / 1000);
	let selectedResponse: Response | null = null;
	let selectedChannel: ChannelRecord | null = null;
	let selectedUpstreamProvider: ProviderType | null = null;
	let selectedUpstreamEndpoint: EndpointType | null = null;
	let selectedUpstreamModel: string | null = null;
	let selectedRequestPath = targetPath;
	let selectedImmediateUsage: NormalizedUsage | null = null;
	let selectedHasUsageHeaders = false;
	let lastResponse: Response | null = null;
	let lastChannel: ChannelRecord | null = null;
	let lastRequestPath = targetPath;
	let lastErrorDetails: ErrorDetails | null = null;
	const responsesToolCallMismatchChannels: string[] = [];
	const streamOptionsCapabilityMemo = new Map<
		string,
		"supported" | "unsupported" | "unknown"
	>();
	const loadStreamOptionsCapability = async (
		channelId: string,
	): Promise<"supported" | "unsupported" | "unknown"> => {
		const cached = streamOptionsCapabilityMemo.get(channelId);
		if (cached) {
			return cached;
		}
		if (!c.env.KV_HOT) {
			streamOptionsCapabilityMemo.set(channelId, "unknown");
			return "unknown";
		}
		const key = buildStreamOptionsCapabilityKey(channelId);
		const record = await readHotJson<StreamOptionsCapabilityRecord>(c.env.KV_HOT, key);
		const value =
			record && typeof record.supported === "boolean"
				? record.supported
					? "supported"
					: "unsupported"
				: "unknown";
		streamOptionsCapabilityMemo.set(channelId, value);
		return value;
	};
	const saveStreamOptionsCapability = (
		channelId: string,
		supported: boolean,
	): void => {
		streamOptionsCapabilityMemo.set(channelId, supported ? "supported" : "unsupported");
		if (!c.env.KV_HOT) {
			return;
		}
		const key = buildStreamOptionsCapabilityKey(channelId);
		const record: StreamOptionsCapabilityRecord = {
			supported,
			updatedAt: new Date().toISOString(),
		};
		void writeHotJson(
			c.env.KV_HOT,
			key,
			record,
			streamOptionsCapabilityTtlSeconds,
		);
	};
	for (const channel of ordered) {
		lastChannel = channel;
		const attemptStart = Date.now();
		const metadata = parseChannelMetadata(channel.metadata_json);
		const upstreamProvider = resolveProvider(metadata.site_type);
		const resolvedModel = resolveUpstreamModelForChannel(
			channel,
			metadata,
			downstreamModel,
			verifiedModelsByChannel,
		);
		const upstreamModel = resolvedModel.model;
		const recordModel = upstreamModel ?? downstreamModel;
		if (
			upstreamProvider === "gemini" &&
			!upstreamModel &&
			endpointType !== "passthrough"
		) {
			continue;
		}
		const baseUrl = resolveChannelBaseUrl(channel);
		const tokens = callTokenMap.get(channel.id) ?? [];
		const selection = selectTokenForModel(tokens, recordModel);
		if (!selection.token && selection.hasModelList && recordModel) {
			continue;
		}
		const apiKey = selection.token?.api_key ?? channel.api_key;
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
			if (endpointType === "images" && metadata.endpoint_overrides.image_url) {
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
					recordEarlyUsage({
						status: 400,
						code: "invalid_body",
						message: "invalid_body",
					});
					return jsonErrorWithTrace(400, "invalid_body", "invalid_body");
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
					recordEarlyUsage({
						status: 400,
						code: "invalid_body",
						message: "invalid_body",
					});
					return jsonErrorWithTrace(400, "invalid_body", "invalid_body");
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
					recordEarlyUsage({
						status: 400,
						code: "invalid_body",
						message: "invalid_body",
					});
					return jsonErrorWithTrace(400, "invalid_body", "invalid_body");
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
			const shouldHandleStreamOptions =
				upstreamProvider === "openai" &&
				isStream &&
				(endpointType === "chat" || endpointType === "responses");
			let streamOptionsInjected = false;
			let strippedStreamOptionsBodyText: string | undefined = upstreamBodyText;
			if (shouldHandleStreamOptions) {
				const capability = await loadStreamOptionsCapability(channel.id);
				if (capability !== "unsupported") {
					const injected = transformOpenAiStreamOptions(
						upstreamBodyText,
						"inject",
					);
					upstreamBodyText = injected.bodyText;
					streamOptionsInjected = injected.injected;
					const stripped = transformOpenAiStreamOptions(
						upstreamBodyText,
						"strip",
					);
					strippedStreamOptionsBodyText = stripped.bodyText;
				} else {
					const stripped = transformOpenAiStreamOptions(
						upstreamBodyText,
						"strip",
					);
					upstreamBodyText = stripped.bodyText;
					strippedStreamOptionsBodyText = stripped.bodyText;
				}
			}
			const targetBase = absoluteUrl ?? `${baseUrl}${upstreamRequestPath}`;
			const target = mergeQuery(
			targetBase,
			querySuffix,
			metadata.query_overrides,
		);

			try {
				const executeUpstreamFetch = async (
					bodyText: string | undefined,
				): Promise<{ response: Response; responsePath: string }> => {
					let response = await fetchWithTimeout(
						target,
						{
							method: c.req.method,
							headers,
							body: bodyText || undefined,
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
								body: bodyText || undefined,
							},
							upstreamTimeoutMs,
						);
						responsePath = upstreamFallbackPath;
					}
					return { response, responsePath };
				};
				let { response, responsePath } =
					await executeUpstreamFetch(upstreamBodyText);
				if (shouldHandleStreamOptions && streamOptionsInjected && !response.ok) {
					const details = await extractErrorDetails(response);
					if (isStreamOptionsUnsupportedMessage(details.errorMessage)) {
						saveStreamOptionsCapability(channel.id, false);
						const retried = await executeUpstreamFetch(
							strippedStreamOptionsBodyText,
						);
						response = retried.response;
						responsePath = retried.responsePath;
					}
				}
				if (shouldHandleStreamOptions && response.ok && streamOptionsInjected) {
					saveStreamOptionsCapability(channel.id, true);
				}

				const attemptLatencyMs = Date.now() - attemptStart;
				lastResponse = response;
				lastRequestPath = responsePath;
				if (response.ok) {
					const hasUsageHeaderSignal = hasUsageHeaders(response.headers);
					const headerUsage = parseUsageFromHeaders(response.headers);
					let jsonUsage: NormalizedUsage | null = null;
					let hasUsageJsonSignal = false;
					if (
						!isStream &&
						response.headers.get("content-type")?.includes("application/json")
					) {
						const data = await response
							.clone()
							.json()
							.catch(() => null);
						hasUsageJsonSignal = hasUsageJsonHint(data);
						jsonUsage = parseUsageFromJson(data);
					}
					const immediateUsage = jsonUsage ?? headerUsage;
					const immediateUsageSource = jsonUsage
						? "json"
						: headerUsage
							? "header"
							: "none";
					if (!isStream && !immediateUsage) {
						const usageMissingCode =
							hasUsageHeaderSignal || hasUsageJsonSignal
								? "usage_missing.non_stream.signal_present_unparseable"
								: "usage_missing.non_stream.signal_absent";
						const usageMissingMessage = `usage_missing: ${usageMissingCode}`;
						lastErrorDetails = {
							upstreamStatus: response.status,
							errorCode: usageMissingCode,
							errorMessage: usageMissingMessage,
						};
						recordAttemptUsage({
							channelId: channel.id,
							requestPath: responsePath,
						latencyMs: attemptLatencyMs,
						firstTokenLatencyMs: attemptLatencyMs,
							usage: null,
							status: "error",
							upstreamStatus: response.status,
							errorCode: usageMissingCode,
							errorMessage: usageMissingMessage,
							failureStage: "usage_finalize",
							failureReason: usageMissingCode,
							usageSource: immediateUsageSource,
						});
						continue;
					}
					if (!isStream) {
					recordAttemptUsage({
						channelId: channel.id,
						requestPath: responsePath,
						latencyMs: attemptLatencyMs,
						firstTokenLatencyMs: attemptLatencyMs,
							usage: immediateUsage,
							status: "ok",
							upstreamStatus: response.status,
							failureStage: "usage_finalize",
							usageSource: immediateUsageSource,
						});
					}
				selectedChannel = channel;
				selectedUpstreamProvider = upstreamProvider;
				try {
					selectedUpstreamEndpoint = detectEndpointType(
						upstreamProvider,
						responsePath,
					);
				} catch {
					selectedUpstreamEndpoint = endpointType;
				}
				selectedUpstreamModel = upstreamModel;
					selectedResponse = response;
					selectedRequestPath = responsePath;
					selectedImmediateUsage = immediateUsage;
					selectedHasUsageHeaders = hasUsageHeaderSignal;
					lastErrorDetails = null;
				if (recordModel) {
					scheduleUsageEvent({
						type: "capability_upsert",
						payload: {
							channelId: channel.id,
							models: [recordModel],
							nowSeconds,
						},
					});
				}
				break;
			}
			const errorInfo = await extractErrorDetails(response);
			const normalizedErrorCode = normalizeUpstreamErrorCode(
				errorInfo.errorCode,
				response.status,
			);
			const normalizedErrorMessage =
				normalizeMessage(errorInfo.errorMessage) ?? normalizedErrorCode;
				const responsesToolCallMismatch =
					downstreamProvider === "openai" &&
					isResponsesToolCallNotFoundMessage(normalizedErrorMessage);
				const streamOptionsUnsupported =
					shouldHandleStreamOptions &&
					isStreamOptionsUnsupportedMessage(normalizedErrorMessage);
				if (responsesToolCallMismatch) {
					responsesToolCallMismatchChannels.push(channel.id);
				}
				const finalErrorCode = responsesToolCallMismatch
					? "responses_tool_call_chain_mismatch"
					: streamOptionsUnsupported
						? "stream_options_unsupported"
					: normalizedErrorCode;
				lastErrorDetails = {
					upstreamStatus: response.status,
					errorCode: finalErrorCode,
					errorMessage: normalizedErrorMessage,
					errorMetaJson: errorInfo.errorMetaJson,
				};
				recordAttemptUsage({
					channelId: channel.id,
					requestPath: responsePath,
					latencyMs: attemptLatencyMs,
					firstTokenLatencyMs: isStream ? null : attemptLatencyMs,
					usage: null,
					status: "error",
					upstreamStatus: response.status,
					errorCode: finalErrorCode,
					errorMessage: normalizedErrorMessage,
					failureStage: "upstream_response",
					failureReason: finalErrorCode,
					usageSource: "none",
					errorMetaJson: errorInfo.errorMetaJson,
				});
			const cooldownEligible = shouldCooldown(
				response.status,
				finalErrorCode,
			);
			if (recordModel && cooldownSeconds > 0 && cooldownEligible) {
				scheduleUsageEvent({
					type: "model_error",
					payload: {
						channelId: channel.id,
						model: recordModel,
						errorCode: String(response.status),
						nowSeconds,
					},
				});
			}
			if (
				downstreamModel &&
				downstreamModel !== recordModel &&
				cooldownSeconds > 0 &&
				cooldownEligible
			) {
				scheduleUsageEvent({
					type: "model_error",
					payload: {
						channelId: channel.id,
						model: downstreamModel,
						errorCode: String(response.status),
						nowSeconds,
					},
				});
			}
		} catch (error) {
			const isTimeout =
				error instanceof Error &&
				(error.name === "AbortError" ||
					error.message.includes("upstream_timeout"));
			const usageErrorCode = isTimeout
				? PROXY_UPSTREAM_TIMEOUT_ERROR_CODE
				: PROXY_UPSTREAM_FETCH_ERROR_CODE;
			const usageErrorDetail = normalizeMessage(
				error instanceof Error ? error.message : String(error),
			);
			const usageErrorMessage = formatUsageErrorMessage(
				usageErrorCode,
				usageErrorDetail,
				usageErrorMessageMaxLength,
			);
			scheduleRuntimeEvent(
				"error",
				"proxy_upstream_exception",
				"proxy_upstream_exception",
				{
					channel_id: channel.id,
					upstream_provider: upstreamProvider,
					path: upstreamRequestPath,
					model: downstreamModel,
					upstream_model: upstreamModel,
					timeout_ms: upstreamTimeoutMs,
					reason: isTimeout ? "timeout" : "exception",
					error: error instanceof Error ? error.message : String(error),
				},
			);
			const attemptLatencyMs = Date.now() - attemptStart;
				lastErrorDetails = {
					upstreamStatus: null,
					errorCode: usageErrorCode,
					errorMessage: usageErrorMessage,
					errorMetaJson: JSON.stringify({
						type: "fetch_exception",
						reason: isTimeout ? "timeout" : "exception",
					}),
				};
				recordAttemptUsage({
					channelId: channel.id,
					requestPath: upstreamRequestPath,
					latencyMs: attemptLatencyMs,
					firstTokenLatencyMs: null,
					usage: null,
					status: "error",
					upstreamStatus: null,
					errorCode: lastErrorDetails.errorCode,
					errorMessage: lastErrorDetails.errorMessage,
					failureStage: "upstream_call",
					failureReason: usageErrorCode,
					usageSource: "none",
					errorMetaJson: lastErrorDetails.errorMetaJson ?? null,
				});
			const cooldownEligible = shouldCooldown(null, usageErrorCode);
			if (recordModel && cooldownSeconds > 0 && cooldownEligible) {
				scheduleUsageEvent({
					type: "model_error",
					payload: {
						channelId: channel.id,
						model: recordModel,
						errorCode: usageErrorCode,
						nowSeconds,
					},
				});
			}
			if (
				downstreamModel &&
				downstreamModel !== recordModel &&
				cooldownSeconds > 0 &&
				cooldownEligible
			) {
				scheduleUsageEvent({
					type: "model_error",
					payload: {
						channelId: channel.id,
						model: downstreamModel,
						errorCode: usageErrorCode,
						nowSeconds,
					},
				});
			}
			lastResponse = null;
		}
	}

	if (!selectedResponse && lastResponse && !lastResponse.ok) {
		scheduleRuntimeEvent(
			"warning",
			"proxy_upstream_exhausted",
			"proxy_upstream_exhausted",
			{
				path: targetPath,
				model: downstreamModel,
				status: lastResponse.status,
				last_channel_id: lastChannel?.id ?? null,
				last_request_path: lastRequestPath,
			},
		);
	}

	if (!selectedResponse) {
		if (responsesToolCallMismatchChannels.length > 0) {
			const code = "responses_tool_call_chain_mismatch";
			const details = `responses_tool_call_chain_mismatch: previous_response_id=${responsesRequestHints?.previousResponseId ?? "-"}, channels=${responsesToolCallMismatchChannels.join(",")}`;
			recordEarlyUsage({
				status: 409,
				code,
				message: details,
			});
			return jsonErrorWithTrace(409, code, code);
		}
		if (lastResponse && !lastResponse.ok) {
			return withTraceHeader(lastResponse);
		}
		if (lastErrorDetails) {
			const errorCode = lastErrorDetails.errorCode ?? "upstream_unavailable";
			return jsonErrorWithTrace(502, errorCode, errorCode);
		}
		scheduleRuntimeEvent("error", "proxy_unavailable", "proxy_unavailable", {
			path: targetPath,
			model: downstreamModel,
			latency_ms: Date.now() - requestStart,
			last_channel_id: lastChannel?.id ?? null,
		});
		recordEarlyUsage({
			status: 502,
			code: "upstream_unavailable",
			message: "upstream_unavailable",
		});
		return jsonErrorWithTrace(502, "upstream_unavailable", "upstream_unavailable");
	}

	if (selectedChannel && isStream) {
		const selectedLatencyMs = Date.now() - requestStart;
		const executionCtx = (c as { executionCtx?: ExecutionContextLike })
			.executionCtx;
		const streamUsageOptions = getStreamUsageOptions(runtimeSettings);
		const streamUsageMaxParsers = getStreamUsageMaxParsers(runtimeSettings);
		let usageFinalized = false;
		const finalizeUsage = (
			options: Parameters<typeof recordAttemptUsage>[0],
		) => {
			if (usageFinalized) {
				return;
			}
			usageFinalized = true;
			recordAttemptUsage(options);
		};
		const canParseStream =
			streamUsageOptions.mode !== "off" &&
			activeStreamUsageParsers < streamUsageMaxParsers;
			if (!canParseStream) {
				const fallbackUsageSource = selectedImmediateUsage ? "header" : "none";
				const fallbackMissingCode = "usage_missing.stream.parser_disabled";
				finalizeUsage({
					channelId: selectedChannel.id,
					requestPath: selectedRequestPath,
					latencyMs: selectedLatencyMs,
					firstTokenLatencyMs: null,
					usage: selectedImmediateUsage,
					status: selectedImmediateUsage ? "ok" : "error",
					upstreamStatus: selectedResponse.status,
					errorCode: selectedImmediateUsage ? null : fallbackMissingCode,
					errorMessage: selectedImmediateUsage
						? null
						: `usage_missing: ${fallbackMissingCode}`,
					failureStage: "usage_finalize",
					failureReason: selectedImmediateUsage ? null : fallbackMissingCode,
					usageSource: fallbackUsageSource,
				});
			} else {
			activeStreamUsageParsers += 1;
			const task = parseUsageFromSse(selectedResponse.clone(), {
				...streamUsageOptions,
				timeoutMs: streamUsageParseTimeoutMs,
			})
				.then((streamUsage) => {
					const usageValue = selectedImmediateUsage ?? streamUsage.usage;
					if (streamUsage.timedOut) {
						scheduleRuntimeEvent(
							"warning",
							"usage_stream_parse_timeout",
							"usage_stream_parse_timeout",
							{
								path: selectedRequestPath,
								timeout_ms: streamUsageParseTimeoutMs,
							},
						);
						const timeoutMessage = `usage_parse_timeout: stream usage parsing timed out after ${streamUsageParseTimeoutMs}ms`;
							finalizeUsage({
								channelId: selectedChannel.id,
								requestPath: selectedRequestPath,
								latencyMs: selectedLatencyMs,
								firstTokenLatencyMs: streamUsage.firstTokenLatencyMs,
								usage: usageValue,
								status: usageValue ? "ok" : "error",
								upstreamStatus: selectedResponse.status,
								errorCode: usageValue ? null : "usage_parse_timeout",
								errorMessage: usageValue ? null : timeoutMessage,
								failureStage: "usage_finalize",
								failureReason: usageValue ? null : "usage_parse_timeout",
								usageSource: usageValue
									? selectedImmediateUsage
										? "header"
										: "sse"
									: "none",
							});
						return;
						}
						if (!usageValue) {
							const streamUsageMissingCode = selectedHasUsageHeaders
								? "usage_missing.stream.header_signal_unparseable"
								: "usage_missing.stream.signal_absent";
							const streamUsageMissingMessage = `usage_missing: ${streamUsageMissingCode}`;
							finalizeUsage({
								channelId: selectedChannel.id,
								requestPath: selectedRequestPath,
								latencyMs: selectedLatencyMs,
								firstTokenLatencyMs: streamUsage.firstTokenLatencyMs,
								usage: null,
								status: "error",
								upstreamStatus: selectedResponse.status,
								errorCode: streamUsageMissingCode,
								errorMessage: streamUsageMissingMessage,
								failureStage: "usage_finalize",
								failureReason: streamUsageMissingCode,
								usageSource: "none",
							});
							return;
						}
						finalizeUsage({
							channelId: selectedChannel.id,
							requestPath: selectedRequestPath,
							latencyMs: selectedLatencyMs,
							firstTokenLatencyMs: streamUsage.firstTokenLatencyMs,
							usage: usageValue,
							status: "ok",
							upstreamStatus: selectedResponse.status,
							failureStage: "usage_finalize",
							usageSource: selectedImmediateUsage ? "header" : "sse",
						});
				})
				.catch((error) => {
					const parseFailure = classifyStreamUsageParseError(
						error,
						usageErrorMessageMaxLength,
					);
					scheduleRuntimeEvent(
						"warning",
						"usage_stream_parse_failed",
						"usage_stream_parse_failed",
						{
							path: selectedRequestPath,
							error_code: parseFailure.errorCode,
							error_message: parseFailure.errorMessage,
						},
					);
					finalizeUsage({
						channelId: selectedChannel.id,
						requestPath: selectedRequestPath,
						latencyMs: selectedLatencyMs,
						firstTokenLatencyMs: null,
						usage: selectedImmediateUsage,
						status: selectedImmediateUsage ? "ok" : "error",
						upstreamStatus: selectedResponse.status,
						errorCode: selectedImmediateUsage ? null : parseFailure.errorCode,
						errorMessage: selectedImmediateUsage
							? null
							: parseFailure.errorMessage,
						failureStage: "usage_finalize",
						failureReason: selectedImmediateUsage
							? null
							: parseFailure.errorCode,
						usageSource: selectedImmediateUsage ? "header" : "none",
					});
				})
				.finally(() => {
					activeStreamUsageParsers = Math.max(0, activeStreamUsageParsers - 1);
				});
			if (executionCtx?.waitUntil) {
				executionCtx.waitUntil(task);
			} else {
				task.catch(() => undefined);
			}
		}
	}

	if (
		canResolveResponsesAffinity &&
		selectedChannel &&
		downstreamProvider === "openai" &&
		endpointType === "responses"
	) {
		const task = (async () => {
			const contentType = selectedResponse.headers.get("content-type") ?? "";
			let responseId: string | null = null;
			if (isStream && contentType.includes("text/event-stream")) {
				responseId = await extractOpenAiResponseIdFromSse(selectedResponse.clone());
			} else if (contentType.includes("application/json")) {
				const payload = await selectedResponse
					.clone()
					.json()
					.catch(() => null);
				responseId = extractOpenAiResponseIdFromJson(payload);
			}
			if (!responseId) {
				return;
			}
			const affinity: ResponsesAffinityRecord = {
				channelId: selectedChannel.id,
				tokenId: tokenRecord.id,
				model: downstreamModel,
				updatedAt: new Date().toISOString(),
			};
			await writeHotJson(
				c.env.KV_HOT,
				buildResponsesAffinityKey(responseId),
				affinity,
				responsesAffinityTtlSeconds,
			);
		})();
		scheduleDbWrite(c, task);
	}

	if (
		selectedUpstreamProvider &&
		selectedUpstreamEndpoint &&
		(endpointType === "chat" || endpointType === "responses")
	) {
		const transformed = await adaptChatResponse({
			response: selectedResponse,
			upstreamProvider: selectedUpstreamProvider,
			downstreamProvider,
			upstreamEndpoint: selectedUpstreamEndpoint,
			downstreamEndpoint: endpointType,
			model: selectedUpstreamModel ?? downstreamModel,
			isStream,
		});
		if (transformed !== selectedResponse) {
			return withTraceHeader(transformed);
		}
	}

	return withTraceHeader(selectedResponse);
});

export default proxy;
