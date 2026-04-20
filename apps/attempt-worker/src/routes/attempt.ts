import { Hono } from "hono";
import {
	extractResponsesRequestHints,
	normalizeProxyStreamUsageMode,
	repairOpenAiToolCallChain,
	resolveStreamMetaPartialReason,
	sanitizeUpstreamRequestHeaders,
	shouldMarkStreamMetaPartial,
	shouldParseSuccessStreamUsage,
	validateOpenAiToolCallChain,
} from "../../../shared-core/src";
import { safeJsonParse } from "../../../worker/src/utils/json";
import {
	parseUsageFromHeaders,
	parseUsageFromSse,
	type StreamUsageOptions,
} from "../../../worker/src/utils/usage";
import {
	buildProxyErrorCodeSet,
	resolveProxyErrorAction,
} from "../../../worker/src/services/proxy-error-policy";
import type { AppEnv } from "../env";

const ATTEMPT_RESPONSE_PATH_HEADER = "x-ha-attempt-response-path";
const ATTEMPT_LATENCY_HEADER = "x-ha-attempt-latency-ms";
const ATTEMPT_UPSTREAM_REQUEST_ID_HEADER = "x-ha-attempt-upstream-request-id";
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
const DISPATCH_ATTEMPT_INDEX_HEADER = "x-ha-dispatch-attempt-index";
const DISPATCH_CHANNEL_ID_HEADER = "x-ha-dispatch-channel-id";
const DISPATCH_STOP_RETRY_HEADER = "x-ha-dispatch-stop-retry";
const DISPATCH_ERROR_ACTION_HEADER = "x-ha-dispatch-error-action";
const CLIENT_ABORT_ERROR_CODE = "client_disconnected";
const STREAM_OPTIONS_UNSUPPORTED_SNIPPET = "unsupported parameter";
const STREAM_OPTIONS_PARAM_NAME = "stream_options";
const ATTEMPT_STREAM_USAGE_PARSE_TIMEOUT_MS = 1200;
const ATTEMPT_RESPONSE_ID_PARSE_TIMEOUT_MS = 1200;
const ATTEMPT_RESPONSE_ID_PARSE_MAX_BYTES = 64 * 1024;

type AttemptRequest = {
	method: string;
	target: string;
	fallbackTarget?: string | null;
	headers?: Array<[string, string]>;
	bodyText?: string | null;
	timeoutMs?: number;
	responsePath?: string | null;
	fallbackPath?: string | null;
	streamUsage?: StreamUsageOptions | null;
};

type DispatchAttemptRequest = AttemptRequest & {
	channelId?: string | null;
	streamOptionsInjected?: boolean;
	strippedBodyText?: string | null;
};

type DispatchRequest = {
	attempts?: DispatchAttemptRequest[];
	retryConfig?: RetryConfigPayload | null;
	streamUsage?: StreamUsageOptions | null;
};

type AttemptExecutionResult = {
	response: Response;
	responsePath: string;
	latencyMs: number;
};

type PreparedAttemptPayload = {
	bodyText: string | undefined;
	preflightError: Response | null;
};

type RetryConfigPayload = {
	sleepMs?: number;
	disableErrorCodes?: string[];
	returnErrorCodes?: string[];
	sleepErrorCodes?: string[];
};

type RetryConfig = {
	sleepMs: number;
	disableErrorCodeSet: Set<string>;
	returnErrorCodeSet: Set<string>;
	sleepErrorCodeSet: Set<string>;
};

const attempt = new Hono<AppEnv>();

function supportsAbortSignalEvents(
	signal?: AbortSignal | null,
): signal is AbortSignal {
	return (
		typeof signal?.addEventListener === "function" &&
		typeof signal?.removeEventListener === "function"
	);
}

