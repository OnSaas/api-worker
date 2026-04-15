import { Hono } from "hono";
import {
	detectStreamFlagFromRawJsonRequest,
	extractResponsesRequestHints as extractResponsesRequestHintsShared,
	hasChatToolOutputHint as hasChatToolOutputHintShared,
	hasUnresolvedResponsesFunctionCallOutput as hasUnresolvedResponsesFunctionCallOutputShared,
	isResponsesToolCallNotFoundMessage as isResponsesToolCallNotFoundMessageShared,
	normalizeProxyStreamUsageMode,
	repairOpenAiToolCallChain as repairOpenAiToolCallChainShared,
	resolveLargeRequestOffload,
	resolveStreamMetaPartialReason,
	sanitizeUpstreamRequestHeaders,
	shouldMarkStreamMetaPartial,
	shouldParseFailureStreamUsage,
	shouldParseSuccessStreamUsage,
	shouldTreatMissingUsageAsError,
	validateOpenAiToolCallChain as validateOpenAiToolCallChainShared,
} from "../../../shared-core/src";
import type { AppEnv } from "../../../worker/src/env";
import {
	type TokenRecord,
	tokenAuth,
} from "../../../worker/src/middleware/tokenAuth";
import type { CallTokenItem } from "../../../worker/src/services/call-token-selector";
import { resolveChannelAttemptTarget } from "../../../worker/src/services/channel-attemptability";
import { listCallTokens } from "../../../worker/src/services/channel-call-token-repo";
import {
	listCoolingDownChannelsForModel,
	listVerifiedModelsByChannel,
	recordChannelDisableHit,
} from "../../../worker/src/services/channel-model-capabilities";
import {
	type ChannelRecord,
	createWeightedOrder,
} from "../../../worker/src/services/channels";
import { selectCandidateChannels } from "../../../worker/src/services/channel-routing";
import { adaptChatResponse } from "../../../worker/src/services/chat-response-adapter";
import {
	buildActiveChannelsKey,
	buildCallTokensIndexKey,
	buildResponsesAffinityKey,
	buildStreamOptionsCapabilityKey,
	invalidateSelectionHotCache,
	readHotJson,
	writeHotJson,
} from "../../../worker/src/services/hot-kv";
import { shouldCooldown } from "../../../worker/src/services/model-cooldown";
import {
	buildProxyErrorCodeSet,
	resolveProxyErrorDecision,
	type ProxyErrorAction,
} from "../../../worker/src/services/proxy-error-policy";
import {
	getSuccessfulUsageWarning,
	shouldValidateToolSchemasFromRequestText,
} from "../../../worker/src/services/proxy-request-guards";
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
	type UpstreamRequest,
} from "../../../worker/src/services/provider-transform";
import { getProxyRuntimeSettings } from "../../../worker/src/services/settings";
import {
	processUsageEvent,
	type UsageEvent,
} from "../../../worker/src/services/usage-events";
import { jsonError } from "../../../worker/src/utils/http";
import { safeJsonParse } from "../../../worker/src/utils/json";
import { extractReasoningEffort } from "../../../worker/src/utils/reasoning";
import { normalizeBaseUrl } from "../../../worker/src/utils/url";
import {
	type NormalizedUsage,
	parseUsageFromHeaders,
	parseUsageFromJson,
	parseUsageFromSse,
	type StreamAbnormalSuccess,
	type StreamUsage,
	type StreamUsageMode,
	type StreamUsageOptions,
	StreamUsageParseError,
} from "../../../worker/src/utils/usage";

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

type AbnormalSuccessDetails = {
	errorCode: string;
	errorMessage: string;
	errorMetaJson: string | null;
};

type AttemptFailureDetail = {
	attemptIndex: number;
	channelId: string | null;
	channelName: string | null;
	httpStatus: number | null;
	errorCode: string;
	errorMessage: string;
	latencyMs: number;
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
const DOWNSTREAM_CLIENT_ABORT_ERROR_CODE = "client_disconnected";
const USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE = "usage_zero_completion_tokens";
const ABNORMAL_SUCCESS_RESPONSE_ERROR_CODE = "abnormal_success_response";
const UPSTREAM_STREAM_ERROR_PAYLOAD_CODE = "upstream_stream_error_payload";
const INTERNAL_USAGE_ERROR_MESSAGE_MAX_LENGTH = 320;
const UPSTREAM_ERROR_DETAIL_MAX_LENGTH = 240;
const HOT_KV_ACTIVE_CHANNELS_TTL_SECONDS = 60;
const HOT_KV_CALL_TOKENS_TTL_SECONDS = 60;
const RESPONSES_TOOL_CALL_NOT_FOUND_SNIPPET =
	"no tool call found for function call output";
const STREAM_OPTIONS_UNSUPPORTED_SNIPPET = "unsupported parameter";
const STREAM_OPTIONS_PARAM_NAME = "stream_options";
const ATTEMPT_BINDING_RESPONSE_PATH_HEADER = "x-ha-attempt-response-path";
const ATTEMPT_BINDING_LATENCY_HEADER = "x-ha-attempt-latency-ms";
const ATTEMPT_BINDING_UPSTREAM_REQUEST_ID_HEADER =
	"x-ha-attempt-upstream-request-id";
const ATTEMPT_DISPATCH_ERROR_ACTION_HEADER = "x-ha-dispatch-error-action";
const ATTEMPT_ERROR_CODE_HEADER = "x-ha-attempt-error-code";
const ATTEMPT_STREAM_USAGE_PROCESSED_HEADER =
	"x-ha-attempt-stream-usage-processed";
const ATTEMPT_STREAM_FIRST_TOKEN_LATENCY_HEADER =
	"x-ha-attempt-stream-first-token-latency-ms";
const ATTEMPT_STREAM_META_PARTIAL_HEADER = "x-ha-attempt-stream-meta-partial";
const ATTEMPT_STREAM_META_REASON_HEADER = "x-ha-attempt-stream-meta-reason";
const ATTEMPT_STREAM_EVENTS_SEEN_HEADER = "x-ha-attempt-stream-events-seen";
const ATTEMPT_STREAM_ERROR_CODE_HEADER = "x-ha-attempt-stream-error-code";
const ATTEMPT_STREAM_ERROR_MESSAGE_HEADER = "x-ha-attempt-stream-error-message";
const ATTEMPT_RESPONSE_ID_HEADER = "x-ha-attempt-response-id";
const ATTEMPT_DISPATCH_INDEX_HEADER = "x-ha-dispatch-attempt-index";
const ATTEMPT_DISPATCH_CHANNEL_ID_HEADER = "x-ha-dispatch-channel-id";
const ATTEMPT_DISPATCH_STOP_RETRY_HEADER = "x-ha-dispatch-stop-retry";
const ATTEMPT_BINDING_DISPATCH_ERROR_CODE =
	"attempt_binding_dispatch_unavailable";
const ATTEMPT_BINDING_ATTEMPT_ERROR_CODE = "attempt_binding_call_unavailable";
const HA_TRACE_ID_HEADER = "x-ha-trace-id";
const HA_ATTEMPT_COUNT_HEADER = "x-ha-attempt-count";
const HA_CANDIDATE_COUNT_HEADER = "x-ha-candidate-count";
const HA_PROXY_QUALITY_HEADER = "x-ha-proxy-quality";
const HA_BIZ_STATUS_HEADER = "x-ha-biz-status";
const HA_QUALITY_REASON_HEADER = "x-ha-quality-reason";
const MAX_ATTEMPT_WORKER_INVOCATIONS = 31;
const USAGE_OBSERVE_FAILURE_STAGE = "usage_observe";
const PROXY_INTERNAL_ERROR_CODE = "proxy_internal_error";
const PROVIDER_DETECT_FAILED_CODE = "provider_detect_failed";
const WEIGHTED_ORDER_FAILED_CODE = "weighted_order_failed";
const RESPONSE_ADAPT_FAILED_CODE = "response_adapt_failed";
const STREAM_META_PARTIAL_CODE = "stream_meta_partial";
const STREAM_META_PARTIAL_BIZ_STATUS = "29011";
const NO_ROUTABLE_CHANNELS_ERROR_CODE = "no_routable_channels";

let activeStreamUsageParsers = 0;

proxy.onError((error, c) => {
	const traceId = crypto.randomUUID();
	const errorMessage =
		error instanceof Error && error.message
			? error.message
			: "proxy_unhandled_exception";
	console.error("proxy_unhandled_exception", {
		traceId,
		path: c.req.path,
		message: errorMessage,
	});
	const response = c.json(
		{
			error: PROXY_INTERNAL_ERROR_CODE,
			code: PROXY_INTERNAL_ERROR_CODE,
		},
		502,
	);
	response.headers.set(HA_TRACE_ID_HEADER, traceId);
	response.headers.set(HA_ATTEMPT_COUNT_HEADER, "0");
	response.headers.set(HA_CANDIDATE_COUNT_HEADER, "0");
	return response;
});

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

function normalizeSummaryDetail(value: string, maxLength: number): string {
	void maxLength;
	const normalized = value.trim();
	if (!normalized) {
		return "-";
	}
	return normalized;
}

function redactHeaderValue(key: string, value: string): string {
	const normalizedKey = key.trim().toLowerCase();
	if (
		normalizedKey === "authorization" ||
		normalizedKey === "x-api-key" ||
		normalizedKey === "x-goog-api-key" ||
		normalizedKey === "proxy-authorization"
	) {
		return "[redacted]";
	}
	return value;
}

function snapshotHeaders(headers: Headers): Record<string, string> {
	const entries = Array.from(headers.entries()).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	return Object.fromEntries(
		entries.map(([key, value]) => [key, redactHeaderValue(key, value)]),
	);
}

function extractEmbeddedHttpStatus(text: string): {
	statusLine: string | null;
	statusCode: number | null;
	statusText: string | null;
} {
	const match = text.match(
		/^(HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s+([^\r\n]+))?)/m,
	);
	if (!match) {
		return {
			statusLine: null,
			statusCode: null,
			statusText: null,
		};
	}
	const parsedStatus = Number(match[2] ?? "");
	return {
		statusLine: match[1] ?? null,
		statusCode: Number.isInteger(parsedStatus) ? parsedStatus : null,
		statusText: normalizeStringField(match[3] ?? null),
	};
}

function mergeErrorMetaJson(
	base: string | null | undefined,
	extra: Record<string, unknown>,
): string | null {
	const parsedBase = safeJsonParse<Record<string, unknown> | null>(
		base ?? "",
		null,
	);
	const merged = {
		...(parsedBase ?? {}),
		...extra,
	};
	return stringifyErrorMeta(merged);
}

function buildUpstreamDiagnosticMeta(options: {
	target: string;
	fallbackTarget?: string;
	requestHeaders: Headers;
	response: Response;
}): Record<string, unknown> {
	return {
		upstream_target: options.target,
		upstream_fallback_target: options.fallbackTarget ?? null,
		request_headers: snapshotHeaders(options.requestHeaders),
		response_status_text: normalizeStringField(options.response.statusText),
		response_headers: snapshotHeaders(options.response.headers),
	};
}

function buildAttemptFailureSummary(failures: AttemptFailureDetail[]): {
	statusCounts: Record<string, number>;
	codeCounts: Record<string, number>;
	topReason: string | null;
} {
	const statusCounts: Record<string, number> = {};
	const codeCounts: Record<string, number> = {};
	for (const failure of failures) {
		const statusKey =
			failure.httpStatus === null ? "none" : String(failure.httpStatus);
		statusCounts[statusKey] = (statusCounts[statusKey] ?? 0) + 1;
		codeCounts[failure.errorCode] = (codeCounts[failure.errorCode] ?? 0) + 1;
	}
	let topReason: string | null = null;
	let topCount = -1;
	for (const [code, count] of Object.entries(codeCounts)) {
		if (count > topCount) {
			topReason = code;
			topCount = count;
		}
	}
	return {
		statusCounts,
		codeCounts,
		topReason,
	};
}

function shouldTreatZeroCompletionAsError(options: {
	enabled: boolean;
	endpointType: EndpointType;
	usage: NormalizedUsage | null;
}): boolean {
	if (!options.enabled) {
		return false;
	}
	if (options.endpointType !== "chat" && options.endpointType !== "responses") {
		return false;
	}
	if (!options.usage) {
		return false;
	}
	return options.usage.completionTokens <= 0;
}

function isLikelyHtmlPayload(value: string): boolean {
	return (
		/<!doctype\s+html/i.test(value) ||
		/<html[\s>]/i.test(value) ||
		/<head[\s>]/i.test(value) ||
		/<body[\s>]/i.test(value)
	);
}

function summarizeHtmlErrorPayload(html: string, statusHint: number): string {
	const title = normalizeStringField(
		html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? null,
	);
	const headline = normalizeStringField(
		html.match(/<h1[^>]*>([^<]+)<\/h1>/i)?.[1] ?? null,
	);
	return `upstream_html_error_page: status=${statusHint}, title=${title ?? "-"}, headline=${headline ?? "-"}`;
}

function normalizeStringField(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function extractModelFromRawJsonRequest(rawText: string): string | null {
	if (!rawText) {
		return null;
	}
	const match = rawText.match(/"model"\s*:\s*"((?:\\.|[^"\\])*)"/);
	if (!match || !match[1]) {
		return null;
	}
	try {
		const decoded = JSON.parse(`"${match[1]}"`);
		return normalizeStringField(decoded);
	} catch {
		return normalizeStringField(match[1]);
	}
}

function decodeRawJsonStringLiteral(value: string): string | null {
	try {
		const decoded = JSON.parse(`"${value}"`);
		return normalizeStringField(decoded);
	} catch {
		return normalizeStringField(value);
	}
}

function extractStringFieldFromRawJsonRequest(
	rawText: string,
	fieldName: string,
): string | null {
	if (!rawText) {
		return null;
	}
	const escapedName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const matcher = new RegExp(
		`"${escapedName}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`,
	);
	const match = rawText.match(matcher);
	if (!match || !match[1]) {
		return null;
	}
	return decodeRawJsonStringLiteral(match[1]);
}

function extractResponsesRequestHintsFromRawJsonRequest(
	rawText: string,
): ResponsesRequestHints | null {
	if (!rawText) {
		return null;
	}
	const previousResponseId =
		extractStringFieldFromRawJsonRequest(rawText, "previous_response_id") ??
		extractStringFieldFromRawJsonRequest(rawText, "previousResponseId");
	const hasFunctionCallOutput = /"type"\s*:\s*"function_call_output"/.test(
		rawText,
	);
	if (!previousResponseId && !hasFunctionCallOutput) {
		return null;
	}
	return {
		previousResponseId,
		functionCallOutputIds: [],
		hasFunctionCallOutput,
	};
}

function rewriteModelInRawJsonRequest(
	rawText: string | undefined,
	model: string,
): string | undefined {
	if (!rawText) {
		return rawText;
	}
	const matcher = /"model"\s*:\s*"(?:\\.|[^"\\])*"/;
	if (!matcher.test(rawText)) {
		return rawText;
	}
	return rawText.replace(matcher, `"model":${JSON.stringify(model)}`);
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

function hasChatToolOutputHint(body: Record<string, unknown> | null): boolean {
	if (!body || !Array.isArray(body.messages)) {
		return false;
	}
	for (const message of body.messages) {
		if (!message || typeof message !== "object" || Array.isArray(message)) {
			continue;
		}
		const record = message as Record<string, unknown>;
		const role = normalizeStringField(record.role)?.toLowerCase();
		if (role !== "tool") {
			continue;
		}
		const toolCallId = normalizeStringField(
			record.tool_call_id ??
				record.toolCallId ??
				record.call_id ??
				record.callId,
		);
		if (toolCallId) {
			return true;
		}
	}
	return false;
}

function hasAssistantToolCallHint(
	body: Record<string, unknown> | null,
): boolean {
	if (!body || !Array.isArray(body.messages)) {
		return false;
	}
	for (const message of body.messages) {
		if (!message || typeof message !== "object" || Array.isArray(message)) {
			continue;
		}
		const record = message as Record<string, unknown>;
		const role = normalizeStringField(record.role)?.toLowerCase();
		if (role !== "assistant") {
			continue;
		}
		if (Array.isArray(record.tool_calls) || Array.isArray(record.toolCalls)) {
			return true;
		}
		const functionCall = record.function_call ?? record.functionCall;
		if (
			functionCall &&
			typeof functionCall === "object" &&
			!Array.isArray(functionCall)
		) {
			return true;
		}
	}
	return false;
}

type ToolCallChainRepairReport = {
	patchedAssistantCalls: number;
	droppedToolMessages: number;
	droppedFunctionOutputs: number;
	droppedToolMessageIndexes: number[];
	droppedFunctionOutputIndexes: number[];
};

function emptyToolCallChainRepairReport(): ToolCallChainRepairReport {
	return {
		patchedAssistantCalls: 0,
		droppedToolMessages: 0,
		droppedFunctionOutputs: 0,
		droppedToolMessageIndexes: [],
		droppedFunctionOutputIndexes: [],
	};
}

function collectAssistantToolCallIds(
	message: Record<string, unknown>,
): string[] {
	const ids: string[] = [];
	const toolCalls = Array.isArray(message.tool_calls)
		? message.tool_calls
		: Array.isArray(message.toolCalls)
			? message.toolCalls
			: [];
	for (const call of toolCalls) {
		if (!call || typeof call !== "object" || Array.isArray(call)) {
			continue;
		}
		const record = call as Record<string, unknown>;
		const id = normalizeStringField(
			record.id ?? record.call_id ?? record.callId,
		);
		if (id) {
			ids.push(id);
		}
	}
	const functionCall =
		message.function_call &&
		typeof message.function_call === "object" &&
		!Array.isArray(message.function_call)
			? (message.function_call as Record<string, unknown>)
			: message.functionCall &&
					typeof message.functionCall === "object" &&
					!Array.isArray(message.functionCall)
				? (message.functionCall as Record<string, unknown>)
				: null;
	if (functionCall) {
		const id = normalizeStringField(
			functionCall.id ?? functionCall.call_id ?? functionCall.callId,
		);
		if (id) {
			ids.push(id);
		}
	}
	return ids;
}

function patchNearestAssistantCallId(
	messages: Array<Record<string, unknown>>,
	toolCallId: string,
): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const candidate = messages[index];
		const role = normalizeStringField(candidate.role)?.toLowerCase();
		if (role !== "assistant") {
			continue;
		}
		const toolCalls = Array.isArray(candidate.tool_calls)
			? candidate.tool_calls
			: Array.isArray(candidate.toolCalls)
				? candidate.toolCalls
				: [];
		const missingCalls = toolCalls.filter((call) => {
			if (!call || typeof call !== "object" || Array.isArray(call)) {
				return false;
			}
			const record = call as Record<string, unknown>;
			return !normalizeStringField(
				record.id ?? record.call_id ?? record.callId,
			);
		});
		if (missingCalls.length === 1) {
			const missingRecord = missingCalls[0] as Record<string, unknown>;
			missingRecord.id = toolCallId;
			return true;
		}
		const functionCall =
			candidate.function_call &&
			typeof candidate.function_call === "object" &&
			!Array.isArray(candidate.function_call)
				? (candidate.function_call as Record<string, unknown>)
				: candidate.functionCall &&
						typeof candidate.functionCall === "object" &&
						!Array.isArray(candidate.functionCall)
					? (candidate.functionCall as Record<string, unknown>)
					: null;
		if (functionCall) {
			const hasId = normalizeStringField(
				functionCall.id ?? functionCall.call_id ?? functionCall.callId,
			);
			if (!hasId) {
				functionCall.call_id = toolCallId;
				return true;
			}
		}
	}
	return false;
}

