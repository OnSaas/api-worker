/* tslint:disable */
/* eslint-disable */

export function adapt_chat_json(direction: string, payload_json: string, model: string, now_ms: bigint): string;

export function adapt_sse_line(payload_json: string, upstream: string, downstream: string, _model: string): string;

export function apply_gemini_model_to_path(path: string, model: string): string;

export function build_upstream_chat_request(payload_json: string, provider: string, model: string, endpoint: string, is_stream: boolean, endpoint_overrides_json: string): string;

export function create_weighted_order(weights_json: string, seed: bigint): string;

export function detect_downstream_provider(path: string): string;

export function detect_endpoint_type(provider: string, path: string): string;

export function gemini_usage_tokens_json(payload_json: string): string;

export function map_finish_reason(kind: string, reason: string): string;

export function normalize_chat_request(payload_json: string, provider: string, endpoint: string, model: string, is_stream: boolean): string;

export function normalize_usage(payload_json: string): string;

export function normalize_usage_json(payload_json: string): string;

export function parse_downstream_model(provider: string, path: string, body_json: string): string;

export function parse_downstream_stream(provider: string, path: string, body_json: string): boolean;

export function parse_usage_from_json(payload_json: string): string;

export function parse_usage_from_sse_line(line: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly adapt_chat_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: bigint) => [number, number];
    readonly adapt_sse_line: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly apply_gemini_model_to_path: (a: number, b: number, c: number, d: number) => [number, number];
    readonly build_upstream_chat_request: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number];
    readonly create_weighted_order: (a: number, b: number, c: bigint) => [number, number];
    readonly detect_downstream_provider: (a: number, b: number) => [number, number];
    readonly detect_endpoint_type: (a: number, b: number, c: number, d: number) => [number, number];
    readonly gemini_usage_tokens_json: (a: number, b: number) => [number, number];
    readonly map_finish_reason: (a: number, b: number, c: number, d: number) => [number, number];
    readonly normalize_chat_request: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly normalize_usage: (a: number, b: number) => [number, number];
    readonly parse_downstream_model: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly parse_downstream_stream: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly parse_usage_from_json: (a: number, b: number) => [number, number];
    readonly parse_usage_from_sse_line: (a: number, b: number) => [number, number];
    readonly normalize_usage_json: (a: number, b: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
