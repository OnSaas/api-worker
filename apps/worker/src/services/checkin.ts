import { beijingDateString } from "../utils/time";
import { normalizeBaseUrl } from "../utils/url";

export type CheckinTarget = {
	id: string;
	name: string;
	base_url: string;
	checkin_url?: string | null;
	system_token?: string | null;
	system_userid?: string | null;
};

export type CheckinResultStatus = "success" | "failed" | "skipped";

export type CheckinResultItem = {
	id: string;
	name: string;
	status: CheckinResultStatus;
	message: string;
	checkin_date?: string | null;
};

export type CheckinSummary = {
	total: number;
	success: number;
	failed: number;
	skipped: number;
};

type PayloadSummary = {
	type: string;
	keys?: string[];
	signed?: unknown;
	success?: unknown;
	status?: unknown;
	code?: unknown;
	message?: unknown;
	error?: unknown;
};

const buildCheckinUrl = (baseUrl: string) => {
	const normalized = normalizeBaseUrl(baseUrl);
	if (!normalized) {
		return "";
	}
	if (normalized.endsWith("/api")) {
		return `${normalized}/user/checkin`;
	}
	return `${normalized}/api/user/checkin`;
};

const resolveCheckinBaseUrl = (site: CheckinTarget) => {
	if (site.checkin_url?.trim()) {
		return site.checkin_url;
	}
	return site.base_url;
};

const summarizePayload = (payload: unknown): PayloadSummary => {
	if (!payload) {
		return { type: "null" };
	}
	if (typeof payload !== "object") {
		return { type: typeof payload };
	}
	const record = payload as Record<string, unknown>;
	return {
		type: "object",
		keys: Object.keys(record).slice(0, 12),
		signed: record.signed ?? record.is_signed ?? record.already_signed,
		success: record.success,
		status: record.status,
		code: record.code,
		message: record.message ?? record.msg,
		error: record.error,
	};
};

const logCheckin = (
	_site: CheckinTarget,
	_stage: string,
	_data: Record<string, unknown>,
) => {};

const parseSigned = (payload: unknown): boolean => {
	if (!payload || typeof payload !== "object") {
		return false;
	}
	const record = payload as Record<string, unknown>;
	const message = String(
		record.message ?? record.msg ?? record.error ?? "",
	).trim();
	if (message.includes("已签到")) {
		return true;
	}
	const data = record.data;
	if (data && typeof data === "object") {
		const dataRecord = data as Record<string, unknown>;
		if (dataRecord.checkin_date || dataRecord.checked_in || dataRecord.signed) {
			return true;
		}
	}
	return Boolean(
		record.signed ??
			record.is_signed ??
			record.checked ??
			record.checkin ??
			record.already_signed ??
			record.checked_in,
	);
};

const extractCheckinDate = (payload: unknown): string | null => {
	if (!payload || typeof payload !== "object") {
		return null;
	}
	const record = payload as Record<string, unknown>;
	const data = record.data;
	if (data && typeof data === "object") {
		const date = (data as Record<string, unknown>).checkin_date;
		if (typeof date === "string" && date.trim()) {
			return date.trim();
		}
	}
	const message = String(
		record.message ?? record.msg ?? record.error ?? "",
	).trim();
	if (message.includes("已签到")) {
		return beijingDateString();
	}
	return null;
};

const parseMessage = (payload: unknown, fallback: string) => {
	if (!payload || typeof payload !== "object") {
		return fallback;
	}
	const record = payload as Record<string, unknown>;
	const msg = record.message ?? record.msg ?? record.error;
	if (typeof msg === "string" && msg.trim()) {
		return msg;
	}
	return fallback;
};

const readJson = async (response: Response) => {
	try {
		return await response.json();
	} catch (_error) {
		return null;
	}
};

const readError = async (response: Response) => {
	const payload = await readJson(response);
	return parseMessage(payload, `HTTP ${response.status}`);
};

