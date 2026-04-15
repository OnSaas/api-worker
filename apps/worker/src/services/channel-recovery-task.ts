import {
	testChannelTokens,
	type ChannelTokenTestSummary,
} from "./channel-testing";
import type {
	SiteTaskProbeChannel,
	SiteTaskProbeResult,
	SiteTaskToken,
} from "./site-task-contract";
import { normalizeBaseUrl } from "../utils/url";
import { inspectSuccessfulResponse } from "./successful-response";

const RECOVERY_PROBE_PROMPT = "Reply with a short health-check message.";
const RECOVERY_PROBE_MAX_TOKENS = 32;

export function pickRandomItem<T>(
	items: readonly T[],
	random: () => number = Math.random,
): T | null {
	if (items.length === 0) {
		return null;
	}
	const index = Math.floor(random() * items.length);
	const safeIndex = Math.max(0, Math.min(items.length - 1, index));
	return items[safeIndex] ?? null;
}

async function sendCompletionProbe(options: {
	baseUrl: string;
	apiKey: string;
	model: string;
	fetcher?: typeof fetch;
}): Promise<boolean> {
	const fetcher = options.fetcher ?? fetch;
	const target = `${normalizeBaseUrl(options.baseUrl)}/v1/chat/completions`;
	let response: Response;
	try {
		response = await fetcher(target, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${options.apiKey}`,
				"x-api-key": options.apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: options.model,
				messages: [{ role: "user", content: RECOVERY_PROBE_PROMPT }],
				max_tokens: RECOVERY_PROBE_MAX_TOKENS,
				temperature: 0,
			}),
		});
	} catch {
		return false;
	}
	if (!response.ok) {
		return false;
	}
	const inspection = await inspectSuccessfulResponse(response, {
		requireOutputText: true,
	});
	return inspection.ok;
}

function buildProbeTokens(
	channel: SiteTaskProbeChannel,
	tokens: SiteTaskToken[],
): SiteTaskToken[] {
	if (tokens.length > 0) {
		return tokens;
	}
	const fallbackApiKey = String(channel.api_key ?? "").trim();
	if (!fallbackApiKey) {
		return [];
	}
	return [
		{
			id: "primary",
			name: "primary",
			api_key: fallbackApiKey,
		},
	];
}

function selectSuccessfulToken(
	summary: ChannelTokenTestSummary,
	random: () => number,
) {
	const successfulItems = summary.items.filter(
		(item) => item.ok && item.models.length > 0,
	);
	return pickRandomItem(successfulItems, random);
}

export async function runDisabledChannelRecoveryProbe(
	channel: SiteTaskProbeChannel,
	tokens: SiteTaskToken[],
	options: {
		random?: () => number;
		fetcher?: typeof fetch;
	} = {},
): Promise<SiteTaskProbeResult> {
	const random = options.random ?? Math.random;
	const probeTokens = buildProbeTokens(channel, tokens);
	if (probeTokens.length === 0) {
		return {
			attempted: true,
			recovered: false,
			reason: "missing_token",
			channel_id: channel.id,
			channel_name: channel.name,
			elapsed: 0,
			models: [],
			items: [],
		};
	}

	const summary = await testChannelTokens(channel.base_url, probeTokens);
	if (!summary.ok) {
		return {
			attempted: true,
			recovered: false,
			reason: "token_model_test_failed",
			channel_id: channel.id,
			channel_name: channel.name,
			elapsed: summary.elapsed,
			models: summary.models,
			items: summary.items,
		};
	}

	const selectedToken = selectSuccessfulToken(summary, random);
	const model = pickRandomItem(selectedToken?.models ?? [], random);
	if (!selectedToken || !model) {
		return {
			attempted: true,
			recovered: false,
			reason: "completion_probe_failed",
			channel_id: channel.id,
			channel_name: channel.name,
			elapsed: summary.elapsed,
			models: summary.models,
			items: summary.items,
		};
	}

	const matchingToken = probeTokens.find(
		(token) =>
			(token.id ?? "") === (selectedToken.tokenId ?? "") &&
			token.api_key.trim().length > 0,
	);
	const probeApiKey = matchingToken?.api_key ?? "";
	const probeOk =
		probeApiKey.length > 0
			? await sendCompletionProbe({
					baseUrl: channel.base_url,
					apiKey: probeApiKey,
					model,
					fetcher: options.fetcher,
				})
			: false;

	return {
		attempted: true,
		recovered: probeOk,
		reason: probeOk ? "recovered" : "completion_probe_failed",
		channel_id: channel.id,
		channel_name: channel.name,
		model,
		elapsed: summary.elapsed,
		models: summary.models,
		items: summary.items,
	};
}
