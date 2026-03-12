import type { D1Database } from "@cloudflare/workers-types";
import { nowIso } from "../utils/time";
import { normalizeBaseUrl } from "../utils/url";
import { modelsToJson, normalizeModelsInput } from "./channel-models";
import { upsertChannelModelCapabilities } from "./channel-model-capabilities";

export type ChannelTestResult = {
	ok: boolean;
	elapsed: number;
	models: string[];
	payload?: unknown[] | { data?: unknown[] };
};

export type ChannelToken = {
	id?: string;
	name?: string;
	api_key: string;
};

export type ChannelTokenTestItem = {
	tokenId?: string;
	tokenName?: string;
	ok: boolean;
	elapsed: number;
	models: string[];
};

export type ChannelTokenTestSummary = {
	ok: boolean;
	total: number;
	success: number;
	failed: number;
	elapsed: number;
	models: string[];
	items: ChannelTokenTestItem[];
};

export async function fetchChannelModels(
	baseUrl: string,
	apiKey: string,
): Promise<ChannelTestResult> {
	const target = `${normalizeBaseUrl(baseUrl)}/v1/models`;
	const start = Date.now();
	const response = await fetch(target, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"x-api-key": apiKey,
			"Content-Type": "application/json",
		},
	});

	const elapsed = Date.now() - start;
	if (!response.ok) {
		return { ok: false, elapsed, models: [] };
	}

	const payload = (await response.json().catch(() => ({ data: [] }))) as
		| { data?: unknown[] }
		| unknown[];
	const models = normalizeModelsInput(
		Array.isArray(payload) ? payload : (payload.data ?? payload),
	);
	return { ok: true, elapsed, models, payload };
}

/**
 * Tests channel models with multiple API keys and aggregates results.
 *
 * Args:
 *   baseUrl: Upstream base URL.
 *   tokens: List of call tokens to test.
 *   fetcher: Optional fetcher override for tests.
 *
 * Returns:
 *   Summary of token test results and aggregated model IDs.
 */
export async function testChannelTokens(
	baseUrl: string,
	tokens: ChannelToken[],
	fetcher: (
		baseUrl: string,
		apiKey: string,
	) => Promise<ChannelTestResult> = fetchChannelModels,
): Promise<ChannelTokenTestSummary> {
	if (tokens.length === 0) {
		return {
			ok: false,
			total: 0,
			success: 0,
			failed: 0,
			elapsed: 0,
			models: [],
			items: [],
		};
	}

	const items: ChannelTokenTestItem[] = [];
	const modelSet = new Set<string>();
	let success = 0;
	let totalElapsed = 0;

	for (const token of tokens) {
		const result = await fetcher(baseUrl, token.api_key);
		totalElapsed += result.elapsed;
		if (result.ok) {
			success += 1;
			for (const model of result.models) {
				modelSet.add(model);
			}
		}
		items.push({
			tokenId: token.id,
			tokenName: token.name,
			ok: result.ok,
			elapsed: result.elapsed,
			models: result.models,
		});
	}

	const total = tokens.length;
	const failed = total - success;
	const elapsed = Math.round(totalElapsed / total);

	return {
		ok: success > 0,
		total,
		success,
		failed,
		elapsed,
		models: Array.from(modelSet),
		items,
	};
}

export async function updateChannelTestResult(
	db: D1Database,
	id: string,
	result: {
		ok: boolean;
		elapsed: number;
		models?: string[];
		modelsJson?: string;
	},
): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	const status = result.ok ? "active" : "error";
	const modelsJson =
		result.modelsJson ??
		(result.models ? modelsToJson(result.models) : undefined);
	const sql = modelsJson
		? "UPDATE channels SET status = ?, models_json = ?, test_time = ?, response_time_ms = ?, updated_at = ? WHERE id = ?"
		: "UPDATE channels SET status = ?, test_time = ?, response_time_ms = ?, updated_at = ? WHERE id = ?";

	const stmt = db.prepare(sql);
	if (modelsJson) {
		await stmt
			.bind(status, modelsJson, now, result.elapsed, nowIso(), id)
			.run();
	} else {
		await stmt.bind(status, now, result.elapsed, nowIso(), id).run();
	}
	if (result.ok && result.models && result.models.length > 0) {
		await upsertChannelModelCapabilities(db, id, result.models, now);
	}
}
