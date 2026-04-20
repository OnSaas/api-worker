import type {
	Site,
	SiteVerificationBatchSummary,
	SiteVerificationResult,
	VerificationVerdict,
	VerificationStageStatus,
} from "./types";
import { getBeijingDateString } from "./utils";

export type SiteSortKey =
	| "name"
	| "type"
	| "status"
	| "weight"
	| "tokens"
	| "cooldowns"
	| "checkin_enabled"
	| "checkin";

export type SiteSortDirection = "asc" | "desc";

export type SiteSortState = {
	key: SiteSortKey;
	direction: SiteSortDirection;
};

export type SiteCooldownFilter = "all" | "cooling";

export const SITE_TYPE_LABELS: Record<Site["site_type"], string> = {
	"new-api": "New API",
	"done-hub": "Done Hub",
	subapi: "Sub API",
	openai: "OpenAI",
	anthropic: "Anthropic",
	gemini: "Gemini",
};

export const getSiteTypeLabel = (siteType: Site["site_type"]) =>
	SITE_TYPE_LABELS[siteType] ?? siteType;

export const getSiteStatusLabel = (status: string) =>
	status === "active" ? "启用" : "禁用";

export const getSiteCoolingModelCount = (site: Site) =>
	Number(site.cooling_model_count ?? site.cooling_models?.length ?? 0);

export const getSiteCoolingMaxRemainingSeconds = (site: Site) =>
	Number(
		site.cooling_max_remaining_seconds ??
			Math.max(
				0,
				...(site.cooling_models ?? []).map((item) =>
					Number(item.remaining_seconds ?? 0),
				),
			),
	);

export const getVerificationStageTone = (status: VerificationStageStatus) => {
	if (status === "pass") {
		return "success";
	}
	if (status === "warn") {
		return "warning";
	}
	if (status === "fail") {
		return "danger";
	}
	return "muted";
};

export const getVerificationVerdictLabel = (verdict: VerificationVerdict) => {
	if (verdict === "serving") {
		return "可服务";
	}
	if (verdict === "degraded") {
		return "部分异常";
	}
	if (verdict === "recoverable") {
		return "可恢复";
	}
	if (verdict === "not_recoverable") {
		return "暂不可恢复";
	}
	return "不可服务";
};

export const getSuggestedActionLabel = (action: string) => {
	if (action === "fix_credentials") {
		return "检查站点或调用令牌";
	}
	if (action === "fix_endpoint") {
		return "检查站点地址与 endpoint 配置";
	}
	if (action === "fix_model_config") {
		return "补充模型配置或模型映射";
	}
	if (action === "retry") {
		return "稍后重试";
	}
	if (action === "manual_review") {
		return "需要人工排查";
	}
	return "无需额外处理";
};

export const getPrimaryVerificationIssue = (result: SiteVerificationResult) => {
	if (result.stages.service.status === "fail") {
		return result.stages.service.message;
	}
	if (result.stages.capability.status === "fail") {
		return result.stages.capability.message;
	}
	if (result.stages.connectivity.status === "fail") {
		return result.stages.connectivity.message;
	}
	if (result.stages.recovery.status === "fail") {
		return result.stages.recovery.message;
	}
	if (result.stages.capability.status === "warn") {
		return result.stages.capability.message;
	}
	return result.message;
};

export const getVerificationSeverityRank = (verdict: VerificationVerdict) => {
	if (verdict === "degraded" || verdict === "recoverable") {
		return 1;
	}
	if (verdict === "failed" || verdict === "not_recoverable") {
		return 2;
	}
	return 0;
};

export const getVerificationSeverityLabel = (verdict: VerificationVerdict) => {
	if (verdict === "degraded") {
		return "轻微";
	}
	if (verdict === "recoverable") {
		return "可恢复";
	}
	if (verdict === "not_recoverable") {
		return "未恢复";
	}
	if (verdict === "failed") {
		return "严重";
	}
	return "正常";
};

export const summarizeVerificationResults = (
	items: SiteVerificationResult[],
): SiteVerificationBatchSummary => {
	return items.reduce(
		(acc, item) => {
			acc.total += 1;
			if (item.verdict === "serving") {
				acc.serving += 1;
			} else if (item.verdict === "degraded") {
				acc.degraded += 1;
			} else if (item.verdict === "recoverable") {
				acc.recoverable += 1;
			} else if (item.verdict === "not_recoverable") {
				acc.not_recoverable += 1;
			} else {
				acc.failed += 1;
			}
			return acc;
		},
		{
			total: 0,
			serving: 0,
			degraded: 0,
			failed: 0,
			recoverable: 0,
			not_recoverable: 0,
			skipped: 0,
		} satisfies SiteVerificationBatchSummary,
	);
};

export const getSiteCheckinLabel = (site: Site, today?: string) => {
	const shouldShow =
		site.site_type === "new-api" && Boolean(site.checkin_enabled);
	if (!shouldShow) {
		return "-";
	}
	const day = today ?? getBeijingDateString();
	const isToday = site.last_checkin_date === day;
	const status = isToday ? site.last_checkin_status : null;
	if (!status) {
		return "未签到";
	}
	if (status === "success") {
		return "成功";
	}
	if (status === "skipped") {
		return "已签";
	}
	return "签到失败";
};

export const filterSites = (sites: Site[], query: string) => {
	const keyword = query.trim().toLowerCase();
	if (!keyword) {
		return sites;
	}
	return sites.filter((site) => {
		const name = String(site.name ?? "").toLowerCase();
		const url = String(site.base_url ?? "").toLowerCase();
		return name.includes(keyword) || url.includes(keyword);
	});
};

export const filterSitesByCooldown = (
	sites: Site[],
	filter: SiteCooldownFilter,
) => {
	if (filter !== "cooling") {
		return sites;
	}
	return sites.filter((site) => getSiteCoolingModelCount(site) > 0);
};

const toSortableText = (value: string) => value.trim().toLowerCase();

const getSortValue = (site: Site, key: SiteSortKey, today: string) => {
	switch (key) {
		case "name":
			return String(site.name ?? "");
		case "type":
			return getSiteTypeLabel(site.site_type);
		case "status":
			return getSiteStatusLabel(site.status);
		case "weight":
			return Number(site.weight ?? 0);
		case "tokens":
			return Number(site.call_tokens?.length ?? 0);
		case "cooldowns":
			return (
				getSiteCoolingModelCount(site) * 1_000_000 +
				getSiteCoolingMaxRemainingSeconds(site)
			);
		case "checkin_enabled":
			return site.site_type === "new-api"
				? site.checkin_enabled
					? "已开启"
					: "已关闭"
				: "-";
		case "checkin":
			return getSiteCheckinLabel(site, today);
		default:
			return "";
	}
};

export const sortSites = (sites: Site[], sort: SiteSortState) => {
	const today = getBeijingDateString();
	const items = sites.map((site, index) => {
		const raw = getSortValue(site, sort.key, today);
		const value =
			typeof raw === "number" ? raw : toSortableText(String(raw ?? ""));
		return { site, index, value };
	});
	items.sort((left, right) => {
		if (left.value === right.value) {
			return left.index - right.index;
		}
		if (typeof left.value === "number" && typeof right.value === "number") {
			return sort.direction === "asc"
				? left.value - right.value
				: right.value - left.value;
		}
		const comparison = String(left.value).localeCompare(String(right.value));
		return sort.direction === "asc" ? comparison : -comparison;
	});
	return items.map((item) => item.site);
};
