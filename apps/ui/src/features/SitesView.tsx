import { useEffect, useMemo, useRef, useState } from "hono/jsx/dom";
import {
	Button,
	Card,
	Chip,
	ColumnPicker,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Pagination,
	SingleSelect,
	Switch,
	Tooltip,
} from "../components/ui";
import {
	getSiteCheckinLabel,
	getSiteCoolingMaxRemainingSeconds,
	getSiteCoolingModelCount,
	getSiteStatusLabel,
	getPrimaryVerificationIssue,
	getSuggestedActionLabel,
	getSiteTypeLabel,
	getVerificationSeverityLabel,
	getVerificationSeverityRank,
	getVerificationVerdictLabel,
	type SiteCooldownFilter,
	type SiteSortKey,
	type SiteSortState,
} from "../core/sites";
import type {
	Site,
	SiteCoolingModel,
	SiteChannelRefreshItem,
	SiteForm,
	SiteTaskKind,
	SiteTaskReportMap,
	SiteVerificationResult,
} from "../core/types";
import {
	buildPageItems,
	formatChinaDateTimeMinute,
	getBeijingDateString,
	loadColumnPrefs,
	persistColumnPrefs,
} from "../core/utils";

type SitesViewProps = {
	sites: Site[];
	siteForm: SiteForm;
	sitePage: number;
	sitePageSize: number;
	siteTotal: number;
	siteTotalPages: number;
	pagedSites: Site[];
	editingSite: Site | null;
	isSiteModalOpen: boolean;
	taskReports: SiteTaskReportMap;
	siteSearch: string;
	siteCooldownFilter: SiteCooldownFilter;
	siteSort: SiteSortState;
	isActionPending: (key: string) => boolean;
	onCreate: () => void;
	onCloseModal: () => void;
	onEdit: (site: Site) => void;
	onSubmit: (event: Event) => void;
	onVerify: (id: string) => void;
	onCheckin: (site: Site) => void;
	onRefreshSite: (site: Site) => void;
	onToggle: (id: string, status: string) => void;
	onDelete: (site: Site) => void;
	onPageChange: (next: number) => void;
	onPageSizeChange: (next: number) => void;
	onSearchChange: (next: string) => void;
	onCooldownFilterChange: (next: SiteCooldownFilter) => void;
	onSortChange: (next: SiteSortState) => void;
	onFormChange: (patch: Partial<SiteForm>) => void;
	onRunAll: () => void;
	onVerifyAll: () => void;
	onEvaluateRecovery: () => void;
	onRefreshAll: () => void;
	onDisableFailedSite: (site: SiteVerificationResult) => void;
	onDisableAllFailedSites: () => void;
	onClearCoolingModel: (siteId: string, model: string) => void;
};

const pageSizeOptions = [10, 20, 50];
const siteTypeOptions = [
	{ value: "new-api", label: getSiteTypeLabel("new-api") },
	{ value: "done-hub", label: getSiteTypeLabel("done-hub") },
	{ value: "subapi", label: getSiteTypeLabel("subapi") },
	{ value: "openai", label: getSiteTypeLabel("openai") },
	{ value: "anthropic", label: getSiteTypeLabel("anthropic") },
	{ value: "gemini", label: getSiteTypeLabel("gemini") },
];
const siteStatusOptions = [
	{ value: "active", label: getSiteStatusLabel("active") },
	{ value: "disabled", label: getSiteStatusLabel("disabled") },
];
const cooldownFilterOptions = [
	{ value: "all", label: "全部站点" },
	{ value: "cooling", label: "仅冷却中" },
] as const;
const sortableColumns: Array<{ key: SiteSortKey; label: string }> = [
	{ key: "name", label: "站点" },
	{ key: "type", label: "类型" },
	{ key: "status", label: "状态" },
	{ key: "weight", label: "权重" },
	{ key: "tokens", label: "令牌" },
	{ key: "cooldowns", label: "冷却模型" },
	{ key: "checkin_enabled", label: "自动签到" },
	{ key: "checkin", label: "今日签到" },
];
const siteColumnOptions = [
	{ id: "name", label: "站点", width: "minmax(0,1.4fr)", locked: true },
	{ id: "type", label: "类型", width: "minmax(0,0.6fr)" },
	{ id: "status", label: "状态", width: "minmax(0,0.6fr)", locked: true },
	{ id: "weight", label: "权重", width: "minmax(0,0.5fr)", locked: true },
	{ id: "tokens", label: "令牌", width: "minmax(0,0.6fr)", locked: true },
	{
		id: "cooldowns",
		label: "冷却模型",
		width: "minmax(0,0.9fr)",
		locked: true,
	},
	{
		id: "checkin_enabled",
		label: "自动签到",
		width: "minmax(0,0.6fr)",
		locked: true,
	},
	{ id: "checkin", label: "今日签到", width: "minmax(0,0.8fr)", locked: true },
	{ id: "actions", label: "操作", width: "minmax(0,1.4fr)", locked: true },
];
const siteColumnDefaults = siteColumnOptions.map((column) => column.id);
const requiredSiteColumns = [
	"name",
	"status",
	"weight",
	"tokens",
	"cooldowns",
	"checkin_enabled",
	"checkin",
	"actions",
];
const siteColumnVersion = "2026-04-20";
const columnTooltips: Partial<Record<SiteSortKey, string>> = {
	cooldowns: "按冷却模型数量排序；数量相同则按最长剩余冷却时间排序。",
	checkin_enabled: "仅 new-api 类型支持自动签到。",
	checkin: "展示今天的签到结果。",
};

const siteTaskButtons: Array<{
	kind: SiteTaskKind;
	label: string;
	pendingLabel: string;
}> = [
	{
		kind: "checkin",
		label: "签到已启用站点",
		pendingLabel: "签到中...",
	},
	{
		kind: "verify-active",
		label: "检查启用渠道",
		pendingLabel: "检查中...",
	},
	{
		kind: "verify-disabled",
		label: "检查停用渠道",
		pendingLabel: "检查中...",
	},
	{
		kind: "refresh-active",
		label: "更新启用渠道",
		pendingLabel: "更新中...",
	},
];

