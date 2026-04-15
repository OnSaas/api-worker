export type ProxyStreamUsageMode = "full" | "lite" | "off";

export function normalizeProxyStreamUsageMode(
	value: string | null | undefined,
): ProxyStreamUsageMode {
	const normalized = String(value ?? "")
		.trim()
		.toLowerCase();
	if (normalized === "full" || normalized === "lite" || normalized === "off") {
		return normalized;
	}
	return "lite";
}

export function detectStreamFlagFromRawJsonRequest(
	requestText: string,
): boolean | null {
	if (!requestText) {
		return null;
	}
	if (/"stream"\s*:\s*true/i.test(requestText)) {
		return true;
	}
	if (/"stream"\s*:\s*false/i.test(requestText)) {
		return false;
	}
	return null;
}

export type MissingUsagePolicyInput = {
	isStream: boolean;
	bodyParsingSkipped: boolean;
	hasUsageSignal: boolean;
};

export function shouldTreatMissingUsageAsError(
	input: MissingUsagePolicyInput,
): boolean {
	if (input.isStream) {
		return false;
	}
	if (input.bodyParsingSkipped) {
		return false;
	}
	return true;
}

export function shouldParseSuccessStreamUsage(
	mode: ProxyStreamUsageMode,
): boolean {
	return mode !== "off";
}

export function shouldParseFailureStreamUsage(
	mode: ProxyStreamUsageMode,
): boolean {
	return mode === "full";
}

export function resolveStreamMetaPartialReason(input: {
	mode: ProxyStreamUsageMode;
	timedOut?: boolean;
	eventsSeen?: number;
}): string {
	if (input.mode === "off") {
		return "stream_usage_mode_off";
	}
	if (input.timedOut) {
		return "usage_parse_timeout";
	}
	if ((input.eventsSeen ?? 0) > 0) {
		return "usage_missing.stream.signal_absent";
	}
	return "stream_meta_partial";
}

export function shouldMarkStreamMetaPartial(input: {
	mode: ProxyStreamUsageMode;
	hasImmediateUsage: boolean;
	hasParsedUsage: boolean;
	eventsSeen?: number;
}): boolean {
	if (input.hasImmediateUsage || input.hasParsedUsage) {
		return false;
	}
	if (input.mode === "off") {
		return true;
	}
	return (input.eventsSeen ?? 0) > 0;
}
