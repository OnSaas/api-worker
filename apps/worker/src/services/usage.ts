import type { D1Database } from "@cloudflare/workers-types";
import { nowIso } from "../utils/time";

export type UsageInput = {
	tokenId?: string | null;
	channelId?: string | null;
	model?: string | null;
	requestPath?: string | null;
	totalTokens?: number | null;
	promptTokens?: number | null;
	completionTokens?: number | null;
	cost?: number | null;
	latencyMs?: number | null;
	firstTokenLatencyMs?: number | null;
	stream?: boolean | number | null;
	reasoningEffort?: string | number | null;
	status?: string | null;
	upstreamStatus?: number | null;
	errorCode?: string | null;
	errorMessage?: string | null;
};

/**
 * Inserts a usage record and updates token quota.
 */
export async function recordUsage(
	db: D1Database,
	input: UsageInput,
): Promise<void> {
	const id = crypto.randomUUID();
	const createdAt = nowIso();
	const streamValue =
		input.stream === null || input.stream === undefined
			? null
			: typeof input.stream === "number"
				? input.stream
				: input.stream
					? 1
					: 0;
	const reasoningValue =
		input.reasoningEffort === null || input.reasoningEffort === undefined
			? null
			: String(input.reasoningEffort);
	await db
		.prepare(
			"INSERT INTO usage_logs (id, token_id, channel_id, model, request_path, total_tokens, prompt_tokens, completion_tokens, cost, latency_ms, first_token_latency_ms, stream, reasoning_effort, status, upstream_status, error_code, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			id,
			input.tokenId ?? null,
			input.channelId ?? null,
			input.model ?? null,
			input.requestPath ?? null,
			input.totalTokens ?? 0,
			input.promptTokens ?? 0,
			input.completionTokens ?? 0,
			input.cost ?? 0,
			input.latencyMs ?? 0,
			input.firstTokenLatencyMs ?? null,
			streamValue,
			reasoningValue,
			input.status ?? "ok",
			input.upstreamStatus ?? null,
			input.errorCode ?? null,
			input.errorMessage ?? null,
			createdAt,
		)
		.run();

	if (input.tokenId && input.totalTokens) {
		await db
			.prepare(
				"UPDATE tokens SET quota_used = quota_used + ?, updated_at = ? WHERE id = ?",
			)
			.bind(input.totalTokens, createdAt, input.tokenId)
			.run();
	}
}

/**
 * Deletes usage logs older than the retention window.
 */
export async function pruneUsageLogs(
	db: D1Database,
	retentionDays: number,
): Promise<void> {
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - retentionDays);
	await db
		.prepare("DELETE FROM usage_logs WHERE created_at < ?")
		.bind(cutoff.toISOString())
		.run();
}
