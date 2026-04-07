import {
	type ChannelMetadata,
	parseChannelMetadata,
	resolveMappedModel,
} from "./channel-metadata";
import { extractModels } from "./channel-models";
import type { ChannelRecord } from "./channel-types";

function normalizeKnownModel(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function hasExplicitModelMapping(
	metadata: ChannelMetadata,
	downstreamModel: string | null,
): boolean {
	if (downstreamModel) {
		return (
			metadata.model_mapping[downstreamModel] !== undefined ||
			metadata.model_mapping["*"] !== undefined
		);
	}
	return metadata.model_mapping["*"] !== undefined;
}

function collectKnownChannelModels(
	channel: ChannelRecord,
	verifiedModelsByChannel: Map<string, Set<string>>,
): string[] {
	const output: string[] = [];
	const appendModel = (value: string | null | undefined) => {
		const normalized = normalizeKnownModel(value);
		if (!normalized || output.includes(normalized)) {
			return;
		}
		output.push(normalized);
	};
	const verified = verifiedModelsByChannel.get(channel.id);
	if (verified && verified.size > 0) {
		for (const model of verified) {
			appendModel(model);
		}
	}
	for (const entry of extractModels(channel)) {
		appendModel(entry.id);
	}
	return output;
}

export function resolveUpstreamModelForChannel(
	channel: ChannelRecord,
	metadata: ChannelMetadata,
	downstreamModel: string | null,
	verifiedModelsByChannel: Map<string, Set<string>> = new Map(),
): { model: string | null; autoMapped: boolean } {
	const mapped = resolveMappedModel(metadata.model_mapping, downstreamModel);
	if (!downstreamModel || hasExplicitModelMapping(metadata, downstreamModel)) {
		return { model: mapped, autoMapped: false };
	}

	const knownModels = collectKnownChannelModels(
		channel,
		verifiedModelsByChannel,
	);
	if (knownModels.length === 0) {
		return { model: null, autoMapped: false };
	}
	if (knownModels.includes(downstreamModel)) {
		return { model: downstreamModel, autoMapped: false };
	}
	return { model: null, autoMapped: false };
}

function channelSupportsModel(
	channel: ChannelRecord,
	model: string | null,
	verifiedModelsByChannel: Map<string, Set<string>>,
): boolean {
	if (!model) {
		return true;
	}
	const metadata = parseChannelMetadata(channel.metadata_json);
	const resolved = resolveUpstreamModelForChannel(
		channel,
		metadata,
		model,
		verifiedModelsByChannel,
	);
	if (!resolved.model) {
		return false;
	}
	if (hasExplicitModelMapping(metadata, model)) {
		return true;
	}
	const knownModels = collectKnownChannelModels(
		channel,
		verifiedModelsByChannel,
	);
	if (knownModels.length === 0) {
		return false;
	}
	return knownModels.includes(resolved.model);
}

export function selectCandidateChannels(
	allowedChannels: ChannelRecord[],
	downstreamModel: string | null,
	verifiedModelsByChannel: Map<string, Set<string>> = new Map(),
): ChannelRecord[] {
	return allowedChannels.filter((channel) =>
		channelSupportsModel(channel, downstreamModel, verifiedModelsByChannel),
	);
}
