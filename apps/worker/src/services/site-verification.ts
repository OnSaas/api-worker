import type { D1Database } from "@cloudflare/workers-types";
import { safeJsonParse } from "../utils/json";
import { nowIso } from "../utils/time";
import { normalizeBaseUrl } from "../utils/url";
import { updateCallTokenModels } from "./channel-call-token-repo";
import { extractModelIds, modelsToJson } from "./channel-models";
import { parseChannelMetadata, resolveProvider } from "./channel-metadata";
import { collectVerifiedTokenModelUpdates } from "./site-verification-token-models";
import {
	type ChannelTokenTestItem,
	updateChannelTestResult,
	testChannelTokens,
} from "./channel-testing";
import type { ChannelRow } from "./channel-types";
import {
	buildUpstreamChatRequest,
	normalizeChatRequest,
	type ProviderType,
} from "./provider-transform";
import type { SiteType } from "./site-metadata";

export type VerificationStageStatus = "pass" | "warn" | "fail" | "skip";

export type VerificationVerdict =
	| "serving"
	| "degraded"
	| "failed"
	| "recoverable"
	| "not_recoverable";

export type VerificationMode = "service" | "recovery";

export type VerificationSuggestedAction =
	| "none"
	| "retry"
	| "fix_credentials"
	| "fix_endpoint"
	| "fix_model_config"
	| "manual_review";

export type VerificationStageResult = {
	status: VerificationStageStatus;
	code: string;
	message: string;
};

export type VerificationToken = {
	id?: string;
	name?: string;
	api_key: string;
	models_json?: string | null;
};

export type StoredVerificationSummary = {
	verdict: VerificationVerdict;
	message: string;
	checked_at: string;
	suggested_action: VerificationSuggestedAction;
	selected_model?: string | null;
	stage_codes?: Record<string, string>;
};

export type SiteVerificationResult = {
	site_id: string;
	site_name: string;
	mode: VerificationMode;
	verdict: VerificationVerdict;
	message: string;
	suggested_action: VerificationSuggestedAction;
	stages: {
		connectivity: VerificationStageResult;
		capability: VerificationStageResult;
		service: VerificationStageResult;
		recovery: VerificationStageResult;
	};
	selected_model: string | null;
	selected_token: {
		id?: string;
		name?: string;
	} | null;
	discovered_models: string[];
	token_results: ChannelTokenTestItem[];
	token_summary: {
		total: number;
		success: number;
		failed: number;
	} | null;
	trace: {
		latency_ms?: number;
		upstream_status?: number;
		detail_code?: string;
		detail_message?: string;
	};
	checked_at: string;
};

type SiteVerificationBatchSummary = {
	total: number;
	serving: number;
	degraded: number;
	failed: number;
	recoverable: number;
	not_recoverable: number;
	skipped: number;
};

export type SiteVerificationBatchResult = {
	summary: SiteVerificationBatchSummary;
	items: SiteVerificationResult[];
	runs_at: string;
};

type VerificationMetadataShape = {
	verification?: StoredVerificationSummary | null;
};

const MINIMAL_PROBE_PROMPT = "Reply with OK.";
const MINIMAL_PROBE_MAX_TOKENS = 8;

const openAiCompatibleSiteTypes = new Set<SiteType>([
	"new-api",
	"done-hub",
	"subapi",
	"openai",
]);

const defaultConnectivityResult = (): VerificationStageResult => ({
	status: "skip",
	code: "not_started",
	message: "尚未执行连接验证",
});

const defaultCapabilityResult = (): VerificationStageResult => ({
	status: "skip",
	code: "not_started",
	message: "尚未执行能力验证",
});

const defaultServiceResult = (): VerificationStageResult => ({
	status: "skip",
	code: "not_started",
	message: "尚未执行服务验证",
});

const defaultRecoveryResult = (
	channelStatus: string,
): VerificationStageResult => ({
	status: "skip",
	code: channelStatus === "disabled" ? "pending" : "not_disabled",
	message:
		channelStatus === "disabled"
			? "待服务验证完成后评估恢复"
			: "当前站点未被禁用",
});