const formatTaskTime = (value: string) =>
	new Date(value).toLocaleTimeString("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

const formatTaskDateTime = (value: string) => formatChinaDateTimeMinute(value);

const formatCooldownDuration = (seconds: number) => {
	const safeSeconds = Math.max(0, Math.floor(seconds));
	if (safeSeconds <= 0) {
		return "即将恢复";
	}
	const days = Math.floor(safeSeconds / 86400);
	const hours = Math.floor((safeSeconds % 86400) / 3600);
	const minutes = Math.floor((safeSeconds % 3600) / 60);
	if (days > 0) {
		return `${days}天 ${hours}小时`;
	}
	if (hours > 0) {
		return `${hours}小时 ${minutes}分钟`;
	}
	return `${Math.max(1, minutes)}分钟`;
};

const getCoolingModels = (site: Site) => site.cooling_models ?? [];

const getCoolingSummaryLabel = (site: Site) => {
	const count = getSiteCoolingModelCount(site);
	if (count <= 0) {
		return "无";
	}
	return `${count} 个`;
};

const getCoolingToneClass = (site: Site) => {
	const count = getSiteCoolingModelCount(site);
	if (count <= 0) {
		return "border-white/70 bg-white/70 text-[color:var(--app-ink-muted)]";
	}
	if (count >= 3) {
		return "border-amber-300/70 bg-amber-50 text-amber-700";
	}
	return "border-sky-300/70 bg-sky-50 text-sky-700";
};

const normalizeCallTokenOrder = (tokens: SiteForm["call_tokens"]) =>
	tokens.map((token, index) => ({
		...token,
		priority: index,
	}));

const getCallTokenDragKey = (
	token: SiteForm["call_tokens"][number],
	fallbackIndex: number,
) => {
	if (token.id) {
		return token.id;
	}
	const existingKey = callTokenDraftKeyMap.get(token);
	if (existingKey) {
		return existingKey;
	}
	const nextKey = `draft-${fallbackIndex}-${callTokenDraftKeySeed + 1}`;
	callTokenDraftKeySeed += 1;
	callTokenDraftKeyMap.set(token, nextKey);
	return nextKey;
};

const reorderCallTokens = (
	tokens: SiteForm["call_tokens"],
	fromIndex: number,
	toIndex: number,
) => {
	if (
		fromIndex === toIndex ||
		fromIndex < 0 ||
		toIndex < 0 ||
		fromIndex >= tokens.length ||
		toIndex >= tokens.length
	) {
		return tokens;
	}
	const next = [...tokens];
	const [movedToken] = next.splice(fromIndex, 1);
	next.splice(toIndex, 0, movedToken);
	return next;
};

const haveSameCallTokenSequence = (
	left: SiteForm["call_tokens"],
	right: SiteForm["call_tokens"],
) => {
	if (left.length !== right.length) {
		return false;
	}
	for (let index = 0; index < left.length; index += 1) {
		const leftKey = getCallTokenDragKey(left[index], index);
		const rightKey = getCallTokenDragKey(right[index], index);
		if (leftKey !== rightKey) {
			return false;
		}
	}
	return true;
};

const logCallTokenDrag = (
	stage: string,
	detail: Record<string, unknown> = {},
) => {
	if (typeof window === "undefined") {
		return;
	}
	const enabled =
		import.meta.env.DEV ||
		window.localStorage.getItem("debug:site-call-token-drag") === "1";
	if (!enabled) {
		return;
	}
	console.debug("[sites:call-token-drag]", stage, detail);
};

const callTokenFlipDurationMs = 220;
const callTokenDropSettleMs = 180;
const callTokenDraftKeyMap = new WeakMap<
	SiteForm["call_tokens"][number],
	string
>();
let callTokenDraftKeySeed = 0;

type ActiveCallTokenDrag = {
	currentIndex: number;
	grabOffsetX: number;
	grabOffsetY: number;
	height: number;
	isSettling: boolean;
	left: number;
	pointerId: number;
	tokenKey: string;
	top: number;
	width: number;
};

type CallTokenOverlayVisual = {
	frameId: number | null;
	scale: number;
	transition: string;
	x: number;
	y: number;
};

export const SitesView = ({
	sites,
	siteForm,
	sitePage,
	sitePageSize,
	siteTotal,
	siteTotalPages,
	pagedSites,
	editingSite,
	isSiteModalOpen,
	taskReports,
	siteSearch,
	siteCooldownFilter,
	siteSort,
	isActionPending,
	onCreate,
	onCloseModal,
	onEdit,
	onSubmit,
	onVerify,
	onCheckin,
	onRefreshSite,
	onToggle,
	onDelete,
	onPageChange,
	onPageSizeChange,
	onSearchChange,
	onCooldownFilterChange,
	onSortChange,
	onFormChange,
	onRunAll,
	onVerifyAll,
	onEvaluateRecovery,
	onRefreshAll,
	onDisableFailedSite,
	onDisableAllFailedSites,
	onClearCoolingModel,
}: SitesViewProps) => {
	const isEditing = Boolean(editingSite);
	const pageItems = buildPageItems(sitePage, siteTotalPages);
	const today = getBeijingDateString();
	const isSubmitting = isActionPending("site:submit");
	const isVerifyingAll = isActionPending("site:verifyAll");
	const isCheckinAll = isActionPending("site:checkinAll");
	const isRecoveryEvaluate = isActionPending("site:recoveryEvaluate");
	const isRefreshingAll = isActionPending("site:refreshAll");
	const [localSearch, setLocalSearch] = useState(siteSearch);
	const [draftCallTokens, setDraftCallTokens] = useState<
		SiteForm["call_tokens"]
	>(() => siteForm.call_tokens);
	const [activeCallTokenDrag, setActiveCallTokenDrag] =
		useState<ActiveCallTokenDrag | null>(null);
	const callTokenCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
	const activeCallTokenDragRef = useRef<ActiveCallTokenDrag | null>(null);
	const callTokenOverlayRef = useRef<HTMLDivElement | null>(null);
	const callTokenOverlayVisualRef = useRef<CallTokenOverlayVisual>({
		frameId: null,
		scale: 1.015,
		transition: "none",
		x: 0,
		y: 0,
	});
	const callTokenFlipRectsRef = useRef<Map<string, DOMRect>>(new Map());
	const callTokenFlipFrameRef = useRef<number | null>(null);
	const callTokenDropTimerRef = useRef<number | null>(null);
	const [activeReportTask, setActiveReportTask] = useState<SiteTaskKind | null>(
		null,
	);
	const [cooldownDetailSite, setCooldownDetailSite] = useState<Site | null>(
		null,
	);
	const isOfficialType =
		siteForm.site_type === "openai" ||
		siteForm.site_type === "anthropic" ||
		siteForm.site_type === "gemini";
	const needsSystemToken = !isOfficialType;
	const isNewApi = siteForm.site_type === "new-api";
	const checkinTask = taskReports.checkin;
	const verifyActiveTask = taskReports["verify-active"];
	const verifyDisabledTask = taskReports["verify-disabled"];
	const refreshTask = taskReports["refresh-active"];
	const failedVerificationItems =
		verifyActiveTask?.kind === "verify-active"
			? verifyActiveTask.report.items.filter(
					(item) => item.verdict !== "serving",
				)
			: [];
	const recoveredItems =
		verifyDisabledTask?.kind === "verify-disabled"
			? verifyDisabledTask.report.items.filter(
					(item) => item.verdict === "recoverable",
				)
			: [];
	const stillFailedRecoveryItems =
		verifyDisabledTask?.kind === "verify-disabled"
			? verifyDisabledTask.report.items.filter(
					(item) => item.verdict !== "recoverable",
				)
			: [];
	const [visibleColumns, setVisibleColumns] = useState(() => {
		if (typeof window === "undefined") {
			return siteColumnDefaults;
		}
		const versionKey = "columns:sites:version";
		const storedVersion = window.localStorage.getItem(versionKey);
		const stored = loadColumnPrefs("columns:sites", siteColumnDefaults);
		const nextSet = new Set([...stored, ...requiredSiteColumns]);
		const normalized = siteColumnDefaults.filter((id) => nextSet.has(id));
		if (storedVersion !== siteColumnVersion) {
			window.localStorage.setItem(versionKey, siteColumnVersion);
			persistColumnPrefs("columns:sites", normalized);
			return normalized;
		}
		if (
			normalized.length !== stored.length ||
			normalized.some((id, index) => stored[index] !== id)
		) {
			persistColumnPrefs("columns:sites", normalized);
		}
		return normalized;
	});
	const visibleColumnSet = useMemo(
		() => new Set(visibleColumns),
		[visibleColumns],
	);
	const updateVisibleColumns = (next: string[]) => {
		const nextSet = new Set([...next, ...requiredSiteColumns]);
		const normalized = siteColumnDefaults.filter((id) => nextSet.has(id));
		setVisibleColumns(normalized);
		persistColumnPrefs("columns:sites", normalized);
	};
	const siteGridTemplate = useMemo(
		() =>
			siteColumnOptions
				.filter((column) => visibleColumnSet.has(column.id))
				.map((column) => column.width)
				.join(" "),
		[visibleColumnSet],
	);
	const displayCallTokens = draftCallTokens;
	const draggingCallTokenKey = activeCallTokenDrag?.tokenKey ?? null;
	const isDraggingCallToken = draggingCallTokenKey !== null;
	const syncCallTokensToForm = (tokens: SiteForm["call_tokens"]) => {
		onFormChange({ call_tokens: normalizeCallTokenOrder(tokens) });
	};
	const commitCallTokenOrder = (
		tokens: SiteForm["call_tokens"],
		options?: { syncForm?: boolean },
	) => {
		const normalizedTokens = normalizeCallTokenOrder(tokens);
		setDraftCallTokens(normalizedTokens);
		if (options?.syncForm !== false) {
			syncCallTokensToForm(normalizedTokens);
		}
	};
	const setActiveCallTokenDragState = (next: ActiveCallTokenDrag | null) => {
		activeCallTokenDragRef.current = next;
		setActiveCallTokenDrag(next);
	};
	const getCallTokenOverlayVisual = (): CallTokenOverlayVisual => {
		if (!callTokenOverlayVisualRef.current) {
			callTokenOverlayVisualRef.current = {
				frameId: null,
				scale: 1.015,
				transition: "none",
				x: 0,
				y: 0,
			};
		}
		return callTokenOverlayVisualRef.current;
	};
	const flushCallTokenOverlayVisual = () => {
		const overlay = callTokenOverlayRef.current;
		const visual = getCallTokenOverlayVisual();
		if (!overlay) {
			visual.frameId = null;
			return;
		}
		overlay.style.transition = visual.transition;
		overlay.style.transform = `translate3d(${visual.x}px, ${visual.y}px, 0) scale(${visual.scale})`;
		visual.frameId = null;
	};
	const scheduleCallTokenOverlayVisual = (
		patch: Partial<Omit<CallTokenOverlayVisual, "frameId">>,
	) => {
		const visual = getCallTokenOverlayVisual();
		callTokenOverlayVisualRef.current = {
			...visual,
			...patch,
			frameId: visual.frameId,
		};
		if (visual.frameId !== null) {
			return;
		}
		const frameId = window.requestAnimationFrame(() => {
			flushCallTokenOverlayVisual();
		});
		callTokenOverlayVisualRef.current.frameId = frameId;
	};
	const getCallTokenCardRefMap = () => {
		if (!callTokenCardRefs.current) {
			callTokenCardRefs.current = new Map<string, HTMLDivElement>();
		}
		return callTokenCardRefs.current;
	};
	const captureCallTokenRects = () => {
		const cardRefs = getCallTokenCardRefMap();
		const rects = new Map<string, DOMRect>();
		for (let index = 0; index < displayCallTokens.length; index += 1) {
			const token = displayCallTokens[index];
			const tokenKey = getCallTokenDragKey(token, index);
			const element = cardRefs.get(tokenKey);
			if (element) {
				rects.set(tokenKey, element.getBoundingClientRect());
			}
		}
		return rects;
	};
	const queueCallTokenFlip = () => {
		callTokenFlipRectsRef.current = captureCallTokenRects();
	};
	const setCallTokenCardRef = (
		tokenKey: string,
		element: HTMLDivElement | null,
	) => {
		const cardRefs = getCallTokenCardRefMap();
		if (element) {
			cardRefs.set(tokenKey, element);
			return;
		}
		cardRefs.delete(tokenKey);
	};
	const updateCallToken = (
		index: number,
		patch: Partial<SiteForm["call_tokens"][number]>,
	) => {
		const next = displayCallTokens.map((token, idx) =>
			idx === index ? { ...token, ...patch } : token,
		);
		commitCallTokenOrder(next);
	};
	const addCallToken = () => {
		const next = [
			...displayCallTokens,
			{
				name: `调用令牌${displayCallTokens.length + 1}`,
				api_key: "",
				priority: displayCallTokens.length,
			},
		];
		commitCallTokenOrder(next);
	};
	const removeCallToken = (index: number) => {
		if (displayCallTokens.length <= 1) {
			return;
		}
		const next = displayCallTokens.filter((_, idx) => idx !== index);
		commitCallTokenOrder(next);
		setActiveCallTokenDragState(null);
	};
	const moveCallToken = (fromIndex: number, toIndex: number) => {
		logCallTokenDrag("move-request", {
			fromIndex,
			toIndex,
			total: displayCallTokens.length,
		});
		queueCallTokenFlip();
		const next = reorderCallTokens(displayCallTokens, fromIndex, toIndex);
		commitCallTokenOrder(next);
	};
	const syncDraggedCallTokenOrder = (nextIndex: number) => {
		const currentDrag = activeCallTokenDragRef.current;
		if (!currentDrag || currentDrag.currentIndex === nextIndex) {
			return;
		}
		logCallTokenDrag("reorder", {
			tokenKey: currentDrag.tokenKey,
			fromIndex: currentDrag.currentIndex,
			toIndex: nextIndex,
		});
		queueCallTokenFlip();
		setActiveCallTokenDragState({
			...currentDrag,
			currentIndex: nextIndex,
		});
		const nextTokens = reorderCallTokens(
			displayCallTokens,
			currentDrag.currentIndex,
			nextIndex,
		);
		commitCallTokenOrder(nextTokens, { syncForm: false });
	};
	const beginPointerDrag = (
		tokenKey: string,
		index: number,
		event: PointerEvent,
	) => {
		const element = getCallTokenCardRefMap().get(tokenKey);
		const rect = element?.getBoundingClientRect();
		if (!rect) {
			logCallTokenDrag("pointer-down-skip", {
				tokenKey,
				index,
				reason: "missing-rect",
			});
			return;
		}
		logCallTokenDrag("pointer-down", {
			tokenKey,
			index,
			pointerId: event.pointerId,
			clientX: event.clientX,
			clientY: event.clientY,
		});
		setActiveCallTokenDragState({
			currentIndex: index,
			grabOffsetX: event.clientX - rect.left,
			grabOffsetY: event.clientY - rect.top,
			height: rect.height,
			isSettling: false,
			left: rect.left,
			pointerId: event.pointerId,
			tokenKey,
			top: rect.top,
			width: rect.width,
		});
		callTokenOverlayVisualRef.current = {
			frameId: null,
			scale: 1.015,
			transition: "none",
			x: 0,
			y: 0,
		};
		const currentTarget = event.currentTarget as
			| (EventTarget & { setPointerCapture?: (pointerId: number) => void })
			| null;
		currentTarget?.setPointerCapture?.(event.pointerId);
	};
	const resetCallTokenDrag = () => {
		logCallTokenDrag("reset", {
			draggingCallTokenKey,
		});
		if (callTokenDropTimerRef.current !== null) {
			window.clearTimeout(callTokenDropTimerRef.current);
			callTokenDropTimerRef.current = null;
		}
		if (callTokenFlipFrameRef.current !== null) {
			window.cancelAnimationFrame(callTokenFlipFrameRef.current);
			callTokenFlipFrameRef.current = null;
		}
		const overlayVisual = getCallTokenOverlayVisual();
		if (overlayVisual.frameId !== null) {
			window.cancelAnimationFrame(overlayVisual.frameId);
		}
		callTokenOverlayVisualRef.current = {
			frameId: null,
			scale: 1.015,
			transition: "none",
			x: 0,
			y: 0,
		};
		if (callTokenOverlayRef.current) {
			callTokenOverlayRef.current.style.transition = "";
			callTokenOverlayRef.current.style.transform = "";
		}
		callTokenFlipRectsRef.current = new Map();
		setActiveCallTokenDragState(null);
	};
	const finishPointerDrag = () => {
		const currentDrag = activeCallTokenDragRef.current;
		if (!currentDrag) {
			logCallTokenDrag("drop-skip", {
				reason: "missing-active-drag",
			});
			return;
		}
		const targetElement = getCallTokenCardRefMap().get(currentDrag.tokenKey);
		const targetRect = targetElement?.getBoundingClientRect();
		if (!targetRect) {
			resetCallTokenDrag();
			return;
		}
		logCallTokenDrag("pointer-up", {
			tokenKey: currentDrag.tokenKey,
			pointerId: currentDrag.pointerId,
			targetIndex: currentDrag.currentIndex,
			targetTop: targetRect.top,
		});
		setActiveCallTokenDragState({
			...currentDrag,
			isSettling: true,
		});
		scheduleCallTokenOverlayVisual({
			scale: 1,
			transition: `transform ${callTokenDropSettleMs}ms cubic-bezier(0.22, 1, 0.36, 1)`,
			x: targetRect.left - currentDrag.left,
			y: targetRect.top - currentDrag.top,
		});
		if (!haveSameCallTokenSequence(displayCallTokens, siteForm.call_tokens)) {
			syncCallTokensToForm(displayCallTokens);
		}
		if (callTokenDropTimerRef.current !== null) {
			window.clearTimeout(callTokenDropTimerRef.current);
		}
		callTokenDropTimerRef.current = window.setTimeout(() => {
			resetCallTokenDrag();
		}, callTokenDropSettleMs);
	};
	const toggleSort = (key: SiteSortKey) => {
		if (siteSort.key === key) {
			onSortChange({
				key,
				direction: siteSort.direction === "asc" ? "desc" : "asc",
			});
			return;
		}
		onSortChange({ key, direction: "asc" });
	};
	const sortIndicator = (key: SiteSortKey) => {
		if (siteSort.key !== key) {
			return "↕";
		}
		return siteSort.direction === "asc" ? "▲" : "▼";
	};
	const getTaskStatusText = (kind: SiteTaskKind) => {
		if (kind === "checkin") {
			if (!checkinTask || checkinTask.kind !== "checkin") {
				return "暂无";
			}
			if (checkinTask.summary.total === 0) {
				return `${formatTaskTime(checkinTask.runs_at)}  无站点`;
			}
			return `${formatTaskTime(checkinTask.runs_at)}  ${
				checkinTask.summary.failed > 0
					? `失败 ${checkinTask.summary.failed}`
					: "完成"
			}`;
		}
		if (kind === "verify-active") {
			if (!verifyActiveTask || verifyActiveTask.kind !== "verify-active") {
				return "暂无";
			}
			if (verifyActiveTask.report.summary.total === 0) {
				return `${formatTaskTime(verifyActiveTask.runs_at)}  无站点`;
			}
			return `${formatTaskTime(verifyActiveTask.runs_at)}  ${
				failedVerificationItems.length > 0
					? `异常 ${failedVerificationItems.length}`
					: "正常"
			}`;
		}
		if (kind === "verify-disabled") {
			if (
				!verifyDisabledTask ||
				verifyDisabledTask.kind !== "verify-disabled"
			) {
				return "暂无";
			}
			if (verifyDisabledTask.report.summary.total === 0) {
				return `${formatTaskTime(verifyDisabledTask.runs_at)}  无站点`;
			}
			return `${formatTaskTime(verifyDisabledTask.runs_at)}  ${
				recoveredItems.length > 0 ? `恢复 ${recoveredItems.length}` : "未恢复"
			}`;
		}
		if (!refreshTask || refreshTask.kind !== "refresh-active") {
			return "暂无";
		}
		if (refreshTask.report.summary.total === 0) {
			return `${formatTaskTime(refreshTask.runs_at)}  无站点`;
		}
		return `${formatTaskTime(refreshTask.runs_at)}  ${
			refreshTask.report.summary.failed > 0
				? `失败 ${refreshTask.report.summary.failed}`
				: "完成"
		}`;
	};
	const getTaskStatusClass = (kind: SiteTaskKind) => {
		if (!taskReports[kind]) {
			return "border-white/60 bg-white/65 text-[color:var(--app-ink-muted)]/80";
		}
		if (kind === "checkin") {
			return checkinTask &&
				checkinTask.kind === "checkin" &&
				checkinTask.summary.failed > 0
				? "border-amber-200 bg-amber-50/90 text-amber-700"
				: "border-slate-200 bg-slate-50/90 text-slate-600";
		}
		if (kind === "verify-active") {
			const hasHardFailure = failedVerificationItems.some(
				(item) => item.verdict === "failed",
			);
			if (hasHardFailure) {
				return "border-rose-200 bg-rose-50/90 text-rose-700";
			}
			if (failedVerificationItems.length > 0) {
				return "border-amber-200 bg-amber-50/90 text-amber-700";
			}
			return "border-slate-200 bg-slate-50/90 text-slate-600";
		}
		if (kind === "verify-disabled") {
			return recoveredItems.length > 0
				? "border-emerald-200 bg-emerald-50/90 text-emerald-700"
				: "border-slate-200 bg-slate-50/90 text-slate-600";
		}
		return refreshTask &&
			refreshTask.kind === "refresh-active" &&
			refreshTask.report.summary.failed > 0
			? "border-amber-200 bg-amber-50/90 text-amber-700"
			: "border-slate-200 bg-slate-50/90 text-slate-600";
	};
	const openTaskReport = (kind: SiteTaskKind) => {
		const hasReport = Boolean(taskReports[kind]);
		if (!hasReport) {
			return;
		}
		setActiveReportTask(kind);
	};
	const closeTaskReport = () => setActiveReportTask(null);
	const openCooldownDetails = (site: Site) => {
		if (getSiteCoolingModelCount(site) <= 0) {
			return;
		}
		setCooldownDetailSite(site);
	};
	const closeCooldownDetails = () => setCooldownDetailSite(null);
	const runTask = (kind: SiteTaskKind) => {
		if (kind === "checkin") {
			onRunAll();
			return;
		}
		if (kind === "verify-active") {
			onVerifyAll();
			return;
		}
		if (kind === "verify-disabled") {
			onEvaluateRecovery();
			return;
		}
		onRefreshAll();
	};
	const displayPages = siteTotal === 0 ? 0 : siteTotalPages;

	useEffect(() => {
		if (!cooldownDetailSite) {
			return;
		}
		const latest = sites.find((site) => site.id === cooldownDetailSite.id);
		if (!latest) {
			setCooldownDetailSite(null);
			return;
		}
		const latestSignature = JSON.stringify(latest.cooling_models ?? []);
		const currentSignature = JSON.stringify(
			cooldownDetailSite.cooling_models ?? [],
		);
		if (
			latestSignature !== currentSignature ||
			latest.name !== cooldownDetailSite.name
		) {
			setCooldownDetailSite(latest);
		}
	}, [cooldownDetailSite, sites]);

	useEffect(() => {
		if (!isSiteModalOpen) {
			return;
		}
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				onCloseModal();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isSiteModalOpen, onCloseModal]);
	useEffect(() => {
		setLocalSearch(siteSearch);
	}, [siteSearch]);
	useEffect(() => {
		const timer = window.setTimeout(() => {
			if (localSearch !== siteSearch) {
				onSearchChange(localSearch);
			}
		}, 300);
		return () => window.clearTimeout(timer);
	}, [localSearch, onSearchChange, siteSearch]);
	useEffect(() => {
		if (isDraggingCallToken) {
			return;
		}
		if (draftCallTokens === siteForm.call_tokens) {
			return;
		}
		setDraftCallTokens(siteForm.call_tokens);
	}, [draftCallTokens, isDraggingCallToken, siteForm.call_tokens]);
	useEffect(() => {
		const previousRects =
			callTokenFlipRectsRef.current ?? new Map<string, DOMRect>();
		if (previousRects.size === 0) {
			return;
		}
		if (callTokenFlipFrameRef.current !== null) {
			window.cancelAnimationFrame(callTokenFlipFrameRef.current);
			callTokenFlipFrameRef.current = null;
		}
		const frameId = window.requestAnimationFrame(() => {
			const cardRefs = getCallTokenCardRefMap();
			let animatedCount = 0;
			previousRects.forEach((previousRect, tokenKey) => {
				if (tokenKey === draggingCallTokenKey) {
					return;
				}
				const element = cardRefs.get(tokenKey);
				if (!element) {
					return;
				}
				const nextRect = element.getBoundingClientRect();
				const deltaY = previousRect.top - nextRect.top;
				if (Math.abs(deltaY) < 1) {
					return;
				}
				animatedCount += 1;
				element.style.transition = "none";
				element.style.transform = `translateY(${deltaY}px)`;
				window.requestAnimationFrame(() => {
					element.style.transition = `transform ${callTokenFlipDurationMs}ms cubic-bezier(0.22, 1, 0.36, 1)`;
					element.style.transform = "";
				});
				const cleanup = () => {
					element.style.transition = "";
					element.removeEventListener("transitionend", cleanup);
				};
				element.addEventListener("transitionend", cleanup);
			});
			logCallTokenDrag("flip-play", {
				animatedCount,
				draggingCallTokenKey,
			});
			callTokenFlipRectsRef.current = new Map();
			callTokenFlipFrameRef.current = null;
		});
		callTokenFlipFrameRef.current = frameId;
		return () => window.cancelAnimationFrame(frameId);
	}, [displayCallTokens, draggingCallTokenKey]);
	useEffect(() => {
		if (!isDraggingCallToken) {
			return;
		}
		const handlePointerMove = (event: PointerEvent) => {
			const currentDrag = activeCallTokenDragRef.current;
			if (!currentDrag || currentDrag.pointerId !== event.pointerId) {
				return;
			}
			const nextLeft = event.clientX - currentDrag.grabOffsetX;
			const nextTop = event.clientY - currentDrag.grabOffsetY;
			const nextOffsetX = nextLeft - currentDrag.left;
			const nextOffsetY = nextTop - currentDrag.top;
			let nextIndex = currentDrag.currentIndex;
			while (nextIndex > 0) {
				const previousToken = displayCallTokens[nextIndex - 1];
				const previousKey = getCallTokenDragKey(previousToken, nextIndex - 1);
				const previousCard = getCallTokenCardRefMap().get(previousKey);
				if (!previousCard) {
					break;
				}
				const previousRect = previousCard.getBoundingClientRect();
				if (event.clientY < previousRect.top + previousRect.height / 2) {
					nextIndex -= 1;
					continue;
				}
				break;
			}
			while (nextIndex < displayCallTokens.length - 1) {
				const nextToken = displayCallTokens[nextIndex + 1];
				const nextKey = getCallTokenDragKey(nextToken, nextIndex + 1);
				const nextCard = getCallTokenCardRefMap().get(nextKey);
				if (!nextCard) {
					break;
				}
				const nextRect = nextCard.getBoundingClientRect();
				if (event.clientY > nextRect.top + nextRect.height / 2) {
					nextIndex += 1;
					continue;
				}
				break;
			}
			logCallTokenDrag("pointer-move", {
				tokenKey: currentDrag.tokenKey,
				pointerId: event.pointerId,
				clientX: event.clientX,
				clientY: event.clientY,
				nextIndex,
				x: nextOffsetX,
				y: nextOffsetY,
			});
			scheduleCallTokenOverlayVisual({
				scale: 1.015,
				transition: "none",
				x: nextOffsetX,
				y: nextOffsetY,
			});
			syncDraggedCallTokenOrder(nextIndex);
			event.preventDefault();
		};
		const handlePointerFinish = (event: PointerEvent) => {
			const currentDrag = activeCallTokenDragRef.current;
			if (!currentDrag || currentDrag.pointerId !== event.pointerId) {
				return;
			}
			finishPointerDrag();
		};
		window.addEventListener("pointermove", handlePointerMove);
		window.addEventListener("pointerup", handlePointerFinish);
		window.addEventListener("pointercancel", handlePointerFinish);
		return () => {
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", handlePointerFinish);
			window.removeEventListener("pointercancel", handlePointerFinish);
		};
	}, [
		finishPointerDrag,
		isDraggingCallToken,
		displayCallTokens,
		syncDraggedCallTokenOrder,
	]);
	useEffect(
		() => () => {
			if (callTokenFlipFrameRef.current !== null) {
				window.cancelAnimationFrame(callTokenFlipFrameRef.current);
			}
			const overlayVisual = getCallTokenOverlayVisual();
			if (overlayVisual.frameId !== null) {
				window.cancelAnimationFrame(overlayVisual.frameId);
			}
			if (callTokenDropTimerRef.current !== null) {
				window.clearTimeout(callTokenDropTimerRef.current);
			}
		},
		[],
	);
	useEffect(() => {
		if (!isDraggingCallToken) {
			return;
		}
		const previousUserSelect = document.body.style.userSelect;
		const previousCursor = document.body.style.cursor;
		document.body.style.userSelect = "none";
		document.body.style.cursor = "grabbing";
		return () => {
			document.body.style.userSelect = previousUserSelect;
			document.body.style.cursor = previousCursor;
		};
	}, [isDraggingCallToken]);
	useEffect(() => {
		if (isSiteModalOpen) {
			return;
		}
		resetCallTokenDrag();
	}, [isSiteModalOpen]);
	useEffect(() => {
		if (!activeCallTokenDrag) {
			return;
		}
		flushCallTokenOverlayVisual();
	}, [
		activeCallTokenDrag?.currentIndex,
		activeCallTokenDrag?.isSettling,
		activeCallTokenDrag?.tokenKey,
	]);
	const getCallTokenSupportText = (index: number, isDragged: boolean) => {
		if (isDragged) {
			return "当前位置会实时让位，松开后会平滑落回卡槽。";
		}
		if (isDraggingCallToken) {
			return "其余卡片会按新的优先级即时重排。";
		}
		return "支持拖拽，也可使用上移/下移精确调整。";
	};
	const renderCallTokenCardBody = (
		token: SiteForm["call_tokens"][number],
		index: number,
		tokenKey: string,
		options: {
			isDragged: boolean;
			isOverlay?: boolean;
		},
	) => {
		const { isDragged, isOverlay = false } = options;
		const controlsDisabled = isOverlay || isDraggingCallToken;
		const dragHandleClass = isOverlay
			? "border-[color:var(--app-primary)] bg-[rgba(10,132,255,0.1)] text-[color:var(--app-primary)] shadow-[0_12px_30px_rgba(10,132,255,0.2)]"
			: isDragged
				? "border-[rgba(10,132,255,0.3)] bg-[rgba(10,132,255,0.05)] text-[color:var(--app-primary)]"
				: "border-white/70 bg-white/80 text-[color:var(--app-ink-muted)] hover:border-[color:var(--app-primary)] hover:text-[color:var(--app-primary)]";
		return (
			<>
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div class="flex min-w-0 items-center gap-2">
						{isOverlay ? (
							<div
								aria-hidden="true"
								class={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border text-sm ${dragHandleClass}`}
							>
								⋮⋮
							</div>
						) : (
							<div
								aria-label={`拖拽调整 ${token.name || `调用令牌${index + 1}`} 的优先级`}
								class={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border text-sm transition ${dragHandleClass} ${
									isDragged
										? "cursor-grabbing"
										: "cursor-grab active:cursor-grabbing"
								}`}
								role="button"
								style="touch-action: none;"
								tabIndex={isDraggingCallToken ? -1 : 0}
								onPointerDown={(event: PointerEvent) => {
									logCallTokenDrag("handle-pointer-down", {
										tokenKey,
										index,
										button: event.button,
										pointerId: event.pointerId,
									});
									if (event.button !== 0 || isDraggingCallToken) {
										return;
									}
									event.preventDefault();
									beginPointerDrag(tokenKey, index, event);
								}}
							>
								⋮⋮
							</div>
						)}
						<div class="min-w-0">
							<p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-[color:var(--app-ink-muted)]">
								优先级 {index + 1}
							</p>
							<p class="truncate text-xs text-[color:var(--app-ink-muted)]">
								{index === 0
									? "主优先级，优先尝试"
									: "优先级更低，前面的不可用时再尝试"}
							</p>
						</div>
					</div>
					<div class="flex items-center gap-2">
						<button
							aria-label="上移令牌优先级"
							class="rounded-lg border border-white/70 px-2 py-1 text-[11px] font-semibold text-[color:var(--app-ink-muted)] transition hover:border-[color:var(--app-primary)] hover:text-[color:var(--app-primary)] disabled:cursor-not-allowed disabled:opacity-40"
							type="button"
							disabled={controlsDisabled || index === 0}
							onClick={() => moveCallToken(index, index - 1)}
						>
							上移
						</button>
						<button
							aria-label="下移令牌优先级"
							class="rounded-lg border border-white/70 px-2 py-1 text-[11px] font-semibold text-[color:var(--app-ink-muted)] transition hover:border-[color:var(--app-primary)] hover:text-[color:var(--app-primary)] disabled:cursor-not-allowed disabled:opacity-40"
							type="button"
							disabled={
								controlsDisabled || index === displayCallTokens.length - 1
							}
							onClick={() => moveCallToken(index, index + 1)}
						>
							下移
						</button>
					</div>
				</div>
				<div class="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
					<Input
						class="text-xs"
						disabled={controlsDisabled}
						placeholder="备注名"
						value={token.name}
						onInput={(event) =>
							updateCallToken(index, {
								name: (event.currentTarget as HTMLInputElement).value,
							})
						}
					/>
					<Input
						class="text-xs"
						disabled={controlsDisabled}
						placeholder="调用令牌"
						value={token.api_key}
						onInput={(event) =>
							updateCallToken(index, {
								api_key: (event.currentTarget as HTMLInputElement).value,
							})
						}
					/>
				</div>
				<div class="mt-2 flex items-center justify-between gap-3">
					<p class="text-[11px] text-[color:var(--app-ink-muted)]">
						{getCallTokenSupportText(index, isDragged || isOverlay)}
					</p>
					<button
						class="text-[11px] font-semibold text-[color:var(--app-ink-muted)] transition-colors hover:text-[color:var(--app-danger)] disabled:cursor-not-allowed disabled:opacity-50"
						type="button"
						disabled={
							controlsDisabled || displayCallTokens.length <= 1 || isDragged
						}
						onClick={() => removeCallToken(index)}
					>
						删除此令牌
					</button>
				</div>
			</>
		);
	};
	const activeDraggedToken =
		activeCallTokenDrag === null
			? null
			: (displayCallTokens.find(
					(token, index) =>
						getCallTokenDragKey(token, index) === activeCallTokenDrag.tokenKey,
				) ?? null);
	const renderTaskReportDialog = () => {
		if (!activeReportTask) {
			return null;
		}
		if (activeReportTask === "checkin") {
			if (!checkinTask || checkinTask.kind !== "checkin") {
				return null;
			}
			const items = [...checkinTask.items].sort((left, right) => {
				const rank = { failed: 0, skipped: 1, success: 2 };
				const diff = rank[left.status] - rank[right.status];
				return diff !== 0 ? diff : left.name.localeCompare(right.name);
			});
			return (
				<Dialog open={Boolean(activeReportTask)} onClose={closeTaskReport}>
					<DialogContent class="max-w-4xl" aria-modal="true">
						<DialogHeader>
							<div>
								<DialogTitle>签到已启用站点</DialogTitle>
								<DialogDescription>
									最后记录 {formatTaskDateTime(checkinTask.runs_at)}。
								</DialogDescription>
							</div>
							<Button size="sm" type="button" onClick={closeTaskReport}>
								关闭
							</Button>
						</DialogHeader>
						<div class="mt-3 max-h-[55vh] space-y-2 overflow-y-auto">
							{items.length === 0 ? (
								<p class="text-xs text-[color:var(--app-ink-muted)]">
									当前没有开启签到的站点。
								</p>
							) : (
								items.map((item) => (
									<div
										class="grid gap-3 rounded-xl border border-white/60 bg-white/80 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]"
										key={item.id}
									>
										<div class="min-w-0">
											<p class="truncate text-sm font-semibold text-[color:var(--app-ink)]">
												{item.name}
											</p>
											<p class="text-[11px] text-[color:var(--app-ink-muted)]">
												{item.status === "failed"
													? "失败"
													: item.status === "skipped"
														? "已签"
														: "成功"}
											</p>
										</div>
										<p class="text-xs text-[color:var(--app-ink)]">
											{item.message || "-"}
										</p>
									</div>
								))
							)}
						</div>
					</DialogContent>
				</Dialog>
			);
		}
		if (activeReportTask === "verify-active") {
			if (!verifyActiveTask || verifyActiveTask.kind !== "verify-active") {
				return null;
			}
			const items = [...failedVerificationItems].sort((left, right) => {
				const diff =
					getVerificationSeverityRank(left.verdict) -
					getVerificationSeverityRank(right.verdict);
				return diff !== 0
					? diff
					: left.site_name.localeCompare(right.site_name);
			});
			const failedItems = items.filter((item) => item.verdict === "failed");
			return (
				<Dialog open={Boolean(activeReportTask)} onClose={closeTaskReport}>
					<DialogContent class="max-w-4xl" aria-modal="true">
						<DialogHeader>
							<div>
								<DialogTitle>检查启用渠道</DialogTitle>
								<DialogDescription>
									最后记录 {formatTaskDateTime(verifyActiveTask.runs_at)}。
								</DialogDescription>
							</div>
							<Button size="sm" type="button" onClick={closeTaskReport}>
								关闭
							</Button>
						</DialogHeader>
						<div class="mt-3 max-h-[55vh] space-y-2 overflow-y-auto">
							{items.length === 0 ? (
								<p class="text-xs text-[color:var(--app-ink-muted)]">
									本次无异常。
								</p>
							) : (
								items.map((item) => (
									<div
										class="grid gap-3 rounded-xl border border-white/60 bg-white/80 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto]"
										key={item.site_id}
									>
										<div class="min-w-0">
											<p class="truncate text-sm font-semibold text-[color:var(--app-ink)]">
												{item.site_name}
											</p>
											<p class="text-[11px] text-[color:var(--app-ink-muted)]">
												{getVerificationSeverityLabel(item.verdict)} ·{" "}
												{getVerificationVerdictLabel(item.verdict)}
											</p>
										</div>
										<div class="space-y-1">
											<p class="text-xs text-[color:var(--app-ink)]">
												{getPrimaryVerificationIssue(item)}
											</p>
											<p class="text-[11px] text-[color:var(--app-ink-muted)]">
												建议：{getSuggestedActionLabel(item.suggested_action)}
											</p>
										</div>
										<div class="flex flex-wrap items-center justify-end gap-2">
											<Button
												size="sm"
												type="button"
												class="h-8 px-3 text-xs"
												disabled={isActionPending(
													`site:verify:${item.site_id}`,
												)}
												onClick={() => onVerify(item.site_id)}
											>
												重新检查
											</Button>
											<Button
												size="sm"
												type="button"
												variant="danger"
												class="h-8 px-3 text-xs"
												disabled={isActionPending(
													`site:disableFailed:${item.site_id}`,
												)}
												onClick={() => onDisableFailedSite(item)}
											>
												禁用
											</Button>
										</div>
									</div>
								))
							)}
						</div>
						<DialogFooter>
							<Button size="sm" type="button" onClick={closeTaskReport}>
								关闭
							</Button>
							<Button
								size="sm"
								type="button"
								variant="danger"
								disabled={
									failedItems.length === 0 ||
									isActionPending("site:disableFailedAll")
								}
								onClick={onDisableAllFailedSites}
							>
								{isActionPending("site:disableFailedAll")
									? "禁用中..."
									: "禁用全部失败站点"}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			);
		}
		if (activeReportTask === "verify-disabled") {
			if (
				!verifyDisabledTask ||
				verifyDisabledTask.kind !== "verify-disabled"
			) {
				return null;
			}
			return (
				<Dialog open={Boolean(activeReportTask)} onClose={closeTaskReport}>
					<DialogContent class="max-w-4xl" aria-modal="true">
						<DialogHeader>
							<div>
								<DialogTitle>检查停用渠道</DialogTitle>
								<DialogDescription>
									最后记录 {formatTaskDateTime(verifyDisabledTask.runs_at)}。
								</DialogDescription>
							</div>
							<Button size="sm" type="button" onClick={closeTaskReport}>
								关闭
							</Button>
						</DialogHeader>
						<div class="mt-3 max-h-[55vh] space-y-4 overflow-y-auto">
							<div class="space-y-2">
								<p class="text-[11px] font-semibold text-[color:var(--app-ink-muted)]">
									已自动启用
								</p>
								{recoveredItems.length === 0 ? (
									<p class="text-xs text-[color:var(--app-ink-muted)]">
										本次无自动启用。
									</p>
								) : (
									recoveredItems.map((item) => (
										<div
											class="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)] gap-3 rounded-xl border border-white/60 bg-white/80 px-4 py-3"
											key={item.site_id}
										>
											<div class="min-w-0">
												<p class="truncate text-sm font-semibold text-[color:var(--app-ink)]">
													{item.site_name}
												</p>
												<p class="text-[11px] text-[color:var(--app-ink-muted)]">
													已自动启用
												</p>
											</div>
											<div class="min-w-0">
												<p class="text-[11px] font-semibold text-[color:var(--app-ink-muted)]">
													结果
												</p>
												<p class="mt-1 text-xs text-[color:var(--app-ink)]">
													{item.message}
												</p>
											</div>
										</div>
									))
								)}
							</div>
							<div class="space-y-2">
								<p class="text-[11px] font-semibold text-[color:var(--app-ink-muted)]">
									仍未恢复
								</p>
								{stillFailedRecoveryItems.length === 0 ? (
									<p class="text-xs text-[color:var(--app-ink-muted)]">
										本次已全部恢复。
									</p>
								) : (
									stillFailedRecoveryItems.map((item) => (
										<div
											class="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)] gap-3 rounded-xl border border-white/60 bg-white/80 px-4 py-3"
											key={item.site_id}
										>
											<div class="min-w-0">
												<p class="truncate text-sm font-semibold text-[color:var(--app-ink)]">
													{item.site_name}
												</p>
												<p class="text-[11px] text-[color:var(--app-ink-muted)]">
													仍未恢复
												</p>
											</div>
											<div class="min-w-0">
												<p class="text-[11px] font-semibold text-[color:var(--app-ink-muted)]">
													问题
												</p>
												<p class="mt-1 text-xs text-[color:var(--app-ink)]">
													{getPrimaryVerificationIssue(item)}
												</p>
											</div>
										</div>
									))
								)}
							</div>
						</div>
					</DialogContent>
				</Dialog>
			);
		}
		if (!refreshTask || refreshTask.kind !== "refresh-active") {
			return null;
		}
		const items = [...refreshTask.report.items].sort((left, right) => {
			if (left.status === right.status) {
				return left.site_name.localeCompare(right.site_name);
			}
			return left.status === "failed" ? -1 : 1;
		});
		return (
			<Dialog open={Boolean(activeReportTask)} onClose={closeTaskReport}>
				<DialogContent class="max-w-4xl" aria-modal="true">
					<DialogHeader>
						<div>
							<DialogTitle>更新启用渠道</DialogTitle>
							<DialogDescription>
								最后记录 {formatTaskDateTime(refreshTask.runs_at)}。
							</DialogDescription>
						</div>
						<Button size="sm" type="button" onClick={closeTaskReport}>
							关闭
						</Button>
					</DialogHeader>
					<div class="mt-3 max-h-[55vh] space-y-2 overflow-y-auto">
						{items.length === 0 ? (
							<p class="text-xs text-[color:var(--app-ink-muted)]">
								当前没有启用渠道可更新。
							</p>
						) : (
							items.map((item: SiteChannelRefreshItem) => (
								<div
									class="grid gap-3 rounded-xl border border-white/60 bg-white/80 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto]"
									key={item.site_id}
								>
									<div class="min-w-0">
										<p class="truncate text-sm font-semibold text-[color:var(--app-ink)]">
											{item.site_name}
										</p>
										<p class="text-[11px] text-[color:var(--app-ink-muted)]">
											{item.status === "failed" ? "失败" : "完成"}
										</p>
									</div>
									<div class="space-y-1">
										<p class="text-xs text-[color:var(--app-ink)]">
											{item.message}
										</p>
										<p class="text-[11px] text-[color:var(--app-ink-muted)]">
											{item.models.length > 0
												? `${item.models.length} 个模型`
												: "未更新模型"}
										</p>
									</div>
									<div class="flex justify-end">
										<Button
											size="sm"
											type="button"
											class="h-8 px-3 text-xs"
											disabled={isActionPending(`site:refresh:${item.site_id}`)}
											onClick={() =>
												onRefreshSite(
													pagedSites.find(
														(site) => site.id === item.site_id,
													) ?? {
														id: item.site_id,
														name: item.site_name,
														base_url: "",
														weight: 1,
														status: "active",
														site_type: "new-api",
														call_tokens: [],
													},
												)
											}
										>
											重新更新
										</Button>
									</div>
								</div>
							))
						)}
					</div>
				</DialogContent>
			</Dialog>
		);
	};
	const renderCooldownDetailsDialog = () => {
		if (!cooldownDetailSite) {
			return null;
		}
		const coolingModels = [...getCoolingModels(cooldownDetailSite)].sort(
			(left: SiteCoolingModel, right: SiteCoolingModel) =>
				right.remaining_seconds - left.remaining_seconds ||
				right.last_err_count - left.last_err_count ||
				left.model.localeCompare(right.model),
		);
		const maxRemaining = getSiteCoolingMaxRemainingSeconds(cooldownDetailSite);
		return (
			<Dialog open={Boolean(cooldownDetailSite)} onClose={closeCooldownDetails}>
				<DialogContent class="max-w-4xl" aria-modal="true">
					<DialogHeader>
						<div>
							<DialogTitle>模型冷却详情</DialogTitle>
							<DialogDescription>
								{cooldownDetailSite.name} · {coolingModels.length} 个模型冷却中
								{maxRemaining > 0
									? ` · 最长剩余 ${formatCooldownDuration(maxRemaining)}`
									: ""}
							</DialogDescription>
						</div>
						<Button size="sm" type="button" onClick={closeCooldownDetails}>
							关闭
						</Button>
					</DialogHeader>
					<div class="mt-3 max-h-[55vh] space-y-2 overflow-y-auto">
						{coolingModels.length === 0 ? (
							<p class="text-xs text-[color:var(--app-ink-muted)]">
								当前没有冷却中的模型。
							</p>
						) : (
							coolingModels.map((item) => (
								<div
									class="grid gap-3 rounded-xl border border-amber-200/70 bg-amber-50/70 px-4 py-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.75fr)_minmax(0,0.75fr)_minmax(0,1fr)_auto]"
									key={`${cooldownDetailSite.id}:${item.model}`}
								>
									<div class="min-w-0">
										<p class="truncate text-sm font-semibold text-[color:var(--app-ink)]">
											{item.model}
										</p>
										<p class="mt-1 truncate text-[11px] text-[color:var(--app-ink-muted)]">
											错误码：{item.last_err_code || "-"}
										</p>
									</div>
									<div>
										<p class="text-[11px] font-semibold text-[color:var(--app-ink-muted)]">
											剩余
										</p>
										<p class="mt-1 text-xs font-semibold text-amber-700">
											{formatCooldownDuration(item.remaining_seconds)}
										</p>
									</div>
									<div>
										<p class="text-[11px] font-semibold text-[color:var(--app-ink-muted)]">
											连续失败
										</p>
										<p class="mt-1 text-xs text-[color:var(--app-ink)]">
											{item.last_err_count} 次
										</p>
									</div>
									<div>
										<p class="text-[11px] font-semibold text-[color:var(--app-ink-muted)]">
											最近失败
										</p>
										<p class="mt-1 text-xs text-[color:var(--app-ink)]">
											{new Date(item.last_err_at * 1000).toLocaleString(
												"zh-CN",
												{
													hour12: false,
												},
											)}
										</p>
									</div>
									<div class="flex items-center justify-end">
										<Button
											class="h-8 px-3 text-xs"
											size="sm"
											type="button"
											disabled={isActionPending(
												`site:clearCooling:${cooldownDetailSite.id}:${item.model}`,
											)}
											onClick={() =>
												onClearCoolingModel(cooldownDetailSite.id, item.model)
											}
										>
											{isActionPending(
												`site:clearCooling:${cooldownDetailSite.id}:${item.model}`,
											)
												? "解除中..."
												: "解除"}
										</Button>
									</div>
								</div>
							))
						)}
					</div>
				</DialogContent>
			</Dialog>
		);
	};
	return (
		<div class="space-y-5">
			<div class="app-panel animate-fade-up space-y-4">
				<div class="flex flex-col gap-3 2xl:flex-row 2xl:items-start">
					<div class="min-w-0 flex-1 2xl:max-w-3xl">
						<h3 class="app-title text-lg">站点管理</h3>
						<p class="app-subtitle max-w-3xl break-words pr-1 leading-5">
							统一维护调用令牌、系统令牌与站点类型，并支持签到、检查、恢复与更新。
						</p>
					</div>
					<div class="flex w-full max-w-full flex-wrap items-center gap-2 pb-1 2xl:ml-auto 2xl:w-auto 2xl:flex-nowrap 2xl:justify-end">
						<div class="shrink-0">
							<ColumnPicker
								columns={siteColumnOptions}
								value={visibleColumns}
								onChange={updateVisibleColumns}
							/>
						</div>
						{siteTaskButtons.map((task) => {
							const pending =
								task.kind === "checkin"
									? isCheckinAll
									: task.kind === "verify-active"
										? isVerifyingAll
										: task.kind === "verify-disabled"
											? isRecoveryEvaluate
											: isRefreshingAll;
							return (
								<div
									class="flex shrink-0 items-center gap-1.5 rounded-full border border-white/70 bg-white/72 px-1.5 py-1 shadow-[0_6px_18px_rgba(15,23,42,0.04)]"
									key={task.kind}
								>
									<Button
										class="h-8 whitespace-nowrap rounded-full px-3 text-xs"
										size="sm"
										type="button"
										disabled={pending}
										onClick={() => runTask(task.kind)}
									>
										{pending ? task.pendingLabel : task.label}
									</Button>
									<button
										class={`inline-flex h-8 items-center rounded-full border px-3 text-[11px] leading-none ${
											taskReports[task.kind]
												? `${getTaskStatusClass(task.kind)} transition-colors hover:brightness-[0.98]`
												: `${getTaskStatusClass(task.kind)} cursor-default`
										}`}
										type="button"
										disabled={!taskReports[task.kind]}
										onClick={() => openTaskReport(task.kind)}
									>
										{getTaskStatusText(task.kind)}
									</button>
								</div>
							);
						})}
						<Button
							class="h-9 shrink-0 px-4 text-xs"
							size="sm"
							variant="primary"
							type="button"
							onClick={onCreate}
						>
							新增站点
						</Button>
					</div>
				</div>
				<Card variant="compact" class="app-toolbar-card space-y-3 p-4">
					<div class="flex flex-wrap items-center gap-3">
						<div class="app-search w-full sm:w-72">
							<span class="app-search__icon" aria-hidden="true">
								<svg
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
								>
									<title>搜索</title>
									<circle cx="11" cy="11" r="7" />
									<path d="M20 20l-3.5-3.5" />
								</svg>
							</span>
							<input
								class="app-search__input"
								placeholder="搜索站点名称或 URL"
								value={localSearch}
								onInput={(event) =>
									setLocalSearch(
										(event.currentTarget as HTMLInputElement).value,
									)
								}
							/>
						</div>
						<SingleSelect
							class="w-full sm:w-40"
							options={[...cooldownFilterOptions]}
							value={siteCooldownFilter}
							onChange={(next) =>
								onCooldownFilterChange(next as SiteCooldownFilter)
							}
						/>
						<div class="flex flex-wrap items-center gap-2 md:hidden">
							{sortableColumns.map((column) => (
								<button
									class={`app-button app-focus h-8 px-3 text-[11px] ${
										siteSort.key === column.key ? "app-button-primary" : ""
									}`}
									key={column.key}
									type="button"
									onClick={() => toggleSort(column.key)}
								>
									{column.label} {sortIndicator(column.key)}
								</button>
							))}
						</div>
					</div>
				</Card>
				<div>
					<div class="app-mobile-stack space-y-3 md:hidden">
						{pagedSites.length === 0 ? (
							<Card class="text-center text-sm text-[color:var(--app-ink-muted)]">
								<p>
									{siteCooldownFilter === "cooling"
										? "暂无冷却中的模型-站点。"
										: "暂无站点，请先创建。"}
								</p>
								{siteCooldownFilter === "cooling" ? null : (
									<Button
										class="mt-4 h-9 px-4 text-xs"
										size="sm"
										variant="primary"
										type="button"
										onClick={onCreate}
									>
										新增站点
									</Button>
								)}
							</Card>
						) : (
							pagedSites.map((site) => {
								const isActive = site.status === "active";
								const isToday = site.last_checkin_date === today;
								const message = isToday ? site.last_checkin_message : null;
								const canCheckin = site.site_type === "new-api";
								const checkinDisabled = !canCheckin;
								const systemReady = Boolean(
									site.system_token && site.system_userid,
								);
								const callTokenCount = site.call_tokens?.length ?? 0;
								const coolingCount = getSiteCoolingModelCount(site);
								const verifyPending = isActionPending(`site:verify:${site.id}`);
								const checkinPending = isActionPending(
									`site:checkin:${site.id}`,
								);
								const refreshPending = isActionPending(
									`site:refresh:${site.id}`,
								);
								const togglePending = isActionPending(`site:toggle:${site.id}`);
								const deletePending = isActionPending(`site:delete:${site.id}`);
								return (
									<Card
										class={`p-4 ${
											editingSite?.id === site.id
												? "bg-[rgba(10,132,255,0.12)]"
												: ""
										}`}
										key={site.id}
									>
										<div class="flex items-start justify-between gap-3">
											<div class="min-w-0">
												<p class="truncate text-sm font-semibold text-[color:var(--app-ink)]">
													{site.name}
												</p>
												<p class="truncate text-xs text-[color:var(--app-ink-muted)]">
													{site.base_url}
												</p>
												{site.verification && (
													<p class="mt-1 truncate text-[11px] text-[color:var(--app-ink-muted)]">
														最近验证：
														{getVerificationVerdictLabel(
															site.verification.verdict,
														)}
													</p>
												)}
											</div>
											<Chip
												class="text-[10px] uppercase tracking-widest"
												variant={isActive ? "success" : "muted"}
											>
												{isActive ? "启用" : "禁用"}
											</Chip>
										</div>
										<div class="mt-3 flex items-center justify-between text-xs text-[color:var(--app-ink-muted)]">
											<span>类型</span>
											<span class="font-semibold text-[color:var(--app-ink)]">
												{getSiteTypeLabel(site.site_type)}
											</span>
										</div>
										<div class="mt-3 flex items-center justify-between text-xs text-[color:var(--app-ink-muted)]">
											<span>权重</span>
											<span class="font-semibold text-[color:var(--app-ink)]">
												{site.weight}
											</span>
										</div>
										<div class="mt-3 grid grid-cols-2 gap-2 text-xs text-[color:var(--app-ink-muted)]">
											<Card variant="compact">
												<p>系统令牌</p>
												<p class="mt-1 truncate font-semibold text-[color:var(--app-ink)]">
													{systemReady ? "已配置" : "未配置"}
												</p>
											</Card>
											<Card variant="compact">
												<p>调用令牌</p>
												<p class="mt-1 font-semibold text-[color:var(--app-ink)]">
													{callTokenCount > 0 ? `${callTokenCount} 个` : "-"}
												</p>
											</Card>
											<Card variant="compact">
												<p>冷却模型</p>
												<button
													class={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getCoolingToneClass(site)}`}
													type="button"
													disabled={coolingCount <= 0}
													onClick={() => openCooldownDetails(site)}
												>
													{getCoolingSummaryLabel(site)}
												</button>
											</Card>
											{site.site_type === "new-api" && (
												<Card variant="compact">
													<p>自动签到</p>
													<p class="mt-1 font-semibold text-[color:var(--app-ink)]">
														{site.checkin_enabled ? "已开启" : "已关闭"}
													</p>
												</Card>
											)}
											<Card variant="compact">
												<p>今日签到</p>
												<p class="mt-1 font-semibold text-[color:var(--app-ink)]">
													{getSiteCheckinLabel(site, today)}
												</p>
												{message &&
													site.site_type === "new-api" &&
													site.checkin_enabled && (
														<p class="mt-1 truncate text-[11px] text-[color:var(--app-ink-muted)]">
															{message}
														</p>
													)}
											</Card>
										</div>
										<div class="mt-3 grid grid-cols-2 gap-2">
											<Button
												class="h-9 w-full px-3 text-xs"
												size="sm"
												type="button"
												disabled={verifyPending}
												onClick={() => onVerify(site.id)}
											>
												{verifyPending ? "验证中..." : "验证"}
											</Button>
											<Button
												class="h-9 w-full px-3 text-xs"
												size="sm"
												type="button"
												disabled={checkinPending || checkinDisabled}
												title={
													checkinDisabled ? "仅 new-api 支持签到" : undefined
												}
												onClick={() => {
													if (!canCheckin) {
														return;
													}
													onCheckin(site);
												}}
											>
												{checkinPending ? "签到中..." : "签到"}
											</Button>
											<Button
												class="h-9 w-full px-3 text-xs"
												size="sm"
												type="button"
												disabled={refreshPending || !isActive}
												title={!isActive ? "仅启用渠道可更新" : undefined}
												onClick={() => onRefreshSite(site)}
											>
												{refreshPending ? "更新中..." : "更新渠道"}
											</Button>
											<Button
												class="h-9 w-full px-3 text-xs"
												size="sm"
												type="button"
												disabled={togglePending}
												onClick={() => onToggle(site.id, site.status)}
											>
												{togglePending
													? "处理中..."
													: isActive
														? "禁用"
														: "启用"}
											</Button>
											<Button
												class="h-9 w-full px-3 text-xs"
												size="sm"
												type="button"
												onClick={() => onEdit(site)}
											>
												编辑
											</Button>
											<Button
												class="h-9 w-full px-3 text-xs"
												size="sm"
												variant="ghost"
												type="button"
												disabled={deletePending}
												onClick={() => onDelete(site)}
											>
												{deletePending ? "删除中..." : "删除"}
											</Button>
										</div>
									</Card>
								);
							})
						)}
					</div>
					<div class="app-surface app-list-shell hidden overflow-hidden md:block">
						<div
							class="app-list-header grid gap-3 px-4 py-3 text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]"
							style={`grid-template-columns: ${siteGridTemplate};`}
						>
							{sortableColumns
								.filter((column) => visibleColumnSet.has(column.key))
								.map((column) => {
									const tooltip = columnTooltips[column.key];
									return (
										<div key={column.key}>
											<button
												class="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-[color:var(--app-ink-muted)] hover:text-[color:var(--app-ink)]"
												type="button"
												onClick={() => toggleSort(column.key)}
											>
												{tooltip ? (
													<Tooltip content={tooltip} class="inline-flex">
														<span>{column.label}</span>
													</Tooltip>
												) : (
													<span>{column.label}</span>
												)}
												<span class="text-[10px]">
													{sortIndicator(column.key)}
												</span>
											</button>
										</div>
									);
								})}
							{visibleColumnSet.has("actions") && <div>操作</div>}
						</div>
						{pagedSites.length === 0 ? (
							<div class="app-list-empty px-4 py-10 text-center text-sm text-[color:var(--app-ink-muted)]">
								<p>
									{siteCooldownFilter === "cooling"
										? "暂无冷却中的模型-站点。"
										: "暂无站点，请先创建。"}
								</p>
								{siteCooldownFilter === "cooling" ? null : (
									<Button
										class="mt-4 h-9 px-4 text-xs"
										size="sm"
										variant="primary"
										type="button"
										onClick={onCreate}
									>
										新增站点
									</Button>
								)}
							</div>
						) : (
							<div class="app-list-body divide-y divide-white/60">
								{pagedSites.map((site) => {
									const isActive = site.status === "active";
									const canCheckin = site.site_type === "new-api";
									const checkinDisabled = !canCheckin;
									const callTokenCount = site.call_tokens?.length ?? 0;
									const coolingCount = getSiteCoolingModelCount(site);
									const verifyPending = isActionPending(
										`site:verify:${site.id}`,
									);
									const checkinPending = isActionPending(
										`site:checkin:${site.id}`,
									);
									const refreshPending = isActionPending(
										`site:refresh:${site.id}`,
									);
									const togglePending = isActionPending(
										`site:toggle:${site.id}`,
									);
									const deletePending = isActionPending(
										`site:delete:${site.id}`,
									);
									return (
										<div
											class={`app-list-row grid items-center gap-3 px-4 py-4 text-sm ${
												editingSite?.id === site.id
													? "bg-[rgba(10,132,255,0.08)]"
													: ""
											}`}
											key={site.id}
											style={`grid-template-columns: ${siteGridTemplate};`}
										>
											{visibleColumnSet.has("name") && (
												<div class="flex min-w-0 flex-col">
													<span class="truncate font-semibold text-[color:var(--app-ink)]">
														{site.name}
													</span>
													<span
														class="truncate text-xs text-[color:var(--app-ink-muted)]"
														title={site.base_url}
													>
														{site.base_url}
													</span>
													{site.verification && (
														<span class="truncate text-[11px] text-[color:var(--app-ink-muted)]">
															最近验证：
															{getVerificationVerdictLabel(
																site.verification.verdict,
															)}
														</span>
													)}
												</div>
											)}
											{visibleColumnSet.has("type") && (
												<div class="text-xs font-semibold text-[color:var(--app-ink)]">
													{getSiteTypeLabel(site.site_type)}
												</div>
											)}
											{visibleColumnSet.has("status") && (
												<div>
													<Chip
														variant={isActive ? "success" : "muted"}
														class="text-xs"
													>
														{isActive ? "启用" : "禁用"}
													</Chip>
												</div>
											)}
											{visibleColumnSet.has("weight") && (
												<div class="text-xs font-semibold text-[color:var(--app-ink)]">
													{site.weight}
												</div>
											)}
											{visibleColumnSet.has("tokens") && (
												<div class="text-xs text-[color:var(--app-ink-muted)]">
													{callTokenCount > 0 ? `${callTokenCount} 个` : "-"}
												</div>
											)}
											{visibleColumnSet.has("cooldowns") && (
												<div>
													<button
														class={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${getCoolingToneClass(site)}`}
														type="button"
														disabled={coolingCount <= 0}
														onClick={() => openCooldownDetails(site)}
													>
														{getCoolingSummaryLabel(site)}
													</button>
												</div>
											)}
											{visibleColumnSet.has("checkin_enabled") && (
												<div class="text-xs text-[color:var(--app-ink-muted)]">
													{site.site_type === "new-api"
														? site.checkin_enabled
															? "已开启"
															: "已关闭"
														: "-"}
												</div>
											)}
											{visibleColumnSet.has("checkin") && (
												<div class="text-xs text-[color:var(--app-ink-muted)]">
													{getSiteCheckinLabel(site, today)}
												</div>
											)}
											{visibleColumnSet.has("actions") && (
												<div class="flex flex-wrap gap-2">
													<Button
														class="h-9 px-3 text-xs"
														size="sm"
														type="button"
														disabled={verifyPending}
														onClick={() => onVerify(site.id)}
													>
														{verifyPending ? "验证中..." : "验证"}
													</Button>
													<Button
														class="h-9 px-3 text-xs"
														size="sm"
														type="button"
														disabled={checkinPending || checkinDisabled}
														title={
															checkinDisabled
																? "仅 new-api 支持签到"
																: undefined
														}
														onClick={() => {
															if (!canCheckin) {
																return;
															}
															onCheckin(site);
														}}
													>
														{checkinPending ? "签到中..." : "签到"}
													</Button>
													<Button
														class="h-9 px-3 text-xs"
														size="sm"
														type="button"
														disabled={refreshPending || !isActive}
														title={!isActive ? "仅启用渠道可更新" : undefined}
														onClick={() => onRefreshSite(site)}
													>
														{refreshPending ? "更新中..." : "更新渠道"}
													</Button>
													<Button
														class="h-9 px-3 text-xs"
														size="sm"
														type="button"
														disabled={togglePending}
														onClick={() => onToggle(site.id, site.status)}
													>
														{togglePending
															? "处理中..."
															: isActive
																? "禁用"
																: "启用"}
													</Button>
													<Button
														class="h-9 px-3 text-xs"
														size="sm"
														type="button"
														onClick={() => onEdit(site)}
													>
														编辑
													</Button>
													<Button
														class="h-9 px-3 text-xs"
														size="sm"
														variant="ghost"
														type="button"
														disabled={deletePending}
														onClick={() => onDelete(site)}
													>
														{deletePending ? "删除中..." : "删除"}
													</Button>
												</div>
											)}
										</div>
									);
								})}
							</div>
						)}
					</div>
				</div>
				<div class="app-pagination-bar flex flex-col gap-3 text-xs text-[color:var(--app-ink-muted)] sm:flex-row sm:items-center sm:justify-between">
					<div class="flex flex-wrap items-center gap-2">
						<span class="text-xs text-[color:var(--app-ink-muted)]">
							共 {siteTotal} 条 · {displayPages} 页
						</span>
						<Pagination
							page={sitePage}
							totalPages={siteTotalPages}
							items={pageItems}
							onPageChange={onPageChange}
						/>
					</div>
					<div class="app-page-size-control">
						<span class="app-page-size-control__label">每页</span>
						<div class="app-page-size-control__chips">
							{pageSizeOptions.map((size) => (
								<button
									class={`app-page-size-chip ${
										sitePageSize === size ? "app-page-size-chip--active" : ""
									}`}
									key={size}
									type="button"
									onClick={() => onPageSizeChange(size)}
								>
									{size}
								</button>
							))}
						</div>
					</div>
				</div>
			</div>
			{renderCooldownDetailsDialog()}
			{renderTaskReportDialog()}
			{isSiteModalOpen && (
				<Dialog open={isSiteModalOpen} onClose={onCloseModal}>
					<DialogContent
						aria-labelledby="site-modal-title"
						aria-modal="true"
						class="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden"
					>
						<DialogHeader>
							<div>
								<DialogTitle id="site-modal-title">
									{isEditing ? "编辑站点" : "新增站点"}
								</DialogTitle>
								<DialogDescription>
									{isEditing
										? `正在编辑：${editingSite?.name ?? ""}`
										: "填写站点信息并保存。"}
								</DialogDescription>
							</div>
							<Button size="sm" type="button" onClick={onCloseModal}>
								关闭
							</Button>
						</DialogHeader>
						<form
							class="mt-4 grid min-h-0 gap-4 overflow-y-auto pr-1"
							onSubmit={onSubmit}
						>
							<Card class="p-4">
								<p class="text-xs font-semibold uppercase tracking-widest text-[color:var(--app-ink-muted)]">
									基础信息
								</p>
								<div class="mt-3 grid gap-4 md:grid-cols-2">
									<div>
										<label
											class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]"
											for="site-name"
										>
											名称
										</label>
										<Input
											id="site-name"
											name="name"
											value={siteForm.name}
											required
											onInput={(event) =>
												onFormChange({
													name: (event.currentTarget as HTMLInputElement).value,
												})
											}
										/>
									</div>
									<div>
										<label class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]">
											站点类型
										</label>
										<SingleSelect
											class="w-full"
											value={siteForm.site_type}
											options={siteTypeOptions}
											onChange={(next) =>
												onFormChange({
													site_type: next as Site["site_type"],
												})
											}
										/>
									</div>
								</div>
								<div class="mt-4">
									<label
										class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]"
										for="site-base"
									>
										基础 URL{isOfficialType ? "（可留空）" : ""}
									</label>
									<Input
										id="site-base"
										name="base_url"
										placeholder="https://api.example.com"
										value={siteForm.base_url}
										required={!isOfficialType}
										onInput={(event) =>
											onFormChange({
												base_url: (event.currentTarget as HTMLInputElement)
													.value,
											})
										}
									/>
								</div>
								<div class="mt-4 grid gap-4 md:grid-cols-2">
									<div>
										<label
											class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]"
											for="site-weight"
										>
											权重
										</label>
										<Input
											id="site-weight"
											name="weight"
											type="number"
											min="1"
											value={siteForm.weight}
											onInput={(event) =>
												onFormChange({
													weight: Number(
														(event.currentTarget as HTMLInputElement).value ||
															0,
													),
												})
											}
										/>
									</div>
									<div>
										<label class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]">
											站点状态
										</label>
										<SingleSelect
											class="w-full"
											value={siteForm.status}
											options={siteStatusOptions}
											onChange={(next) =>
												onFormChange({
													status: next,
												})
											}
										/>
									</div>
								</div>
							</Card>
							<Card class="p-4">
								<div class="flex flex-wrap items-center justify-between gap-2">
									<p class="text-xs font-semibold uppercase tracking-widest text-[color:var(--app-ink-muted)]">
										调用令牌
									</p>
									<Button
										class="h-8 px-3 text-[11px]"
										size="sm"
										type="button"
										onClick={addCallToken}
									>
										新增令牌
									</Button>
								</div>
								<p class="mt-2 text-xs text-[color:var(--app-ink-muted)]">
									用于实际调用，系统会按优先级依次选择可用令牌。可拖拽排序，最上方优先级最高。
								</p>
								<div class="mt-3 max-h-64 space-y-3 overflow-y-auto pr-1">
									{displayCallTokens.map((token, index) => {
										const tokenKey = getCallTokenDragKey(token, index);
										const isDragged = draggingCallTokenKey === tokenKey;
										return (
											<Card
												ref={(element: HTMLDivElement | null) =>
													setCallTokenCardRef(tokenKey, element)
												}
												variant="compact"
												class={`px-3 py-3 ${
													isDragged
														? "pointer-events-none border-dashed border-[rgba(10,132,255,0.35)] bg-[rgba(10,132,255,0.05)] opacity-45 shadow-none ring-1 ring-[rgba(10,132,255,0.12)]"
														: isDraggingCallToken
															? "border-white/85 bg-white/92 shadow-[0_14px_34px_rgba(15,23,42,0.08)] transition-shadow duration-200"
															: ""
												}`}
												key={tokenKey}
											>
												{renderCallTokenCardBody(token, index, tokenKey, {
													isDragged,
												})}
											</Card>
										);
									})}
								</div>
								{activeCallTokenDrag && activeDraggedToken && (
									<Card
										aria-hidden="true"
										ref={(element: HTMLDivElement | null) => {
											callTokenOverlayRef.current = element;
										}}
										variant="compact"
										class="pointer-events-none fixed z-[90] px-3 py-3 border-[color:var(--app-primary)] bg-white shadow-[0_26px_60px_rgba(15,23,42,0.24)] ring-1 ring-[rgba(10,132,255,0.18)]"
										style={`left:${activeCallTokenDrag.left}px; top:${activeCallTokenDrag.top}px; width:${activeCallTokenDrag.width}px; min-height:${activeCallTokenDrag.height}px; will-change: transform;`}
									>
										{renderCallTokenCardBody(
											activeDraggedToken,
											activeCallTokenDrag.currentIndex,
											activeCallTokenDrag.tokenKey,
											{
												isDragged: false,
												isOverlay: true,
											},
										)}
									</Card>
								)}
							</Card>
							{needsSystemToken && (
								<Card class="p-4">
									<p class="text-xs font-semibold uppercase tracking-widest text-[color:var(--app-ink-muted)]">
										系统令牌与签到
									</p>
									<div class="mt-3 grid gap-3 md:grid-cols-2">
										<Input
											placeholder="系统令牌"
											value={siteForm.system_token}
											onInput={(event) =>
												onFormChange({
													system_token: (
														event.currentTarget as HTMLInputElement
													).value,
												})
											}
										/>
										<Input
											placeholder="User ID"
											value={siteForm.system_userid}
											onInput={(event) =>
												onFormChange({
													system_userid: (
														event.currentTarget as HTMLInputElement
													).value,
												})
											}
										/>
									</div>
									<div class="mt-3 grid gap-3 md:grid-cols-2">
										{isNewApi && (
											<div class="flex items-center justify-between gap-3 rounded-xl border border-white/60 bg-white/70 px-3 py-2">
												<div>
													<p class="text-xs font-semibold uppercase tracking-widest text-[color:var(--app-ink-muted)]">
														自动签到
													</p>
													<p class="text-xs text-[color:var(--app-ink-muted)]">
														启用后按计划自动执行。
													</p>
												</div>
												<Switch
													checked={Boolean(siteForm.checkin_enabled)}
													onToggle={(next) =>
														onFormChange({ checkin_enabled: next })
													}
												/>
											</div>
										)}
										<Input
											placeholder={
												isNewApi ? "签到地址（可选）" : "外部签到地址（可选）"
											}
											value={siteForm.checkin_url}
											onInput={(event) =>
												onFormChange({
													checkin_url: (event.currentTarget as HTMLInputElement)
														.value,
												})
											}
										/>
									</div>
								</Card>
							)}
							<DialogFooter>
								<Button size="sm" type="button" onClick={onCloseModal}>
									取消
								</Button>
								<Button
									size="sm"
									variant="primary"
									type="submit"
									disabled={isSubmitting}
								>
									{isSubmitting
										? "保存中..."
										: isEditing
											? "保存修改"
											: "创建站点"}
								</Button>
							</DialogFooter>
						</form>
					</DialogContent>
				</Dialog>
			)}
		</div>
	);
};
