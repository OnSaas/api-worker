import { safeJsonParse } from "../utils/json";
import * as wasm from "./generated/worker_wasm_core";
import { initSync } from "./generated/worker_wasm_core";
import wasmModule from "./generated/worker_wasm_core_bg.wasm";

type NormalizedUsageLike = {
	totalTokens: number;
	promptTokens: number;
	completionTokens: number;
};

type GeminiUsageTokensLike = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
};

export type AdaptedSseLine = {
	text?: string | null;
	stopReason?: string | null;
	finishReason?: string | null;
	eventType?: string | null;
	outputTokens?: number | null;
};

const toJson = (value: unknown): string => {
	try {
		return JSON.stringify(value);
	} catch {
		return "null";
	}
};

const randomSeed = (): bigint => {
	try {
		const values = new BigUint64Array(1);
		crypto.getRandomValues(values);
		const value = values[0];
		return value === 0n ? 1n : value;
	} catch {
		const fallback = BigInt(Date.now());
		return fallback === 0n ? 1n : fallback;
	}
};

let wasmCoreInitialized = false;

const ensureWasmCoreInitialized = (): void => {
	if (wasmCoreInitialized) {
		return;
	}
	initSync({ module: wasmModule });
	wasmCoreInitialized = true;
};

export const warmupWasmCore = (): void => {
	ensureWasmCoreInitialized();
};

export const normalizeUsageViaWasm = (
	raw: unknown,
): NormalizedUsageLike | null =>
	safeJsonParse<NormalizedUsageLike | null>(
		wasm.normalize_usage(toJson(raw)),
		null,
	);

export const parseUsageFromJsonViaWasm = (
	payload: unknown,
): NormalizedUsageLike | null =>
	safeJsonParse<NormalizedUsageLike | null>(
		wasm.parse_usage_from_json(toJson(payload)),
		null,
	);

export const parseUsageFromSseLineViaWasm = (
	line: string,
): NormalizedUsageLike | null =>
	safeJsonParse<NormalizedUsageLike | null>(
		wasm.parse_usage_from_sse_line(line),
		null,
	);

export const createWeightedOrderIndicesViaWasm = (
	weights: number[],
): number[] | null =>
	safeJsonParse<number[] | null>(
		wasm.create_weighted_order(toJson(weights), randomSeed()),
		null,
	);

export const mapFinishReasonViaWasm = (
	kind:
		| "openai_to_anthropic"
		| "anthropic_to_openai"
		| "gemini_to_openai"
		| "gemini_to_anthropic"
		| "openai_to_gemini"
		| "anthropic_to_gemini",
	reason: unknown,
): string | null => {
	if (typeof reason !== "string") {
		return null;
	}
	const output = wasm.map_finish_reason(kind, reason);
	return output.length > 0 ? output : null;
};

export const geminiUsageTokensViaWasm = (
	payload: Record<string, unknown>,
): GeminiUsageTokensLike | null =>
	safeJsonParse<GeminiUsageTokensLike | null>(
		wasm.gemini_usage_tokens_json(toJson(payload)),
		null,
	);

export const detectDownstreamProviderViaWasm = (path: string): string =>
	wasm.detect_downstream_provider(path);

export const detectEndpointTypeViaWasm = (
	provider: string,
	path: string,
): string => wasm.detect_endpoint_type(provider, path);

export const parseDownstreamModelViaWasm = (
	provider: string,
	path: string,
	body: Record<string, unknown> | null,
): string | null => {
	const output = wasm.parse_downstream_model(
		provider,
		path,
		toJson(body ?? {}),
	);
	return output.length > 0 ? output : null;
};

export const parseDownstreamStreamViaWasm = (
	provider: string,
	path: string,
	body: Record<string, unknown> | null,
): boolean => wasm.parse_downstream_stream(provider, path, toJson(body ?? {}));

export const applyGeminiModelToPathViaWasm = (
	path: string,
	model: string | null,
): string => wasm.apply_gemini_model_to_path(path, model ?? "");

export const normalizeChatRequestViaWasm = <T>(
	payload: Record<string, unknown> | null,
	provider: string,
	endpoint: string,
	model: string | null,
	isStream: boolean,
): T | null =>
	safeJsonParse<T | null>(
		wasm.normalize_chat_request(
			toJson(payload ?? {}),
			provider,
			endpoint,
			model ?? "",
			isStream,
		),
		null,
	);

export const buildUpstreamChatRequestViaWasm = <T>(
	payload: Record<string, unknown> | null,
	provider: string,
	model: string | null,
	endpoint: string,
	isStream: boolean,
	endpointOverrides: Record<string, unknown> | null,
): T | null =>
	safeJsonParse<T | null>(
		wasm.build_upstream_chat_request(
			toJson(payload ?? {}),
			provider,
			model ?? "",
			endpoint,
			isStream,
			toJson(endpointOverrides ?? {}),
		),
		null,
	);

export const adaptChatJsonViaWasm = (
	direction:
		| "openai_to_anthropic"
		| "anthropic_to_openai"
		| "gemini_to_openai"
		| "gemini_to_anthropic"
		| "openai_to_gemini"
		| "anthropic_to_gemini",
	payload: Record<string, unknown>,
	model: string | null,
): Record<string, unknown> | null =>
	safeJsonParse<Record<string, unknown> | null>(
		wasm.adapt_chat_json(
			direction,
			toJson(payload),
			model ?? "",
			BigInt(Date.now()),
		),
		null,
	);

export const adaptSseLineViaWasm = (
	payload: Record<string, unknown>,
	upstream: string,
	downstream: string,
	model: string | null,
): AdaptedSseLine | null =>
	safeJsonParse<AdaptedSseLine | null>(
		wasm.adapt_sse_line(toJson(payload), upstream, downstream, model ?? ""),
		null,
	);