function extractVerificationSummary(
	raw: string | null | undefined,
): StoredVerificationSummary | null {
	const parsed = safeJsonParse<VerificationMetadataShape>(raw, {});
	if (!parsed.verification || typeof parsed.verification !== "object") {
		return null;
	}
	const summary = parsed.verification as StoredVerificationSummary;
	if (
		typeof summary.verdict !== "string" ||
		typeof summary.message !== "string" ||
		typeof summary.checked_at !== "string" ||
		typeof summary.suggested_action !== "string"
	) {
		return null;
	}
	return summary;
}

export function parseSiteVerificationSummary(
	raw: string | null | undefined,
): StoredVerificationSummary | null {
	return extractVerificationSummary(raw);
}

function withVerificationSummary(
	raw: string | null | undefined,
	summary: StoredVerificationSummary,
): string {
	const parsed = safeJsonParse<Record<string, unknown>>(raw, {});
	return JSON.stringify({
		...parsed,
		verification: summary,
	});
}

function buildSummarySnapshot(
	result: SiteVerificationResult,
): StoredVerificationSummary {
	return {
		verdict: result.verdict,
		message: result.message,
		checked_at: result.checked_at,
		suggested_action: result.suggested_action,
		selected_model: result.selected_model,
		stage_codes: {
			connectivity: result.stages.connectivity.code,
			capability: result.stages.capability.code,
			service: result.stages.service.code,
			recovery: result.stages.recovery.code,
		},
	};
}

function normalizeTokenModels(raw?: string | null): string[] {
	const parsed = safeJsonParse<string[] | null>(raw ?? null, null);
	if (!Array.isArray(parsed)) {
		return [];
	}
	return parsed
		.map((item) => String(item ?? "").trim())
		.filter((item) => item.length > 0);
}

function selectTokenForModel(
	tokens: VerificationToken[],
	model: string | null,
): VerificationToken | null {
	if (tokens.length === 0) {
		return null;
	}
	if (!model) {
		return tokens[0] ?? null;
	}
	const matched = tokens.find((token) =>
		normalizeTokenModels(token.models_json).includes(model),
	);
	return matched ?? tokens[0] ?? null;
}

function applyQueryOverrides(
	path: string,
	overrides: Record<string, string>,
): string {
	const [basePath, rawQuery] = path.split("?");
	const params = new URLSearchParams(rawQuery ?? "");
	for (const [key, value] of Object.entries(overrides)) {
		params.set(key, value);
	}
	const query = params.toString();
	return query ? `${basePath}?${query}` : basePath;
}

function buildVerificationHeaders(
	provider: ProviderType,
	apiKey: string,
	overrides: Record<string, string>,
): Headers {
	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	if (provider === "openai") {
		headers.set("Authorization", `Bearer ${apiKey}`);
		headers.set("x-api-key", apiKey);
	} else if (provider === "anthropic") {
		headers.set("x-api-key", apiKey);
		headers.set("anthropic-version", "2023-06-01");
	} else {
		headers.set("x-goog-api-key", apiKey);
	}
	for (const [key, value] of Object.entries(overrides)) {
		headers.set(key, value);
	}
	return headers;
}

function collectCandidateModels(options: {
	channel: ChannelRow;
	tokens: VerificationToken[];
	discoveredModels: string[];
	mappedDefaultModel: string | null;
}): { model: string | null; source: string; all: string[] } {
	const storedVerification = extractVerificationSummary(
		options.channel.metadata_json,
	);
	const candidates = new Set<string>();
	const lastVerified = String(storedVerification?.selected_model ?? "").trim();
	if (lastVerified) {
		candidates.add(lastVerified);
	}
	if (options.mappedDefaultModel) {
		candidates.add(options.mappedDefaultModel);
	}
	for (const model of options.discoveredModels) {
		candidates.add(model);
	}
	for (const model of extractModelIds(options.channel)) {
		candidates.add(model);
	}
	for (const token of options.tokens) {
		for (const model of normalizeTokenModels(token.models_json)) {
			candidates.add(model);
		}
	}
	const all = Array.from(candidates);
	if (lastVerified) {
		return { model: lastVerified, source: "last_verified_model", all };
	}
	if (options.mappedDefaultModel) {
		return {
			model: options.mappedDefaultModel,
			source: "model_mapping_default",
			all,
		};
	}
	if (options.discoveredModels[0]) {
		return {
			model: options.discoveredModels[0],
			source: "discovered_models",
			all,
		};
	}
	if (all[0]) {
		return { model: all[0], source: "configured_models", all };
	}
	return { model: null, source: "missing_model", all };
}