function normalizeRequestId(headers: Headers): string | null {
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
			if (supportsAbortSignalEvents(signal)) {
				signal.removeEventListener("abort", onAbort);
			}
		};
		if (supportsAbortSignalEvents(signal)) {
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function normalizeRetryErrorCode(value: string | null): string {
	return normalizeMessage(value)?.toLowerCase() ?? "";
}

function normalizeRetryErrorCodeList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const normalized = value
		.filter((item) => typeof item === "string")
		.map((item) => normalizeRetryErrorCode(item as string))
		.filter((item) => item.length > 0);
	return Array.from(new Set(normalized));
}

function normalizeRetryConfig(
	payload: RetryConfigPayload | null | undefined,
): RetryConfig {
	const sleepRaw = Number(payload?.sleepMs ?? 0);
	const sleepMs =
		Number.isFinite(sleepRaw) && sleepRaw >= 0 ? Math.floor(sleepRaw) : 0;
	return {
		sleepMs,
		disableErrorCodeSet: buildProxyErrorCodeSet(
			normalizeRetryErrorCodeList(payload?.disableErrorCodes),
		),
		returnErrorCodeSet: buildProxyErrorCodeSet(
			normalizeRetryErrorCodeList(payload?.returnErrorCodes),
		),
		sleepErrorCodeSet: buildProxyErrorCodeSet(
			normalizeRetryErrorCodeList(payload?.sleepErrorCodes),
		),
	};
}

function resolveRetryDecision(
	retryConfig: RetryConfig,
	errorCode: string | null,
	errorMessage: string | null,
): {
	action: "retry" | "sleep" | "disable" | "return";
	sleepMs: number;
} {
	const action = resolveProxyErrorAction(
		{
			sleepErrorCodeSet: retryConfig.sleepErrorCodeSet,
			disableErrorCodeSet: retryConfig.disableErrorCodeSet,
			returnErrorCodeSet: retryConfig.returnErrorCodeSet,
		},
		errorCode,
		errorMessage,
	);
	return {
		action,
		sleepMs: action === "sleep" ? retryConfig.sleepMs : 0,
	};
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal | null,
): Promise<Response> {
	if (!signal && timeoutMs <= 0) {
		return fetch(url, init);
	}
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) {
		controller.abort(signal.reason);
	} else if (supportsAbortSignalEvents(signal)) {
		signal.addEventListener("abort", onAbort, { once: true });
	}
	const timer =
		timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
	try {
		return await fetch(url, {
			...init,
			signal: controller.signal,
		});
	} finally {
		if (timer !== null) {
			clearTimeout(timer);
		}
		if (supportsAbortSignalEvents(signal)) {
			signal.removeEventListener("abort", onAbort);
		}
	}
}

async function extractErrorMessage(response: Response): Promise<string | null> {
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		const payload = await response
			.clone()
			.json()
			.catch(() => null);
		if (payload && typeof payload === "object") {
			const record = payload as Record<string, unknown>;
			const error =
				record.error && typeof record.error === "object"
					? (record.error as Record<string, unknown>)
					: null;
			const message =
				typeof error?.message === "string"
					? error.message
					: typeof record.message === "string"
						? record.message
						: null;
			return normalizeMessage(message);
		}
	}
	const text = await response
		.clone()
		.text()
		.catch(() => "");
	return normalizeMessage(text);
}

async function extractErrorCode(response: Response): Promise<string | null> {
	const direct = normalizeMessage(
		response.headers.get(ATTEMPT_ERROR_CODE_HEADER),
	);
	if (direct) {
		return direct;
	}
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		const payload = await response
			.clone()
			.json()
			.catch(() => null);
		if (payload && typeof payload === "object") {
			const record = payload as Record<string, unknown>;
			const error =
				record.error && typeof record.error === "object"
					? (record.error as Record<string, unknown>)
					: null;
			const code =
				typeof error?.code === "string"
					? error.code
					: typeof record.code === "string"
						? record.code
						: null;
			const normalized = normalizeMessage(code);
			if (normalized) {
				return normalized;
			}
		}
	}
	return `upstream_http_${response.status}`;
}

