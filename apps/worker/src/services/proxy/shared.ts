import { normalizeProxyStreamUsageMode } from "../../../../shared-core/src";
import { type ChannelRecord, createWeightedOrder } from "../channels";
import type { EndpointType } from "../provider-transform";
import type { StreamUsageMode, StreamUsageOptions } from "../../utils/usage";

export type ExecutionContextLike = {
	waitUntil: (promise: Promise<unknown>) => void;
};

export type ErrorDetails = {
	upstreamStatus: number | null;
	errorCode: string | null;
	errorMessage: string | null;
	errorMetaJson?: string | null;
};

export type AttemptFailureDetail = {
	attemptIndex: number;
	channelId: string | null;
	channelName: string | null;
	httpStatus: number | null;
	errorCode: string;
	errorMessage: string;
	latencyMs: number;
};

export function scheduleDbWrite(
	c: { executionCtx?: ExecutionContextLike },
	task: Promise<void>,
): void {
	if (c.executionCtx?.waitUntil) {
		c.executionCtx.waitUntil(task);
	} else {
		task.catch(() => undefined);
	}
}

export function normalizeMessage(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function normalizeSummaryDetail(
	value: string,
	maxLength: number,
): string {
	const normalized = value.trim();
	if (!normalized) {
		return "-";
	}
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function normalizeStringField(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function supportsAbortSignalEvents(
	signal?: AbortSignal | null,
): signal is AbortSignal {
	return (
		typeof signal?.addEventListener === "function" &&
		typeof signal?.removeEventListener === "function"
	);
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

export function mergeErrorMetaJson(
	baseJson: string | null | undefined,
	extra: Record<string, unknown>,
): string | null {
	const base = baseJson
		? (() => {
				try {
					const parsed = JSON.parse(baseJson);
					return parsed && typeof parsed === "object" && !Array.isArray(parsed)
						? (parsed as Record<string, unknown>)
						: {};
				} catch {
					return {};
				}
			})()
		: {};
	try {
		return JSON.stringify({
			...base,
			...extra,
		});
	} catch {
		return baseJson ?? null;
	}
}

export function buildUpstreamDiagnosticMeta(options: {
	target: string;
	fallbackTarget?: string | null;
	requestHeaders: Headers;
	response: Response;
}): Record<string, unknown> {
	return {
		upstream_target: options.target,
		upstream_fallback_target: options.fallbackTarget ?? null,
		request_headers: snapshotHeaders(options.requestHeaders),
		response_status_text: options.response.statusText || null,
		response_headers: snapshotHeaders(options.response.headers),
	};
}

export function buildAttemptFailureSummary(failures: AttemptFailureDetail[]): {
	statusCounts: Record<string, number>;
	codeCounts: Record<string, number>;
	topReason: string | null;
} {
	const statusCounts: Record<string, number> = {};
	const codeCounts: Record<string, number> = {};
	for (const failure of failures) {
		const statusKey =
			failure.httpStatus === null ? "network" : String(failure.httpStatus);
		statusCounts[statusKey] = (statusCounts[statusKey] ?? 0) + 1;
		codeCounts[failure.errorCode] = (codeCounts[failure.errorCode] ?? 0) + 1;
	}
	const topReason =
		Object.entries(codeCounts).sort(
			(left, right) => right[1] - left[1],
		)[0]?.[0] ?? null;
	return {
		statusCounts,
		codeCounts,
		topReason,
	};
}

export function shouldTreatZeroCompletionAsError(options: {
	enabled: boolean;
	endpointType: EndpointType;
	usage: { completionTokens?: number | null } | null;
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
	return options.usage.completionTokens === 0;
}

export function stringifyErrorMeta(
	meta: Record<string, unknown>,
): string | null {
	try {
		return JSON.stringify(meta);
	} catch {
		return null;
	}
}

export function formatUsageErrorMessage(
	code: string,
	detail: string | null,
	maxLength: number,
): string {
	const normalized = normalizeMessage(detail);
	if (!normalized) {
		return code;
	}
	return `${code}: ${normalizeSummaryDetail(normalized, maxLength)}`;
}

export function normalizeUpstreamErrorCode(
	errorCode: string | null,
	status: number,
): string {
	const normalized = normalizeMessage(errorCode);
	if (normalized) {
		return normalized;
	}
	return `upstream_http_${status}`;
}

export function sleep(
	delayMs: number,
	signal?: AbortSignal | null,
): Promise<boolean> {
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

export function buildAttemptSequence(
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

export function getStreamUsageOptions(settings: {
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

export function getStreamUsageMaxParsers(settings: {
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

export function getStreamUsageParseTimeoutMs(settings: {
	stream_usage_parse_timeout_ms: number;
}): number {
	return Math.max(0, Math.floor(settings.stream_usage_parse_timeout_ms));
}