function deriveSuggestedAction(
	stages: SiteVerificationResult["stages"],
): VerificationSuggestedAction {
	if (stages.connectivity.code === "auth_failed") {
		return "fix_credentials";
	}
	if (
		stages.connectivity.code === "network_error" ||
		stages.service.code === "network_error"
	) {
		return "retry";
	}
	if (
		stages.service.code === "endpoint_not_supported" ||
		stages.service.code === "service_request_build_failed"
	) {
		return "fix_endpoint";
	}
	if (stages.capability.code === "no_verification_model") {
		return "fix_model_config";
	}
	if (stages.recovery.status === "fail" || stages.service.status === "fail") {
		return "manual_review";
	}
	return "none";
}

function summarizeVerdict(
	channelStatus: string,
	stages: SiteVerificationResult["stages"],
): { verdict: VerificationVerdict; message: string } {
	if (stages.service.status === "pass") {
		if (channelStatus === "disabled") {
			return {
				verdict: "recoverable",
				message: "站点已通过真实服务验证，可恢复启用。",
			};
		}
		if (stages.capability.status === "warn") {
			return {
				verdict: "degraded",
				message: "站点当前可服务，但能力发现存在告警。",
			};
		}
		return {
			verdict: "serving",
			message: "站点已通过连接、能力与服务验证。",
		};
	}
	if (channelStatus === "disabled") {
		return {
			verdict: "not_recoverable",
			message: "站点当前仍未满足恢复条件。",
		};
	}
	return {
		verdict: "failed",
		message: "站点未通过服务验证，当前不建议承接流量。",
	};
}

function supportsModelDiscovery(siteType: SiteType): boolean {
	return openAiCompatibleSiteTypes.has(siteType);
}

