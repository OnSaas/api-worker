export type ProxyErrorAction = "retry" | "sleep" | "disable" | "return";
export type ProxyErrorPolicyMatchedSet = "return" | "disable" | "sleep" | null;

export type ProxyErrorPolicySets = {
	sleepErrorCodeSet: Set<string>;
	disableErrorCodeSet: Set<string>;
	returnErrorCodeSet: Set<string>;
};

export type ProxyErrorDecision = {
	action: ProxyErrorAction;
	lookupKeys: string[];
	matchedKey: string | null;
	matchedSet: ProxyErrorPolicyMatchedSet;
	normalizedErrorCode: string | null;
};

function normalizeMessage(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function normalizeProxyErrorCode(value: string | null): string {
	return normalizeMessage(value)?.toLowerCase() ?? "";
}

export function buildProxyErrorCodeSet(codes: string[]): Set<string> {
	const normalized = codes
		.map((code) => normalizeProxyErrorCode(code))
		.filter((code) => code.length > 0);
	return new Set(normalized);
}

function isNoAvailableChannelMessage(message: string | null): boolean {
	const normalized = normalizeMessage(message)?.toLowerCase() ?? "";
	if (!normalized) {
		return false;
	}
	return (
		normalized.includes("no available channel") ||
		normalized.includes("无可用渠道") ||
		normalized.includes("no available providers") ||
		normalized.includes("无可用供应商")
	);
}

export function buildProxyErrorLookupKeys(
	errorCode: string | null,
	errorMessage: string | null,
): string[] {
	const normalizedCode = normalizeProxyErrorCode(errorCode);
	const lookupKeys: string[] = [];
	if (
		normalizedCode === "pond_hub_error" &&
		isNoAvailableChannelMessage(errorMessage)
	) {
		lookupKeys.push("model_not_found");
	}
	if (normalizedCode) {
		lookupKeys.push(normalizedCode);
	}
	return lookupKeys;
}

function findMatchedKey(
	codeSet: Set<string>,
	lookupKeys: string[],
): string | null {
	for (const key of lookupKeys) {
		if (codeSet.has(key)) {
			return key;
		}
	}
	return null;
}

export function resolveProxyErrorDecision(
	policy: ProxyErrorPolicySets,
	errorCode: string | null,
	errorMessage: string | null,
): ProxyErrorDecision {
	const lookupKeys = buildProxyErrorLookupKeys(errorCode, errorMessage);
	const normalizedErrorCode = normalizeProxyErrorCode(errorCode) || null;
	const matchedReturnKey = findMatchedKey(
		policy.returnErrorCodeSet,
		lookupKeys,
	);
	if (matchedReturnKey) {
		return {
			action: "return",
			lookupKeys,
			matchedKey: matchedReturnKey,
			matchedSet: "return",
			normalizedErrorCode,
		};
	}
	const matchedDisableKey = findMatchedKey(
		policy.disableErrorCodeSet,
		lookupKeys,
	);
	if (matchedDisableKey) {
		return {
			action: "disable",
			lookupKeys,
			matchedKey: matchedDisableKey,
			matchedSet: "disable",
			normalizedErrorCode,
		};
	}
	const matchedSleepKey = findMatchedKey(policy.sleepErrorCodeSet, lookupKeys);
	if (matchedSleepKey) {
		return {
			action: "sleep",
			lookupKeys,
			matchedKey: matchedSleepKey,
			matchedSet: "sleep",
			normalizedErrorCode,
		};
	}
	return {
		action: "retry",
		lookupKeys,
		matchedKey: null,
		matchedSet: null,
		normalizedErrorCode,
	};
}

export function resolveProxyErrorAction(
	policy: ProxyErrorPolicySets,
	errorCode: string | null,
	errorMessage: string | null,
): ProxyErrorAction {
	return resolveProxyErrorDecision(policy, errorCode, errorMessage).action;
}