export async function runCheckin(
	site: CheckinTarget,
): Promise<CheckinResultItem> {
	const endpoint = buildCheckinUrl(resolveCheckinBaseUrl(site));
	if (!endpoint) {
		return {
			id: site.id,
			name: site.name,
			status: "failed",
			message: "站点 URL 为空",
		};
	}
	if (!site.system_token || !site.system_token.trim()) {
		return {
			id: site.id,
			name: site.name,
			status: "failed",
			message: "缺少系统令牌",
		};
	}
	const headers = new Headers();
	headers.set("Authorization", `Bearer ${site.system_token}`);
	if (site.system_userid?.trim()) {
		headers.set("New-Api-User", site.system_userid.trim());
	} else {
		return {
			id: site.id,
			name: site.name,
			status: "failed",
			message: "缺少 userid",
		};
	}
	try {
		logCheckin(site, "status:request", { endpoint });
		const statusResp = await fetch(endpoint, { method: "GET", headers });
		logCheckin(site, "status:response", {
			status: statusResp.status,
			ok: statusResp.ok,
		});
		if (!statusResp.ok) {
			return {
				id: site.id,
				name: site.name,
				status: "failed",
				message: await readError(statusResp),
			};
		}
		const statusPayload = await readJson(statusResp);
		if (!statusPayload) {
			logCheckin(site, "status:invalid-json", {});
			return {
				id: site.id,
				name: site.name,
				status: "failed",
				message: "签到状态返回非 JSON",
			};
		}
		logCheckin(site, "status:payload", {
			payload: summarizePayload(statusPayload),
		});
		if (parseSigned(statusPayload)) {
			return {
				id: site.id,
				name: site.name,
				status: "skipped",
				message: parseMessage(statusPayload, "今日已签到"),
				checkin_date: extractCheckinDate(statusPayload),
			};
		}
		const checkinResp = await fetch(endpoint, { method: "POST", headers });
		logCheckin(site, "checkin:response", {
			status: checkinResp.status,
			ok: checkinResp.ok,
		});
		if (!checkinResp.ok) {
			return {
				id: site.id,
				name: site.name,
				status: "failed",
				message: await readError(checkinResp),
			};
		}
		const checkinPayload = await readJson(checkinResp);
		if (!checkinPayload) {
			logCheckin(site, "checkin:invalid-json", {});
			return {
				id: site.id,
				name: site.name,
				status: "failed",
				message: "签到响应非 JSON",
			};
		}
		logCheckin(site, "checkin:payload", {
			payload: summarizePayload(checkinPayload),
		});
		if (parseSigned(checkinPayload)) {
			return {
				id: site.id,
				name: site.name,
				status: "skipped",
				message: parseMessage(checkinPayload, "今日已签到"),
				checkin_date: extractCheckinDate(checkinPayload),
			};
		}
		const record = checkinPayload as Record<string, unknown>;
		const codeValue = record.code;
		const numericCode =
			typeof codeValue === "number"
				? codeValue
				: typeof codeValue === "string"
					? Number(codeValue)
					: null;
		const explicitFailure = Boolean(
			record.success === false ||
				record.status === "error" ||
				(record.error && String(record.error).length > 0) ||
				(numericCode !== null &&
					!Number.isNaN(numericCode) &&
					numericCode !== 0),
		);
		if (explicitFailure) {
			logCheckin(site, "checkin:explicit-failure", {
				payload: summarizePayload(checkinPayload),
			});
			return {
				id: site.id,
				name: site.name,
				status: "failed",
				message: parseMessage(checkinPayload, "签到失败"),
				checkin_date: extractCheckinDate(checkinPayload),
			};
		}
		logCheckin(site, "verify:request", { endpoint });
		const verifyResp = await fetch(endpoint, { method: "GET", headers });
		logCheckin(site, "verify:response", {
			status: verifyResp.status,
			ok: verifyResp.ok,
		});
		if (!verifyResp.ok) {
			return {
				id: site.id,
				name: site.name,
				status: "failed",
				message: await readError(verifyResp),
			};
		}
		const verifyPayload = await readJson(verifyResp);
		if (!verifyPayload) {
			logCheckin(site, "verify:invalid-json", {});
			return {
				id: site.id,
				name: site.name,
				status: "failed",
				message: "签到验证响应非 JSON",
			};
		}
		logCheckin(site, "verify:payload", {
			payload: summarizePayload(verifyPayload),
		});
		if (!parseSigned(verifyPayload)) {
			return {
				id: site.id,
				name: site.name,
				status: "failed",
				message: parseMessage(verifyPayload, "签到未生效"),
				checkin_date: extractCheckinDate(verifyPayload),
			};
		}
		return {
			id: site.id,
			name: site.name,
			status: "success",
			message: parseMessage(checkinPayload, "签到成功"),
			checkin_date:
				extractCheckinDate(checkinPayload) ?? extractCheckinDate(verifyPayload),
		};
	} catch (error) {
		return {
			id: site.id,
			name: site.name,
			status: "failed",
			message: (error as Error).message || "请求失败",
		};
	}
}

export function summarizeCheckin(results: CheckinResultItem[]): CheckinSummary {
	return results.reduce<CheckinSummary>(
		(acc, item) => {
			acc.total += 1;
			if (item.status === "success") {
				acc.success += 1;
			} else if (item.status === "failed") {
				acc.failed += 1;
			} else {
				acc.skipped += 1;
			}
			return acc;
		},
		{ total: 0, success: 0, failed: 0, skipped: 0 },
	);
}

export { buildCheckinUrl, parseSigned, parseMessage };