export async function verifySiteChannel(options: {
	channel: ChannelRow;
	tokens: VerificationToken[];
	mode?: VerificationMode;
	fetcher?: typeof fetch;
}): Promise<SiteVerificationResult> {
	const fetcher = options.fetcher ?? fetch;
	const channel = options.channel;
	const metadata = parseChannelMetadata(channel.metadata_json);
	const provider = resolveProvider(metadata.site_type);
	const mode = options.mode ?? "service";
	const tokens = options.tokens.filter(
		(token) => token.api_key.trim().length > 0,
	);
	const checkedAt = nowIso();
	const connectivity = defaultConnectivityResult();
	const capability = defaultCapabilityResult();
	const service = defaultServiceResult();
	const recovery = defaultRecoveryResult(channel.status);
	let discoveredModels: string[] = [];
	let tokenResults: ChannelTokenTestItem[] = [];
	let selectedModel: string | null = null;
	let selectedToken: VerificationToken | null = null;
	let tokenSummary: SiteVerificationResult["token_summary"] = null;
	let trace: SiteVerificationResult["trace"] = {};

	if (tokens.length === 0) {
		connectivity.status = "fail";
		connectivity.code = "missing_token";
		connectivity.message = "未找到可用的调用令牌。";
		capability.status = "fail";
		capability.code = "missing_token";
		capability.message = "缺少调用令牌，无法选择验证模型。";
		service.status = "fail";
		service.code = "missing_token";
		service.message = "缺少调用令牌，无法执行真实服务验证。";
		if (channel.status === "disabled") {
			recovery.status = "fail";
			recovery.code = "missing_token";
			recovery.message = "缺少调用令牌，不能评估恢复。";
		}
		const provisional: SiteVerificationResult = {
			site_id: channel.id,
			site_name: channel.name,
			mode,
			verdict: "failed",
			message: "站点缺少调用令牌，无法执行验证。",
			suggested_action: "fix_credentials" as VerificationSuggestedAction,
			stages: { connectivity, capability, service, recovery },
			selected_model: null,
			selected_token: null,
			discovered_models: [],
			token_results: [],
			token_summary: null,
			trace,
			checked_at: checkedAt,
		};
		if (channel.status === "disabled") {
			provisional.verdict = "not_recoverable";
			provisional.message = "站点缺少调用令牌，当前不能恢复。";
		}
		return provisional;
	}

	if (supportsModelDiscovery(metadata.site_type)) {
		const summary = await testChannelTokens(channel.base_url, tokens);
		tokenResults = summary.items;
		tokenSummary = {
			total: summary.total,
			success: summary.success,
			failed: summary.failed,
		};
		discoveredModels = summary.models;
		if (summary.ok && summary.models.length > 0) {
			capability.status = "pass";
			capability.code = "models_discovered";
			capability.message = `已发现 ${summary.models.length} 个可验证模型。`;
		} else {
			capability.status = "warn";
			capability.code = "model_discovery_failed";
			capability.message =
				"未能通过模型发现接口获取结果，将回退到已配置模型继续验证。";
		}
	} else {
		capability.status = "warn";
		capability.code = "model_discovery_skipped";
		capability.message =
			"当前站点类型不使用固定模型发现探针，将直接基于已配置模型执行服务验证。";
	}

	const mappedDefaultModel =
		String(metadata.model_mapping["*"] ?? "").trim() || null;
	const modelSelection = collectCandidateModels({
		channel,
		tokens,
		discoveredModels,
		mappedDefaultModel,
	});
	selectedModel = modelSelection.model;
	if (!selectedModel) {
		capability.status = "fail";
		capability.code = "no_verification_model";
		capability.message = "未找到可用于验证的模型，请补充模型配置或模型映射。";
		service.status = "fail";
		service.code = "no_verification_model";
		service.message = "缺少验证模型，无法执行真实服务验证。";
		if (channel.status === "disabled") {
			recovery.status = "fail";
			recovery.code = "no_verification_model";
			recovery.message = "缺少验证模型，当前不能恢复。";
		}
		const summarized = summarizeVerdict(channel.status, {
			connectivity,
			capability,
			service,
			recovery,
		});
		const result: SiteVerificationResult = {
			site_id: channel.id,
			site_name: channel.name,
			mode,
			verdict: summarized.verdict,
			message: summarized.message,
			suggested_action: deriveSuggestedAction({
				connectivity,
				capability,
				service,
				recovery,
			}),
			stages: { connectivity, capability, service, recovery },
			selected_model: null,
			selected_token: null,
			discovered_models: modelSelection.all,
			token_results: tokenResults,
			token_summary: tokenSummary,
			trace,
			checked_at: checkedAt,
		};
		return result;
	}

	if (capability.status !== "pass") {
		capability.status = "warn";
		capability.code =
			capability.code === "not_started"
				? "configured_model_available"
				: capability.code;
		capability.message =
			capability.code === "configured_model_available"
				? `将使用已配置模型 ${selectedModel} 执行服务验证。`
				: `${capability.message} 当前选择模型 ${selectedModel}。`;
	}

	selectedToken = selectTokenForModel(tokens, selectedModel);
	if (!selectedToken) {
		connectivity.status = "fail";
		connectivity.code = "missing_token";
		connectivity.message = "未找到可用于当前模型的调用令牌。";
		service.status = "fail";
		service.code = "missing_token";
		service.message = "未找到可用于当前模型的调用令牌。";
		if (channel.status === "disabled") {
			recovery.status = "fail";
			recovery.code = "missing_token";
			recovery.message = "没有匹配的调用令牌，当前不能恢复。";
		}
		const summarized = summarizeVerdict(channel.status, {
			connectivity,
			capability,
			service,
			recovery,
		});
		return {
			site_id: channel.id,
			site_name: channel.name,
			mode,
			verdict: summarized.verdict,
			message: summarized.message,
			suggested_action: deriveSuggestedAction({
				connectivity,
				capability,
				service,
				recovery,
			}),
			stages: { connectivity, capability, service, recovery },
			selected_model: selectedModel,
			selected_token: null,
			discovered_models: modelSelection.all,
			token_results: tokenResults,
			token_summary: tokenSummary,
			trace,
			checked_at: checkedAt,
		};
	}

	const downstreamBody = {
		model: selectedModel,
		messages: [{ role: "user", content: MINIMAL_PROBE_PROMPT }],
		max_tokens: MINIMAL_PROBE_MAX_TOKENS,
		temperature: 0,
		stream: false,
	};
	const normalized = normalizeChatRequest(
		"openai",
		"chat",
		downstreamBody as unknown as Record<string, unknown>,
		selectedModel,
		false,
	);
	if (!normalized) {
		service.status = "fail";
		service.code = "service_request_build_failed";
		service.message = "无法构造最小服务验证请求。";
		if (channel.status === "disabled") {
			recovery.status = "fail";
			recovery.code = "service_request_build_failed";
			recovery.message = "无法构造恢复验证请求。";
		}
		const summarized = summarizeVerdict(channel.status, {
			connectivity,
			capability,
			service,
			recovery,
		});
		return {
			site_id: channel.id,
			site_name: channel.name,
			mode,
			verdict: summarized.verdict,
			message: summarized.message,
			suggested_action: deriveSuggestedAction({
				connectivity,
				capability,
				service,
				recovery,
			}),
			stages: { connectivity, capability, service, recovery },
			selected_model: selectedModel,
			selected_token: {
				id: selectedToken.id,
				name: selectedToken.name,
			},
			discovered_models: modelSelection.all,
			token_results: tokenResults,
			token_summary: tokenSummary,
			trace,
			checked_at: checkedAt,
		};
	}

	const request = buildUpstreamChatRequest(
		provider,
		normalized,
		selectedModel,
		"chat",
		false,
		metadata.endpoint_overrides,
	);
	if (!request) {
		service.status = "fail";
		service.code = "service_request_build_failed";
		service.message = "当前站点类型暂不支持生成统一验证请求。";
		if (channel.status === "disabled") {
			recovery.status = "fail";
			recovery.code = "service_request_build_failed";
			recovery.message = "当前站点类型暂不支持恢复验证。";
		}
		const summarized = summarizeVerdict(channel.status, {
			connectivity,
			capability,
			service,
			recovery,
		});
		return {
			site_id: channel.id,
			site_name: channel.name,
			mode,
			verdict: summarized.verdict,
			message: summarized.message,
			suggested_action: deriveSuggestedAction({
				connectivity,
				capability,
				service,
				recovery,
			}),
			stages: { connectivity, capability, service, recovery },
			selected_model: selectedModel,
			selected_token: {
				id: selectedToken.id,
				name: selectedToken.name,
			},
			discovered_models: modelSelection.all,
			token_results: tokenResults,
			token_summary: tokenSummary,
			trace,
			checked_at: checkedAt,
		};
	}

	const targetPath = applyQueryOverrides(
		request.path,
		metadata.query_overrides,
	);
	const target = request.absoluteUrl
		? applyQueryOverrides(request.absoluteUrl, metadata.query_overrides)
		: `${normalizeBaseUrl(channel.base_url)}${targetPath}`;
	const headers = buildVerificationHeaders(
		provider,
		selectedToken.api_key,
		metadata.header_overrides,
	);
	const startedAt = Date.now();
	try {
		const response = await fetcher(target, {
			method: "POST",
			headers,
			body: JSON.stringify(request.body),
		});
		trace = {
			latency_ms: Date.now() - startedAt,
			upstream_status: response.status,
			detail_code: response.ok
				? "service_request_succeeded"
				: `upstream_http_${response.status}`,
			detail_message: response.ok
				? "service_request_succeeded"
				: `HTTP ${response.status}`,
		};
		if (response.status === 401 || response.status === 403) {
			connectivity.status = "fail";
			connectivity.code = "auth_failed";
			connectivity.message = "调用令牌校验失败，请检查站点或调用令牌。";
			service.status = "fail";
			service.code = "auth_failed";
			service.message = "真实服务验证被上游鉴权拒绝。";
		} else if (!response.ok) {
			connectivity.status = "pass";
			connectivity.code = "reachable";
			connectivity.message = "站点可达，但服务验证返回错误。";
			service.status = "fail";
			service.code =
				response.status === 404 || response.status === 405
					? "endpoint_not_supported"
					: `upstream_http_${response.status}`;
			service.message =
				response.status === 404 || response.status === 405
					? "上游接口存在，但当前验证端点不受支持。"
					: `真实服务验证失败，HTTP ${response.status}。`;
		} else {
			connectivity.status = "pass";
			connectivity.code = "reachable";
			connectivity.message = "站点地址、鉴权与最小请求链路均可达。";
			service.status = "pass";
			service.code = "service_request_succeeded";
			service.message = "真实服务验证通过，站点当前可被系统正常使用。";
		}
	} catch (error) {
		trace = {
			latency_ms: Date.now() - startedAt,
			detail_code: "network_error",
			detail_message: (error as Error).message || "network_error",
		};
		connectivity.status = "fail";
		connectivity.code = "network_error";
		connectivity.message = "无法连接到站点，请检查地址、网络或 TLS 配置。";
		service.status = "fail";
		service.code = "network_error";
		service.message = "真实服务验证未能连接到上游。";
	}

	if (channel.status === "disabled") {
		if (service.status === "pass") {
			recovery.status = "pass";
			recovery.code = "eligible_for_recovery";
			recovery.message = "站点已满足恢复条件，可恢复启用。";
		} else {
			recovery.status = "fail";
			recovery.code = service.code;
			recovery.message = "站点尚未通过服务验证，当前不能恢复。";
		}
	}

	const summarized = summarizeVerdict(channel.status, {
		connectivity,
		capability,
		service,
		recovery,
	});
	return {
		site_id: channel.id,
		site_name: channel.name,
		mode,
		verdict: summarized.verdict,
		message: summarized.message,
		suggested_action: deriveSuggestedAction({
			connectivity,
			capability,
			service,
			recovery,
		}),
		stages: { connectivity, capability, service, recovery },
		selected_model: selectedModel,
		selected_token: {
			id: selectedToken.id,
			name: selectedToken.name,
		},
		discovered_models: modelSelection.all,
		token_results: tokenResults,
		token_summary: tokenSummary,
		trace,
		checked_at: checkedAt,
	};
}

