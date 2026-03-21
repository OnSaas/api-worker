import {
	normalizeUsageViaWasm,
	parseUsageFromJsonViaWasm,
	parseUsageFromSseLineViaWasm,
} from "../wasm/core";
import { safeJsonParse } from "./json";

export type NormalizedUsage = {
	totalTokens: number;
	promptTokens: number;
	completionTokens: number;
};

export type StreamUsage = {
	usage: NormalizedUsage | null;
	firstTokenLatencyMs: number | null;
	timedOut?: boolean;
};

export type StreamUsageMode = "full" | "lite" | "off";

export type StreamUsageOptions = {
	mode?: StreamUsageMode;
	maxBytes?: number;
	timeoutMs?: number;
};

export type StreamUsageParseErrorCode =
	| "usage_stream_reader_failed"
	| "usage_sse_line_parse_failed"
	| "usage_sse_tail_parse_failed";

export class StreamUsageParseError extends Error {
	code: StreamUsageParseErrorCode;
	detail: string | null;

	constructor(code: StreamUsageParseErrorCode, detail?: string | null) {
		super(code);
		this.name = "StreamUsageParseError";
		this.code = code;
		this.detail = detail ?? null;
	}
}

const USAGE_HINTS = ['"usage"', '"usageMetadata"', '"usage_metadata"'];

function normalizeErrorDetail(error: unknown): string | null {
	if (error instanceof Error) {
		const text = error.message.trim();
		return text.length > 0 ? text : error.name;
	}
	if (typeof error === "string") {
		const text = error.trim();
		return text.length > 0 ? text : null;
	}
	return null;
}

function isAbortLikeError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const message = error.message.toLowerCase();
	return (
		error.name === "AbortError" ||
		message.includes("abort") ||
		message.includes("cancel")
	);
}

function toNumber(value: unknown): number | null {
	if (value === null || value === undefined) {
		return null;
	}
	const num = Number(value);
	return Number.isFinite(num) ? num : null;
}

function pickNumber(...values: Array<unknown>): number | null {
	for (const value of values) {
		const parsed = toNumber(value);
		if (parsed !== null) {
			return parsed;
		}
	}
	return null;
}

export function normalizeUsage(raw: unknown): NormalizedUsage | null {
	return normalizeUsageViaWasm(raw);
}

export function parseUsageFromJson(payload: unknown): NormalizedUsage | null {
	return parseUsageFromJsonViaWasm(payload);
}

export function parseUsageFromHeaders(
	headers: Headers,
): NormalizedUsage | null {
	const jsonHeader = headers.get("x-usage") ?? headers.get("x-openai-usage");
	if (jsonHeader) {
		const parsed = safeJsonParse<unknown>(jsonHeader, null);
		const normalized = normalizeUsage(parsed);
		if (normalized) {
			return normalized;
		}
	}

	const totalTokens = pickNumber(
		headers.get("x-usage-total-tokens"),
		headers.get("x-openai-usage-total-tokens"),
	);
	const promptTokens = pickNumber(
		headers.get("x-usage-prompt-tokens"),
		headers.get("x-openai-usage-prompt-tokens"),
	);
	const completionTokens = pickNumber(
		headers.get("x-usage-completion-tokens"),
		headers.get("x-openai-usage-completion-tokens"),
	);

	if (
		totalTokens === null &&
		promptTokens === null &&
		completionTokens === null
	) {
		return null;
	}

	return {
		totalTokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
		promptTokens: promptTokens ?? 0,
		completionTokens: completionTokens ?? 0,
	};
}

export async function parseUsageFromSse(
	response: Response,
	options: StreamUsageOptions = {},
): Promise<StreamUsage> {
	if (!response.body) {
		return { usage: null, firstTokenLatencyMs: null, timedOut: false };
	}
	const mode: StreamUsageMode = options.mode ?? "full";
	if (mode === "off") {
		return { usage: null, firstTokenLatencyMs: null, timedOut: false };
	}
	const maxBytes =
		typeof options.maxBytes === "number" && options.maxBytes > 0
			? options.maxBytes
			: Number.POSITIVE_INFINITY;
	const reader = response.body.getReader();
	const timeoutMs =
		typeof options.timeoutMs === "number" && options.timeoutMs > 0
			? Math.floor(options.timeoutMs)
			: 0;
	let timedOut = false;
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	if (timeoutMs > 0) {
		timeoutId = setTimeout(() => {
			timedOut = true;
			reader.cancel().catch(() => undefined);
		}, timeoutMs);
	}
	const decoder = new TextDecoder();
	let buffer = "";
	let usage: NormalizedUsage | null = null;
	const start = Date.now();
	let firstTokenLatencyMs: number | null = null;
	let bytesRead = 0;

	const payloadMayContainUsage = (payload: string): boolean => {
		if (!payload) {
			return false;
		}
		return USAGE_HINTS.some((hint) => payload.includes(hint));
	};

	while (true) {
		let chunk: ReadableStreamReadResult<Uint8Array>;
		try {
			chunk = await reader.read();
		} catch (error) {
			if (timedOut || isAbortLikeError(error)) {
				break;
			}
			throw new StreamUsageParseError(
				"usage_stream_reader_failed",
				normalizeErrorDetail(error),
			);
		}
		const { done, value } = chunk;
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
			if (line.startsWith("data:")) {
				const payload = line.slice(5).trim();
				if (payload && payload !== "[DONE]") {
					if (firstTokenLatencyMs === null) {
						firstTokenLatencyMs = Date.now() - start;
					}
					if (mode === "lite" && !payloadMayContainUsage(payload)) {
						newlineIndex = buffer.indexOf("\n");
						continue;
					}
					let wasmCandidate: NormalizedUsage | null = null;
					try {
						wasmCandidate = parseUsageFromSseLineViaWasm(line);
					} catch (error) {
						throw new StreamUsageParseError(
							"usage_sse_line_parse_failed",
							normalizeErrorDetail(error),
						);
					}
					if (wasmCandidate) {
						usage = wasmCandidate;
						if (mode === "lite") {
							await reader.cancel();
							if (timeoutId) {
								clearTimeout(timeoutId);
							}
							return { usage, firstTokenLatencyMs, timedOut };
						}
						newlineIndex = buffer.indexOf("\n");
						continue;
					}
				}
			}
			newlineIndex = buffer.indexOf("\n");
		}
	}

	const remaining = buffer.trim();
	if (remaining.startsWith("data:")) {
		const payload = remaining.slice(5).trim();
		if (payload && payload !== "[DONE]") {
			if (firstTokenLatencyMs === null) {
				firstTokenLatencyMs = Date.now() - start;
			}
			if (mode === "lite" && !payloadMayContainUsage(payload)) {
				return { usage, firstTokenLatencyMs, timedOut };
			}
			let wasmCandidate: NormalizedUsage | null = null;
			try {
				wasmCandidate = parseUsageFromSseLineViaWasm(remaining);
			} catch (error) {
				throw new StreamUsageParseError(
					"usage_sse_tail_parse_failed",
					normalizeErrorDetail(error),
				);
			}
			if (wasmCandidate) {
				usage = wasmCandidate;
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
				return { usage, firstTokenLatencyMs, timedOut };
			}
		}
	}

	if (timeoutId) {
		clearTimeout(timeoutId);
	}
	return { usage, firstTokenLatencyMs, timedOut };
}