function buildErrorResponse(
	error: unknown,
	responsePath: string,
	latencyMs: number,
): Response {
	const isTimeout =
		error instanceof Error &&
		(error.name === "AbortError" || error.message.includes("upstream_timeout"));
	const errorCode = isTimeout
		? "proxy_upstream_timeout"
		: "proxy_upstream_fetch_exception";
	const outHeaders = new Headers({
		"content-type": "application/json",
	});
	outHeaders.set(ATTEMPT_RESPONSE_PATH_HEADER, responsePath);
	outHeaders.set(ATTEMPT_LATENCY_HEADER, String(latencyMs));
	outHeaders.set(ATTEMPT_ERROR_CODE_HEADER, errorCode);
	return new Response(
		JSON.stringify({
			error: {
				code: errorCode,
				message:
					error instanceof Error && error.message ? error.message : errorCode,
			},
		}),
		{
			status: isTimeout ? 504 : 502,
			headers: outHeaders,
		},
	);
}

function buildClientAbortResponse(
	responsePath: string,
	latencyMs: number,
): Response {
	const outHeaders = new Headers({
		"content-type": "application/json",
	});
	outHeaders.set(ATTEMPT_RESPONSE_PATH_HEADER, responsePath);
	outHeaders.set(ATTEMPT_LATENCY_HEADER, String(latencyMs));
	outHeaders.set(ATTEMPT_ERROR_CODE_HEADER, CLIENT_ABORT_ERROR_CODE);
	return new Response(
		JSON.stringify({
			error: {
				code: CLIENT_ABORT_ERROR_CODE,
				message: CLIENT_ABORT_ERROR_CODE,
			},
		}),
		{
			status: 499,
			headers: outHeaders,
		},
	);
}

function buildValidationErrorResponse(
	responsePath: string,
	latencyMs: number,
	errorCode: string,
	message: string,
): Response {
	const outHeaders = new Headers({
		"content-type": "application/json",
	});
	outHeaders.set(ATTEMPT_RESPONSE_PATH_HEADER, responsePath);
	outHeaders.set(ATTEMPT_LATENCY_HEADER, String(latencyMs));
	outHeaders.set(ATTEMPT_ERROR_CODE_HEADER, errorCode);
	return new Response(
		JSON.stringify({
			error: {
				type: "invalid_request_error",
				param: null,
				code: errorCode,
				message,
			},
		}),
		{
			status: 409,
			headers: outHeaders,
		},
	);
}

function resolveRequestPathForPreflight(
	responsePath: string,
	target: string,
): string {
	if (responsePath.startsWith("/")) {
		return responsePath;
	}
	try {
		return new URL(responsePath).pathname;
	} catch {
		// fall through
	}
	try {
		return new URL(target).pathname;
	} catch {
		return responsePath;
	}
}

function detectOpenAiEndpointType(path: string): "chat" | "responses" | null {
	const normalized = path.toLowerCase();
	if (normalized.endsWith("/v1/chat/completions")) {
		return "chat";
	}
	if (normalized.endsWith("/v1/responses")) {
		return "responses";
	}
	return null;
}

function extractOpenAiResponseIdFromJson(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") {
		return null;
	}
	const record = payload as Record<string, unknown>;
	const objectType = normalizeMessage(
		String(record.object ?? ""),
	)?.toLowerCase();
	if (objectType && objectType !== "response") {
		return null;
	}
	const id = record.id;
	return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