function repairOpenAiChatToolCallChain(
	body: Record<string, unknown> | null,
	report: ToolCallChainRepairReport,
): void {
	if (!body || !Array.isArray(body.messages)) {
		return;
	}
	const repairedMessages: Array<Record<string, unknown>> = [];
	const seenIds = new Set<string>();
	for (let index = 0; index < body.messages.length; index += 1) {
		const rawMessage = body.messages[index];
		if (
			!rawMessage ||
			typeof rawMessage !== "object" ||
			Array.isArray(rawMessage)
		) {
			continue;
		}
		const message = rawMessage as Record<string, unknown>;
		const role = normalizeStringField(message.role)?.toLowerCase();
		if (role === "assistant") {
			for (const id of collectAssistantToolCallIds(message)) {
				seenIds.add(id);
			}
			repairedMessages.push(message);
			continue;
		}
		if (role !== "tool") {
			repairedMessages.push(message);
			continue;
		}
		const toolCallId = normalizeStringField(
			message.tool_call_id ??
				message.toolCallId ??
				message.call_id ??
				message.callId,
		);
		if (!toolCallId) {
			report.droppedToolMessages += 1;
			report.droppedToolMessageIndexes.push(index);
			continue;
		}
		if (!seenIds.has(toolCallId)) {
			const patched = patchNearestAssistantCallId(repairedMessages, toolCallId);
			if (patched) {
				report.patchedAssistantCalls += 1;
				seenIds.add(toolCallId);
			}
		}
		if (!seenIds.has(toolCallId)) {
			report.droppedToolMessages += 1;
			report.droppedToolMessageIndexes.push(index);
			continue;
		}
		repairedMessages.push(message);
	}
	body.messages = repairedMessages;
}

function repairOpenAiResponsesToolCallChain(
	body: Record<string, unknown> | null,
	report: ToolCallChainRepairReport,
): void {
	if (!body || !Array.isArray(body.input)) {
		return;
	}
	const seenFunctionCallIds = new Set<string>();
	const pendingWithoutId: Array<Record<string, unknown>> = [];
	const repairedInput: Array<unknown> = [];
	for (let index = 0; index < body.input.length; index += 1) {
		const rawItem = body.input[index];
		if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
			repairedInput.push(rawItem);
			continue;
		}
		const item = rawItem as Record<string, unknown>;
		const itemType = normalizeStringField(item.type)?.toLowerCase();
		if (itemType === "function_call") {
			const callId = normalizeStringField(
				item.call_id ?? item.callId ?? item.id,
			);
			if (callId) {
				seenFunctionCallIds.add(callId);
			} else {
				pendingWithoutId.push(item);
			}
			repairedInput.push(item);
			continue;
		}
		if (itemType !== "function_call_output") {
			repairedInput.push(item);
			continue;
		}
		const outputCallId = normalizeStringField(
			item.call_id ?? item.callId ?? item.tool_call_id ?? item.toolCallId,
		);
		if (!outputCallId) {
			report.droppedFunctionOutputs += 1;
			report.droppedFunctionOutputIndexes.push(index);
			continue;
		}
		if (!seenFunctionCallIds.has(outputCallId) && pendingWithoutId.length > 0) {
			const candidate = pendingWithoutId.pop() as Record<string, unknown>;
			candidate.call_id = outputCallId;
			seenFunctionCallIds.add(outputCallId);
			report.patchedAssistantCalls += 1;
		}
		if (!seenFunctionCallIds.has(outputCallId)) {
			report.droppedFunctionOutputs += 1;
			report.droppedFunctionOutputIndexes.push(index);
			continue;
		}
		repairedInput.push(item);
	}
	body.input = repairedInput;
}

function repairOpenAiToolCallChain(
	body: Record<string, unknown> | null,
	endpointType: EndpointType,
): ToolCallChainRepairReport {
	const report = emptyToolCallChainRepairReport();
	if (!body) {
		return report;
	}
	repairOpenAiChatToolCallChain(body, report);
	if (endpointType === "responses") {
		repairOpenAiResponsesToolCallChain(body, report);
	}
	return report;
}

type ToolCallChainValidationIssue = {
	code: "tool_call_chain_invalid_local";
	message: string;
	errorMetaJson: string;
};

function validateOpenAiChatToolCallChain(
	body: Record<string, unknown> | null,
): ToolCallChainValidationIssue | null {
	if (!body || !Array.isArray(body.messages)) {
		return null;
	}
	const seenToolCallIds = new Set<string>();
	const missingRefs: Array<{ id: string; index: number }> = [];
	const missingIdIndexes: number[] = [];
	for (let index = 0; index < body.messages.length; index += 1) {
		const rawMessage = body.messages[index];
		if (
			!rawMessage ||
			typeof rawMessage !== "object" ||
			Array.isArray(rawMessage)
		) {
			continue;
		}
		const message = rawMessage as Record<string, unknown>;
		const role = normalizeStringField(message.role)?.toLowerCase();
		if (role === "assistant") {
			const toolCalls = Array.isArray(message.tool_calls)
				? message.tool_calls
				: Array.isArray(message.toolCalls)
					? message.toolCalls
					: [];
			for (const call of toolCalls) {
				if (!call || typeof call !== "object" || Array.isArray(call)) {
					continue;
				}
				const callRecord = call as Record<string, unknown>;
				const callId = normalizeStringField(
					callRecord.id ?? callRecord.call_id ?? callRecord.callId,
				);
				if (callId) {
					seenToolCallIds.add(callId);
				}
			}
			const legacyFunctionCall =
				(message.function_call &&
				typeof message.function_call === "object" &&
				!Array.isArray(message.function_call)
					? (message.function_call as Record<string, unknown>)
					: null) ??
				(message.functionCall &&
				typeof message.functionCall === "object" &&
				!Array.isArray(message.functionCall)
					? (message.functionCall as Record<string, unknown>)
					: null);
			const legacyCallId = normalizeStringField(
				legacyFunctionCall?.id ??
					legacyFunctionCall?.call_id ??
					legacyFunctionCall?.callId,
			);
			if (legacyCallId) {
				seenToolCallIds.add(legacyCallId);
			}
			continue;
		}
		if (role !== "tool") {
			continue;
		}
		const toolCallId = normalizeStringField(
			message.tool_call_id ?? message.toolCallId ?? message.call_id,
		);
		if (!toolCallId) {
			missingIdIndexes.push(index);
			continue;
		}
		if (!seenToolCallIds.has(toolCallId)) {
			missingRefs.push({ id: toolCallId, index });
		}
	}
	if (missingRefs.length === 0 && missingIdIndexes.length === 0) {
		return null;
	}
	const missingIds = Array.from(new Set(missingRefs.map((item) => item.id)));
	const message = [
		"tool_call_chain_invalid_local: chat_messages contain tool output without matching assistant tool_calls",
		`missing_ids=${missingIds.length > 0 ? missingIds.join(",") : "-"}`,
		`missing_id_message_indexes=${missingIdIndexes.length > 0 ? missingIdIndexes.join(",") : "-"}`,
		`unmatched_message_indexes=${missingRefs.length > 0 ? missingRefs.map((item) => item.index).join(",") : "-"}`,
	].join(", ");
	return {
		code: "tool_call_chain_invalid_local",
		message,
		errorMetaJson: JSON.stringify({
			type: "local_validation",
			source: "chat_messages",
			status: 409,
			missing_ids: missingIds,
			missing_id_message_indexes: missingIdIndexes,
			unmatched_message_indexes: missingRefs.map((item) => item.index),
		}),
	};
}

function validateOpenAiResponsesToolCallChain(
	body: Record<string, unknown> | null,
	previousResponseId: string | null,
): ToolCallChainValidationIssue | null {
	if (!body || previousResponseId) {
		return null;
	}
	const rawInput = body.input;
	const inputItems = Array.isArray(rawInput)
		? rawInput
		: rawInput
			? [rawInput]
			: [];
	if (inputItems.length === 0) {
		return null;
	}
	const seenFunctionCallIds = new Set<string>();
	const missingOutputs: Array<{ id: string; index: number }> = [];
	for (let index = 0; index < inputItems.length; index += 1) {
		const rawItem = inputItems[index];
		if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
			continue;
		}
		const item = rawItem as Record<string, unknown>;
		const itemType = normalizeStringField(item.type)?.toLowerCase();
		if (itemType === "function_call") {
			const callId = normalizeStringField(item.call_id ?? item.id);
			const callIdAlt = normalizeStringField(item.callId);
			if (callId) {
				seenFunctionCallIds.add(callId);
			}
			if (callIdAlt) {
				seenFunctionCallIds.add(callIdAlt);
			}
			continue;
		}
		if (itemType !== "function_call_output") {
			continue;
		}
		const outputCallId = normalizeStringField(
			item.call_id ?? item.callId ?? item.tool_call_id ?? item.toolCallId,
		);
		if (!outputCallId || seenFunctionCallIds.has(outputCallId)) {
			continue;
		}
		missingOutputs.push({ id: outputCallId, index });
	}
	if (missingOutputs.length === 0) {
		return null;
	}
	const missingIds = Array.from(new Set(missingOutputs.map((item) => item.id)));
	const message = [
		"tool_call_chain_invalid_local: responses input contains function_call_output without previous_response_id or in-request function_call",
		`missing_ids=${missingIds.join(",")}`,
		`unmatched_item_indexes=${missingOutputs.map((item) => item.index).join(",")}`,
	].join(", ");
	return {
		code: "tool_call_chain_invalid_local",
		message,
		errorMetaJson: JSON.stringify({
			type: "local_validation",
			source: "responses_input",
			status: 409,
			missing_ids: missingIds,
			unmatched_item_indexes: missingOutputs.map((item) => item.index),
		}),
	};
}

function validateOpenAiResponsesChatMessageChain(
	body: Record<string, unknown> | null,
	hints: ResponsesRequestHints | null,
): ToolCallChainValidationIssue | null {
	if (!body) {
		return null;
	}
	const hasChatToolOutput = hasChatToolOutputHint(body);
	if (!hasChatToolOutput) {
		return null;
	}
	const hasAssistantCalls = hasAssistantToolCallHint(body);
	if (!hasAssistantCalls) {
		const message =
			"tool_call_chain_invalid_local: responses request contains tool messages but assistant tool_calls are missing in messages";
		return {
			code: "tool_call_chain_invalid_local",
			message,
			errorMetaJson: JSON.stringify({
				type: "local_validation",
				source: "responses_chat_messages",
				status: 409,
				reason: "assistant_tool_calls_missing",
			}),
		};
	}
	if (!hints?.previousResponseId && !hints?.hasFunctionCallOutput) {
		const message =
			"tool_call_chain_invalid_local: responses request carries chat-style tool messages without previous_response_id";
		return {
			code: "tool_call_chain_invalid_local",
			message,
			errorMetaJson: JSON.stringify({
				type: "local_validation",
				source: "responses_chat_messages",
				status: 409,
				reason: "missing_previous_response_id",
			}),
		};
	}
	return null;
}

function validateOpenAiToolCallChain(
	body: Record<string, unknown> | null,
	endpointType: EndpointType,
	hints: ResponsesRequestHints | null,
): ToolCallChainValidationIssue | null {
	const chatIssue = validateOpenAiChatToolCallChain(body);
	if (chatIssue) {
		return chatIssue;
	}
	if (endpointType === "chat") {
		return null;
	}
	if (endpointType === "responses") {
		const responsesChatIssue = validateOpenAiResponsesChatMessageChain(
			body,
			hints,
		);
		if (responsesChatIssue) {
			return responsesChatIssue;
		}
		return validateOpenAiResponsesToolCallChain(
			body,
			hints?.previousResponseId ?? null,
		);
	}
	return null;
}

function hasUnresolvedResponsesFunctionCallOutput(
	body: Record<string, unknown> | null,
	hints: ResponsesRequestHints | null,
): boolean {
	if (!body || !hints?.hasFunctionCallOutput) {
		return false;
	}
	const rawInput = body.input;
	const inputItems = Array.isArray(rawInput)
		? rawInput
		: rawInput
			? [rawInput]
			: [];
	if (inputItems.length === 0) {
		return false;
	}
	const inRequestFunctionCallIds = new Set<string>();
	for (const rawItem of inputItems) {
		if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
			continue;
		}
		const item = rawItem as Record<string, unknown>;
		const itemType = normalizeStringField(item.type)?.toLowerCase();
		if (itemType !== "function_call") {
			continue;
		}
		const callId = normalizeStringField(item.call_id ?? item.callId ?? item.id);
		if (callId) {
			inRequestFunctionCallIds.add(callId);
		}
	}
	for (const outputCallId of hints.functionCallOutputIds) {
		if (!inRequestFunctionCallIds.has(outputCallId)) {
			return true;
		}
	}
	return false;
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
		Object.hasOwn(record, "required") &&
		record.required !== undefined &&
		!Array.isArray(record.required)
	) {
		return `${basePath}.required`;
	}
	if (Object.hasOwn(record, "properties") && record.properties !== undefined) {
		const properties = record.properties;
		if (
			!properties ||
			typeof properties !== "object" ||
			Array.isArray(properties)
		) {
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
	if (Object.hasOwn(record, "items") && record.items !== undefined) {
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
			const nestedPath = validateRequiredArrayInSchema(
				items,
				`${basePath}.items`,
			);
			if (nestedPath) {
				return nestedPath;
			}
		} else if (items !== true && items !== false) {
			return `${basePath}.items`;
		}
	}
	for (const key of ["allOf", "anyOf", "oneOf"] as const) {
		if (Object.hasOwn(record, key) && record[key] !== undefined) {
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
		let parameters: unknown;
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

function formatUsageErrorMessage(
	code: string,
	detail: string | null,
	maxLength: number,
): string {
	void maxLength;
	const normalized = normalizeMessage(detail);
	if (!normalized) {
		return code;
	}
	return `${code}: ${normalized}`;
}

function stringifyErrorMeta(meta: Record<string, unknown>): string | null {
	try {
		return JSON.stringify(meta);
	} catch {
		return null;
	}
}

function classifyStreamUsageParseError(
	error: unknown,
	maxLength: number,
): {
	errorCode: string;
	errorMessage: string;
	errorMetaJson: string | null;
} {
	if (error instanceof StreamUsageParseError) {
		return {
			errorCode: error.code,
			errorMessage: formatUsageErrorMessage(
				error.code,
				error.detail,
				maxLength,
			),
			errorMetaJson: stringifyErrorMeta({
				type: "stream_usage_parse_error",
				code: error.code,
				detail: normalizeMessage(error.detail),
				bytes_read: error.bytesRead,
				events_seen: error.eventsSeen,
				sampled_payload: error.sampledPayload,
				sample_truncated: error.sampleTruncated,
			}),
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
			errorMetaJson: stringifyErrorMeta({
				type: "stream_usage_parse_error",
				code: errorCode,
				detail: normalizeMessage(error.message) ?? error.name,
			}),
		};
	}
	const errorCode = STREAM_USAGE_NON_ERROR_THROWN_CODE;
	return {
		errorCode,
		errorMessage: errorCode,
		errorMetaJson: stringifyErrorMeta({
			type: "stream_usage_parse_error",
			code: errorCode,
		}),
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

function sleep(delayMs: number, signal?: AbortSignal | null): Promise<boolean> {
	const safeDelay = Math.max(0, Math.floor(delayMs));
	if (safeDelay <= 0) {
		return Promise.resolve(!signal?.aborted);
	}
	if (signal?.aborted) {
		return Promise.resolve(false);
	}
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve(true);
		}, safeDelay);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			resolve(false);
		};
		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function buildAttemptSequence(
	candidates: ChannelRecord[],
	maxAttempts: number,
): ChannelRecord[] {
	if (candidates.length === 0 || maxAttempts <= 0) {
		return [];
	}
	const ordered: ChannelRecord[] = [];
	while (ordered.length < maxAttempts) {
		const round = createWeightedOrder(candidates);
		for (const channel of round) {
			ordered.push(channel);
			if (ordered.length >= maxAttempts) {
				break;
			}
		}
	}
	return ordered;
}

function getStreamUsageOptions(settings: {
	stream_usage_mode: string;
	stream_usage_parse_timeout_ms?: number;
}): StreamUsageOptions {
	return {
		mode: normalizeProxyStreamUsageMode(
			settings.stream_usage_mode,
		) as StreamUsageMode,
		timeoutMs: Math.max(
			0,
			Math.floor(Number(settings.stream_usage_parse_timeout_ms ?? 0)),
		),
	};
}

function getStreamUsageMaxParsers(settings: {
	stream_usage_max_parsers: number;
}): number {
	const configuredMaxParsers = Math.max(
		0,
		Math.floor(settings.stream_usage_max_parsers),
	);
	return configuredMaxParsers === 0
		? Number.POSITIVE_INFINITY
		: configuredMaxParsers;
}

function getStreamUsageParseTimeoutMs(settings: {
	stream_usage_parse_timeout_ms: number;
}): number {
	const configuredTimeoutMs = Math.max(
		0,
		Math.floor(settings.stream_usage_parse_timeout_ms),
	);
	return configuredTimeoutMs;
}

function createUsageEventScheduler(c: {
	env: AppEnv["Bindings"];
	executionCtx?: ExecutionContextLike;
}): (event: UsageEvent) => void {
	return (event: UsageEvent) => {
		const task = processUsageEvent(c.env.DB, event)
			.then((result) => {
				if (!result.channelDisabled) {
					return;
				}
				return invalidateSelectionHotCache(c.env.KV_HOT);
			})
			.catch(() => undefined);
		scheduleDbWrite(c, task);
	};
}

function extractJsonErrorPayload(
	payload: Record<string, unknown>,
	status: number,
): {
	errorCode: string | null;
	errorMessage: string | null;
	errorMetaJson: string | null;
} {
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
	const normalizedErrorMessage = normalizeMessage(errorMessage);
	return {
		errorCode,
		errorMessage: `upstream_json_error: status=${status}, code=${errorCode ?? "-"}, message=${
			normalizedErrorMessage
				? normalizeSummaryDetail(
						normalizedErrorMessage,
						UPSTREAM_ERROR_DETAIL_MAX_LENGTH,
					)
				: "-"
		}`,
		errorMetaJson: JSON.stringify({
			type: "json_error",
			param,
			status,
		}),
	};
}

async function detectAbnormalSuccessResponse(
	response: Response,
): Promise<AbnormalSuccessDetails | null> {
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) {
		return null;
	}
	const payload = await response
		.clone()
		.json()
		.catch(() => null);
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return null;
	}
	const record = payload as Record<string, unknown>;
	if (!("error" in record)) {
		return null;
	}
	const details = extractJsonErrorPayload(record, response.status);
	const normalizedCode = normalizeMessage(details.errorCode);
	const finalErrorCode = normalizedCode ?? ABNORMAL_SUCCESS_RESPONSE_ERROR_CODE;
	const finalErrorMessage =
		normalizeMessage(details.errorMessage) ?? finalErrorCode;
	return {
		errorCode: finalErrorCode,
		errorMessage: finalErrorMessage,
		errorMetaJson: details.errorMetaJson,
	};
}

function extractStreamPayloadError(
	payload: Record<string, unknown>,
	context: {
		eventsSeen: number;
		bytesRead: number;
	},
): AbnormalSuccessDetails | null {
	const typeValue =
		typeof payload.type === "string" ? payload.type.trim() : null;
	const normalizedType = typeValue?.toLowerCase() ?? "";
	const nestedError =
		payload.error && typeof payload.error === "object"
			? (payload.error as Record<string, unknown>)
			: null;
	const shouldTreatAsError =
		Boolean(nestedError) ||
		normalizedType === "error" ||
		normalizedType === "response.failed";
	if (!shouldTreatAsError) {
		return null;
	}
	const upstreamCode =
		typeof nestedError?.code === "string"
			? nestedError.code
			: typeof nestedError?.type === "string"
				? nestedError.type
				: typeof payload.code === "string"
					? payload.code
					: null;
	const upstreamMessage =
		typeof nestedError?.message === "string"
			? nestedError.message
			: typeof payload.message === "string"
				? payload.message
				: null;
	const summary = normalizeSummaryDetail(
		normalizeMessage(upstreamMessage) ?? "-",
		UPSTREAM_ERROR_DETAIL_MAX_LENGTH,
	);
	return {
		errorCode: UPSTREAM_STREAM_ERROR_PAYLOAD_CODE,
		errorMessage: `${UPSTREAM_STREAM_ERROR_PAYLOAD_CODE}: status=200, event_type=${
			typeValue ?? "-"
		}, code=${upstreamCode ?? "-"}, message=${summary}`,
		errorMetaJson: stringifyErrorMeta({
			type: "stream_error_payload",
			event_type: typeValue ?? null,
			upstream_code: upstreamCode ?? null,
			upstream_message: normalizeMessage(upstreamMessage),
			events_seen: context.eventsSeen,
			bytes_read: context.bytesRead,
		}),
	};
}

async function detectAbnormalStreamSuccessResponse(
	response: Response,
): Promise<AbnormalSuccessDetails | null> {
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("text/event-stream")) {
		return null;
	}
	const cloned = response.clone();
	if (!cloned.body) {
		return null;
	}
	const reader = cloned.body.getReader();
	const decoder = new TextDecoder();
	const maxProbeEvents = 2;
	const maxProbeBytes = 32 * 1024;
	const probeTimeoutMs = 300;
	let timedOut = false;
	let bytesRead = 0;
	let eventsSeen = 0;
	let buffer = "";
	const probeTimer = setTimeout(() => {
		timedOut = true;
		reader.cancel().catch(() => undefined);
	}, probeTimeoutMs);
	try {
		while (
			!timedOut &&
			eventsSeen < maxProbeEvents &&
			bytesRead < maxProbeBytes
		) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await reader.read();
			} catch {
				break;
			}
			const { done, value } = chunk;
			if (done) {
				break;
			}
			bytesRead += value?.byteLength ?? 0;
			buffer += decoder.decode(value, { stream: true });
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (!line.startsWith("data:")) {
					newlineIndex = buffer.indexOf("\n");
					continue;
				}
				const payloadText = line.slice(5).trim();
				if (!payloadText || payloadText === "[DONE]") {
					newlineIndex = buffer.indexOf("\n");
					continue;
				}
				eventsSeen += 1;
				const payload = safeJsonParse<Record<string, unknown> | null>(
					payloadText,
					null,
				);
				if (payload && typeof payload === "object" && !Array.isArray(payload)) {
					const abnormal = extractStreamPayloadError(payload, {
						eventsSeen,
						bytesRead,
					});
					if (abnormal) {
						return abnormal;
					}
				}
				if (eventsSeen >= maxProbeEvents) {
					break;
				}
				newlineIndex = buffer.indexOf("\n");
			}
		}
		return null;
	} finally {
		clearTimeout(probeTimer);
		reader.cancel().catch(() => undefined);
	}
}