export async function persistSiteVerificationResult(options: {
	db: D1Database;
	channel: ChannelRow;
	tokens: VerificationToken[];
	result: SiteVerificationResult;
}): Promise<void> {
	const { db, channel, result } = options;
	const metadataJson = withVerificationSummary(
		channel.metadata_json,
		buildSummarySnapshot(result),
	);
	const updatedAt = nowIso();
	await db
		.prepare(
			"UPDATE channels SET metadata_json = ?, updated_at = ? WHERE id = ?",
		)
		.bind(metadataJson, updatedAt, channel.id)
		.run();

	if (result.discovered_models.length > 0) {
		await updateChannelTestResult(db, channel.id, {
			ok: true,
			elapsed: result.trace.latency_ms ?? channel.response_time_ms ?? 0,
			models: result.discovered_models,
			modelsJson: modelsToJson(result.discovered_models),
		});
		for (const tokenResult of collectVerifiedTokenModelUpdates(
			result.token_results,
		)) {
			await updateCallTokenModels(
				db,
				tokenResult.tokenId,
				tokenResult.models,
				updatedAt,
			);
		}
	} else {
		await updateChannelTestResult(db, channel.id, {
			ok: result.stages.service.status === "pass",
			elapsed: result.trace.latency_ms ?? channel.response_time_ms ?? 0,
			models:
				result.stages.service.status === "pass" && result.selected_model
					? [result.selected_model]
					: undefined,
		});
	}
}

export async function buildVerificationBatchResult(
	items: SiteVerificationResult[],
): Promise<SiteVerificationBatchResult> {
	const summary: SiteVerificationBatchSummary = {
		total: items.length,
		serving: 0,
		degraded: 0,
		failed: 0,
		recoverable: 0,
		not_recoverable: 0,
		skipped: 0,
	};
	for (const item of items) {
		if (item.verdict === "serving") {
			summary.serving += 1;
		} else if (item.verdict === "degraded") {
			summary.degraded += 1;
		} else if (item.verdict === "recoverable") {
			summary.recoverable += 1;
		} else if (item.verdict === "not_recoverable") {
			summary.not_recoverable += 1;
		} else {
			summary.failed += 1;
		}
	}
	return {
		summary,
		items,
		runs_at: nowIso(),
	};
}