async function extractOpenAiResponseIdFromSse(
	response: Response,
	maxBytes = ATTEMPT_RESPONSE_ID_PARSE_MAX_BYTES,
	timeoutMs = ATTEMPT_RESPONSE_ID_PARSE_TIMEOUT_MS,
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
					(typeof responseObj?.id === "string" && responseObj.id.trim()) ||
					(normalizeMessage(String(parsed.object ?? ""))?.toLowerCase() ===
					"response"
						? normalizeMessage(String(parsed.id ?? ""))
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

async function collectAttemptStreamMeta(
	response: Response,
	responsePath: string,
	streamUsage: StreamUsageOptions | null | undefined,
): Promise<Record<string, string>> {
	const contentType = response.headers.get("content-type") ?? "";
	const endpointType = detectOpenAiEndpointType(responsePath);
	const isStreamResponse = contentType.includes("text/event-stream");
	const meta: Record<string, string> = {};
	if (!response.ok) {
		return meta;
	}

	if (endpointType === "responses") {
		let responseId: string | null = null;
		if (isStreamResponse) {
			responseId = await extractOpenAiResponseIdFromSse(response.clone());
		} else if (contentType.includes("application/json")) {
			const payload = await response
				.clone()
				.json()
				.catch(() => null);
			responseId = extractOpenAiResponseIdFromJson(payload);
		}
		if (responseId) {
			meta[ATTEMPT_RESPONSE_ID_HEADER] = responseId;
		}
	}

	if (!isStreamResponse || !endpointType) {
		return meta;
	}

	meta[ATTEMPT_STREAM_USAGE_PROCESSED_HEADER] = "1";
	const mode = normalizeProxyStreamUsageMode(streamUsage?.mode);
	let usage = parseUsageFromHeaders(response.headers);
	let firstTokenLatencyMs: number | null = null;
	let streamMetaPartial = false;
	let streamMetaReason: string | null = null;
	let eventsSeen = 0;

	if (!usage && shouldParseSuccessStreamUsage(mode)) {
		const parsedStreamUsage = await parseUsageFromSse(response.clone(), {
			mode,
			timeoutMs:
				streamUsage?.timeoutMs ?? ATTEMPT_STREAM_USAGE_PARSE_TIMEOUT_MS,
		}).catch(() => null);
		if (parsedStreamUsage) {
			usage = parsedStreamUsage.usage;
			firstTokenLatencyMs = parsedStreamUsage.firstTokenLatencyMs;
			eventsSeen = parsedStreamUsage.eventsSeen ?? 0;
			if (parsedStreamUsage.abnormal) {
				meta[ATTEMPT_STREAM_ERROR_CODE_HEADER] =
					parsedStreamUsage.abnormal.errorCode;
				meta[ATTEMPT_STREAM_ERROR_MESSAGE_HEADER] =
					parsedStreamUsage.abnormal.errorMessage;
			}
			streamMetaPartial = shouldMarkStreamMetaPartial({
				mode,
				hasImmediateUsage: false,
				hasParsedUsage: Boolean(parsedStreamUsage.usage),
				eventsSeen: parsedStreamUsage.eventsSeen,
			});
			if (streamMetaPartial) {
				streamMetaReason = resolveStreamMetaPartialReason({
					mode,
					timedOut: parsedStreamUsage.timedOut,
					eventsSeen: parsedStreamUsage.eventsSeen,
				});
			}
		}
	} else if (!usage) {
		streamMetaPartial = shouldMarkStreamMetaPartial({
			mode,
			hasImmediateUsage: false,
			hasParsedUsage: false,
		});
		if (streamMetaPartial) {
			streamMetaReason = resolveStreamMetaPartialReason({ mode });
		}
	}

	if (eventsSeen > 0) {
		meta[ATTEMPT_STREAM_EVENTS_SEEN_HEADER] = String(eventsSeen);
	}
	if (usage) {
		meta["x-usage-total-tokens"] = String(usage.totalTokens);
		meta["x-usage-prompt-tokens"] = String(usage.promptTokens);
		meta["x-usage-completion-tokens"] = String(usage.completionTokens);
	}
	if (firstTokenLatencyMs !== null && Number.isFinite(firstTokenLatencyMs)) {
		meta[ATTEMPT_STREAM_FIRST_TOKEN_LATENCY_HEADER] = String(
			Math.max(0, Math.floor(firstTokenLatencyMs)),
		);
	}
	if (streamMetaPartial) {
		meta[ATTEMPT_STREAM_META_PARTIAL_HEADER] = "1";
		if (streamMetaReason) {
			meta[ATTEMPT_STREAM_META_REASON_HEADER] = streamMetaReason;
		}
	}
	return meta;
}

function parseJsonObjectBody(bodyText: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(bodyText) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

function preflightOpenAiToolChain(
	requestPath: string,
	bodyText: string | undefined,
	latencyMs: number,
): PreparedAttemptPayload {
	if (!bodyText) {
		return {
			bodyText,
			preflightError: null,
		};
	}
	const endpointType = detectOpenAiEndpointType(requestPath);
	if (!endpointType) {
		return {
			bodyText,
			preflightError: null,
		};
	}
	const parsedBody = parseJsonObjectBody(bodyText);
	if (!parsedBody) {
		return {
			bodyText,
			preflightError: null,
		};
	}
	repairOpenAiToolCallChain(parsedBody, endpointType);
	const hints =
		endpointType === "responses"
			? extractResponsesRequestHints(parsedBody)
			: null;
	const issue = validateOpenAiToolCallChain(parsedBody, endpointType, hints);
	if (issue) {
		return {
			bodyText,
			preflightError: buildValidationErrorResponse(
				requestPath,
				latencyMs,
				issue.code,
				issue.message,
			),
		};
	}
	return {
		bodyText: JSON.stringify(parsedBody),
		preflightError: null,
	};
}

async function executeSingleAttempt(
	body: AttemptRequest,
	overrideBodyText?: string | null,
	callerSignal?: AbortSignal | null,
): Promise<AttemptExecutionResult> {
	const start = Date.now();
	const timeoutMs = Math.max(0, Math.floor(Number(body.timeoutMs ?? 0)));
	const headers = new Headers();
	for (const [key, value] of body.headers ?? []) {
		headers.set(key, value);
	}
	const sanitizedHeaders = sanitizeUpstreamRequestHeaders(headers);
	sanitizedHeaders.delete("host");
	sanitizedHeaders.delete("content-length");

	const requestInit: RequestInit = {
		method: body.method,
		headers: sanitizedHeaders,
		body: undefined,
	};
	let responsePath = body.responsePath?.trim() || body.target;
	const requestPath = resolveRequestPathForPreflight(responsePath, body.target);
	const prepared = preflightOpenAiToolChain(
		requestPath,
		overrideBodyText ?? body.bodyText ?? undefined,
		Date.now() - start,
	);
	if (prepared.preflightError) {
		return {
			response: prepared.preflightError,
			responsePath,
			latencyMs: Date.now() - start,
		};
	}
	requestInit.body = prepared.bodyText;
	try {
		let response = await fetchWithTimeout(
			body.target,
			requestInit,
			timeoutMs,
			callerSignal,
		);
		if (
			(response.status === 400 || response.status === 404) &&
			body.fallbackTarget
		) {
			response = await fetchWithTimeout(
				body.fallbackTarget,
				requestInit,
				timeoutMs,
				callerSignal,
			);
			responsePath = body.fallbackPath?.trim() || body.fallbackTarget;
		}
		return {
			response,
			responsePath,
			latencyMs: Date.now() - start,
		};
	} catch (error) {
		if (callerSignal?.aborted) {
			return {
				response: buildClientAbortResponse(responsePath, Date.now() - start),
				responsePath,
				latencyMs: Date.now() - start,
			};
		}
		return {
			response: buildErrorResponse(error, responsePath, Date.now() - start),
			responsePath,
			latencyMs: Date.now() - start,
		};
	}
}

async function attachAttemptHeaders(
	source: AttemptExecutionResult,
	streamUsage: StreamUsageOptions | null | undefined,
	extraHeaders?: Record<string, string>,
): Promise<Response> {
	const outHeaders = new Headers(source.response.headers);
	outHeaders.set(ATTEMPT_RESPONSE_PATH_HEADER, source.responsePath);
	outHeaders.set(ATTEMPT_LATENCY_HEADER, String(source.latencyMs));
	const upstreamRequestId = normalizeRequestId(source.response.headers);
	if (upstreamRequestId) {
		outHeaders.set(ATTEMPT_UPSTREAM_REQUEST_ID_HEADER, upstreamRequestId);
	}
	const streamMetaHeaders = await collectAttemptStreamMeta(
		source.response,
		source.responsePath,
		streamUsage,
	);
	for (const [key, value] of Object.entries(streamMetaHeaders)) {
		outHeaders.set(key, value);
	}
	if (extraHeaders) {
		for (const [key, value] of Object.entries(extraHeaders)) {
			outHeaders.set(key, value);
		}
	}
	return new Response(source.response.body, {
		status: source.response.status,
		statusText: source.response.statusText,
		headers: outHeaders,
	});
}

attempt.post("/", async (c) => {
	const body = await c.req.json<AttemptRequest>().catch(() => null);
	if (!body?.target || !body?.method) {
		return c.json({ error: "invalid_attempt_payload" }, 400);
	}
	const result = await executeSingleAttempt(body, undefined, c.req.raw.signal);
	return attachAttemptHeaders(result, body.streamUsage);
});

attempt.post("/dispatch", async (c) => {
	const body = await c.req.json<DispatchRequest>().catch(() => null);
	const callerSignal = c.req.raw.signal;
	const attempts = Array.isArray(body?.attempts) ? body.attempts : [];
	const retryConfig = normalizeRetryConfig(body?.retryConfig);
	if (attempts.length === 0) {
		return c.json({ error: "invalid_dispatch_payload" }, 400);
	}
	let lastResult: {
		result: AttemptExecutionResult;
		attemptIndex: number;
		channelId: string;
	} | null = null;
	const blockedChannelIds = new Set<string>();
	for (
		let attemptIndex = 0;
		attemptIndex < attempts.length;
		attemptIndex += 1
	) {
		const item = attempts[attemptIndex];
		if (callerSignal?.aborted === true) {
			return attachAttemptHeaders(
				{
					response: buildClientAbortResponse(
						item?.responsePath?.trim() || item?.target || "/dispatch",
						0,
					),
					responsePath:
						item?.responsePath?.trim() || item?.target || "/dispatch",
					latencyMs: 0,
				},
				body?.streamUsage,
				{
					[DISPATCH_ATTEMPT_INDEX_HEADER]: String(
						Math.max(0, attemptIndex - 1),
					),
					[DISPATCH_CHANNEL_ID_HEADER]: lastResult?.channelId ?? "",
					[DISPATCH_STOP_RETRY_HEADER]: "1",
					[DISPATCH_ERROR_ACTION_HEADER]: "return",
				},
			);
		}
		if (!item?.target || !item?.method) {
			continue;
		}
		const channelId = String(item.channelId ?? "");
		if (channelId && blockedChannelIds.has(channelId)) {
			continue;
		}
		let result = await executeSingleAttempt(item, undefined, callerSignal);
		if (
			item.streamOptionsInjected &&
			item.strippedBodyText &&
			!result.response.ok
		) {
			const message = await extractErrorMessage(result.response);
			if (isStreamOptionsUnsupportedMessage(message)) {
				result = await executeSingleAttempt(
					item,
					item.strippedBodyText,
					callerSignal,
				);
			}
		}
		lastResult = {
			result,
			attemptIndex,
			channelId,
		};
		if (Boolean(callerSignal?.aborted) || result.response.status === 499) {
			return attachAttemptHeaders(result, body?.streamUsage, {
				[DISPATCH_ATTEMPT_INDEX_HEADER]: String(attemptIndex),
				[DISPATCH_CHANNEL_ID_HEADER]: channelId,
				[DISPATCH_STOP_RETRY_HEADER]: "1",
				[DISPATCH_ERROR_ACTION_HEADER]: "return",
			});
		}
		if (result.response.ok) {
			return attachAttemptHeaders(result, body?.streamUsage, {
				[DISPATCH_ATTEMPT_INDEX_HEADER]: String(attemptIndex),
				[DISPATCH_CHANNEL_ID_HEADER]: channelId,
			});
		}
		const errorCode = await extractErrorCode(result.response);
		const errorMessage = await extractErrorMessage(result.response);
		const hasNextAttempt = attemptIndex + 1 < attempts.length;
		if (hasNextAttempt) {
			const decision = resolveRetryDecision(
				retryConfig,
				errorCode,
				errorMessage,
			);
			if (decision.action === "return") {
				return attachAttemptHeaders(result, body?.streamUsage, {
					[DISPATCH_ATTEMPT_INDEX_HEADER]: String(attemptIndex),
					[DISPATCH_CHANNEL_ID_HEADER]: channelId,
					[DISPATCH_STOP_RETRY_HEADER]: "1",
					[DISPATCH_ERROR_ACTION_HEADER]: "return",
				});
			}
			if (decision.action === "disable") {
				if (channelId) {
					blockedChannelIds.add(channelId);
				}
				return attachAttemptHeaders(result, body?.streamUsage, {
					[DISPATCH_ATTEMPT_INDEX_HEADER]: String(attemptIndex),
					[DISPATCH_CHANNEL_ID_HEADER]: channelId,
					[DISPATCH_ERROR_ACTION_HEADER]: "disable",
				});
			}
			if (decision.sleepMs > 0) {
				const completedSleep = await sleep(decision.sleepMs, callerSignal);
				if (!completedSleep) {
					return attachAttemptHeaders(
						{
							response: buildClientAbortResponse(result.responsePath, 0),
							responsePath: result.responsePath,
							latencyMs: 0,
						},
						body?.streamUsage,
						{
							[DISPATCH_ATTEMPT_INDEX_HEADER]: String(attemptIndex),
							[DISPATCH_CHANNEL_ID_HEADER]: channelId,
							[DISPATCH_STOP_RETRY_HEADER]: "1",
							[DISPATCH_ERROR_ACTION_HEADER]: "return",
						},
					);
				}
			}
		}
	}
	if (callerSignal?.aborted === true) {
		const responsePath =
			lastResult?.result.responsePath ??
			attempts[0]?.responsePath?.trim() ??
			attempts[0]?.target ??
			"/dispatch";
		return attachAttemptHeaders(
			{
				response: buildClientAbortResponse(responsePath, 0),
				responsePath,
				latencyMs: 0,
			},
			body?.streamUsage,
			{
				[DISPATCH_ATTEMPT_INDEX_HEADER]: String(lastResult?.attemptIndex ?? 0),
				[DISPATCH_CHANNEL_ID_HEADER]: lastResult?.channelId ?? "",
				[DISPATCH_STOP_RETRY_HEADER]: "1",
				[DISPATCH_ERROR_ACTION_HEADER]: "return",
			},
		);
	}
	if (!lastResult) {
		return c.json({ error: "dispatch_no_valid_attempt" }, 400);
	}
	const lastErrorCode = await extractErrorCode(lastResult.result.response);
	const lastErrorMessage = await extractErrorMessage(
		lastResult.result.response,
	);
	const shouldStopRetry =
		resolveRetryDecision(retryConfig, lastErrorCode, lastErrorMessage)
			.action === "return";
	return attachAttemptHeaders(lastResult.result, body?.streamUsage, {
		[DISPATCH_ATTEMPT_INDEX_HEADER]: String(lastResult.attemptIndex),
		[DISPATCH_CHANNEL_ID_HEADER]: lastResult.channelId,
		...(shouldStopRetry ? { [DISPATCH_STOP_RETRY_HEADER]: "1" } : {}),
	});
});

export default attempt;