async function extractErrorDetails(response: Response): Promise<{
	errorCode: string | null;
	errorMessage: string | null;
	errorMetaJson: string | null;
}> {
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		const payload = await response
			.clone()
			.json()
			.catch(() => null);
		if (payload && typeof payload === "object") {
			return extractJsonErrorPayload(
				payload as Record<string, unknown>,
				response.status,
			);
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
		return extractJsonErrorPayload(payloadFromText, response.status);
	}
	const normalizedText = normalizeMessage(text);
	if (!normalizedText) {
		return {
			errorCode: null,
			errorMessage: null,
			errorMetaJson: null,
		};
	}
	if (isLikelyHtmlPayload(normalizedText)) {
		return {
			errorCode: null,
			errorMessage: summarizeHtmlErrorPayload(normalizedText, response.status),
			errorMetaJson: stringifyErrorMeta({
				type: "html_error",
				status: response.status,
				status_text: normalizeStringField(response.statusText),
				response_headers: snapshotHeaders(response.headers),
			}),
		};
	}
	const embeddedHttp = extractEmbeddedHttpStatus(normalizedText);
	return {
		errorCode: null,
		errorMessage: `upstream_text_error: status=${response.status}, detail=${normalizeSummaryDetail(normalizedText, UPSTREAM_ERROR_DETAIL_MAX_LENGTH)}`,
		errorMetaJson: stringifyErrorMeta({
			type: "text_error",
			status: response.status,
			status_text: normalizeStringField(response.statusText),
			response_headers: snapshotHeaders(response.headers),
			embedded_http_status_line: embeddedHttp.statusLine,
			embedded_http_status: embeddedHttp.statusCode,
			embedded_http_status_text: embeddedHttp.statusText,
		}),
	};
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

type RoutableChannelSkip = {
	channelId: string;
	channelName: string | null;
	reason: string;
	recordModel: string | null;
	upstreamProvider: ProviderType;
	hasModelList: boolean;
};

function resolveAttemptableChannels(options: {
	channels: ChannelRecord[];
	callTokenMap: Map<string, CallTokenItem[]>;
	downstreamModel: string | null;
	downstreamProvider: ProviderType;
	endpointType: EndpointType;
	verifiedModelsByChannel: Map<string, Set<string>>;
}): {
	channels: ChannelRecord[];
	skipped: RoutableChannelSkip[];
} {
	const routableChannels: ChannelRecord[] = [];
	const skipped: RoutableChannelSkip[] = [];
	for (const channel of options.channels) {
		const target = resolveChannelAttemptTarget({
			channel,
			tokens: options.callTokenMap.get(channel.id) ?? [],
			downstreamModel: options.downstreamModel,
			verifiedModelsByChannel: options.verifiedModelsByChannel,
			endpointType: options.endpointType,
			downstreamProvider: options.downstreamProvider,
		});
		if (target.eligible) {
			routableChannels.push(channel);
			continue;
		}
		skipped.push({
			channelId: channel.id,
			channelName: channel.name ?? null,
			reason: target.reason ?? "unknown",
			recordModel: target.recordModel,
			upstreamProvider: target.upstreamProvider,
			hasModelList: target.tokenSelection.hasModelList,
		});
	}
	return {
		channels: routableChannels,
		skipped,
	};
}

function buildNoRoutableChannelsMeta(skipped: RoutableChannelSkip[]): string {
	const reasonCounts: Record<string, number> = {};
	for (const item of skipped) {
		reasonCounts[item.reason] = (reasonCounts[item.reason] ?? 0) + 1;
	}
	return JSON.stringify({
		type: "channel_attemptability",
		reason_counts: reasonCounts,
		channels: skipped.slice(0, 20).map((item) => ({
			channel_id: item.channelId,
			channel_name: item.channelName,
			reason: item.reason,
			model: item.recordModel,
			upstream_provider: item.upstreamProvider,
			has_model_list: item.hasModelList,
		})),
	});
}

function resolveChannelBaseUrl(channel: ChannelRecord): string {
	return normalizeBaseUrl(channel.base_url);
}

function normalizeIncomingRequestPath(path: string): {
	path: string;
	rewritten: boolean;
} {
	if (!path) {
		return { path, rewritten: false };
	}
	const normalizedV1Beta = path.replace(/^\/v1beta(\/|$)/i, "/v1$1");
	const normalized = normalizedV1Beta.replace(/^\/v1(?:\/v1)+(\/|$)/i, "/v1$1");
	return {
		path: normalized,
		rewritten: normalized !== path,
	};
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
	const headers = sanitizeUpstreamRequestHeaders(baseHeaders);
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

type AttemptBindingRequest = {
	method: string;
	target: string;
	fallbackTarget?: string;
	headers: Array<[string, string]>;
	bodyText?: string;
	timeoutMs: number;
	responsePath: string;
	fallbackPath?: string;
	streamUsage?: StreamUsageOptions;
};

type AttemptDispatchRequest = {
	channelId: string;
	method: string;
	target: string;
	fallbackTarget?: string;
	headers: Array<[string, string]>;
	bodyText?: string;
	timeoutMs: number;
	responsePath: string;
	fallbackPath?: string;
	streamUsage?: StreamUsageOptions;
	streamOptionsInjected?: boolean;
	strippedBodyText?: string;
};

type DispatchRetryConfig = {
	sleepMs: number;
	disableErrorCodes: string[];
	returnErrorCodes: string[];
	sleepErrorCodes: string[];
};

type DispatchBindingRequest = {
	attempts: AttemptDispatchRequest[];
	retryConfig?: DispatchRetryConfig;
	streamUsage?: StreamUsageOptions;
};

type AttemptBindingSuccess = {
	kind: "success";
	response: Response;
	responsePath: string;
	latencyMs: number;
	upstreamRequestId: string | null;
};

type DispatchBindingSuccess = {
	kind: "success";
	response: Response;
	responsePath: string;
	latencyMs: number;
	upstreamRequestId: string | null;
	attemptIndex: number;
	channelId: string | null;
	stopRetry: boolean;
	errorAction: ProxyErrorAction;
};

type AttemptBindingFailure = {
	kind: "binding_error";
	errorCode: string;
	errorMessage: string;
	latencyMs: number;
};

type AttemptBindingAborted = {
	kind: "aborted";
	latencyMs: number;
};

type AttemptWorkerInternalError = {
	kind: "attempt_worker_error";
	errorCode: string;
	errorMessage: string;
	latencyMs: number;
	httpStatus: number;
	errorMetaJson: string | null;
};

type AttemptBindingResult =
	| AttemptBindingSuccess
	| AttemptBindingFailure
	| AttemptBindingAborted
	| AttemptWorkerInternalError;
type DispatchBindingResult =
	| DispatchBindingSuccess
	| AttemptBindingFailure
	| AttemptWorkerInternalError;

type AttemptBindingPolicy = {
	fallbackEnabled: boolean;
	fallbackThreshold: number;
};

type AttemptBindingState = {
	forceLocalDirect: boolean;
	bindingFailureCount: number;
};

async function fetchWithTimeoutLocal(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal | null,
): Promise<Response> {
	if (signal?.aborted) {
		return fetch(url, {
			...init,
			signal,
		});
	}
	if (timeoutMs <= 0) {
		return fetch(url, signal ? { ...init, signal } : init);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		return await fetch(url, {
			...init,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

function parseLatencyHeader(value: string | null): number {
	if (!value) {
		return 0;
	}
	const parsed = Number(value);
	if (Number.isNaN(parsed) || parsed < 0) {
		return 0;
	}
	return Math.floor(parsed);
}

function parseOptionalLatencyHeader(value: string | null): number | null {
	if (!value) {
		return null;
	}
	const parsed = Number(value);
	if (Number.isNaN(parsed) || parsed < 0) {
		return null;
	}
	return Math.floor(parsed);
}

function parseOptionalCountHeader(value: string | null): number | null {
	if (!value) {
		return null;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		return null;
	}
	return parsed;
}

function parseAttemptIndexHeader(value: string | null): number | null {
	if (!value) {
		return null;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		return null;
	}
	return parsed;
}

function parseBooleanHeader(value: string | null): boolean {
	if (!value) {
		return false;
	}
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

function readAttemptStreamAbnormal(
	headers: Headers,
): StreamAbnormalSuccess | null {
	const errorCode = normalizeMessage(
		headers.get(ATTEMPT_STREAM_ERROR_CODE_HEADER),
	);
	if (!errorCode) {
		return null;
	}
	return {
		errorCode,
		errorMessage:
			normalizeMessage(headers.get(ATTEMPT_STREAM_ERROR_MESSAGE_HEADER)) ??
			errorCode,
		errorMetaJson: null,
		eventType: null,
	};
}

function parseErrorActionHeader(value: string | null): ProxyErrorAction {
	const normalized = value?.trim().toLowerCase();
	if (
		normalized === "sleep" ||
		normalized === "disable" ||
		normalized === "return"
	) {
		return normalized;
	}
	return "retry";
}

type HeaderLookup = {
	get: (name: string) => string | null;
};

function normalizeUpstreamRequestIdFromHeaders(
	headers: HeaderLookup,
): string | null {
	const direct = headers.get(ATTEMPT_BINDING_UPSTREAM_REQUEST_ID_HEADER);
	if (direct && direct.trim()) {
		return direct.trim();
	}
	const candidates = [
		"x-request-id",
		"request-id",
		"x-correlation-id",
		"cf-ray",
		"openai-request-id",
	];
	for (const key of candidates) {
		const value = headers.get(key);
		if (value && value.trim()) {
			return value.trim();
		}
	}
	return null;
}

function normalizeAttemptWorkerBaseUrl(
	value: string | null | undefined,
): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	return trimmed.replace(/\/+$/u, "");
}

function registerAttemptWorkerTransportFailure(
	policy: AttemptBindingPolicy,
	state: AttemptBindingState,
): void {
	state.bindingFailureCount += 1;
	if (state.bindingFailureCount >= policy.fallbackThreshold) {
		state.forceLocalDirect = true;
	}
}

async function parseAttemptWorkerErrorResponse(
	response: Response,
	transport: "local_http" | "binding",
	started: number,
): Promise<AttemptWorkerInternalError | null> {
	if (response.ok) {
		return null;
	}
	if (response.headers.get(ATTEMPT_BINDING_RESPONSE_PATH_HEADER)) {
		return null;
	}
	const contentType = response.headers.get("content-type") ?? "";
	let errorCode =
		normalizeStringField(response.headers.get(ATTEMPT_ERROR_CODE_HEADER)) ??
		"attempt_worker_internal_error";
	let errorMessage: string | null = null;
	if (contentType.includes("application/json")) {
		const payload = await response
			.clone()
			.json()
			.catch(() => null);
		if (payload && typeof payload === "object") {
			const record = payload as Record<string, unknown>;
			if (typeof record.code === "string" && record.code.trim()) {
				errorCode = record.code.trim();
			}
			const nestedError =
				record.error && typeof record.error === "object"
					? (record.error as Record<string, unknown>)
					: null;
			errorMessage =
				normalizeStringField(
					typeof nestedError?.message === "string"
						? nestedError.message
						: typeof record.message === "string"
							? record.message
							: null,
				) ?? errorMessage;
			const nestedCode = normalizeStringField(
				typeof nestedError?.code === "string" ? nestedError.code : null,
			);
			if (nestedCode) {
				errorCode = nestedCode;
			}
		}
	}
	if (!errorMessage) {
		errorMessage =
			normalizeMessage(
				await response
					.clone()
					.text()
					.catch(() => ""),
			) ?? errorCode;
	}
	return {
		kind: "attempt_worker_error",
		errorCode,
		errorMessage,
		latencyMs: Math.max(0, Date.now() - started),
		httpStatus: response.status,
		errorMetaJson: JSON.stringify({
			type: "attempt_worker_internal_error",
			transport,
			status: response.status,
		}),
	};
}

async function executeAttemptViaWorker(
	c: { env: AppEnv["Bindings"] },
	input: AttemptBindingRequest,
	policy: AttemptBindingPolicy,
	state: AttemptBindingState,
	signal?: AbortSignal | null,
): Promise<AttemptBindingResult> {
	const started = Date.now();
	const buildAbortedResult = (): AttemptBindingAborted => ({
		kind: "aborted",
		latencyMs: Date.now() - started,
	});
	const executeLocalDirect = async (): Promise<AttemptBindingSuccess> => {
		let response = await fetchWithTimeoutLocal(
			input.target,
			{
				method: input.method,
				headers: new Headers(input.headers),
				body: input.bodyText || undefined,
			},
			input.timeoutMs,
			signal,
		);
		let responsePath = input.responsePath;
		if (
			(response.status === 400 || response.status === 404) &&
			input.fallbackTarget
		) {
			response = await fetchWithTimeoutLocal(
				input.fallbackTarget,
				{
					method: input.method,
					headers: new Headers(input.headers),
					body: input.bodyText || undefined,
				},
				input.timeoutMs,
				signal,
			);
			responsePath = input.fallbackPath ?? input.responsePath;
		}
		return {
			kind: "success",
			response: response as unknown as Response,
			responsePath,
			latencyMs: Date.now() - started,
			upstreamRequestId: normalizeUpstreamRequestIdFromHeaders(
				response.headers,
			),
		};
	};

	const localAttemptWorkerUrl = normalizeAttemptWorkerBaseUrl(
		c.env.LOCAL_ATTEMPT_WORKER_URL,
	);
	const binding = c.env.ATTEMPT_WORKER;
	if (signal?.aborted) {
		return buildAbortedResult();
	}
	if (state.forceLocalDirect || (!localAttemptWorkerUrl && !binding)) {
		try {
			return await executeLocalDirect();
		} catch (error) {
			if (signal?.aborted) {
				return buildAbortedResult();
			}
			throw error;
		}
	}
	try {
		const requestInit: RequestInit = {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify(input),
		};
		const response = localAttemptWorkerUrl
			? await fetchWithTimeoutLocal(
					`${localAttemptWorkerUrl}/internal/attempt`,
					requestInit,
					Math.max(0, input.timeoutMs),
					signal,
				)
			: await binding!.fetch("https://attempt-worker/internal/attempt", {
					method: "POST",
					headers: {
						"content-type": "application/json",
					},
					body: JSON.stringify(input),
					signal: signal as never,
				});
		const attemptWorkerError = await parseAttemptWorkerErrorResponse(
			response as unknown as Response,
			localAttemptWorkerUrl ? "local_http" : "binding",
			started,
		);
		if (attemptWorkerError) {
			if (!policy.fallbackEnabled) {
				return attemptWorkerError;
			}
			registerAttemptWorkerTransportFailure(policy, state);
			return executeLocalDirect();
		}
		const responsePath =
			response.headers.get(ATTEMPT_BINDING_RESPONSE_PATH_HEADER) ??
			input.responsePath;
		const latencyMs = parseLatencyHeader(
			response.headers.get(ATTEMPT_BINDING_LATENCY_HEADER),
		);
		return {
			kind: "success",
			response: response as unknown as Response,
			responsePath,
			latencyMs,
			upstreamRequestId: normalizeUpstreamRequestIdFromHeaders(
				response.headers,
			),
		};
	} catch (error) {
		if (signal?.aborted) {
			return buildAbortedResult();
		}
		const errorMessage = normalizeMessage(
			error instanceof Error ? error.message : String(error),
		);
		if (!policy.fallbackEnabled) {
			return {
				kind: "binding_error",
				errorCode: ATTEMPT_BINDING_ATTEMPT_ERROR_CODE,
				errorMessage:
					errorMessage ?? "attempt worker call failed without fallback",
				latencyMs: Date.now() - started,
			};
		}
		registerAttemptWorkerTransportFailure(policy, state);
		try {
			return await executeLocalDirect();
		} catch (fallbackError) {
			if (signal?.aborted) {
				return buildAbortedResult();
			}
			throw fallbackError;
		}
	}
}

async function executeDispatchViaWorker(
	c: { env: AppEnv["Bindings"] },
	input: DispatchBindingRequest,
	policy: AttemptBindingPolicy,
	state: AttemptBindingState,
	signal?: AbortSignal | null,
): Promise<DispatchBindingResult | null> {
	const started = Date.now();
	const localAttemptWorkerUrl = normalizeAttemptWorkerBaseUrl(
		c.env.LOCAL_ATTEMPT_WORKER_URL,
	);
	const binding = c.env.ATTEMPT_WORKER;
	if (
		state.forceLocalDirect ||
		input.attempts.length === 0 ||
		(!localAttemptWorkerUrl && !binding)
	) {
		return null;
	}
	try {
		const requestInit: RequestInit = {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify(input),
		};
		const response = localAttemptWorkerUrl
			? await fetchWithTimeoutLocal(
					`${localAttemptWorkerUrl}/internal/attempt/dispatch`,
					requestInit,
					0,
					signal,
				)
			: await binding!.fetch(
					"https://attempt-worker/internal/attempt/dispatch",
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
						},
						body: JSON.stringify(input),
						signal: signal as never,
					} as never,
				);
		const attemptWorkerError = await parseAttemptWorkerErrorResponse(
			response as unknown as Response,
			localAttemptWorkerUrl ? "local_http" : "binding",
			started,
		);
		if (attemptWorkerError) {
			if (!policy.fallbackEnabled) {
				return attemptWorkerError;
			}
			registerAttemptWorkerTransportFailure(policy, state);
			return null;
		}
		const firstAttempt = input.attempts[0];
		const fallbackIndex = Math.max(0, input.attempts.length - 1);
		const attemptIndex =
			parseAttemptIndexHeader(
				response.headers.get(ATTEMPT_DISPATCH_INDEX_HEADER),
			) ?? fallbackIndex;
		const selectedAttempt = input.attempts[attemptIndex] ?? firstAttempt;
		const responsePath =
			response.headers.get(ATTEMPT_BINDING_RESPONSE_PATH_HEADER) ??
			selectedAttempt.responsePath;
		const latencyMs = parseLatencyHeader(
			response.headers.get(ATTEMPT_BINDING_LATENCY_HEADER),
		);
		const channelId =
			normalizeStringField(
				response.headers.get(ATTEMPT_DISPATCH_CHANNEL_ID_HEADER),
			) ?? selectedAttempt.channelId;
		return {
			kind: "success",
			response: response as unknown as Response,
			responsePath,
			latencyMs,
			upstreamRequestId: normalizeUpstreamRequestIdFromHeaders(
				response.headers,
			),
			attemptIndex,
			channelId,
			stopRetry: parseBooleanHeader(
				response.headers.get(ATTEMPT_DISPATCH_STOP_RETRY_HEADER),
			),
			errorAction: parseErrorActionHeader(
				response.headers.get(ATTEMPT_DISPATCH_ERROR_ACTION_HEADER),
			),
		};
	} catch (error) {
		if (signal?.aborted) {
			return null;
		}
		const errorMessage = normalizeMessage(
			error instanceof Error ? error.message : String(error),
		);
		if (!policy.fallbackEnabled) {
			return {
				kind: "binding_error",
				errorCode: ATTEMPT_BINDING_DISPATCH_ERROR_CODE,
				errorMessage:
					errorMessage ?? "attempt worker dispatch failed without fallback",
				latencyMs: Date.now() - started,
			};
		}
		registerAttemptWorkerTransportFailure(policy, state);
		return null;
	}
}

/**
 * Multi-provider proxy handler.
 */
proxy.all("/*", tokenAuth, async (c) => {
	const db = c.env.DB;
	const tokenRecord = c.get("tokenRecord") as TokenRecord;
	const requestStart = Date.now();
	const traceId = crypto.randomUUID();
	let responseAttemptCount = 0;
	let responseCandidateCount = 0;
	let responseQuality: "ok" | "stream_meta_partial" = "ok";
	let responseBizStatus: string | null = null;
	let responseQualityReason: string | null = null;
	const markStreamMetaPartial = (options: {
		reason: string;
		path: string;
		eventsSeen: number;
		hasImmediateUsage: boolean;
		hasUsageHeaders: boolean;
	}) => {
		responseQuality = "stream_meta_partial";
		responseBizStatus = STREAM_META_PARTIAL_BIZ_STATUS;
		responseQualityReason = options.reason;
		console.warn("proxy_stream_meta_partial", {
			traceId,
			path: options.path,
			reason: options.reason,
			eventsSeen: options.eventsSeen,
			hasImmediateUsage: options.hasImmediateUsage,
			hasUsageHeaders: options.hasUsageHeaders,
		});
	};
	const withTraceHeader = (response: Response): Response => {
		const headers = new Headers(response.headers);
		headers.set(HA_TRACE_ID_HEADER, traceId);
		headers.set(HA_ATTEMPT_COUNT_HEADER, String(responseAttemptCount));
		headers.set(HA_CANDIDATE_COUNT_HEADER, String(responseCandidateCount));
		if (responseQuality !== "ok") {
			headers.set(HA_PROXY_QUALITY_HEADER, responseQuality);
			if (responseBizStatus) {
				headers.set(HA_BIZ_STATUS_HEADER, responseBizStatus);
			}
			if (responseQualityReason) {
				headers.set(HA_QUALITY_REASON_HEADER, responseQualityReason);
			}
		}
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};
	const jsonErrorWithTrace = (
		status: Parameters<typeof jsonError>[1],
		message: string,
		code?: string,
	): Response => withTraceHeader(jsonError(c, status, message, code));
	const downstreamSignal = c.req.raw.signal;
	const downstreamAbortResponse = (): Response =>
		withTraceHeader(
			new Response(
				JSON.stringify({
					error: DOWNSTREAM_CLIENT_ABORT_ERROR_CODE,
					code: DOWNSTREAM_CLIENT_ABORT_ERROR_CODE,
				}),
				{
					status: 499,
					headers: {
						"content-type": "application/json",
					},
				},
			),
		);
	const runtimeSettings = await getProxyRuntimeSettings(db);
	const retrySleepMs = Math.max(
		0,
		Math.floor(Number(runtimeSettings.retry_sleep_ms ?? 0)),
	);
	const retrySleepErrorCodeSet = buildProxyErrorCodeSet(
		runtimeSettings.retry_sleep_error_codes ?? [],
	);
	const retryReturnErrorCodeSet = buildProxyErrorCodeSet(
		runtimeSettings.retry_return_error_codes ?? [],
	);
	const channelDisableErrorCodeSet = buildProxyErrorCodeSet(
		runtimeSettings.channel_disable_error_codes ?? [],
	);
	const dispatchRetryConfig: DispatchRetryConfig = {
		sleepMs: retrySleepMs,
		disableErrorCodes: Array.from(channelDisableErrorCodeSet),
		returnErrorCodes: Array.from(retryReturnErrorCodeSet),
		sleepErrorCodes: Array.from(retrySleepErrorCodeSet),
	};
	const attemptBindingPolicy: AttemptBindingPolicy = {
		fallbackEnabled: runtimeSettings.attempt_worker_fallback_enabled,
		fallbackThreshold: Math.max(
			1,
			Math.floor(runtimeSettings.attempt_worker_fallback_threshold),
		),
	};
	const attemptBindingState: AttemptBindingState = {
		forceLocalDirect: false,
		bindingFailureCount: 0,
	};
	const attemptWorkerAvailable = Boolean(
		normalizeAttemptWorkerBaseUrl(c.env.LOCAL_ATTEMPT_WORKER_URL) ??
			c.env.ATTEMPT_WORKER,
	);
	const requestPath = normalizeIncomingRequestPath(c.req.path).path;
	let downstreamProvider: ProviderType;
	let endpointType: EndpointType;
	try {
		downstreamProvider = detectDownstreamProvider(requestPath);
		endpointType = detectEndpointType(downstreamProvider, requestPath);
	} catch (error) {
		console.error("proxy_provider_detect_failed", {
			traceId,
			path: requestPath,
			message:
				error instanceof Error ? error.message : "provider_detection_failed",
		});
		return jsonErrorWithTrace(
			502,
			PROVIDER_DETECT_FAILED_CODE,
			PROVIDER_DETECT_FAILED_CODE,
		);
	}
	const offloadThresholdBytes = Math.max(
		0,
		Math.floor(
			Number(runtimeSettings.large_request_offload_threshold_bytes ?? 32768),
		),
	);
	const requestText = await c.req.text();
	const offloadDecision = resolveLargeRequestOffload({
		attemptWorkerAvailable,
		thresholdBytes: offloadThresholdBytes,
		contentLengthHeader: c.req.header("content-length") ?? null,
	});
	const requestSizeBytes = offloadDecision.requestSizeKnown
		? (offloadDecision.requestSizeBytes ?? 0)
		: requestText.length;
	const shouldTryLargeRequestDispatch = offloadDecision.requestSizeKnown
		? offloadDecision.shouldOffload
		: attemptWorkerAvailable &&
			(offloadThresholdBytes === 0 ||
				requestSizeBytes >= offloadThresholdBytes);
	const shouldSkipHeavyBodyParsing = shouldTryLargeRequestDispatch;
	let parsedBodyInitialized = !shouldSkipHeavyBodyParsing;
	let parsedBody =
		parsedBodyInitialized && requestText
			? safeJsonParse<Record<string, unknown> | null>(requestText, null)
			: null;
	if (parsedBodyInitialized && downstreamProvider === "openai") {
		repairOpenAiToolCallChainShared(parsedBody, endpointType);
	}
	let responsesRequestHints =
		parsedBodyInitialized && downstreamProvider === "openai"
			? extractResponsesRequestHintsShared(parsedBody)
			: null;
	if (
		!responsesRequestHints &&
		shouldSkipHeavyBodyParsing &&
		downstreamProvider === "openai" &&
		endpointType === "responses"
	) {
		responsesRequestHints =
			extractResponsesRequestHintsFromRawJsonRequest(requestText);
	}
	let hasChatToolOutput =
		parsedBodyInitialized && downstreamProvider === "openai"
			? hasChatToolOutputHintShared(parsedBody)
			: false;
	let reasoningEffort = extractReasoningEffort(parsedBody);
	let effectiveRequestText = parsedBody
		? JSON.stringify(parsedBody)
		: requestText;
	const ensureParsedBody = (): Record<string, unknown> | null => {
		if (parsedBodyInitialized) {
			return parsedBody;
		}
		parsedBodyInitialized = true;
		parsedBody = requestText
			? safeJsonParse<Record<string, unknown> | null>(requestText, null)
			: null;
		if (downstreamProvider === "openai") {
			repairOpenAiToolCallChainShared(parsedBody, endpointType);
			responsesRequestHints = extractResponsesRequestHintsShared(parsedBody);
			hasChatToolOutput = hasChatToolOutputHintShared(parsedBody);
		}
		reasoningEffort = extractReasoningEffort(parsedBody);
		effectiveRequestText = parsedBody
			? JSON.stringify(parsedBody)
			: requestText;
		return parsedBody;
	};
	const rawRequestModel = extractModelFromRawJsonRequest(requestText);
	const modelProbeBody =
		parsedBody ??
		(rawRequestModel
			? ({ model: rawRequestModel } as Record<string, unknown>)
			: null);
	const parsedDownstreamModel = parseDownstreamModel(
		downstreamProvider,
		requestPath,
		modelProbeBody,
	);
	const downstreamModel = parsedDownstreamModel ?? rawRequestModel;
	const inferredStream =
		shouldSkipHeavyBodyParsing && requestText
			? detectStreamFlagFromRawJsonRequest(requestText)
			: null;
	const isStream =
		inferredStream ??
		parseDownstreamStream(downstreamProvider, requestPath, parsedBody);
	const scheduleUsageEvent = createUsageEventScheduler(c);
	let normalizedChat: NormalizedChatRequest | null = null;
	let normalizedEmbedding: NormalizedEmbeddingRequest | null = null;
	let normalizedImage: NormalizedImageRequest | null = null;
	const ensureNormalizedChat = (): NormalizedChatRequest | null => {
		if (endpointType !== "chat" && endpointType !== "responses") {
			return null;
		}
		if (normalizedChat) {
			return normalizedChat;
		}
		const ensuredBody = ensureParsedBody();
		if (!ensuredBody) {
			return null;
		}
		normalizedChat = normalizeChatRequest(
			downstreamProvider,
			endpointType,
			ensuredBody,
			downstreamModel,
			isStream,
		);
		return normalizedChat;
	};
	const ensureNormalizedEmbedding = (): NormalizedEmbeddingRequest | null => {
		if (endpointType !== "embeddings") {
			return null;
		}
		if (normalizedEmbedding) {
			return normalizedEmbedding;
		}
		const ensuredBody = ensureParsedBody();
		if (!ensuredBody) {
			return null;
		}
		normalizedEmbedding = normalizeEmbeddingRequest(
			downstreamProvider,
			ensuredBody,
			downstreamModel,
		);
		return normalizedEmbedding;
	};
	const ensureNormalizedImage = (): NormalizedImageRequest | null => {
		if (endpointType !== "images") {
			return null;
		}
		if (normalizedImage) {
			return normalizedImage;
		}
		const ensuredBody = ensureParsedBody();
		if (!ensuredBody) {
			return null;
		}
		normalizedImage = normalizeImageRequest(
			downstreamProvider,
			ensuredBody,
			downstreamModel,
		);
		return normalizedImage;
	};

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
				requestPath,
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
		status: "ok" | "warn" | "error";
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
	const recordAttemptLog = (options: {
		attemptIndex: number;
		channelId: string | null;
		provider: ProviderType | null;
		model: string | null;
		status: "ok" | "warn" | "error";
		errorClass?: string | null;
		errorCode?: string | null;
		httpStatus?: number | null;
		latencyMs: number;
		upstreamRequestId?: string | null;
		startedAt: string;
		endedAt: string;
		rawSizeBytes?: number | null;
		rawHash?: string | null;
	}) => {
		if (!runtimeSettings.attempt_log_enabled) {
			return;
		}
		scheduleUsageEvent({
			type: "attempt_log",
			payload: {
				traceId,
				attemptIndex: options.attemptIndex,
				channelId: options.channelId,
				provider: options.provider,
				model: options.model,
				status: options.status,
				errorClass: options.errorClass ?? null,
				errorCode: options.errorCode ?? null,
				httpStatus: options.httpStatus ?? null,
				latencyMs: options.latencyMs,
				upstreamRequestId: options.upstreamRequestId ?? null,
				startedAt: options.startedAt,
				endedAt: options.endedAt,
				rawSizeBytes: options.rawSizeBytes ?? requestSizeBytes,
				rawHash: options.rawHash ?? null,
			},
		});
	};
	const toolSchemaValidationBody = parsedBodyInitialized
		? parsedBody
		: shouldValidateToolSchemasFromRequestText(downstreamProvider, requestText)
			? ensureParsedBody()
			: null;
	if (toolSchemaValidationBody) {
		const toolSchemaIssue = validateToolSchemasInBody(toolSchemaValidationBody);
		if (toolSchemaIssue) {
			recordEarlyUsage({
				status: 400,
				code: toolSchemaIssue.code,
				message: toolSchemaIssue.message,
				failureStage: "request_validation",
				failureReason: toolSchemaIssue.code,
				usageSource: "none",
				errorMetaJson: toolSchemaIssue.errorMetaJson,
			});
			return jsonErrorWithTrace(
				400,
				toolSchemaIssue.message,
				toolSchemaIssue.code,
			);
		}
		if (downstreamProvider === "openai") {
			const toolCallChainIssue = validateOpenAiToolCallChainShared(
				toolSchemaValidationBody,
				endpointType,
				responsesRequestHints,
			);
			if (toolCallChainIssue) {
				recordEarlyUsage({
					status: 409,
					code: toolCallChainIssue.code,
					message: toolCallChainIssue.message,
					failureStage: "request_validation",
					failureReason: toolCallChainIssue.code,
					usageSource: "none",
					errorMetaJson: toolCallChainIssue.errorMetaJson,
				});
				return jsonErrorWithTrace(
					409,
					toolCallChainIssue.code,
					toolCallChainIssue.code,
				);
			}
		}
	}

	const activeChannelsCacheKey = buildActiveChannelsKey();
	let activeChannelRows = await readHotJson<ChannelRecord[]>(
		c.env.KV_HOT,
		activeChannelsCacheKey,
	);
	if (!Array.isArray(activeChannelRows)) {
		const selectionNowSeconds = Math.floor(Date.now() / 1000);
		const activeChannels = await db
			.prepare(
				"SELECT * FROM channels WHERE status = ? AND COALESCE(auto_disabled_permanent, 0) = 0 AND (auto_disabled_until IS NULL OR auto_disabled_until <= ?)",
			)
			.bind("active", selectionNowSeconds)
			.all<ChannelRecord>();
		activeChannelRows = (activeChannels.results ?? []) as ChannelRecord[];
		scheduleDbWrite(
			c,
			writeHotJson(
				c.env.KV_HOT,
				activeChannelsCacheKey,
				activeChannelRows,
				HOT_KV_ACTIVE_CHANNELS_TTL_SECONDS,
			),
		);
	}
	const channelIds = activeChannelRows.map((channel) => channel.id);
	const callTokensCacheKey = buildCallTokensIndexKey();
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
		scheduleDbWrite(
			c,
			writeHotJson(
				c.env.KV_HOT,
				callTokensCacheKey,
				callTokenRows,
				HOT_KV_CALL_TOKENS_TTL_SECONDS,
			),
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
	const verifiedModelsByChannel = downstreamModel
		? await listVerifiedModelsByChannel(
				db,
				allowedChannels.map((channel) => channel.id),
			)
		: new Map<string, Set<string>>();
	const modelCompatibleCandidates = selectCandidateChannels(
		allowedChannels,
		downstreamModel,
		verifiedModelsByChannel,
	);
	const routableCandidates = resolveAttemptableChannels({
		channels: modelCompatibleCandidates,
		callTokenMap,
		downstreamModel,
		downstreamProvider,
		endpointType,
		verifiedModelsByChannel,
	});
	let candidates = routableCandidates.channels;
	const canResolveResponsesAffinity = Boolean(c.env.KV_HOT);
	const hasUnresolvedToolOutput =
		endpointType === "responses"
			? hasUnresolvedResponsesFunctionCallOutputShared(
					parsedBody,
					responsesRequestHints,
				)
			: false;
	const responsesPreviousResponseId =
		responsesRequestHints?.previousResponseId ?? null;
	let responsesPinnedChannelId: string | null = null;
	if (
		canResolveResponsesAffinity &&
		hasUnresolvedToolOutput &&
		!responsesPreviousResponseId
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
	if (canResolveResponsesAffinity && responsesPreviousResponseId) {
		const affinityKey = buildResponsesAffinityKey(responsesPreviousResponseId);
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
	const affinityFallbackEnabled = true;
	if (
		canResolveResponsesAffinity &&
		hasUnresolvedToolOutput &&
		responsesPreviousResponseId &&
		!responsesPinnedChannelId &&
		!affinityFallbackEnabled
	) {
		const code = "responses_affinity_missing";
		recordEarlyUsage({
			status: 409,
			code,
			message: `responses_affinity_missing: previous_response_id=${responsesPreviousResponseId}`,
		});
		return jsonErrorWithTrace(409, code, code);
	}
	const candidatesBeforeAffinity = candidates;
	if (responsesPinnedChannelId) {
		const isActivePinnedChannel = activeChannelRows.some(
			(channel) => channel.id === responsesPinnedChannelId,
		);
		if (!isActivePinnedChannel) {
			if (!affinityFallbackEnabled) {
				const code = "responses_affinity_channel_disabled";
				recordEarlyUsage({
					status: 409,
					code,
					message: `responses_affinity_channel_disabled: previous_response_id=${responsesRequestHints?.previousResponseId ?? "-"}, channel_id=${responsesPinnedChannelId}`,
				});
				return jsonErrorWithTrace(409, code, code);
			}
			responsesPinnedChannelId = null;
		}
		const isAllowedPinnedChannel = responsesPinnedChannelId
			? allowedChannels.some(
					(channel) => channel.id === responsesPinnedChannelId,
				)
			: false;
		if (responsesPinnedChannelId && !isAllowedPinnedChannel) {
			if (!affinityFallbackEnabled) {
				const code = "responses_affinity_channel_not_allowed";
				recordEarlyUsage({
					status: 409,
					code,
					message: `responses_affinity_channel_not_allowed: previous_response_id=${responsesRequestHints?.previousResponseId ?? "-"}, channel_id=${responsesPinnedChannelId}`,
				});
				return jsonErrorWithTrace(409, code, code);
			}
			responsesPinnedChannelId = null;
		}
		if (responsesPinnedChannelId) {
			candidates = candidates.filter(
				(channel) => channel.id === responsesPinnedChannelId,
			);
		}
		if (responsesPinnedChannelId && candidates.length === 0) {
			if (!affinityFallbackEnabled) {
				const code = "responses_affinity_channel_model_unavailable";
				recordEarlyUsage({
					status: 409,
					code,
					message: `responses_affinity_channel_model_unavailable: previous_response_id=${responsesRequestHints?.previousResponseId ?? "-"}, channel_id=${responsesPinnedChannelId}, model=${downstreamModel ?? "-"}`,
				});
				return jsonErrorWithTrace(409, code, code);
			}
			responsesPinnedChannelId = null;
			candidates = candidatesBeforeAffinity;
		}
		if (responsesPinnedChannelId && downstreamModel) {
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
					if (!affinityFallbackEnabled) {
						const code = "responses_affinity_channel_cooldown";
						recordEarlyUsage({
							status: 409,
							code,
							message: `responses_affinity_channel_cooldown: previous_response_id=${responsesRequestHints?.previousResponseId ?? "-"}, channel_id=${responsesPinnedChannelId}, model=${downstreamModel}`,
						});
						return jsonErrorWithTrace(409, code, code);
					}
					responsesPinnedChannelId = null;
					candidates = candidatesBeforeAffinity;
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
	const channelDisableThreshold = Math.max(
		1,
		Math.floor(runtimeSettings.channel_disable_error_threshold),
	);
	const channelDisableDurationSeconds =
		Math.max(
			0,
			Math.floor(runtimeSettings.channel_disable_error_code_minutes),
		) * 60;
	const responsesAffinityTtlSeconds = Math.max(
		60,
		Math.floor(runtimeSettings.responses_affinity_ttl_seconds),
	);
	const streamOptionsCapabilityTtlSeconds = Math.max(
		60,
		Math.floor(runtimeSettings.stream_options_capability_ttl_seconds),
	);
	const streamUsageOptions = getStreamUsageOptions(runtimeSettings);
	const streamUsageMode = streamUsageOptions.mode ?? "lite";
	const streamUsageMaxParsers = getStreamUsageMaxParsers(runtimeSettings);
	const usageErrorMessageMaxLength = INTERNAL_USAGE_ERROR_MESSAGE_MAX_LENGTH;
	const streamUsageParseTimeoutMs =
		getStreamUsageParseTimeoutMs(runtimeSettings);
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
				void cooldownMinutes;
				void cooldownFailureThreshold;
				void coolingChannels;
				recordEarlyUsage({
					status: 503,
					code: "upstream_cooldown",
					message: "upstream_cooldown",
				});
				return jsonErrorWithTrace(
					503,
					"upstream_cooldown",
					"upstream_cooldown",
				);
			}
		}
	}

	if (
		modelCompatibleCandidates.length > 0 &&
		candidates.length === 0 &&
		routableCandidates.skipped.length > 0
	) {
		recordEarlyUsage({
			status: 503,
			code: NO_ROUTABLE_CHANNELS_ERROR_CODE,
			message: NO_ROUTABLE_CHANNELS_ERROR_CODE,
			failureStage: "channel_select",
			failureReason: NO_ROUTABLE_CHANNELS_ERROR_CODE,
			usageSource: "none",
			errorMetaJson: buildNoRoutableChannelsMeta(routableCandidates.skipped),
		});
		return jsonErrorWithTrace(
			503,
			NO_ROUTABLE_CHANNELS_ERROR_CODE,
			NO_ROUTABLE_CHANNELS_ERROR_CODE,
		);
	}

	if (candidates.length === 0) {
		recordEarlyUsage({
			status: 503,
			code: "no_available_channels",
			message: "no_available_channels",
		});
		return jsonErrorWithTrace(
			503,
			"no_available_channels",
			"no_available_channels",
		);
	}
	const targetPath = requestPath;
	const querySuffix = c.req.url.includes("?")
		? `?${c.req.url.split("?")[1]}`
		: "";

	const maxRetries = Math.max(
		0,
		Math.floor(Number(runtimeSettings.retry_max_retries ?? 3)),
	);
	const maxAttempts = Math.min(maxRetries + 1, MAX_ATTEMPT_WORKER_INVOCATIONS);
	let ordered: ChannelRecord[];
	try {
		ordered = buildAttemptSequence(candidates, maxAttempts);
	} catch (error) {
		console.error("proxy_weighted_order_failed", {
			traceId,
			path: requestPath,
			message: error instanceof Error ? error.message : "weighted_order_failed",
		});
		recordEarlyUsage({
			status: 502,
			code: WEIGHTED_ORDER_FAILED_CODE,
			message: WEIGHTED_ORDER_FAILED_CODE,
			failureStage: "channel_select",
			failureReason: WEIGHTED_ORDER_FAILED_CODE,
		});
		return jsonErrorWithTrace(
			502,
			WEIGHTED_ORDER_FAILED_CODE,
			WEIGHTED_ORDER_FAILED_CODE,
		);
	}
	responseCandidateCount = candidates.length;
	const upstreamTimeoutMs = Math.max(
		0,
		Math.floor(Number(runtimeSettings.upstream_timeout_ms ?? 30000)),
	);
	const zeroCompletionAsErrorEnabled =
		runtimeSettings.zero_completion_as_error_enabled !== false;
	const nowSeconds = Math.floor(Date.now() / 1000);
	let selectedResponse: Response | null = null;
	let selectedChannel: ChannelRecord | null = null;
	let selectedUpstreamProvider: ProviderType | null = null;
	let selectedUpstreamEndpoint: EndpointType | null = null;
	let selectedUpstreamModel: string | null = null;
	let selectedRequestPath = targetPath;
	let selectedImmediateUsage: NormalizedUsage | null = null;
	let selectedImmediateUsageSource: "json" | "header" | "none" = "none";
	let selectedParsedStreamUsage: StreamUsage | null = null;
	let selectedHasUsageHeaders = false;
	let selectedAttemptIndex: number | null = null;
	let selectedAttemptStartedAt: string | null = null;
	let selectedAttemptLatencyMs: number | null = null;
	let selectedAttemptUpstreamRequestId: string | null = null;
	let selectedClientDisconnectRecorded = false;
	let lastErrorDetails: ErrorDetails | null = null;
	let attemptsExecuted = 0;
	const blockedChannelIds = new Set<string>();
	const recordSelectedClientDisconnect = () => {
		if (
			selectedClientDisconnectRecorded ||
			!selectedResponse ||
			!selectedChannel
		) {
			return;
		}
		selectedClientDisconnectRecorded = true;
		const latencyMs = Date.now() - requestStart;
		recordAttemptUsage({
			channelId: selectedChannel.id,
			requestPath: selectedRequestPath,
			latencyMs,
			firstTokenLatencyMs: isStream
				? null
				: (selectedAttemptLatencyMs ?? latencyMs),
			usage: selectedImmediateUsage,
			status: "warn",
			upstreamStatus: selectedResponse.status,
			errorCode: DOWNSTREAM_CLIENT_ABORT_ERROR_CODE,
			errorMessage: DOWNSTREAM_CLIENT_ABORT_ERROR_CODE,
			failureStage: "downstream_response",
			failureReason: DOWNSTREAM_CLIENT_ABORT_ERROR_CODE,
			usageSource: selectedImmediateUsageSource,
		});
		if (
			selectedAttemptIndex !== null &&
			selectedAttemptStartedAt &&
			selectedAttemptLatencyMs !== null
		) {
			recordAttemptLog({
				attemptIndex: selectedAttemptIndex,
				channelId: selectedChannel.id,
				provider: selectedUpstreamProvider,
				model: selectedUpstreamModel ?? downstreamModel,
				status: "warn",
				errorClass: "downstream_response",
				errorCode: DOWNSTREAM_CLIENT_ABORT_ERROR_CODE,
				httpStatus: selectedResponse.status,
				latencyMs: selectedAttemptLatencyMs,
				upstreamRequestId: selectedAttemptUpstreamRequestId,
				startedAt: selectedAttemptStartedAt,
				endedAt: new Date().toISOString(),
			});
		}
	};
	const parseStreamUsageOnFailure = async (response: Response) => {
		if (
			!isStream ||
			!shouldParseFailureStreamUsage(streamUsageMode as "full" | "lite" | "off")
		) {
			return {
				usage: null as NormalizedUsage | null,
				usageSource: "none" as const,
			};
		}
		try {
			const streamUsage = await parseUsageFromSse(response.clone(), {
				...streamUsageOptions,
				timeoutMs: streamUsageParseTimeoutMs,
			});
			return {
				usage: streamUsage.usage,
				usageSource: streamUsage.usage
					? ("stream" as const)
					: ("none" as const),
			};
		} catch {
			return {
				usage: null as NormalizedUsage | null,
				usageSource: "none" as const,
			};
		}
	};
	const attemptFailures: AttemptFailureDetail[] = [];
	const appendAttemptFailure = (options: {
		attemptIndex: number;
		channel: ChannelRecord | null;
		httpStatus: number | null;
		errorCode: string;
		errorMessage: string;
		latencyMs: number;
	}) => {
		attemptFailures.push({
			attemptIndex: options.attemptIndex,
			channelId: options.channel?.id ?? null,
			channelName: options.channel?.name ?? null,
			httpStatus: options.httpStatus,
			errorCode: options.errorCode,
			errorMessage: options.errorMessage,
			latencyMs: options.latencyMs,
		});
	};
	const resolveFailureAction = (
		errorCode: string | null,
		errorMessage: string | null,
	): ProxyErrorAction =>
		resolveProxyErrorDecision(
			{
				sleepErrorCodeSet: retrySleepErrorCodeSet,
				disableErrorCodeSet: channelDisableErrorCodeSet,
				returnErrorCodeSet: retryReturnErrorCodeSet,
			},
			errorCode,
			errorMessage,
		).action;
	const resolveFailureWithMeta = (options: {
		errorCode: string | null;
		errorMessage: string | null;
		errorMetaJson?: string | null;
		overrideAction?: ProxyErrorAction | null;
	}): { action: ProxyErrorAction; errorMetaJson: string | null } => {
		const decision = resolveProxyErrorDecision(
			{
				sleepErrorCodeSet: retrySleepErrorCodeSet,
				disableErrorCodeSet: channelDisableErrorCodeSet,
				returnErrorCodeSet: retryReturnErrorCodeSet,
			},
			options.errorCode,
			options.errorMessage,
		);
		const action = options.overrideAction ?? decision.action;
		return {
			action,
			errorMetaJson: mergeErrorMetaJson(options.errorMetaJson, {
				normalized_error_code: decision.normalizedErrorCode,
				policy_action: action,
				policy_resolved_action: decision.action,
				policy_lookup_keys: decision.lookupKeys,
				policy_matched_key: decision.matchedKey,
				policy_matched_set: decision.matchedSet,
				policy_action_source: options.overrideAction ? "override" : "policy",
			}),
		};
	};
	const applyDisableAction = async (options: {
		channelId: string;
		errorCode: string;
	}): Promise<void> => {
		blockedChannelIds.add(options.channelId);
		const normalizedErrorCode = options.errorCode.trim().toLowerCase();
		const disableResult = await recordChannelDisableHit(
			db,
			options.channelId,
			normalizedErrorCode,
			{
				disableDurationSeconds: channelDisableDurationSeconds,
				disableThreshold: channelDisableThreshold,
			},
			nowSeconds,
		);
		if (disableResult.channelTempDisabled || disableResult.channelDisabled) {
			await invalidateSelectionHotCache(c.env.KV_HOT);
		}
	};
	const scheduleModelCooldown = (options: {
		channelId: string;
		model: string | null;
		upstreamStatus: number | null;
		errorCode: string | null;
		errorMessage: string | null;
	}) => {
		const action = resolveFailureAction(
			options.errorCode,
			options.errorMessage,
		);
		if (action !== "retry") {
			return;
		}
		if (!shouldCooldown(options.upstreamStatus, options.errorCode)) {
			return;
		}
		if (!options.model || cooldownSeconds <= 0) {
			return;
		}
		scheduleUsageEvent({
			type: "model_error",
			payload: {
				channelId: options.channelId,
				model: options.model,
				errorCode:
					normalizeMessage(options.errorCode) ??
					(options.upstreamStatus === null
						? ABNORMAL_SUCCESS_RESPONSE_ERROR_CODE
						: String(options.upstreamStatus)),
				cooldownSeconds,
				cooldownFailureThreshold,
				nowSeconds,
			},
		});
	};
	const continueAfterFailure = async (
		attemptNumber: number,
		action: ProxyErrorAction,
	): Promise<boolean> => {
		if (downstreamSignal.aborted) {
			return false;
		}
		if (attemptNumber >= ordered.length) {
			return false;
		}
		if (action === "sleep" && retrySleepMs > 0) {
			const completedSleep = await sleep(retrySleepMs, downstreamSignal);
			if (!completedSleep) {
				return false;
			}
		}
		return !downstreamSignal.aborted;
	};
	const buildDirectErrorResponse = (
		status: number | null,
		errorCode: string,
	): Response => {
		responseAttemptCount = attemptsExecuted;
		const responseStatus = (
			status !== null && status >= 400 ? status : 502
		) as Parameters<typeof jsonError>[1];
		return jsonErrorWithTrace(responseStatus, errorCode, errorCode);
	};
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
		const record = await readHotJson<StreamOptionsCapabilityRecord>(
			c.env.KV_HOT,
			key,
		);
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
		streamOptionsCapabilityMemo.set(
			channelId,
			supported ? "supported" : "unsupported",
		);
		if (!c.env.KV_HOT) {
			return;
		}
		const key = buildStreamOptionsCapabilityKey(channelId);
		const record: StreamOptionsCapabilityRecord = {
			supported,
			updatedAt: new Date().toISOString(),
		};
		scheduleDbWrite(
			c,
			writeHotJson(
				c.env.KV_HOT,
				key,
				record,
				streamOptionsCapabilityTtlSeconds,
			),
		);
	};
	const dispatchAttempts: AttemptDispatchRequest[] = [];
	const dispatchAttemptMeta: Array<{
		channel: ChannelRecord;
		upstreamProvider: ProviderType;
		upstreamModel: string | null;
		recordModel: string | null;
		attemptStartedAt: string;
		streamOptionsHandled: boolean;
		target: string;
		fallbackTarget?: string;
		requestHeaders: Headers;
	}> = [];
	let dispatchHandled = false;
	let dispatchStopRetry = false;
	if (shouldTryLargeRequestDispatch) {
		for (const channel of ordered) {
			const attemptStart = Date.now();
			const attemptStartedAt = new Date(attemptStart).toISOString();
			const attemptTarget = resolveChannelAttemptTarget({
				channel,
				tokens: callTokenMap.get(channel.id) ?? [],
				downstreamModel,
				verifiedModelsByChannel,
				endpointType,
				downstreamProvider,
				selectionKey: `${traceId}:${channel.id}:${downstreamModel ?? "*"}`,
			});
			if (!attemptTarget.eligible) {
				continue;
			}
			const metadata = attemptTarget.metadata;
			const upstreamProvider = attemptTarget.upstreamProvider;
			const upstreamModel = attemptTarget.upstreamModel;
			const recordModel = attemptTarget.recordModel;
			const baseUrl = resolveChannelBaseUrl(channel);
			const apiKey =
				attemptTarget.tokenSelection.token?.api_key ?? channel.api_key;
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
			let upstreamBodyText = effectiveRequestText || undefined;
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
				} else if (upstreamModel) {
					upstreamBodyText = parsedBody
						? JSON.stringify({
								...parsedBody,
								model: upstreamModel,
							})
						: rewriteModelInRawJsonRequest(upstreamBodyText, upstreamModel);
				}
			} else if (sameProvider) {
				if (upstreamProvider === "gemini") {
					upstreamRequestPath = applyGeminiModelToPath(
						upstreamRequestPath,
						upstreamModel,
					);
				} else if (upstreamModel) {
					upstreamBodyText = parsedBody
						? JSON.stringify({
								...parsedBody,
								model: upstreamModel,
							})
						: rewriteModelInRawJsonRequest(upstreamBodyText, upstreamModel);
				}
			} else {
				let built: {
					request: UpstreamRequest;
					bodyText?: string;
				} | null = null;
				if (endpointType === "chat" || endpointType === "responses") {
					const chatPayload = ensureNormalizedChat();
					if (!chatPayload) {
						continue;
					}
					const request = buildUpstreamChatRequest(
						upstreamProvider,
						chatPayload,
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
					const embeddingPayload = ensureNormalizedEmbedding();
					if (!embeddingPayload) {
						continue;
					}
					const request = buildUpstreamEmbeddingRequest(
						upstreamProvider,
						embeddingPayload,
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
					const imagePayload = ensureNormalizedImage();
					if (!imagePayload) {
						continue;
					}
					const request = buildUpstreamImageRequest(
						upstreamProvider,
						imagePayload,
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
				(endpointType === "chat" || endpointType === "responses") &&
				!shouldSkipHeavyBodyParsing;
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
			const fallbackTarget =
				upstreamFallbackPath && !absoluteUrl
					? mergeQuery(
							`${baseUrl}${upstreamFallbackPath}`,
							querySuffix,
							metadata.query_overrides,
						)
					: undefined;
			dispatchAttempts.push({
				channelId: channel.id,
				method: c.req.method,
				target,
				fallbackTarget,
				headers: Array.from(headers.entries()),
				bodyText: upstreamBodyText,
				timeoutMs: upstreamTimeoutMs,
				responsePath: upstreamRequestPath,
				fallbackPath: upstreamFallbackPath,
				streamUsage: streamUsageOptions,
				streamOptionsInjected,
				strippedBodyText: strippedStreamOptionsBodyText,
			});
			dispatchAttemptMeta.push({
				channel,
				upstreamProvider,
				upstreamModel,
				recordModel,
				attemptStartedAt,
				streamOptionsHandled: shouldHandleStreamOptions,
				target,
				fallbackTarget,
				requestHeaders: new Headers(headers),
			});
		}
		if (dispatchAttempts.length > 0) {
			const dispatchResult = await executeDispatchViaWorker(
				c,
				{
					attempts: dispatchAttempts,
					retryConfig: dispatchRetryConfig,
					streamUsage: streamUsageOptions,
				},
				attemptBindingPolicy,
				attemptBindingState,
				downstreamSignal,
			);
			if (downstreamSignal.aborted) {
				return downstreamAbortResponse();
			}
			if (dispatchResult?.kind === "binding_error") {
				recordEarlyUsage({
					status: 503,
					code: dispatchResult.errorCode,
					message: dispatchResult.errorMessage,
					failureStage: "attempt_dispatch",
					failureReason: dispatchResult.errorCode,
					usageSource: "none",
					errorMetaJson: JSON.stringify({
						type: "attempt_worker_binding_error",
						latency_ms: dispatchResult.latencyMs,
					}),
				});
				return jsonErrorWithTrace(
					503,
					dispatchResult.errorCode,
					dispatchResult.errorCode,
				);
			}
			if (dispatchResult?.kind === "attempt_worker_error") {
				recordEarlyUsage({
					status: 503,
					code: dispatchResult.errorCode,
					message: dispatchResult.errorMessage,
					failureStage: "attempt_dispatch_worker",
					failureReason: dispatchResult.errorCode,
					usageSource: "none",
					errorMetaJson:
						dispatchResult.errorMetaJson ??
						JSON.stringify({
							type: "attempt_worker_internal_error",
							http_status: dispatchResult.httpStatus,
							latency_ms: dispatchResult.latencyMs,
						}),
				});
				return jsonErrorWithTrace(
					503,
					dispatchResult.errorCode,
					dispatchResult.errorCode,
				);
			}
			if (dispatchResult?.kind === "success") {
				dispatchHandled = true;
				dispatchStopRetry = dispatchResult.stopRetry;
				const resolvedIndex = Math.min(
					dispatchAttemptMeta.length - 1,
					Math.max(0, dispatchResult.attemptIndex),
				);
				const meta = dispatchAttemptMeta[resolvedIndex];
				if (meta) {
					const attemptNumber = resolvedIndex + 1;
					attemptsExecuted = Math.max(attemptsExecuted, attemptNumber);
					const response = dispatchResult.response;
					const responsePath = dispatchResult.responsePath;
					const attemptLatencyMs = dispatchResult.latencyMs;
					const attemptUpstreamRequestId = dispatchResult.upstreamRequestId;
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
						let immediateUsage = jsonUsage ?? headerUsage;
						const immediateUsageSource = jsonUsage
							? "json"
							: headerUsage
								? "header"
								: "none";
						const streamUsageProcessed = isStream
							? parseBooleanHeader(
									response.headers.get(ATTEMPT_STREAM_USAGE_PROCESSED_HEADER),
								)
							: false;
						let parsedSuccessStreamUsage: StreamUsage | null = null;
						if (isStream) {
							if (streamUsageProcessed) {
								parsedSuccessStreamUsage = {
									usage: headerUsage,
									firstTokenLatencyMs: parseOptionalLatencyHeader(
										response.headers.get(
											ATTEMPT_STREAM_FIRST_TOKEN_LATENCY_HEADER,
										),
									),
									eventsSeen:
										parseOptionalCountHeader(
											response.headers.get(ATTEMPT_STREAM_EVENTS_SEEN_HEADER),
										) ?? 0,
									abnormal: readAttemptStreamAbnormal(response.headers),
								};
								if (parsedSuccessStreamUsage?.usage) {
									immediateUsage = parsedSuccessStreamUsage.usage;
								}
							} else if (
								shouldParseSuccessStreamUsage(
									streamUsageMode as "full" | "lite" | "off",
								)
							) {
								parsedSuccessStreamUsage = await parseUsageFromSse(
									response.clone(),
									{
										...streamUsageOptions,
										timeoutMs: streamUsageParseTimeoutMs,
									},
								).catch(() => null);
								if (parsedSuccessStreamUsage?.usage) {
									immediateUsage = parsedSuccessStreamUsage.usage;
								}
							}
						}
						const abnormalResponse =
							parsedSuccessStreamUsage?.abnormal ??
							(await detectAbnormalSuccessResponse(response)) ??
							(isStream &&
							!parsedSuccessStreamUsage &&
							shouldParseSuccessStreamUsage(
								streamUsageMode as "full" | "lite" | "off",
							)
								? await detectAbnormalStreamSuccessResponse(response)
								: null);
						if (abnormalResponse) {
							const failureDecision = resolveFailureWithMeta({
								errorCode: abnormalResponse.errorCode,
								errorMessage: abnormalResponse.errorMessage,
								errorMetaJson: abnormalResponse.errorMetaJson,
							});
							lastErrorDetails = {
								upstreamStatus: response.status,
								errorCode: abnormalResponse.errorCode,
								errorMessage: abnormalResponse.errorMessage,
								errorMetaJson: failureDecision.errorMetaJson,
							};
							recordAttemptUsage({
								channelId: meta.channel.id,
								requestPath: responsePath,
								latencyMs: attemptLatencyMs,
								firstTokenLatencyMs: isStream ? null : attemptLatencyMs,
								usage: null,
								status: "error",
								upstreamStatus: response.status,
								errorCode: abnormalResponse.errorCode,
								errorMessage: abnormalResponse.errorMessage,
								failureStage: "upstream_response",
								failureReason: abnormalResponse.errorCode,
								usageSource: "none",
								errorMetaJson: failureDecision.errorMetaJson,
							});
							recordAttemptLog({
								attemptIndex: attemptNumber,
								channelId: meta.channel.id,
								provider: meta.upstreamProvider,
								model: meta.upstreamModel ?? downstreamModel,
								status: "error",
								errorClass: "upstream_response",
								errorCode: abnormalResponse.errorCode,
								httpStatus: response.status,
								latencyMs: attemptLatencyMs,
								upstreamRequestId: attemptUpstreamRequestId,
								startedAt: meta.attemptStartedAt,
								endedAt: new Date().toISOString(),
							});
							appendAttemptFailure({
								attemptIndex: attemptNumber,
								channel: meta.channel,
								httpStatus: response.status,
								errorCode: abnormalResponse.errorCode,
								errorMessage: abnormalResponse.errorMessage,
								latencyMs: attemptLatencyMs,
							});
							scheduleModelCooldown({
								channelId: meta.channel.id,
								model: meta.recordModel,
								upstreamStatus: response.status,
								errorCode: abnormalResponse.errorCode,
								errorMessage: abnormalResponse.errorMessage,
							});
							if (downstreamModel && downstreamModel !== meta.recordModel) {
								scheduleModelCooldown({
									channelId: meta.channel.id,
									model: downstreamModel,
									upstreamStatus: response.status,
									errorCode: abnormalResponse.errorCode,
									errorMessage: abnormalResponse.errorMessage,
								});
							}
							const action = failureDecision.action;
							if (action === "return") {
								return buildDirectErrorResponse(
									response.status,
									abnormalResponse.errorCode,
								);
							}
							if (action === "disable") {
								await applyDisableAction({
									channelId: meta.channel.id,
									errorCode: abnormalResponse.errorCode,
								});
							} else if (!(await continueAfterFailure(attemptNumber, action))) {
								dispatchStopRetry = true;
							}
						} else {
							const hasAnyUsageSignal =
								hasUsageHeaderSignal || hasUsageJsonSignal;
							const failOnMissingUsage = shouldTreatMissingUsageAsError({
								isStream,
								bodyParsingSkipped:
									shouldSkipHeavyBodyParsing && !parsedBodyInitialized,
								hasUsageSignal: hasAnyUsageSignal,
							});
							if (!isStream && !immediateUsage && failOnMissingUsage) {
								const usageMissingCode = hasAnyUsageSignal
									? "usage_missing.non_stream.signal_present_unparseable"
									: "usage_missing.non_stream.signal_absent";
								const usageMissingMessage = `usage_missing: ${usageMissingCode}`;
								const failureDecision = resolveFailureWithMeta({
									errorCode: usageMissingCode,
									errorMessage: usageMissingMessage,
								});
								lastErrorDetails = {
									upstreamStatus: response.status,
									errorCode: usageMissingCode,
									errorMessage: usageMissingMessage,
									errorMetaJson: failureDecision.errorMetaJson,
								};
								recordAttemptUsage({
									channelId: meta.channel.id,
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
									errorMetaJson: failureDecision.errorMetaJson,
								});
								recordAttemptLog({
									attemptIndex: attemptNumber,
									channelId: meta.channel.id,
									provider: meta.upstreamProvider,
									model: meta.upstreamModel ?? downstreamModel,
									status: "error",
									errorClass: "usage_finalize",
									errorCode: usageMissingCode,
									httpStatus: response.status,
									latencyMs: attemptLatencyMs,
									upstreamRequestId: attemptUpstreamRequestId,
									startedAt: meta.attemptStartedAt,
									endedAt: new Date().toISOString(),
								});
								appendAttemptFailure({
									attemptIndex: attemptNumber,
									channel: meta.channel,
									httpStatus: response.status,
									errorCode: usageMissingCode,
									errorMessage: usageMissingMessage,
									latencyMs: attemptLatencyMs,
								});
								const action = failureDecision.action;
								if (action === "return") {
									return buildDirectErrorResponse(
										response.status,
										usageMissingCode,
									);
								}
								if (action === "disable") {
									await applyDisableAction({
										channelId: meta.channel.id,
										errorCode: usageMissingCode,
									});
								} else if (
									!(await continueAfterFailure(attemptNumber, action))
								) {
									dispatchStopRetry = true;
								}
							} else if (
								shouldTreatZeroCompletionAsError({
									enabled: zeroCompletionAsErrorEnabled,
									endpointType,
									usage: immediateUsage,
								})
							) {
								const zeroCompletionMessage = `${USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE}: completion_tokens=${immediateUsage?.completionTokens ?? 0}`;
								const failureDecision = resolveFailureWithMeta({
									errorCode: USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE,
									errorMessage: zeroCompletionMessage,
								});
								lastErrorDetails = {
									upstreamStatus: response.status,
									errorCode: USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE,
									errorMessage: zeroCompletionMessage,
									errorMetaJson: failureDecision.errorMetaJson,
								};
								recordAttemptUsage({
									channelId: meta.channel.id,
									requestPath: responsePath,
									latencyMs: attemptLatencyMs,
									firstTokenLatencyMs: attemptLatencyMs,
									usage: immediateUsage,
									status: "error",
									upstreamStatus: response.status,
									errorCode: USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE,
									errorMessage: zeroCompletionMessage,
									failureStage: "usage_finalize",
									failureReason: USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE,
									usageSource: immediateUsageSource,
									errorMetaJson: failureDecision.errorMetaJson,
								});
								recordAttemptLog({
									attemptIndex: attemptNumber,
									channelId: meta.channel.id,
									provider: meta.upstreamProvider,
									model: meta.upstreamModel ?? downstreamModel,
									status: "error",
									errorClass: "usage_finalize",
									errorCode: USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE,
									httpStatus: response.status,
									latencyMs: attemptLatencyMs,
									upstreamRequestId: attemptUpstreamRequestId,
									startedAt: meta.attemptStartedAt,
									endedAt: new Date().toISOString(),
								});
								appendAttemptFailure({
									attemptIndex: attemptNumber,
									channel: meta.channel,
									httpStatus: response.status,
									errorCode: USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE,
									errorMessage: zeroCompletionMessage,
									latencyMs: attemptLatencyMs,
								});
								const action = failureDecision.action;
								if (action === "return") {
									return buildDirectErrorResponse(
										response.status,
										USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE,
									);
								}
								if (action === "disable") {
									await applyDisableAction({
										channelId: meta.channel.id,
										errorCode: USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE,
									});
								} else if (
									!(await continueAfterFailure(attemptNumber, action))
								) {
									dispatchStopRetry = true;
								}
							} else {
								recordAttemptLog({
									attemptIndex: attemptNumber,
									channelId: meta.channel.id,
									provider: meta.upstreamProvider,
									model: meta.upstreamModel ?? downstreamModel,
									status: "ok",
									httpStatus: response.status,
									latencyMs: attemptLatencyMs,
									upstreamRequestId: attemptUpstreamRequestId,
									startedAt: meta.attemptStartedAt,
									endedAt: new Date().toISOString(),
								});
								selectedChannel = meta.channel;
								selectedUpstreamProvider = meta.upstreamProvider;
								try {
									selectedUpstreamEndpoint = detectEndpointType(
										meta.upstreamProvider,
										responsePath,
									);
								} catch {
									selectedUpstreamEndpoint = endpointType;
								}
								selectedUpstreamModel = meta.upstreamModel;
								selectedResponse = response;
								selectedRequestPath = responsePath;
								selectedImmediateUsage = immediateUsage;
								selectedImmediateUsageSource = immediateUsageSource;
								selectedParsedStreamUsage = parsedSuccessStreamUsage;
								selectedHasUsageHeaders = hasUsageHeaderSignal;
								selectedAttemptIndex = attemptNumber;
								selectedAttemptStartedAt = meta.attemptStartedAt;
								selectedAttemptLatencyMs = attemptLatencyMs;
								selectedAttemptUpstreamRequestId = attemptUpstreamRequestId;
								lastErrorDetails = null;
								if (meta.recordModel) {
									scheduleUsageEvent({
										type: "capability_upsert",
										payload: {
											channelId: meta.channel.id,
											models: [meta.recordModel],
											nowSeconds,
										},
									});
								}
							}
						}
					} else {
						const errorInfo = await extractErrorDetails(response);
						const errorMetaJson = mergeErrorMetaJson(
							errorInfo.errorMetaJson,
							buildUpstreamDiagnosticMeta({
								target: meta.target,
								fallbackTarget: meta.fallbackTarget,
								requestHeaders: meta.requestHeaders,
								response,
							}),
						);
						const failureUsage = await parseStreamUsageOnFailure(response);
						const normalizedErrorCode = normalizeUpstreamErrorCode(
							errorInfo.errorCode,
							response.status,
						);
						const normalizedErrorMessage =
							normalizeMessage(errorInfo.errorMessage) ?? normalizedErrorCode;
						const responsesToolCallMismatch =
							downstreamProvider === "openai" &&
							(responsesRequestHints?.hasFunctionCallOutput === true ||
								hasChatToolOutput) &&
							isResponsesToolCallNotFoundMessageShared(normalizedErrorMessage);
						const streamOptionsUnsupported =
							meta.streamOptionsHandled &&
							isStreamOptionsUnsupportedMessage(normalizedErrorMessage);
						if (responsesToolCallMismatch) {
							responsesToolCallMismatchChannels.push(meta.channel.id);
						}
						const finalErrorCode = responsesToolCallMismatch
							? "responses_tool_call_chain_mismatch"
							: streamOptionsUnsupported
								? "stream_options_unsupported"
								: normalizedErrorCode;
						const failureDecision = resolveFailureWithMeta({
							errorCode: finalErrorCode,
							errorMessage: normalizedErrorMessage,
							errorMetaJson,
							overrideAction:
								dispatchResult.errorAction !== "retry"
									? dispatchResult.errorAction
									: null,
						});
						lastErrorDetails = {
							upstreamStatus: response.status,
							errorCode: finalErrorCode,
							errorMessage: normalizedErrorMessage,
							errorMetaJson: failureDecision.errorMetaJson,
						};
						recordAttemptUsage({
							channelId: meta.channel.id,
							requestPath: responsePath,
							latencyMs: attemptLatencyMs,
							firstTokenLatencyMs: isStream ? null : attemptLatencyMs,
							usage: failureUsage.usage,
							status: "error",
							upstreamStatus: response.status,
							errorCode: finalErrorCode,
							errorMessage: normalizedErrorMessage,
							failureStage: "upstream_response",
							failureReason: finalErrorCode,
							usageSource: failureUsage.usageSource,
							errorMetaJson: failureDecision.errorMetaJson,
						});
						recordAttemptLog({
							attemptIndex: attemptNumber,
							channelId: meta.channel.id,
							provider: meta.upstreamProvider,
							model: meta.upstreamModel ?? downstreamModel,
							status: "error",
							errorClass: responsesToolCallMismatch
								? "responses_tool_call_chain"
								: streamOptionsUnsupported
									? "stream_options"
									: "upstream_response",
							errorCode: finalErrorCode,
							httpStatus: response.status,
							latencyMs: attemptLatencyMs,
							upstreamRequestId: attemptUpstreamRequestId,
							startedAt: meta.attemptStartedAt,
							endedAt: new Date().toISOString(),
						});
						appendAttemptFailure({
							attemptIndex: attemptNumber,
							channel: meta.channel,
							httpStatus: response.status,
							errorCode: finalErrorCode,
							errorMessage: normalizedErrorMessage,
							latencyMs: attemptLatencyMs,
						});
						scheduleModelCooldown({
							channelId: meta.channel.id,
							model: meta.recordModel,
							upstreamStatus: response.status,
							errorCode: finalErrorCode,
							errorMessage: normalizedErrorMessage,
						});
						if (downstreamModel && downstreamModel !== meta.recordModel) {
							scheduleModelCooldown({
								channelId: meta.channel.id,
								model: downstreamModel,
								upstreamStatus: response.status,
								errorCode: finalErrorCode,
								errorMessage: normalizedErrorMessage,
							});
						}
						const action = failureDecision.action;
						if (action === "return") {
							return buildDirectErrorResponse(response.status, finalErrorCode);
						}
						if (action === "disable") {
							await applyDisableAction({
								channelId: meta.channel.id,
								errorCode: finalErrorCode,
							});
						}
					}
				}
			}
		}
	}
	if (downstreamSignal.aborted) {
		recordSelectedClientDisconnect();
		return downstreamAbortResponse();
	}
	if (dispatchHandled && !selectedResponse && !dispatchStopRetry) {
		dispatchHandled = false;
	}
	if (!dispatchHandled) {
		for (const [attemptIndex, channel] of ordered.entries()) {
			if (downstreamSignal.aborted) {
				return downstreamAbortResponse();
			}
			if (
				attemptIndex < attemptsExecuted ||
				blockedChannelIds.has(channel.id)
			) {
				continue;
			}
			const attemptNumber = attemptIndex + 1;
			const attemptTarget = resolveChannelAttemptTarget({
				channel,
				tokens: callTokenMap.get(channel.id) ?? [],
				downstreamModel,
				verifiedModelsByChannel,
				endpointType,
				downstreamProvider,
				selectionKey: `${traceId}:${channel.id}:${downstreamModel ?? "*"}`,
				selectionOffset: attemptNumber - 1,
			});
			if (!attemptTarget.eligible) {
				continue;
			}
			attemptsExecuted = Math.max(attemptsExecuted, attemptNumber);
			const attemptStart = Date.now();
			const attemptStartedAt = new Date(attemptStart).toISOString();
			const metadata = attemptTarget.metadata;
			const upstreamProvider = attemptTarget.upstreamProvider;
			const upstreamModel = attemptTarget.upstreamModel;
			const recordModel = attemptTarget.recordModel;

			const baseUrl = resolveChannelBaseUrl(channel);
			const apiKey =
				attemptTarget.tokenSelection.token?.api_key ?? channel.api_key;
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
			let upstreamBodyText = effectiveRequestText || undefined;
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
				} else if (upstreamModel) {
					upstreamBodyText = parsedBody
						? JSON.stringify({
								...parsedBody,
								model: upstreamModel,
							})
						: rewriteModelInRawJsonRequest(upstreamBodyText, upstreamModel);
				}
			} else if (sameProvider) {
				if (upstreamProvider === "gemini") {
					upstreamRequestPath = applyGeminiModelToPath(
						upstreamRequestPath,
						upstreamModel,
					);
				} else if (upstreamModel) {
					upstreamBodyText = parsedBody
						? JSON.stringify({
								...parsedBody,
								model: upstreamModel,
							})
						: rewriteModelInRawJsonRequest(upstreamBodyText, upstreamModel);
				}
			} else {
				let built: {
					request: UpstreamRequest;
					bodyText?: string;
				} | null = null;

				if (endpointType === "chat" || endpointType === "responses") {
					const chatPayload = ensureNormalizedChat();
					if (!chatPayload) {
						continue;
					}
					const request = buildUpstreamChatRequest(
						upstreamProvider,
						chatPayload,
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
					const embeddingPayload = ensureNormalizedEmbedding();
					if (!embeddingPayload) {
						continue;
					}
					const request = buildUpstreamEmbeddingRequest(
						upstreamProvider,
						embeddingPayload,
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
					const imagePayload = ensureNormalizedImage();
					if (!imagePayload) {
						continue;
					}
					const request = buildUpstreamImageRequest(
						upstreamProvider,
						imagePayload,
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
				(endpointType === "chat" || endpointType === "responses") &&
				!shouldSkipHeavyBodyParsing;
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
				const fallbackTarget =
					upstreamFallbackPath && !absoluteUrl
						? mergeQuery(
								`${baseUrl}${upstreamFallbackPath}`,
								querySuffix,
								metadata.query_overrides,
							)
						: undefined;

				const attemptResult = await executeAttemptViaWorker(
					c,
					{
						method: c.req.method,
						target,
						fallbackTarget,
						headers: Array.from(headers.entries()),
						bodyText: upstreamBodyText,
						timeoutMs: upstreamTimeoutMs,
						responsePath: upstreamRequestPath,
						fallbackPath: upstreamFallbackPath,
						streamUsage: streamUsageOptions,
					},
					attemptBindingPolicy,
					attemptBindingState,
					downstreamSignal,
				);
				if (attemptResult.kind === "aborted" || downstreamSignal.aborted) {
					return downstreamAbortResponse();
				}
				if (
					attemptResult.kind === "binding_error" ||
					attemptResult.kind === "attempt_worker_error"
				) {
					const errorMetaJson =
						attemptResult.kind === "attempt_worker_error"
							? (attemptResult.errorMetaJson ??
								JSON.stringify({
									type: "attempt_worker_internal_error",
									http_status: attemptResult.httpStatus,
									latency_ms: attemptResult.latencyMs,
								}))
							: JSON.stringify({
									type: "attempt_worker_binding_error",
									latency_ms: attemptResult.latencyMs,
								});
					lastErrorDetails = {
						upstreamStatus: null,
						errorCode: attemptResult.errorCode,
						errorMessage: attemptResult.errorMessage,
						errorMetaJson,
					};
					const failureDecision = resolveFailureWithMeta({
						errorCode: attemptResult.errorCode,
						errorMessage: attemptResult.errorMessage,
						errorMetaJson,
					});
					lastErrorDetails.errorMetaJson = failureDecision.errorMetaJson;
					recordAttemptUsage({
						channelId: channel.id,
						requestPath: upstreamRequestPath,
						latencyMs: attemptResult.latencyMs,
						firstTokenLatencyMs: null,
						usage: null,
						status: "error",
						upstreamStatus: null,
						errorCode: attemptResult.errorCode,
						errorMessage: attemptResult.errorMessage,
						failureStage: "attempt_call",
						failureReason: attemptResult.errorCode,
						usageSource: "none",
						errorMetaJson: failureDecision.errorMetaJson,
					});
					recordAttemptLog({
						attemptIndex: attemptNumber,
						channelId: channel.id,
						provider: upstreamProvider,
						model: upstreamModel ?? downstreamModel,
						status: "error",
						errorClass:
							attemptResult.kind === "attempt_worker_error"
								? "attempt_worker"
								: "attempt_binding",
						errorCode: attemptResult.errorCode,
						httpStatus:
							attemptResult.kind === "attempt_worker_error"
								? attemptResult.httpStatus
								: null,
						latencyMs: attemptResult.latencyMs,
						startedAt: attemptStartedAt,
						endedAt: new Date().toISOString(),
					});
					appendAttemptFailure({
						attemptIndex: attemptNumber,
						channel,
						httpStatus:
							attemptResult.kind === "attempt_worker_error"
								? attemptResult.httpStatus
								: null,
						errorCode: attemptResult.errorCode,
						errorMessage: attemptResult.errorMessage,
						latencyMs: attemptResult.latencyMs,
					});
					const action = failureDecision.action;
					if (action === "return") {
						return buildDirectErrorResponse(
							attemptResult.kind === "attempt_worker_error"
								? attemptResult.httpStatus
								: 503,
							attemptResult.errorCode,
						);
					}
					if (action === "disable") {
						await applyDisableAction({
							channelId: channel.id,
							errorCode: attemptResult.errorCode,
						});
						continue;
					}
					if (!(await continueAfterFailure(attemptNumber, action))) {
						break;
					}
					continue;
				}
				let {
					response,
					responsePath,
					latencyMs: attemptLatencyMs,
					upstreamRequestId: attemptUpstreamRequestId,
				} = attemptResult;

				if (
					shouldHandleStreamOptions &&
					streamOptionsInjected &&
					!response.ok
				) {
					const details = await extractErrorDetails(response);
					if (isStreamOptionsUnsupportedMessage(details.errorMessage)) {
						saveStreamOptionsCapability(channel.id, false);
						const retried = await executeAttemptViaWorker(
							c,
							{
								method: c.req.method,
								target,
								fallbackTarget,
								headers: Array.from(headers.entries()),
								bodyText: strippedStreamOptionsBodyText,
								timeoutMs: upstreamTimeoutMs,
								responsePath: upstreamRequestPath,
								fallbackPath: upstreamFallbackPath,
								streamUsage: streamUsageOptions,
							},
							attemptBindingPolicy,
							attemptBindingState,
							downstreamSignal,
						);
						if (retried.kind === "aborted" || downstreamSignal.aborted) {
							return downstreamAbortResponse();
						}
						if (
							retried.kind === "binding_error" ||
							retried.kind === "attempt_worker_error"
						) {
							const errorMetaJson =
								retried.kind === "attempt_worker_error"
									? (retried.errorMetaJson ??
										JSON.stringify({
											type: "attempt_worker_internal_error",
											http_status: retried.httpStatus,
											latency_ms: retried.latencyMs,
										}))
									: JSON.stringify({
											type: "attempt_worker_binding_error",
											latency_ms: retried.latencyMs,
										});
							lastErrorDetails = {
								upstreamStatus: null,
								errorCode: retried.errorCode,
								errorMessage: retried.errorMessage,
								errorMetaJson,
							};
							const failureDecision = resolveFailureWithMeta({
								errorCode: retried.errorCode,
								errorMessage: retried.errorMessage,
								errorMetaJson,
							});
							lastErrorDetails.errorMetaJson = failureDecision.errorMetaJson;
							recordAttemptUsage({
								channelId: channel.id,
								requestPath: upstreamRequestPath,
								latencyMs: retried.latencyMs,
								firstTokenLatencyMs: null,
								usage: null,
								status: "error",
								upstreamStatus: null,
								errorCode: retried.errorCode,
								errorMessage: retried.errorMessage,
								failureStage: "attempt_call",
								failureReason: retried.errorCode,
								usageSource: "none",
								errorMetaJson: failureDecision.errorMetaJson,
							});
							recordAttemptLog({
								attemptIndex: attemptNumber,
								channelId: channel.id,
								provider: upstreamProvider,
								model: upstreamModel ?? downstreamModel,
								status: "error",
								errorClass:
									retried.kind === "attempt_worker_error"
										? "attempt_worker"
										: "attempt_binding",
								errorCode: retried.errorCode,
								httpStatus:
									retried.kind === "attempt_worker_error"
										? retried.httpStatus
										: null,
								latencyMs: retried.latencyMs,
								startedAt: attemptStartedAt,
								endedAt: new Date().toISOString(),
							});
							appendAttemptFailure({
								attemptIndex: attemptNumber,
								channel,
								httpStatus:
									retried.kind === "attempt_worker_error"
										? retried.httpStatus
										: null,
								errorCode: retried.errorCode,
								errorMessage: retried.errorMessage,
								latencyMs: retried.latencyMs,
							});
							const action = failureDecision.action;
							if (action === "return") {
								return buildDirectErrorResponse(
									retried.kind === "attempt_worker_error"
										? retried.httpStatus
										: 503,
									retried.errorCode,
								);
							}
							if (action === "disable") {
								await applyDisableAction({
									channelId: channel.id,
									errorCode: retried.errorCode,
								});
								continue;
							}
							if (!(await continueAfterFailure(attemptNumber, action))) {
								break;
							}
							continue;
						}
						response = retried.response;
						responsePath = retried.responsePath;
						attemptLatencyMs = retried.latencyMs;
						attemptUpstreamRequestId = retried.upstreamRequestId;
					}
				}
				if (shouldHandleStreamOptions && response.ok && streamOptionsInjected) {
					saveStreamOptionsCapability(channel.id, true);
				}

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
					let immediateUsage = jsonUsage ?? headerUsage;
					const immediateUsageSource = jsonUsage
						? "json"
						: headerUsage
							? "header"
							: "none";
					const streamUsageProcessed = isStream
						? parseBooleanHeader(
								response.headers.get(ATTEMPT_STREAM_USAGE_PROCESSED_HEADER),
							)
						: false;
					let parsedSuccessStreamUsage: StreamUsage | null = null;
					if (isStream) {
						if (streamUsageProcessed) {
							parsedSuccessStreamUsage = {
								usage: headerUsage,
								firstTokenLatencyMs: parseOptionalLatencyHeader(
									response.headers.get(
										ATTEMPT_STREAM_FIRST_TOKEN_LATENCY_HEADER,
									),
								),
								eventsSeen:
									parseOptionalCountHeader(
										response.headers.get(ATTEMPT_STREAM_EVENTS_SEEN_HEADER),
									) ?? 0,
								abnormal: readAttemptStreamAbnormal(response.headers),
							};
							if (parsedSuccessStreamUsage?.usage) {
								immediateUsage = parsedSuccessStreamUsage.usage;
							}
						} else if (
							shouldParseSuccessStreamUsage(
								streamUsageMode as "full" | "lite" | "off",
							)
						) {
							parsedSuccessStreamUsage = await parseUsageFromSse(
								response.clone(),
								{
									...streamUsageOptions,
									timeoutMs: streamUsageParseTimeoutMs,
								},
							).catch(() => null);
							if (parsedSuccessStreamUsage?.usage) {
								immediateUsage = parsedSuccessStreamUsage.usage;
							}
						}
					}
					const abnormalResponse =
						parsedSuccessStreamUsage?.abnormal ??
						(await detectAbnormalSuccessResponse(response)) ??
						(isStream &&
						!parsedSuccessStreamUsage &&
						shouldParseSuccessStreamUsage(
							streamUsageMode as "full" | "lite" | "off",
						)
							? await detectAbnormalStreamSuccessResponse(response)
							: null);
					if (abnormalResponse) {
						const failureDecision = resolveFailureWithMeta({
							errorCode: abnormalResponse.errorCode,
							errorMessage: abnormalResponse.errorMessage,
							errorMetaJson: abnormalResponse.errorMetaJson,
						});
						lastErrorDetails = {
							upstreamStatus: response.status,
							errorCode: abnormalResponse.errorCode,
							errorMessage: abnormalResponse.errorMessage,
							errorMetaJson: failureDecision.errorMetaJson,
						};
						recordAttemptUsage({
							channelId: channel.id,
							requestPath: responsePath,
							latencyMs: attemptLatencyMs,
							firstTokenLatencyMs: isStream ? null : attemptLatencyMs,
							usage: null,
							status: "error",
							upstreamStatus: response.status,
							errorCode: abnormalResponse.errorCode,
							errorMessage: abnormalResponse.errorMessage,
							failureStage: "upstream_response",
							failureReason: abnormalResponse.errorCode,
							usageSource: "none",
							errorMetaJson: failureDecision.errorMetaJson,
						});
						recordAttemptLog({
							attemptIndex: attemptNumber,
							channelId: channel.id,
							provider: upstreamProvider,
							model: upstreamModel ?? downstreamModel,
							status: "error",
							errorClass: "upstream_response",
							errorCode: abnormalResponse.errorCode,
							httpStatus: response.status,
							latencyMs: attemptLatencyMs,
							upstreamRequestId: attemptUpstreamRequestId,
							startedAt: attemptStartedAt,
							endedAt: new Date().toISOString(),
						});
						appendAttemptFailure({
							attemptIndex: attemptNumber,
							channel,
							httpStatus: response.status,
							errorCode: abnormalResponse.errorCode,
							errorMessage: abnormalResponse.errorMessage,
							latencyMs: attemptLatencyMs,
						});
						scheduleModelCooldown({
							channelId: channel.id,
							model: recordModel,
							upstreamStatus: response.status,
							errorCode: abnormalResponse.errorCode,
							errorMessage: abnormalResponse.errorMessage,
						});
						if (downstreamModel && downstreamModel !== recordModel) {
							scheduleModelCooldown({
								channelId: channel.id,
								model: downstreamModel,
								upstreamStatus: response.status,
								errorCode: abnormalResponse.errorCode,
								errorMessage: abnormalResponse.errorMessage,
							});
						}
						const action = failureDecision.action;
						if (action === "return") {
							return buildDirectErrorResponse(
								response.status,
								abnormalResponse.errorCode,
							);
						}
						if (action === "disable") {
							await applyDisableAction({
								channelId: channel.id,
								errorCode: abnormalResponse.errorCode,
							});
							continue;
						}
						if (!(await continueAfterFailure(attemptNumber, action))) {
							break;
						}
						continue;
					}
					const hasAnyUsageSignal = hasUsageHeaderSignal || hasUsageJsonSignal;
					const failOnMissingUsage = shouldTreatMissingUsageAsError({
						isStream,
						bodyParsingSkipped:
							shouldSkipHeavyBodyParsing && !parsedBodyInitialized,
						hasUsageSignal: hasAnyUsageSignal,
					});
					if (!isStream && !immediateUsage && failOnMissingUsage) {
						const usageMissingCode = hasAnyUsageSignal
							? "usage_missing.non_stream.signal_present_unparseable"
							: "usage_missing.non_stream.signal_absent";
						const usageMissingMessage = `usage_missing: ${usageMissingCode}`;
						const failureDecision = resolveFailureWithMeta({
							errorCode: usageMissingCode,
							errorMessage: usageMissingMessage,
						});
						lastErrorDetails = {
							upstreamStatus: response.status,
							errorCode: usageMissingCode,
							errorMessage: usageMissingMessage,
							errorMetaJson: failureDecision.errorMetaJson,
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
							errorMetaJson: failureDecision.errorMetaJson,
						});
						recordAttemptLog({
							attemptIndex: attemptNumber,
							channelId: channel.id,
							provider: upstreamProvider,
							model: upstreamModel ?? downstreamModel,
							status: "error",
							errorClass: "usage_finalize",
							errorCode: usageMissingCode,
							httpStatus: response.status,
							latencyMs: attemptLatencyMs,
							upstreamRequestId: attemptUpstreamRequestId,
							startedAt: attemptStartedAt,
							endedAt: new Date().toISOString(),
						});
						appendAttemptFailure({
							attemptIndex: attemptNumber,
							channel,
							httpStatus: response.status,
							errorCode: usageMissingCode,
							errorMessage: usageMissingMessage,
							latencyMs: attemptLatencyMs,
						});
						const action = failureDecision.action;
						if (action === "return") {
							return buildDirectErrorResponse(
								response.status,
								usageMissingCode,
							);
						}
						if (action === "disable") {
							await applyDisableAction({
								channelId: channel.id,
								errorCode: usageMissingCode,
							});
							continue;
						}
						if (!(await continueAfterFailure(attemptNumber, action))) {
							break;
						}
						continue;
					}
					if (
						shouldTreatZeroCompletionAsError({
							enabled: zeroCompletionAsErrorEnabled,
							endpointType,
							usage: immediateUsage,
						})
					) {
						const zeroCompletionMessage = `${USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE}: completion_tokens=${immediateUsage?.completionTokens ?? 0}`;
						const failureDecision = resolveFailureWithMeta({
							errorCode: USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE,
							errorMessage: zeroCompletionMessage,
						});
						lastErrorDetails = {
							upstreamStatus: response.status,
							errorCode: USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE,
							errorMessage: zeroCompletionMessage,
							errorMetaJson: failureDecision.errorMetaJson,
						};
						recordAttemptUsage({
							channelId: channel.id,
							requestPath: responsePath,
							latencyMs: attemptLatencyMs,
							firstTokenLatencyMs: attemptLatencyMs,
							usage: immediateUsage,
							status: "error",
							upstreamStatus: response.status,
							errorCode: USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE,
							errorMessage: zeroCompletionMessage,
							failureStage: "usage_finalize",
							failureReason: USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE,
							usageSource: immediateUsageSource,
							errorMetaJson: failureDecision.errorMetaJson,
						});
						recordAttemptLog({
							attemptIndex: attemptNumber,
							channelId: channel.id,
							provider: upstreamProvider,
							model: upstreamModel ?? downstreamModel,
							status: "error",
							errorClass: "usage_finalize",
							errorCode: USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE,
							httpStatus: response.status,
							latencyMs: attemptLatencyMs,
							upstreamRequestId: attemptUpstreamRequestId,
							startedAt: attemptStartedAt,
							endedAt: new Date().toISOString(),
						});
						appendAttemptFailure({
							attemptIndex: attemptNumber,
							channel,
							httpStatus: response.status,
							errorCode: USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE,
							errorMessage: zeroCompletionMessage,
							latencyMs: attemptLatencyMs,
						});
						const action = failureDecision.action;
						if (action === "return") {
							return buildDirectErrorResponse(
								response.status,
								USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE,
							);
						}
						if (action === "disable") {
							await applyDisableAction({
								channelId: channel.id,
								errorCode: USAGE_ZERO_COMPLETION_TOKENS_ERROR_CODE,
							});
							continue;
						}
						if (!(await continueAfterFailure(attemptNumber, action))) {
							break;
						}
						continue;
					}

					recordAttemptLog({
						attemptIndex: attemptNumber,
						channelId: channel.id,
						provider: upstreamProvider,
						model: upstreamModel ?? downstreamModel,
						status: "ok",
						httpStatus: response.status,
						latencyMs: attemptLatencyMs,
						upstreamRequestId: attemptUpstreamRequestId,
						startedAt: attemptStartedAt,
						endedAt: new Date().toISOString(),
					});
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
					selectedImmediateUsageSource = immediateUsageSource;
					selectedParsedStreamUsage = parsedSuccessStreamUsage;
					selectedHasUsageHeaders = hasUsageHeaderSignal;
					selectedAttemptIndex = attemptNumber;
					selectedAttemptStartedAt = attemptStartedAt;
					selectedAttemptLatencyMs = attemptLatencyMs;
					selectedAttemptUpstreamRequestId = attemptUpstreamRequestId;
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
				const errorMetaJson = mergeErrorMetaJson(
					errorInfo.errorMetaJson,
					buildUpstreamDiagnosticMeta({
						target,
						fallbackTarget,
						requestHeaders: headers,
						response,
					}),
				);
				const failureUsage = await parseStreamUsageOnFailure(response);
				const normalizedErrorCode = normalizeUpstreamErrorCode(
					errorInfo.errorCode,
					response.status,
				);
				const normalizedErrorMessage =
					normalizeMessage(errorInfo.errorMessage) ?? normalizedErrorCode;
				const responsesToolCallMismatch =
					downstreamProvider === "openai" &&
					(responsesRequestHints?.hasFunctionCallOutput === true ||
						hasChatToolOutput) &&
					isResponsesToolCallNotFoundMessageShared(normalizedErrorMessage);
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
				const failureDecision = resolveFailureWithMeta({
					errorCode: finalErrorCode,
					errorMessage: normalizedErrorMessage,
					errorMetaJson,
				});
				lastErrorDetails = {
					upstreamStatus: response.status,
					errorCode: finalErrorCode,
					errorMessage: normalizedErrorMessage,
					errorMetaJson: failureDecision.errorMetaJson,
				};
				recordAttemptUsage({
					channelId: channel.id,
					requestPath: responsePath,
					latencyMs: attemptLatencyMs,
					firstTokenLatencyMs: isStream ? null : attemptLatencyMs,
					usage: failureUsage.usage,
					status: "error",
					upstreamStatus: response.status,
					errorCode: finalErrorCode,
					errorMessage: normalizedErrorMessage,
					failureStage: "upstream_response",
					failureReason: finalErrorCode,
					usageSource: failureUsage.usageSource,
					errorMetaJson: failureDecision.errorMetaJson,
				});
				recordAttemptLog({
					attemptIndex: attemptNumber,
					channelId: channel.id,
					provider: upstreamProvider,
					model: upstreamModel ?? downstreamModel,
					status: "error",
					errorClass: responsesToolCallMismatch
						? "responses_tool_call_chain"
						: streamOptionsUnsupported
							? "stream_options"
							: "upstream_response",
					errorCode: finalErrorCode,
					httpStatus: response.status,
					latencyMs: attemptLatencyMs,
					upstreamRequestId: attemptUpstreamRequestId,
					startedAt: attemptStartedAt,
					endedAt: new Date().toISOString(),
				});
				appendAttemptFailure({
					attemptIndex: attemptNumber,
					channel,
					httpStatus: response.status,
					errorCode: finalErrorCode,
					errorMessage: normalizedErrorMessage,
					latencyMs: attemptLatencyMs,
				});

				scheduleModelCooldown({
					channelId: channel.id,
					model: recordModel,
					upstreamStatus: response.status,
					errorCode: finalErrorCode,
					errorMessage: normalizedErrorMessage,
				});
				if (downstreamModel && downstreamModel !== recordModel) {
					scheduleModelCooldown({
						channelId: channel.id,
						model: downstreamModel,
						upstreamStatus: response.status,
						errorCode: finalErrorCode,
						errorMessage: normalizedErrorMessage,
					});
				}
				const action = failureDecision.action;
				if (action === "return") {
					return buildDirectErrorResponse(response.status, finalErrorCode);
				}
				if (action === "disable") {
					await applyDisableAction({
						channelId: channel.id,
						errorCode: finalErrorCode,
					});
					continue;
				}
				if (!(await continueAfterFailure(attemptNumber, action))) {
					break;
				}
			} catch (error) {
				if (downstreamSignal.aborted) {
					return downstreamAbortResponse();
				}
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
				const attemptLatencyMs = Date.now() - attemptStart;
				const failureDecision = resolveFailureWithMeta({
					errorCode: usageErrorCode,
					errorMessage: usageErrorMessage,
					errorMetaJson: JSON.stringify({
						type: "fetch_exception",
						reason: isTimeout ? "timeout" : "exception",
					}),
				});
				lastErrorDetails = {
					upstreamStatus: null,
					errorCode: usageErrorCode,
					errorMessage: usageErrorMessage,
					errorMetaJson: failureDecision.errorMetaJson,
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
					errorMetaJson: failureDecision.errorMetaJson,
				});
				recordAttemptLog({
					attemptIndex: attemptNumber,
					channelId: channel.id,
					provider: upstreamProvider,
					model: upstreamModel ?? downstreamModel,
					status: "error",
					errorClass: isTimeout ? "timeout" : "exception",
					errorCode: usageErrorCode,
					httpStatus: null,
					latencyMs: attemptLatencyMs,
					startedAt: attemptStartedAt,
					endedAt: new Date().toISOString(),
				});
				appendAttemptFailure({
					attemptIndex: attemptNumber,
					channel,
					httpStatus: null,
					errorCode: usageErrorCode,
					errorMessage: usageErrorMessage,
					latencyMs: attemptLatencyMs,
				});

				scheduleModelCooldown({
					channelId: channel.id,
					model: recordModel,
					upstreamStatus: null,
					errorCode: usageErrorCode,
					errorMessage: usageErrorMessage,
				});
				if (downstreamModel && downstreamModel !== recordModel) {
					scheduleModelCooldown({
						channelId: channel.id,
						model: downstreamModel,
						upstreamStatus: null,
						errorCode: usageErrorCode,
						errorMessage: usageErrorMessage,
					});
				}
				const action = failureDecision.action;
				if (action === "return") {
					return buildDirectErrorResponse(
						isTimeout ? 504 : 502,
						usageErrorCode,
					);
				}
				if (action === "disable") {
					await applyDisableAction({
						channelId: channel.id,
						errorCode: usageErrorCode,
					});
					continue;
				}
				if (!(await continueAfterFailure(attemptNumber, action))) {
					break;
				}
			}
		}
	}
	if (downstreamSignal.aborted) {
		recordSelectedClientDisconnect();
		return downstreamAbortResponse();
	}

	if (!selectedResponse) {
		responseAttemptCount = attemptsExecuted;
		if (attemptFailures.length > 0) {
			const summary = buildAttemptFailureSummary(attemptFailures);
			const payload = {
				error: "proxy_all_attempts_failed",
				code: "proxy_all_attempts_failed",
				trace_id: traceId,
				attempt_total: ordered.length,
				attempt_failed: attemptFailures.length,
				status_counts: summary.statusCounts,
				code_counts: summary.codeCounts,
				top_reason: summary.topReason,
				failures: attemptFailures.map((failure) => ({
					attempt_index: failure.attemptIndex,
					channel_id: failure.channelId,
					channel_name: failure.channelName,
					http_status: failure.httpStatus,
					error_code: failure.errorCode,
					error_message: failure.errorMessage,
					latency_ms: failure.latencyMs,
				})),
				responses_tool_call_mismatch_channels:
					responsesToolCallMismatchChannels.length > 0
						? responsesToolCallMismatchChannels
						: undefined,
			};
			return withTraceHeader(c.json(payload, 503));
		}
		if (lastErrorDetails) {
			const errorCode = lastErrorDetails.errorCode ?? "upstream_unavailable";
			return jsonErrorWithTrace(502, errorCode, errorCode);
		}
		if (ordered.length > 0 && attemptsExecuted === 0) {
			const skippedChannels = Array.from(
				new Map(
					ordered.map((channel) => [
						channel.id,
						{
							channelId: channel.id,
							channelName: channel.name ?? null,
							reason: "skipped_before_upstream_call",
							recordModel: downstreamModel,
							upstreamProvider: downstreamProvider,
							hasModelList: (callTokenMap.get(channel.id) ?? []).some((token) =>
								Boolean(token.models_json),
							),
						},
					]),
				).values(),
			);
			recordEarlyUsage({
				status: 503,
				code: NO_ROUTABLE_CHANNELS_ERROR_CODE,
				message: NO_ROUTABLE_CHANNELS_ERROR_CODE,
				failureStage: "channel_select",
				failureReason: NO_ROUTABLE_CHANNELS_ERROR_CODE,
				usageSource: "none",
				errorMetaJson: buildNoRoutableChannelsMeta(skippedChannels),
			});
			return jsonErrorWithTrace(
				503,
				NO_ROUTABLE_CHANNELS_ERROR_CODE,
				NO_ROUTABLE_CHANNELS_ERROR_CODE,
			);
		}
		recordEarlyUsage({
			status: 502,
			code: "upstream_unavailable",
			message: "upstream_unavailable",
		});
		return jsonErrorWithTrace(
			502,
			"upstream_unavailable",
			"upstream_unavailable",
		);
	}
	let responseToReturn = selectedResponse;

	if (selectedChannel && isStream) {
		const selectedLatencyMs = Date.now() - requestStart;
		const streamUsageProcessed = parseBooleanHeader(
			selectedResponse.headers.get(ATTEMPT_STREAM_USAGE_PROCESSED_HEADER),
		);
		let usage = selectedImmediateUsage;
		let usageSource: "header" | "stream" | "none" = selectedImmediateUsage
			? "header"
			: "none";
		let streamMetaPartial = false;
		let streamMetaReason: string | null = null;
		let firstTokenLatencyMs: number | null = null;
		let eventsSeen = 0;
		if (streamUsageProcessed) {
			streamMetaPartial = parseBooleanHeader(
				selectedResponse.headers.get(ATTEMPT_STREAM_META_PARTIAL_HEADER),
			);
			streamMetaReason =
				normalizeMessage(
					selectedResponse.headers.get(ATTEMPT_STREAM_META_REASON_HEADER),
				) ?? null;
			firstTokenLatencyMs = parseOptionalLatencyHeader(
				selectedResponse.headers.get(ATTEMPT_STREAM_FIRST_TOKEN_LATENCY_HEADER),
			);
			eventsSeen =
				parseOptionalCountHeader(
					selectedResponse.headers.get(ATTEMPT_STREAM_EVENTS_SEEN_HEADER),
				) ?? 0;
		} else if (selectedParsedStreamUsage) {
			if (selectedParsedStreamUsage.usage) {
				usage = selectedParsedStreamUsage.usage;
				usageSource = "stream";
			}
			firstTokenLatencyMs = selectedParsedStreamUsage.firstTokenLatencyMs;
			eventsSeen = selectedParsedStreamUsage.eventsSeen ?? 0;
			streamMetaPartial = shouldMarkStreamMetaPartial({
				mode: streamUsageMode as "full" | "lite" | "off",
				hasImmediateUsage: Boolean(selectedImmediateUsage),
				hasParsedUsage: Boolean(selectedParsedStreamUsage.usage),
				eventsSeen,
			});
			if (streamMetaPartial) {
				streamMetaReason = resolveStreamMetaPartialReason({
					mode: streamUsageMode as "full" | "lite" | "off",
					timedOut: selectedParsedStreamUsage.timedOut,
					eventsSeen,
				});
			}
		} else if (
			shouldParseSuccessStreamUsage(streamUsageMode as "full" | "lite" | "off")
		) {
			try {
				const streamUsage = await parseUsageFromSse(selectedResponse.clone(), {
					...streamUsageOptions,
					timeoutMs: streamUsageParseTimeoutMs,
				});
				if (streamUsage.usage) {
					usage = streamUsage.usage;
					usageSource = "stream";
				}
				firstTokenLatencyMs = streamUsage.firstTokenLatencyMs;
				eventsSeen = streamUsage.eventsSeen ?? 0;
				streamMetaPartial = shouldMarkStreamMetaPartial({
					mode: streamUsageMode as "full" | "lite" | "off",
					hasImmediateUsage: Boolean(selectedImmediateUsage),
					hasParsedUsage: Boolean(streamUsage.usage),
					eventsSeen,
				});
				if (streamMetaPartial) {
					streamMetaReason = resolveStreamMetaPartialReason({
						mode: streamUsageMode as "full" | "lite" | "off",
						timedOut: streamUsage.timedOut,
						eventsSeen,
					});
				}
			} catch {
				streamMetaPartial = !selectedImmediateUsage;
				if (streamMetaPartial) {
					streamMetaReason = resolveStreamMetaPartialReason({
						mode: streamUsageMode as "full" | "lite" | "off",
						timedOut: true,
					});
				}
			}
		} else {
			streamMetaPartial = shouldMarkStreamMetaPartial({
				mode: streamUsageMode as "full" | "lite" | "off",
				hasImmediateUsage: Boolean(selectedImmediateUsage),
				hasParsedUsage: false,
			});
			if (streamMetaPartial) {
				streamMetaReason = resolveStreamMetaPartialReason({
					mode: streamUsageMode as "full" | "lite" | "off",
				});
			}
		}
		if (streamMetaPartial) {
			const reason = streamMetaReason ?? STREAM_META_PARTIAL_CODE;
			markStreamMetaPartial({
				reason,
				path: selectedRequestPath,
				eventsSeen,
				hasImmediateUsage: Boolean(selectedImmediateUsage),
				hasUsageHeaders: selectedHasUsageHeaders,
			});
			if (
				selectedAttemptIndex !== null &&
				selectedAttemptStartedAt &&
				selectedAttemptLatencyMs !== null
			) {
				recordAttemptLog({
					attemptIndex: selectedAttemptIndex,
					channelId: selectedChannel.id,
					provider: selectedUpstreamProvider,
					model: selectedUpstreamModel ?? downstreamModel,
					status: "warn",
					errorClass: "stream_meta",
					errorCode: STREAM_META_PARTIAL_CODE,
					httpStatus: selectedResponse.status,
					latencyMs: selectedAttemptLatencyMs,
					upstreamRequestId: selectedAttemptUpstreamRequestId,
					startedAt: selectedAttemptStartedAt,
					endedAt: new Date().toISOString(),
				});
			}
		}
		const usageWarning = getSuccessfulUsageWarning({
			isStream,
			endpointType,
			usage,
		});
		if (
			usageWarning &&
			selectedAttemptIndex !== null &&
			selectedAttemptStartedAt &&
			selectedAttemptLatencyMs !== null
		) {
			recordAttemptLog({
				attemptIndex: selectedAttemptIndex,
				channelId: selectedChannel.id,
				provider: selectedUpstreamProvider,
				model: selectedUpstreamModel ?? downstreamModel,
				status: "warn",
				errorClass: "usage_observe",
				errorCode: usageWarning.code,
				httpStatus: selectedResponse.status,
				latencyMs: selectedAttemptLatencyMs,
				upstreamRequestId: selectedAttemptUpstreamRequestId,
				startedAt: selectedAttemptStartedAt,
				endedAt: new Date().toISOString(),
			});
		}
		recordAttemptUsage({
			channelId: selectedChannel.id,
			requestPath: selectedRequestPath,
			latencyMs: selectedLatencyMs,
			firstTokenLatencyMs,
			usage,
			status: streamMetaPartial || usageWarning ? "warn" : "ok",
			upstreamStatus: selectedResponse.status,
			errorCode:
				usageWarning?.code ??
				(streamMetaPartial ? STREAM_META_PARTIAL_CODE : null),
			errorMessage:
				usageWarning?.message ??
				(streamMetaPartial ? STREAM_META_PARTIAL_CODE : null),
			failureStage: usageWarning
				? USAGE_OBSERVE_FAILURE_STAGE
				: streamMetaPartial
					? USAGE_OBSERVE_FAILURE_STAGE
					: "usage_finalize",
			failureReason:
				usageWarning?.code ??
				(streamMetaPartial ? STREAM_META_PARTIAL_CODE : null),
			usageSource,
		});
	}

	if (
		canResolveResponsesAffinity &&
		selectedChannel &&
		downstreamProvider === "openai" &&
		endpointType === "responses"
	) {
		const task = (async () => {
			const contentType = selectedResponse.headers.get("content-type") ?? "";
			let responseId =
				normalizeMessage(
					selectedResponse.headers.get(ATTEMPT_RESPONSE_ID_HEADER),
				) ?? null;
			if (
				!responseId &&
				!isStream &&
				contentType.includes("application/json")
			) {
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
		responseAttemptCount = attemptsExecuted;
		try {
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
				responseToReturn = transformed;
			}
		} catch (error) {
			console.error("proxy_response_adapt_failed", {
				traceId,
				path: selectedRequestPath,
				message:
					error instanceof Error ? error.message : "response_adapt_failed",
			});
			return jsonErrorWithTrace(
				502,
				RESPONSE_ADAPT_FAILED_CODE,
				RESPONSE_ADAPT_FAILED_CODE,
			);
		}
	}
	if (downstreamSignal.aborted) {
		recordSelectedClientDisconnect();
		return downstreamAbortResponse();
	}
	if (selectedChannel && !isStream) {
		const selectedLatencyMs = Date.now() - requestStart;
		recordAttemptUsage({
			channelId: selectedChannel.id,
			requestPath: selectedRequestPath,
			latencyMs: selectedLatencyMs,
			firstTokenLatencyMs: selectedAttemptLatencyMs ?? selectedLatencyMs,
			usage: selectedImmediateUsage,
			status: "ok",
			upstreamStatus: selectedResponse.status,
			failureStage: "usage_finalize",
			usageSource: selectedImmediateUsageSource,
		});
	}

	responseAttemptCount = attemptsExecuted;
	return withTraceHeader(responseToReturn);
});

export default proxy;
