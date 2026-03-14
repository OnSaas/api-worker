import type { UsageLog } from "./types";

/**
 * Formats a datetime string for display.
 *
 * Args:
 *   value: ISO datetime string or nullable value.
 *
 * Returns:
 *   A human-friendly datetime string or "-".
 */
const pad2 = (value: number) => String(value).padStart(2, "0");

export const formatDateTime = (value?: string | null) => {
	if (!value) {
		return "-";
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "-";
	}
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
		date.getDate(),
	)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
		date.getSeconds(),
	)}`;
};

/**
 * Toggles channel or token status between active and disabled.
 *
 * Args:
 *   value: Current status value.
 *
 * Returns:
 *   Next status value.
 */
export const toggleStatus = (value: string) =>
	value === "active" ? "disabled" : "active";

/**
 * Returns Beijing date string (YYYY-MM-DD).
 *
 * Args:
 *   date: Optional date value.
 *
 * Returns:
 *   Beijing date string.
 */
export const getBeijingDateString = (date: Date = new Date()) => {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	return formatter.format(date);
};

export type PageItem = number | "ellipsis";

export const buildPageItems = (current: number, total: number): PageItem[] => {
	if (total <= 6) {
		return Array.from({ length: total }, (_, index) => index + 1);
	}
	const items: PageItem[] = [1, 2, 3];
	if (current > 3 && current < total - 1) {
		items.push("ellipsis", current);
	}
	items.push("ellipsis", total - 1, total);
	return items.filter((item, index, array) => {
		if (item === "ellipsis" && array[index - 1] === "ellipsis") {
			return false;
		}
		if (typeof item === "number") {
			return array.indexOf(item) === index;
		}
		return true;
	});
};

const truncateText = (value: string | null | undefined, max = 80) => {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
};

const describeError = (status?: number | null, code?: string | null) => {
	const normalized = (code ?? "").toLowerCase();
	if (status === 401 || status === 403) {
		return "鉴权失败";
	}
	if (status === 429 || normalized.includes("rate")) {
		return "触发限流";
	}
	if (
		normalized.includes("insufficient") ||
		normalized.includes("quota") ||
		normalized.includes("balance")
	) {
		return "余额不足";
	}
	if (normalized.includes("model")) {
		return "模型不可用";
	}
	return null;
};

export type UsageStatusDetail = {
	label: string;
	message: string | null;
	tone: "success" | "error";
};

export const buildUsageStatusDetail = (log: UsageLog): UsageStatusDetail => {
	if (log.status === "ok") {
		return { label: "成功", message: null, tone: "success" };
	}
	const parts: string[] = [];
	if (log.upstream_status !== null && log.upstream_status !== undefined) {
		parts.push(String(log.upstream_status));
	}
	if (log.error_code) {
		parts.push(log.error_code);
	}
	const hint = describeError(log.upstream_status, log.error_code ?? null);
	if (hint) {
		parts.push(hint);
	}
	const suffix = parts.length > 0 ? ` (${parts.join(" / ")})` : "";
	return {
		label: `失败${suffix}`,
		message: truncateText(log.error_message),
		tone: "error",
	};
};
