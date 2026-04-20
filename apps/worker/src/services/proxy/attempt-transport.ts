import type { AppEnv } from "../../env";
import type { ProxyErrorAction } from "../proxy-error-policy";
import type {
	StreamAbnormalSuccess,
	StreamUsageOptions,
} from "../../utils/usage";
import {
	normalizeMessage,
	normalizeStringField,
	supportsAbortSignalEvents,
} from "./shared";

export const ATTEMPT_BINDING_RESPONSE_PATH_HEADER =
	"x-ha-attempt-response-path";
export const ATTEMPT_BINDING_LATENCY_HEADER = "x-ha-attempt-latency-ms";
export const ATTEMPT_BINDING_UPSTREAM_REQUEST_ID_HEADER =
	"x-ha-attempt-upstream-request-id";
export const ATTEMPT_DISPATCH_ERROR_ACTION_HEADER =
	"x-ha-dispatch-error-action";
export const ATTEMPT_ERROR_CODE_HEADER = "x-ha-attempt-error-code";
export const ATTEMPT_STREAM_USAGE_PROCESSED_HEADER =
	"x-ha-attempt-stream-usage-processed";
export const ATTEMPT_STREAM_FIRST_TOKEN_LATENCY_HEADER =
	"x-ha-attempt-stream-first-token-latency-ms";
export const ATTEMPT_STREAM_META_PARTIAL_HEADER =
	"x-ha-attempt-stream-meta-partial";
export const ATTEMPT_STREAM_META_REASON_HEADER =
	"x-ha-attempt-stream-meta-reason";
export const ATTEMPT_STREAM_EVENTS_SEEN_HEADER =
	"x-ha-attempt-stream-events-seen";
export const ATTEMPT_STREAM_ERROR_CODE_HEADER =
	"x-ha-attempt-stream-error-code";
export const ATTEMPT_STREAM_ERROR_MESSAGE_HEADER =
	"x-ha-attempt-stream-error-message";
export const ATTEMPT_RESPONSE_ID_HEADER = "x-ha-attempt-response-id";
export const ATTEMPT_DISPATCH_INDEX_HEADER = "x-ha-dispatch-attempt-index";
export const ATTEMPT_DISPATCH_CHANNEL_ID_HEADER = "x-ha-dispatch-channel-id";
export const ATTEMPT_DISPATCH_STOP_RETRY_HEADER = "x-ha-dispatch-stop-retry";

const ATTEMPT_BINDING_DISPATCH_ERROR_CODE =
	"attempt_binding_dispatch_unavailable";
const ATTEMPT_BINDING_ATTEMPT_ERROR_CODE = "attempt_binding_call_unavailable";

export type AttemptBindingRequest = {
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

export type AttemptDispatchRequest = {
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

export type DispatchRetryConfig = {
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

export type AttemptBindingResult =
	| AttemptBindingSuccess
	| AttemptBindingFailure
	| AttemptBindingAborted
	| AttemptWorkerInternalError;

export type DispatchBindingResult =
	| DispatchBindingSuccess
	| AttemptBindingFailure
	| AttemptWorkerInternalError;

export type AttemptBindingPolicy = {
	fallbackEnabled: boolean;
	fallbackThreshold: number;
};

export type AttemptBindingState = {
	forceLocalDirect: boolean;
	bindingFailureCount: number;
};

async function fetchWithTimeoutLocal(
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

export function parseOptionalLatencyHeader(
	value: string | null,
): number | null {
	if (!value) {
		return null;
	}
	const parsed = Number(value);
	if (Number.isNaN(parsed) || parsed < 0) {
		return null;
	}
	return Math.floor(parsed);
}

export function parseOptionalCountHeader(value: string | null): number | null {
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

export function parseBooleanHeader(value: string | null): boolean {
	if (!value) {
		return false;
	}
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function readAttemptStreamAbnormal(
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

export function normalizeAttemptWorkerBaseUrl(
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

export async function executeAttemptViaWorker(
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

export async function executeDispatchViaWorker(
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
