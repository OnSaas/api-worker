import "./styles.css";
import {
	render,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "hono/jsx/dom";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./components/ui";
import { createApiFetch } from "./core/api";
import {
	initialDashboardQuery,
	initialData,
	initialSettingsForm,
	initialSiteForm,
	initialTokenForm,
	tabs,
} from "./core/constants";
import {
	filterSites,
	type SiteSortState,
	type SiteTestResult,
	sortSites,
	summarizeSiteTests,
} from "./core/sites";
import type {
	AdminData,
	CheckinSummary,
	DashboardData,
	DashboardQuery,
	NoticeMessage,
	NoticeTone,
	RuntimeEventQuery,
	RuntimeEventResponse,
	Settings,
	SettingsForm,
	Site,
	SiteForm,
	SiteType,
	TabId,
	Token,
	TokenForm,
	UsageQuery,
	UsageResponse,
} from "./core/types";
import {
	getBeijingDateString,
	loadPageSizePref,
	persistPageSizePref,
	toChinaDateTimeInput,
	toChinaIsoFromInput,
	toggleStatus,
} from "./core/utils";
import { AppLayout } from "./features/AppLayout";
import { DashboardView } from "./features/DashboardView";
import { LoginView } from "./features/LoginView";
import { ModelsView } from "./features/ModelsView";
import { RuntimeEventsView } from "./features/RuntimeEventsView";
import { SettingsView } from "./features/SettingsView";
import { SitesView } from "./features/SitesView";
import { TokensView } from "./features/TokensView";
import { UsageView } from "./features/UsageView";

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
	throw new Error("Missing #app root");
}

const normalizePath = (path: string) => {
	if (path.length <= 1) {
		return "/";
	}
	return path.replace(/\/+$/, "") || "/";
};

const tabToPath: Record<TabId, string> = {
	dashboard: "/",
	channels: "/channels",
	models: "/models",
	tokens: "/tokens",
	usage: "/usage",
	runtime_events: "/runtime-events",
	settings: "/settings",
};

const pathToTab: Record<string, TabId> = {
	"/": "dashboard",
	"/channels": "channels",
	"/models": "models",
	"/tokens": "tokens",
	"/usage": "usage",
	"/runtime-events": "runtime_events",
	"/settings": "settings",
};

const DEFAULT_BASE_URL_BY_TYPE: Partial<Record<SiteType, string>> = {
	openai: "https://api.openai.com",
	anthropic: "https://api.anthropic.com",
	gemini: "https://generativelanguage.googleapis.com",
};

type ConfirmState = {
	title: string;
	message: string;
	confirmLabel?: string;
	tone?: NoticeTone;
	onConfirm: () => Promise<void> | void;
};

const buildActionKey = (scope: string, id?: string) =>
	id ? `${scope}:${id}` : scope;

const initialUsageQuery: UsageQuery = {
	channel_ids: [],
	token_ids: [],
	models: [],
	statuses: [],
	from: "",
	to: "",
};

const initialRuntimeEventQuery: RuntimeEventQuery = {
	levels: [],
	codes: [],
	request_id: "",
	session_id: "",
	path: "",
	from: "",
	to: "",
};

const dashboardPresetDays: Record<DashboardQuery["preset"], number> = {
	all: 0,
	"7d": 7,
	"30d": 30,
	"90d": 90,
	"1y": 365,
	custom: 30,
};

const resolveDashboardRange = (query: DashboardQuery) => {
	const today = new Date();
	if (query.preset === "all") {
		return { from: "", to: "", days: 0 };
	}
	if (query.preset !== "custom") {
		const days = dashboardPresetDays[query.preset];
		const fromDate = new Date(today);
		fromDate.setDate(today.getDate() - (days - 1));
		return {
			from: getBeijingDateString(fromDate),
			to: getBeijingDateString(today),
			days,
		};
	}
	const fromValue = query.from || getBeijingDateString(today);
	const toValue = query.to || getBeijingDateString(today);
	const fromDate = new Date(fromValue);
	const toDate = new Date(toValue);
	const diffDays =
		Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())
			? 1
			: Math.max(
					1,
					Math.ceil((toDate.getTime() - fromDate.getTime()) / 86400000) + 1,
				);
	return { from: fromValue, to: toValue, days: diffDays };
};

const buildDashboardParams = (query: DashboardQuery) => {
	const interval = query.interval;
	if (query.preset === "all") {
		const params = new URLSearchParams();
		params.set("interval", interval);
		params.set("limit", "366");
		const channelIds = query.channel_ids.filter(Boolean);
		const tokenIds = query.token_ids.filter(Boolean);
		if (channelIds.length > 0) {
			params.set("channel_ids", channelIds.join(","));
		}
		if (tokenIds.length > 0) {
			params.set("token_ids", tokenIds.join(","));
		}
		if (query.model) {
			params.set("model", query.model);
		}
		return { params, range: { from: "", to: "" } };
	}
	const { from, to, days } = resolveDashboardRange(query);
	const limit =
		interval === "day"
			? days
			: interval === "week"
				? Math.ceil(days / 7)
				: Math.ceil(days / 30);
	const params = new URLSearchParams();
	params.set("interval", interval);
	params.set("limit", String(limit));
	if (from) {
		params.set("from", `${from} 00:00:00`);
	}
	if (to) {
		params.set("to", `${to} 23:59:59`);
	}
	const channelIds = query.channel_ids.filter(Boolean);
	const tokenIds = query.token_ids.filter(Boolean);
	if (channelIds.length > 0) {
		params.set("channel_ids", channelIds.join(","));
	}
	if (tokenIds.length > 0) {
		params.set("token_ids", tokenIds.join(","));
	}
	if (query.model) {
		params.set("model", query.model);
	}
	return { params, range: { from, to } };
};

/**
 * Renders the admin console application.
 *
 * Returns:
 *   Root application JSX element.
 */
const App = () => {
	const [token, setToken] = useState<string | null>(() =>
		localStorage.getItem("admin_token"),
	);
	const [activeTab, setActiveTab] = useState<TabId>(() => {
		if (typeof window === "undefined") {
			return "dashboard";
		}
		const normalized = normalizePath(window.location.pathname);
		return pathToTab[normalized] ?? "dashboard";
	});
	const [loading, setLoading] = useState(false);
	const [notices, setNotices] = useState<NoticeMessage[]>([]);
	const [data, setData] = useState<AdminData>(initialData);
	const [dashboardQuery, setDashboardQuery] = useState<DashboardQuery>(() => {
		if (typeof window === "undefined") {
			return initialDashboardQuery;
		}
		const storedPreset = window.localStorage.getItem("dashboard:preset");
		const storedInterval = window.localStorage.getItem("dashboard:interval");
		const storedFrom = window.localStorage.getItem("dashboard:from") ?? "";
		const storedTo = window.localStorage.getItem("dashboard:to") ?? "";
		const allowedPresets: Array<DashboardQuery["preset"]> = [
			"all",
			"7d",
			"30d",
			"90d",
			"1y",
			"custom",
		];
		const preset = allowedPresets.includes(
			storedPreset as DashboardQuery["preset"],
		)
			? (storedPreset as DashboardQuery["preset"])
			: initialDashboardQuery.preset;
		const interval =
			storedInterval === "day" ||
			storedInterval === "week" ||
			storedInterval === "month"
				? (storedInterval as DashboardQuery["interval"])
				: initialDashboardQuery.interval;
		if (preset === "custom") {
			return {
				...initialDashboardQuery,
				preset,
				interval,
				from: storedFrom,
				to: storedTo,
			};
		}
		return { ...initialDashboardQuery, preset, interval, from: "", to: "" };
	});
	const [settingsForm, setSettingsForm] =
		useState<SettingsForm>(initialSettingsForm);
	const [sitePage, setSitePage] = useState(1);
	const [sitePageSize, setSitePageSize] = useState(() =>
		loadPageSizePref("pageSize:sites", 10),
	);
	const [siteSearch, setSiteSearch] = useState("");
	const [siteSort, setSiteSort] = useState<SiteSortState>({
		key: "name",
		direction: "asc",
	});
	const [tokenPage, setTokenPage] = useState(1);
	const [tokenPageSize, setTokenPageSize] = useState(() =>
		loadPageSizePref("pageSize:tokens", 10),
	);
	const [editingToken, setEditingToken] = useState<Token | null>(null);
	const [tokenForm, setTokenForm] = useState<TokenForm>(initialTokenForm);
	const [usagePage, setUsagePage] = useState(1);
	const [usagePageSize, setUsagePageSize] = useState(() =>
		loadPageSizePref("pageSize:usage", 50),
	);
	const [usageTotal, setUsageTotal] = useState(0);
	const [usageFilters, setUsageFilters] =
		useState<UsageQuery>(initialUsageQuery);
	const [usageQuery, setUsageQuery] = useState<UsageQuery>(initialUsageQuery);
	const [runtimeEventsPage, setRuntimeEventsPage] = useState(1);
	const [runtimeEventsPageSize, setRuntimeEventsPageSize] = useState(() =>
		loadPageSizePref("pageSize:runtimeEvents", 50),
	);
	const [runtimeEventsTotal, setRuntimeEventsTotal] = useState(0);
	const [runtimeEventFilters, setRuntimeEventFilters] =
		useState<RuntimeEventQuery>(initialRuntimeEventQuery);
	const [runtimeEventQuery, setRuntimeEventQuery] = useState<RuntimeEventQuery>(
		initialRuntimeEventQuery,
	);
	const [editingSite, setEditingSite] = useState<Site | null>(null);
	const [siteForm, setSiteForm] = useState<SiteForm>(() => ({
		...initialSiteForm,
	}));
	const [isSiteModalOpen, setSiteModalOpen] = useState(false);
	const [isTokenModalOpen, setTokenModalOpen] = useState(false);
	const [checkinSummary, setCheckinSummary] = useState<CheckinSummary | null>(
		null,
	);
	const [checkinLastRun, setCheckinLastRun] = useState<string | null>(null);
	const [, setPendingActions] = useState<Set<string>>(() => new Set());
	const pendingActionsRef = useRef<Set<string>>(new Set()) as {
		current: Set<string>;
	};
	const noticeTimersRef = useRef<Map<number, number>>(new Map()) as {
		current: Map<number, number>;
	};
	const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
	const [confirmPending, setConfirmPending] = useState(false);

	const updateToken = useCallback((next: string | null) => {
		setToken(next);
		if (next) {
			localStorage.setItem("admin_token", next);
		} else {
			localStorage.removeItem("admin_token");
		}
	}, []);

	const pushNotice = useCallback(
		(tone: NoticeTone, message: string, durationMs?: number) => {
			setNotices((prev) => [
				...prev,
				{ tone, message, id: Date.now() + Math.random(), durationMs },
			]);
		},
		[],
	);

	const dismissNotice = useCallback((id?: number) => {
		setNotices((prev) => {
			if (id === undefined) {
				return [];
			}
			return prev.filter((item) => item.id !== id);
		});
	}, []);

	useEffect(() => {
		const timers = noticeTimersRef.current;
		const activeIds = new Set(notices.map((item) => item.id));
		for (const [id, timer] of timers) {
			if (!activeIds.has(id)) {
				window.clearTimeout(timer);
				timers.delete(id);
			}
		}
		for (const notice of notices) {
			if (timers.has(notice.id)) {
				continue;
			}
			const durationMs = notice.durationMs ?? 4500;
			const timer = window.setTimeout(() => {
				dismissNotice(notice.id);
			}, durationMs);
			timers.set(notice.id, timer);
		}
	}, [dismissNotice, notices]);

	useEffect(() => {
		return () => {
			for (const timer of noticeTimersRef.current.values()) {
				window.clearTimeout(timer);
			}
			noticeTimersRef.current.clear();
		};
	}, []);

	const startAction = useCallback((key: string) => {
		if (pendingActionsRef.current.has(key)) {
			return;
		}
		pendingActionsRef.current.add(key);
		setPendingActions(new Set(pendingActionsRef.current));
	}, []);

	const endAction = useCallback((key: string) => {
		pendingActionsRef.current.delete(key);
		setPendingActions(new Set(pendingActionsRef.current));
	}, []);

	const isActionPending = useCallback(
		(key: string) => pendingActionsRef.current.has(key),
		[],
	);

	const openConfirm = useCallback((state: ConfirmState) => {
		setConfirmState(state);
	}, []);

	const closeConfirm = useCallback(() => {
		if (!confirmPending) {
			setConfirmState(null);
		}
	}, [confirmPending]);

	const handleConfirm = useCallback(async () => {
		if (!confirmState || confirmPending) {
			return;
		}
		setConfirmPending(true);
		try {
			await confirmState.onConfirm();
		} finally {
			setConfirmPending(false);
			setConfirmState(null);
		}
	}, [confirmPending, confirmState]);

	useEffect(() => {
		if (!confirmState) {
			return;
		}
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				closeConfirm();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [confirmState, closeConfirm]);

	const apiFetch = useMemo(
		() => createApiFetch(token, () => updateToken(null)),
		[token, updateToken],
	);

	const loadDashboard = useCallback(
		async (override?: DashboardQuery) => {
			const query = override ?? dashboardQuery;
			const { params } = buildDashboardParams(query);
			const dashboard = await apiFetch<DashboardData>(
				`/api/dashboard?${params.toString()}`,
			);
			setData((prev) => ({ ...prev, dashboard }));
		},
		[apiFetch, dashboardQuery],
	);

	const handleDashboardRefresh = useCallback(async () => {
		const actionKey = buildActionKey("dashboard:refresh");
		if (isActionPending(actionKey)) {
			return;
		}
		startAction(actionKey);
		try {
			await loadDashboard();
			pushNotice("success", "数据已刷新");
		} catch (error) {
			pushNotice("error", (error as Error).message);
		} finally {
			endAction(actionKey);
		}
	}, [endAction, isActionPending, loadDashboard, pushNotice, startAction]);

	const handleDashboardQueryChange = useCallback(
		(patch: Partial<DashboardQuery>) => {
			setDashboardQuery((prev) => {
				const next = { ...prev, ...patch };
				if (typeof window !== "undefined") {
					window.localStorage.setItem("dashboard:preset", next.preset);
					window.localStorage.setItem("dashboard:interval", next.interval);
					if (next.preset === "custom") {
						window.localStorage.setItem("dashboard:from", next.from);
						window.localStorage.setItem("dashboard:to", next.to);
					} else {
						window.localStorage.removeItem("dashboard:from");
						window.localStorage.removeItem("dashboard:to");
					}
				}
				return next;
			});
		},
		[],
	);

	const handleDashboardApply = useCallback(
		async (override?: DashboardQuery) => {
			const actionKey = buildActionKey("dashboard:filter");
			if (isActionPending(actionKey)) {
				return;
			}
			const nextQuery = override ?? dashboardQuery;
			startAction(actionKey);
			try {
				await loadDashboard(nextQuery);
				pushNotice("success", "筛选已更新");
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[
			dashboardQuery,
			endAction,
			isActionPending,
			loadDashboard,
			pushNotice,
			startAction,
		],
	);

	const loadSites = useCallback(async () => {
		const result = await apiFetch<{
			sites: Site[];
		}>("/api/sites");
		setData((prev) => ({
			...prev,
			sites: result.sites,
		}));
	}, [apiFetch]);

	const loadModels = useCallback(async () => {
		const result = await apiFetch<{
			models: Array<{
				id: string;
				channels: Array<{ id: string; name: string }>;
			}>;
		}>("/api/models");
		setData((prev) => ({ ...prev, models: result.models }));
	}, [apiFetch]);

	const loadTokens = useCallback(async () => {
		const result = await apiFetch<{ tokens: Token[] }>("/api/tokens");
		setData((prev) => ({ ...prev, tokens: result.tokens }));
	}, [apiFetch]);

	const loadUsage = useCallback(
		async (options?: {
			page?: number;
			pageSize?: number;
			query?: UsageQuery;
		}) => {
			const page = options?.page ?? usagePage;
			const pageSize = options?.pageSize ?? usagePageSize;
			const query = options?.query ?? usageQuery;
			const params = new URLSearchParams();
			const offset = Math.max(0, (page - 1) * pageSize);
			params.set("limit", String(pageSize));
			params.set("offset", String(offset));
			const channelIds = query.channel_ids.filter(Boolean);
			const tokenIds = query.token_ids.filter(Boolean);
			const models = query.models.filter(Boolean);
			const statuses = query.statuses.filter(Boolean);
			const from = query.from.trim();
			const to = query.to.trim();
			if (from) {
				params.set("from", `${from} 00:00:00`);
			}
			if (to) {
				params.set("to", `${to} 23:59:59`);
			}
			if (channelIds.length > 0) {
				params.set("channel_ids", channelIds.join(","));
			}
			if (tokenIds.length > 0) {
				params.set("token_ids", tokenIds.join(","));
			}
			if (models.length > 0) {
				params.set("models", models.join(","));
			}
			if (statuses.length > 0) {
				params.set("statuses", statuses.join(","));
			}
			const result = await apiFetch<UsageResponse>(
				`/api/usage?${params.toString()}`,
			);
			setData((prev) => ({ ...prev, usage: result.logs }));
			setUsageTotal(result.total ?? result.logs.length);
		},
		[apiFetch, usagePage, usagePageSize, usageQuery],
	);

	const loadRuntimeEvents = useCallback(
		async (options?: {
			page?: number;
			pageSize?: number;
			query?: RuntimeEventQuery;
		}) => {
			const page = options?.page ?? runtimeEventsPage;
			const pageSize = options?.pageSize ?? runtimeEventsPageSize;
			const query = options?.query ?? runtimeEventQuery;
			const params = new URLSearchParams();
			const offset = Math.max(0, (page - 1) * pageSize);
			params.set("limit", String(pageSize));
			params.set("offset", String(offset));
			const levels = query.levels.filter(Boolean);
			const codes = query.codes.filter(Boolean);
			const from = query.from.trim();
			const to = query.to.trim();
			const requestId = query.request_id.trim();
			const sessionId = query.session_id.trim();
			const path = query.path.trim();
			if (from) {
				params.set("from", `${from} 00:00:00`);
			}
			if (to) {
				params.set("to", `${to} 23:59:59`);
			}
			if (levels.length > 0) {
				params.set("levels", levels.join(","));
			}
			if (codes.length > 0) {
				params.set("codes", codes.join(","));
			}
			if (requestId) {
				params.set("request_id", requestId);
			}
			if (sessionId) {
				params.set("session_id", sessionId);
			}
			if (path) {
				params.set("path", path);
			}
			const result = await apiFetch<RuntimeEventResponse>(
				`/api/runtime-events?${params.toString()}`,
			);
			setData((prev) => ({ ...prev, runtime_events: result.events }));
			setRuntimeEventsTotal(result.total ?? result.events.length);
		},
		[apiFetch, runtimeEventQuery, runtimeEventsPage, runtimeEventsPageSize],
	);

	const loadSettings = useCallback(async () => {
		const settings = await apiFetch<Settings>("/api/settings");
		setData((prev) => ({ ...prev, settings }));
	}, [apiFetch]);

	const loadTab = useCallback(
		async (tabId: TabId) => {
			setLoading(true);
			dismissNotice();
			try {
				if (tabId === "dashboard") {
					await Promise.all([loadDashboard(), loadSites(), loadTokens()]);
				}
				if (tabId === "channels") {
					await loadSites();
				}
				if (tabId === "models") {
					await loadModels();
				}
				if (tabId === "tokens") {
					await Promise.all([loadTokens(), loadSites()]);
				}
				if (tabId === "usage") {
					await Promise.all([
						loadUsage(),
						loadSites(),
						loadTokens(),
						loadModels(),
					]);
				}
				if (tabId === "settings") {
					await loadSettings();
				}
				if (tabId === "runtime_events") {
					await loadRuntimeEvents();
				}
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				setLoading(false);
			}
		},
		[
			dismissNotice,
			loadDashboard,
			loadModels,
			loadSettings,
			loadSites,
			loadTokens,
			loadRuntimeEvents,
			loadUsage,
			pushNotice,
		],
	);

	useEffect(() => {
		if (token) {
			loadTab(activeTab);
		}
	}, [token, activeTab, loadTab]);

	useEffect(() => {
		const handlePopState = () => {
			const normalized = normalizePath(window.location.pathname);
			setActiveTab(pathToTab[normalized] ?? "dashboard");
		};
		window.addEventListener("popstate", handlePopState);
		return () => {
			window.removeEventListener("popstate", handlePopState);
		};
	}, []);

	useEffect(() => {
		if (!data.settings) {
			return;
		}
		const cacheConfig = data.settings.cache_config;
		const runtimeSettings =
			data.settings.runtime_settings ?? data.settings.runtime_config;
		setSettingsForm({
			log_retention_days: String(data.settings.log_retention_days ?? 30),
			runtime_event_retention_days: String(
				data.settings.runtime_event_retention_days ?? 30,
			),
			runtime_event_levels: Array.isArray(data.settings.runtime_event_levels)
				? data.settings.runtime_event_levels
				: ["info", "warning", "error"],
			session_ttl_hours: String(data.settings.session_ttl_hours ?? 12),
			admin_password: "",
			checkin_schedule_time: data.settings.checkin_schedule_time ?? "00:10",
			model_failure_cooldown_minutes: String(
				data.settings.model_failure_cooldown_minutes ?? 10,
			),
			proxy_upstream_timeout_ms: String(
				runtimeSettings?.upstream_timeout_ms ?? 30000,
			),
			proxy_retry_max_retries: String(runtimeSettings?.retry_max_retries ?? 3),
			proxy_stream_usage_mode: runtimeSettings?.stream_usage_mode ?? "full",
			proxy_stream_usage_max_bytes: String(
				runtimeSettings?.stream_usage_max_bytes ?? 0,
			),
			proxy_stream_usage_max_parsers: String(
				runtimeSettings?.stream_usage_max_parsers ?? 0,
			),
			proxy_usage_queue_enabled: runtimeSettings?.usage_queue_enabled ?? true,
			usage_queue_daily_limit: String(
				runtimeSettings?.usage_queue_daily_limit ?? 10000,
			),
			usage_queue_direct_write_ratio: String(
				runtimeSettings?.usage_queue_direct_write_ratio ?? 0.5,
			),
			cache_enabled: cacheConfig?.enabled ?? true,
			cache_ttl_dashboard_seconds: String(
				cacheConfig?.dashboard_ttl_seconds ?? 30,
			),
			cache_ttl_usage_seconds: String(cacheConfig?.usage_ttl_seconds ?? 15),
			cache_ttl_models_seconds: String(cacheConfig?.models_ttl_seconds ?? 60),
			cache_ttl_tokens_seconds: String(cacheConfig?.tokens_ttl_seconds ?? 15),
			cache_ttl_channels_seconds: String(
				cacheConfig?.channels_ttl_seconds ?? 15,
			),
			cache_ttl_call_tokens_seconds: String(
				cacheConfig?.call_tokens_ttl_seconds ?? 15,
			),
			cache_ttl_settings_seconds: String(
				cacheConfig?.settings_ttl_seconds ?? 30,
			),
		});
	}, [data.settings]);

	const handleLogin = useCallback(
		async (event: Event) => {
			event.preventDefault();
			const actionKey = buildActionKey("login:submit");
			if (isActionPending(actionKey)) {
				return;
			}
			startAction(actionKey);
			const form = event.currentTarget as HTMLFormElement;
			const formData = new FormData(form);
			const password = String(formData.get("password") ?? "");
			try {
				const result = await apiFetch<{ token: string }>("/api/auth/login", {
					method: "POST",
					body: JSON.stringify({ password }),
				});
				updateToken(result.token);
				dismissNotice();
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[
			apiFetch,
			dismissNotice,
			endAction,
			isActionPending,
			pushNotice,
			startAction,
			updateToken,
		],
	);

	const handleLogout = useCallback(async () => {
		await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => null);
		updateToken(null);
	}, [apiFetch, updateToken]);

	const handleSiteFormChange = useCallback((patch: Partial<SiteForm>) => {
		setSiteForm((prev) => {
			const next = { ...prev, ...patch };
			if (
				patch.site_type &&
				(!patch.base_url || patch.base_url.trim().length === 0) &&
				!prev.base_url.trim()
			) {
				const fallback = DEFAULT_BASE_URL_BY_TYPE[patch.site_type];
				if (fallback) {
					next.base_url = fallback;
				}
			}
			return next;
		});
	}, []);

	const handleSettingsFormChange = useCallback(
		(patch: Partial<SettingsForm>) => {
			setSettingsForm((prev) => ({ ...prev, ...patch }));
		},
		[],
	);

	const handleTokenFormChange = useCallback((patch: Partial<TokenForm>) => {
		setTokenForm((prev) => ({ ...prev, ...patch }));
	}, []);

	const handleSitePageChange = useCallback((next: number) => {
		setSitePage(next);
	}, []);

	const handleSitePageSizeChange = useCallback((next: number) => {
		persistPageSizePref("pageSize:sites", next);
		setSitePageSize(next);
		setSitePage(1);
	}, []);

	const handleSiteSearchChange = useCallback((next: string) => {
		setSiteSearch(next);
	}, []);

	const handleSiteSortChange = useCallback((next: SiteSortState) => {
		setSiteSort(next);
	}, []);

	const handleTokenPageChange = useCallback((next: number) => {
		setTokenPage(next);
	}, []);

	const handleTokenPageSizeChange = useCallback((next: number) => {
		persistPageSizePref("pageSize:tokens", next);
		setTokenPageSize(next);
		setTokenPage(1);
	}, []);

	const handleUsagePageChange = useCallback(
		async (next: number) => {
			if (next === usagePage) {
				return;
			}
			const actionKey = buildActionKey("usage:load");
			if (isActionPending(actionKey)) {
				return;
			}
			startAction(actionKey);
			setUsagePage(next);
			try {
				await loadUsage({ page: next });
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[endAction, isActionPending, loadUsage, pushNotice, startAction, usagePage],
	);

	const handleUsagePageSizeChange = useCallback(
		async (next: number) => {
			const actionKey = buildActionKey("usage:load");
			if (isActionPending(actionKey)) {
				return;
			}
			startAction(actionKey);
			persistPageSizePref("pageSize:usage", next);
			setUsagePageSize(next);
			setUsagePage(1);
			try {
				await loadUsage({ page: 1, pageSize: next });
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[endAction, isActionPending, loadUsage, pushNotice, startAction],
	);

	const handleUsageFiltersChange = useCallback((patch: Partial<UsageQuery>) => {
		setUsageFilters((prev) => ({ ...prev, ...patch }));
	}, []);

	const handleUsageSearch = useCallback(async () => {
		const actionKey = buildActionKey("usage:load");
		if (isActionPending(actionKey)) {
			return;
		}
		const nextQuery = {
			channel_ids: usageFilters.channel_ids.filter(Boolean),
			token_ids: usageFilters.token_ids.filter(Boolean),
			models: usageFilters.models.filter(Boolean),
			statuses: usageFilters.statuses.filter((value) => /^\d+$/.test(value)),
			from: usageFilters.from.trim(),
			to: usageFilters.to.trim(),
		};
		startAction(actionKey);
		setUsageQuery(nextQuery);
		setUsagePage(1);
		setUsageFilters(nextQuery);
		try {
			await loadUsage({ page: 1, query: nextQuery });
		} catch (error) {
			pushNotice("error", (error as Error).message);
		} finally {
			endAction(actionKey);
		}
	}, [
		endAction,
		isActionPending,
		loadUsage,
		pushNotice,
		startAction,
		usageFilters.channel_ids,
		usageFilters.from,
		usageFilters.models,
		usageFilters.statuses,
		usageFilters.token_ids,
		usageFilters.to,
	]);

	const handleUsageClear = useCallback(async () => {
		const actionKey = buildActionKey("usage:load");
		if (isActionPending(actionKey)) {
			return;
		}
		startAction(actionKey);
		setUsageFilters(initialUsageQuery);
		setUsageQuery(initialUsageQuery);
		setUsagePage(1);
		try {
			await loadUsage({ page: 1, query: initialUsageQuery });
		} catch (error) {
			pushNotice("error", (error as Error).message);
		} finally {
			endAction(actionKey);
		}
	}, [endAction, isActionPending, loadUsage, pushNotice, startAction]);

	const handleRuntimeEventsPageChange = useCallback(
		async (next: number) => {
			if (next === runtimeEventsPage) {
				return;
			}
			const actionKey = buildActionKey("runtime-events:load");
			if (isActionPending(actionKey)) {
				return;
			}
			startAction(actionKey);
			setRuntimeEventsPage(next);
			try {
				await loadRuntimeEvents({ page: next });
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[
			endAction,
			isActionPending,
			loadRuntimeEvents,
			pushNotice,
			runtimeEventsPage,
			startAction,
		],
	);

	const handleRuntimeEventsPageSizeChange = useCallback(
		async (next: number) => {
			const actionKey = buildActionKey("runtime-events:load");
			if (isActionPending(actionKey)) {
				return;
			}
			startAction(actionKey);
			persistPageSizePref("pageSize:runtimeEvents", next);
			setRuntimeEventsPageSize(next);
			setRuntimeEventsPage(1);
			try {
				await loadRuntimeEvents({ page: 1, pageSize: next });
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[endAction, isActionPending, loadRuntimeEvents, pushNotice, startAction],
	);

	const handleRuntimeEventFiltersChange = useCallback(
		(patch: Partial<RuntimeEventQuery>) => {
			setRuntimeEventFilters((prev) => ({ ...prev, ...patch }));
		},
		[],
	);

	const handleRuntimeEventSearch = useCallback(async () => {
		const actionKey = buildActionKey("runtime-events:load");
		if (isActionPending(actionKey)) {
			return;
		}
		const nextQuery = {
			levels: runtimeEventFilters.levels.filter(Boolean),
			codes: runtimeEventFilters.codes.filter(Boolean),
			request_id: runtimeEventFilters.request_id.trim(),
			session_id: runtimeEventFilters.session_id.trim(),
			path: runtimeEventFilters.path.trim(),
			from: runtimeEventFilters.from.trim(),
			to: runtimeEventFilters.to.trim(),
		};
		startAction(actionKey);
		setRuntimeEventQuery(nextQuery);
		setRuntimeEventFilters(nextQuery);
		setRuntimeEventsPage(1);
		try {
			await loadRuntimeEvents({ page: 1, query: nextQuery });
		} catch (error) {
			pushNotice("error", (error as Error).message);
		} finally {
			endAction(actionKey);
		}
	}, [
		endAction,
		isActionPending,
		loadRuntimeEvents,
		pushNotice,
		runtimeEventFilters.codes,
		runtimeEventFilters.from,
		runtimeEventFilters.levels,
		runtimeEventFilters.path,
		runtimeEventFilters.request_id,
		runtimeEventFilters.session_id,
		runtimeEventFilters.to,
		startAction,
	]);

	const handleRuntimeEventClear = useCallback(async () => {
		const actionKey = buildActionKey("runtime-events:load");
		if (isActionPending(actionKey)) {
			return;
		}
		startAction(actionKey);
		setRuntimeEventFilters(initialRuntimeEventQuery);
		setRuntimeEventQuery(initialRuntimeEventQuery);
		setRuntimeEventsPage(1);
		try {
			await loadRuntimeEvents({ page: 1, query: initialRuntimeEventQuery });
		} catch (error) {
			pushNotice("error", (error as Error).message);
		} finally {
			endAction(actionKey);
		}
	}, [endAction, isActionPending, loadRuntimeEvents, pushNotice, startAction]);

	const handleTabChange = useCallback(
		(tabId: TabId) => {
			const nextPath = tabToPath[tabId];
			const normalized = normalizePath(window.location.pathname);
			if (normalized !== nextPath) {
				history.pushState(null, "", nextPath);
			}
			dismissNotice();
			setActiveTab(tabId);
		},
		[dismissNotice],
	);

	const closeSiteModal = useCallback(() => {
		setEditingSite(null);
		setSiteForm({ ...initialSiteForm });
		setSiteModalOpen(false);
	}, []);

	const openSiteCreate = useCallback(() => {
		setEditingSite(null);
		setSiteForm({ ...initialSiteForm });
		setSiteModalOpen(true);
		dismissNotice();
	}, [dismissNotice]);

	const openTokenCreate = useCallback(() => {
		setEditingToken(null);
		setTokenForm({ ...initialTokenForm });
		setTokenModalOpen(true);
		dismissNotice();
	}, [dismissNotice]);

	const startSiteEdit = useCallback(
		(site: Site) => {
			setEditingSite(site);
			const callTokens =
				site.call_tokens && site.call_tokens.length > 0
					? site.call_tokens
					: site.api_key
						? [
								{
									id: "",
									name: "主调用令牌",
									api_key: site.api_key,
								},
							]
						: [];
			const tokenForms =
				callTokens.length > 0
					? callTokens.map((token) => ({
							id: token.id,
							name: token.name,
							api_key: token.api_key,
						}))
					: [
							{
								name: "主调用令牌",
								api_key: "",
							},
						];
			setSiteForm({
				name: site.name ?? "",
				base_url: site.base_url ?? "",
				weight: site.weight ?? 1,
				status: site.status ?? "active",
				site_type: site.site_type ?? "new-api",
				checkin_url: site.checkin_url ?? "",
				system_token: site.system_token ?? "",
				system_userid: site.system_userid ?? "",
				checkin_enabled: Boolean(site.checkin_enabled ?? false),
				call_tokens: tokenForms,
			});
			setSiteModalOpen(true);
			dismissNotice();
		},
		[dismissNotice],
	);

	const closeTokenModal = useCallback(() => {
		setTokenModalOpen(false);
		setEditingToken(null);
		setTokenForm({ ...initialTokenForm });
	}, []);

	const openTokenEdit = useCallback(
		(tokenItem: Token) => {
			setEditingToken(tokenItem);
			setTokenForm({
				name: tokenItem.name ?? "",
				quota_total:
					tokenItem.quota_total === null || tokenItem.quota_total === undefined
						? ""
						: String(tokenItem.quota_total),
				status: tokenItem.status ?? "active",
				expires_at: toChinaDateTimeInput(tokenItem.expires_at ?? null),
				allowed_channels: tokenItem.allowed_channels ?? [],
			});
			setTokenModalOpen(true);
			dismissNotice();
		},
		[dismissNotice],
	);

	const handleSiteTest = useCallback(
		async (id: string) => {
			const actionKey = buildActionKey("site:test", id);
			if (isActionPending(actionKey)) {
				return;
			}
			startAction(actionKey);
			try {
				const result = await apiFetch<{
					models: Array<{ id: string }>;
					token_summary?: {
						total: number;
						success: number;
						failed: number;
					};
				}>(`/api/channels/${id}/test`, {
					method: "POST",
				});
				await loadSites();
				const modelCount = result.models?.length ?? 0;
				const summary = result.token_summary;
				const detail = summary
					? `，令牌成功 ${summary.success}/${summary.total}${
							summary.failed > 0 ? `，失败 ${summary.failed}` : ""
						}`
					: "";
				pushNotice("success", `连通测试完成，模型数 ${modelCount}${detail}`);
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[endAction, isActionPending, loadSites, pushNotice, startAction, apiFetch],
	);

	const handleSiteTestAll = useCallback(async () => {
		const actionKey = buildActionKey("site:testAll");
		if (isActionPending(actionKey)) {
			return;
		}
		if (data.sites.length === 0) {
			pushNotice("warning", "暂无站点可测试");
			return;
		}
		startAction(actionKey);
		pushNotice("info", "正在执行一键测试...");
		const results: SiteTestResult[] = [];
		try {
			for (const site of data.sites) {
				if (site.status !== "active") {
					results.push({ status: "skipped" });
					continue;
				}
				try {
					await apiFetch(`/api/channels/${site.id}/test`, {
						method: "POST",
					});
					results.push({ status: "success" });
				} catch (_error) {
					results.push({ status: "failed" });
				}
			}
			await loadSites();
			const summary = summarizeSiteTests(results);
			const testedTotal = summary.success + summary.failed;
			if (testedTotal === 0) {
				pushNotice(
					"info",
					`已跳过 ${summary.skipped} 个禁用站点，暂无可测试站点。`,
				);
				return;
			}
			let message =
				summary.failed > 0
					? `一键测试完成，成功 ${summary.success}/${testedTotal}，失败 ${summary.failed}。`
					: `一键测试完成，成功 ${summary.success}/${testedTotal}。`;
			if (summary.skipped > 0) {
				message += ` 已跳过 ${summary.skipped} 个禁用站点。`;
			}
			pushNotice(summary.failed > 0 ? "warning" : "success", message);
		} finally {
			endAction(actionKey);
		}
	}, [
		apiFetch,
		data.sites,
		endAction,
		isActionPending,
		loadSites,
		pushNotice,
		startAction,
	]);

	const handleSiteSubmit = useCallback(
		async (event: Event) => {
			event.preventDefault();
			const actionKey = buildActionKey("site:submit");
			if (isActionPending(actionKey)) {
				return;
			}
			const siteName = siteForm.name.trim();
			const normalizedName = siteName.toLowerCase();
			const nameExists = data.sites.some(
				(site) =>
					site.name.trim().toLowerCase() === normalizedName &&
					site.id !== editingSite?.id,
			);
			if (nameExists) {
				pushNotice("warning", "站点名称已存在，请使用其他名称");
				return;
			}
			const baseUrlValue = siteForm.base_url.trim();
			if (!baseUrlValue && !DEFAULT_BASE_URL_BY_TYPE[siteForm.site_type]) {
				pushNotice("warning", "基础 URL 不能为空");
				return;
			}
			const callTokens = siteForm.call_tokens
				.map((token, index) => ({
					id: token.id,
					name: token.name.trim() || `调用令牌${index + 1}`,
					api_key: token.api_key.trim(),
				}))
				.filter((token) => token.api_key.length > 0);
			if (callTokens.length === 0) {
				pushNotice("warning", "至少填写一个调用令牌");
				return;
			}
			if (
				siteForm.site_type === "new-api" &&
				siteForm.checkin_enabled &&
				(!siteForm.system_token.trim() || !siteForm.system_userid.trim())
			) {
				pushNotice("warning", "启用签到需要填写系统令牌与 User ID");
				return;
			}
			startAction(actionKey);
			try {
				const body = {
					name: siteName,
					base_url: baseUrlValue,
					weight: Number(siteForm.weight),
					status: siteForm.status,
					site_type: siteForm.site_type,
					system_token: siteForm.system_token.trim(),
					system_userid: siteForm.system_userid.trim(),
					checkin_url: siteForm.checkin_url.trim() || null,
					checkin_enabled: siteForm.checkin_enabled,
					call_tokens: callTokens,
				};
				let siteId = editingSite?.id ?? null;
				let actionLabel = "创建";
				if (editingSite) {
					await apiFetch(`/api/sites/${editingSite.id}`, {
						method: "PATCH",
						body: JSON.stringify(body),
					});
					actionLabel = "更新";
				} else {
					const created = await apiFetch<{ id: string }>("/api/sites", {
						method: "POST",
						body: JSON.stringify(body),
					});
					siteId = created.id;
				}
				closeSiteModal();
				await loadSites();
				if (siteId) {
					pushNotice("info", `站点已${actionLabel}，正在自动测试...`);
					await handleSiteTest(siteId);
				} else {
					pushNotice("success", `站点已${actionLabel}`);
				}
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[
			apiFetch,
			closeSiteModal,
			data.sites,
			editingSite,
			endAction,
			isActionPending,
			loadSites,
			handleSiteTest,
			pushNotice,
			siteForm,
			startAction,
		],
	);

	const handleTokenSubmit = useCallback(
		async (event: Event) => {
			event.preventDefault();
			const actionKey = buildActionKey("token:submit");
			if (isActionPending(actionKey)) {
				return;
			}
			startAction(actionKey);
			try {
				const name = tokenForm.name.trim();
				if (!name) {
					pushNotice("warning", "请输入令牌名称");
					return;
				}
				const quotaInput = tokenForm.quota_total.trim();
				const quotaTotal = quotaInput.length === 0 ? null : Number(quotaInput);
				if (quotaInput.length > 0 && Number.isNaN(quotaTotal)) {
					pushNotice("warning", "额度需为数字");
					return;
				}
				const expiresAtInput = tokenForm.expires_at.trim();
				const expiresAtIso = toChinaIsoFromInput(expiresAtInput);
				if (expiresAtInput && !expiresAtIso) {
					pushNotice("warning", "过期时间格式无效");
					return;
				}
				const allowedChannels = tokenForm.allowed_channels.filter(Boolean);
				if (editingToken) {
					await apiFetch(`/api/tokens/${editingToken.id}`, {
						method: "PATCH",
						body: JSON.stringify({
							name,
							quota_total: quotaTotal,
							status: tokenForm.status,
							expires_at: expiresAtIso,
							allowed_channels: allowedChannels,
						}),
					});
					pushNotice("success", "令牌已更新");
					setTokenModalOpen(false);
					setEditingToken(null);
					setTokenForm({ ...initialTokenForm });
					await loadTokens();
					return;
				}

				const result = await apiFetch<{ token: string }>("/api/tokens", {
					method: "POST",
					body: JSON.stringify({
						name,
						quota_total: quotaTotal,
						status: tokenForm.status,
						expires_at: expiresAtIso,
						allowed_channels: allowedChannels,
					}),
				});
				let message = `新令牌: ${result.token}`;
				try {
					await navigator.clipboard.writeText(result.token);
					message = "新令牌已复制到剪贴板，请妥善保存。";
				} catch (_clipboardError) {
					// keep token in message if clipboard fails
				}
				pushNotice("success", message);
				setTokenModalOpen(false);
				setTokenForm({ ...initialTokenForm });
				setTokenPage(1);
				await loadTokens();
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[
			apiFetch,
			editingToken,
			endAction,
			initialTokenForm,
			isActionPending,
			loadTokens,
			pushNotice,
			startAction,
			tokenForm.expires_at,
			tokenForm.allowed_channels,
			tokenForm.name,
			tokenForm.quota_total,
			tokenForm.status,
		],
	);

	const handleSettingsSubmit = useCallback(
		async (event: Event) => {
			event.preventDefault();
			const actionKey = buildActionKey("settings:submit");
			if (isActionPending(actionKey)) {
				return;
			}
			const retention = Number(settingsForm.log_retention_days);
			const runtimeEventRetention = Number(
				settingsForm.runtime_event_retention_days,
			);
			const sessionTtlHours = Number(settingsForm.session_ttl_hours);
			const failureCooldownMinutes = Number(
				settingsForm.model_failure_cooldown_minutes,
			);
			const upstreamTimeoutMs = Number(settingsForm.proxy_upstream_timeout_ms);
			const retryMaxRetries = Number(settingsForm.proxy_retry_max_retries);
			const streamUsageMode = settingsForm.proxy_stream_usage_mode
				.trim()
				.toLowerCase();
			const streamUsageMaxBytes = Number(
				settingsForm.proxy_stream_usage_max_bytes,
			);
			const streamUsageMaxParsers = Number(
				settingsForm.proxy_stream_usage_max_parsers,
			);
			const runtimeEventLevels = settingsForm.runtime_event_levels
				.map((item) => item.trim().toLowerCase())
				.filter(Boolean);
			const usageQueueDailyLimit = Number(settingsForm.usage_queue_daily_limit);
			const usageQueueDirectRatio = Number(
				settingsForm.usage_queue_direct_write_ratio,
			);
			const cacheDashboardTtl = Number(
				settingsForm.cache_ttl_dashboard_seconds,
			);
			const cacheUsageTtl = Number(settingsForm.cache_ttl_usage_seconds);
			const cacheModelsTtl = Number(settingsForm.cache_ttl_models_seconds);
			const cacheTokensTtl = Number(settingsForm.cache_ttl_tokens_seconds);
			const cacheChannelsTtl = Number(settingsForm.cache_ttl_channels_seconds);
			const cacheCallTokensTtl = Number(
				settingsForm.cache_ttl_call_tokens_seconds,
			);
			const cacheSettingsTtl = Number(settingsForm.cache_ttl_settings_seconds);
			if (
				Number.isNaN(retention) ||
				retention < 1 ||
				Number.isNaN(runtimeEventRetention) ||
				runtimeEventRetention < 1 ||
				Number.isNaN(sessionTtlHours) ||
				sessionTtlHours < 1
			) {
				pushNotice("warning", "请填写有效的日志保留天数与会话时长");
				return;
			}
			if (Number.isNaN(failureCooldownMinutes) || failureCooldownMinutes < 1) {
				pushNotice("warning", "失败冷却需为正整数");
				return;
			}
			if (Number.isNaN(upstreamTimeoutMs) || upstreamTimeoutMs < 0) {
				pushNotice("warning", "上游超时需为非负整数");
				return;
			}
			if (
				Number.isNaN(retryMaxRetries) ||
				retryMaxRetries < 0 ||
				!Number.isInteger(retryMaxRetries)
			) {
				pushNotice("warning", "重发次数需为非负整数");
				return;
			}
			if (!["full", "lite", "off"].includes(streamUsageMode)) {
				pushNotice("warning", "流式解析模式需为 full/lite/off");
				return;
			}
			if (Number.isNaN(streamUsageMaxBytes) || streamUsageMaxBytes < 0) {
				pushNotice("warning", "最大字节数需为非负整数");
				return;
			}
			if (Number.isNaN(streamUsageMaxParsers) || streamUsageMaxParsers < 0) {
				pushNotice("warning", "并发上限需为非负整数");
				return;
			}
			if (Number.isNaN(usageQueueDailyLimit) || usageQueueDailyLimit < 0) {
				pushNotice("warning", "队列日限额需为非负整数");
				return;
			}
			if (
				Number.isNaN(usageQueueDirectRatio) ||
				usageQueueDirectRatio < 0 ||
				usageQueueDirectRatio > 1
			) {
				pushNotice("warning", "直写比例需在 0-1 之间");
				return;
			}
			if (
				Number.isNaN(cacheDashboardTtl) ||
				cacheDashboardTtl < 0 ||
				Number.isNaN(cacheUsageTtl) ||
				cacheUsageTtl < 0 ||
				Number.isNaN(cacheModelsTtl) ||
				cacheModelsTtl < 0 ||
				Number.isNaN(cacheTokensTtl) ||
				cacheTokensTtl < 0 ||
				Number.isNaN(cacheChannelsTtl) ||
				cacheChannelsTtl < 0 ||
				Number.isNaN(cacheCallTokensTtl) ||
				cacheCallTokensTtl < 0 ||
				Number.isNaN(cacheSettingsTtl) ||
				cacheSettingsTtl < 0
			) {
				pushNotice("warning", "缓存 TTL 需为非负整数");
				return;
			}
			if (
				runtimeEventLevels.some(
					(level) => !["info", "warning", "error"].includes(level),
				)
			) {
				pushNotice("warning", "系统日志等级仅支持 info/warning/error");
				return;
			}
			startAction(actionKey);
			const payload: Record<string, number | string | boolean | string[]> = {
				log_retention_days: retention,
				runtime_event_retention_days: runtimeEventRetention,
				runtime_event_levels: runtimeEventLevels,
				session_ttl_hours: sessionTtlHours,
				checkin_schedule_time:
					settingsForm.checkin_schedule_time.trim() || "00:10",
				model_failure_cooldown_minutes: failureCooldownMinutes,
				proxy_upstream_timeout_ms: upstreamTimeoutMs,
				proxy_retry_max_retries: retryMaxRetries,
				proxy_stream_usage_mode: streamUsageMode,
				proxy_stream_usage_max_bytes: streamUsageMaxBytes,
				proxy_stream_usage_max_parsers: streamUsageMaxParsers,
				proxy_usage_queue_enabled: settingsForm.proxy_usage_queue_enabled,
				usage_queue_daily_limit: usageQueueDailyLimit,
				usage_queue_direct_write_ratio: usageQueueDirectRatio,
				cache_enabled: settingsForm.cache_enabled,
				cache_ttl_dashboard_seconds: cacheDashboardTtl,
				cache_ttl_usage_seconds: cacheUsageTtl,
				cache_ttl_models_seconds: cacheModelsTtl,
				cache_ttl_tokens_seconds: cacheTokensTtl,
				cache_ttl_channels_seconds: cacheChannelsTtl,
				cache_ttl_call_tokens_seconds: cacheCallTokensTtl,
				cache_ttl_settings_seconds: cacheSettingsTtl,
			};
			const password = settingsForm.admin_password.trim();
			if (password) {
				payload.admin_password = password;
			}
			try {
				await apiFetch("/api/settings", {
					method: "PUT",
					body: JSON.stringify(payload),
				});
				await loadSettings();
				setSettingsForm((prev) => ({ ...prev, admin_password: "" }));
				pushNotice("success", "设置已更新");
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[
			apiFetch,
			endAction,
			isActionPending,
			loadSettings,
			pushNotice,
			settingsForm,
			startAction,
		],
	);

	const handleCacheRefresh = useCallback(async () => {
		const actionKey = buildActionKey("settings:cache:refresh");
		if (isActionPending(actionKey)) {
			return;
		}
		startAction(actionKey);
		try {
			await apiFetch("/api/settings/cache/refresh", { method: "POST" });
			await loadSettings();
			pushNotice("success", "缓存已刷新");
		} catch (error) {
			pushNotice("error", (error as Error).message);
		} finally {
			endAction(actionKey);
		}
	}, [
		apiFetch,
		endAction,
		isActionPending,
		loadSettings,
		pushNotice,
		startAction,
	]);

	const handleSiteDelete = useCallback(
		async (id: string) => {
			const actionKey = buildActionKey("site:delete", id);
			if (isActionPending(actionKey)) {
				return;
			}
			startAction(actionKey);
			try {
				await apiFetch(`/api/sites/${id}`, { method: "DELETE" });
				await loadSites();
				pushNotice("success", "站点已删除");
				if (editingSite?.id === id) {
					closeSiteModal();
				}
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[
			apiFetch,
			closeSiteModal,
			editingSite,
			endAction,
			isActionPending,
			loadSites,
			pushNotice,
			startAction,
		],
	);

	const requestSiteDelete = useCallback(
		(site: Site) => {
			openConfirm({
				title: "删除站点",
				message: `确定删除“${site.name || "该站点"}”吗？此操作不可恢复。`,
				confirmLabel: "删除站点",
				tone: "error",
				onConfirm: () => handleSiteDelete(site.id),
			});
		},
		[handleSiteDelete, openConfirm],
	);

	const handleSiteToggle = useCallback(
		async (id: string, status: string) => {
			const actionKey = buildActionKey("site:toggle", id);
			if (isActionPending(actionKey)) {
				return;
			}
			startAction(actionKey);
			try {
				const next = toggleStatus(status);
				await apiFetch(`/api/sites/${id}`, {
					method: "PATCH",
					body: JSON.stringify({ status: next }),
				});
				await loadSites();
				pushNotice("success", `站点已${next === "active" ? "启用" : "停用"}`);
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[endAction, isActionPending, loadSites, pushNotice, startAction, apiFetch],
	);

	const handleTokenDelete = useCallback(
		async (id: string) => {
			const actionKey = buildActionKey("token:delete", id);
			if (isActionPending(actionKey)) {
				return;
			}
			startAction(actionKey);
			try {
				await apiFetch(`/api/tokens/${id}`, { method: "DELETE" });
				await loadTokens();
				pushNotice("success", "令牌已删除");
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[endAction, isActionPending, loadTokens, pushNotice, startAction, apiFetch],
	);

	const requestTokenDelete = useCallback(
		(token: Token) => {
			openConfirm({
				title: "删除令牌",
				message: `确定删除“${token.name || "该令牌"}”吗？此操作不可恢复。`,
				confirmLabel: "删除令牌",
				tone: "error",
				onConfirm: () => handleTokenDelete(token.id),
			});
		},
		[handleTokenDelete, openConfirm],
	);

	const handleTokenReveal = useCallback(
		async (id: string) => {
			const actionKey = buildActionKey("token:reveal", id);
			if (isActionPending(actionKey)) {
				return;
			}
			startAction(actionKey);
			try {
				const result = await apiFetch<{ token: string | null }>(
					`/api/tokens/${id}/reveal`,
				);
				if (!result.token) {
					pushNotice("warning", "未找到令牌");
					return;
				}
				try {
					await navigator.clipboard.writeText(result.token);
					pushNotice("success", "令牌已复制到剪贴板。");
				} catch (_clipboardError) {
					pushNotice("info", `令牌: ${result.token}`);
				}
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[endAction, isActionPending, pushNotice, startAction, apiFetch],
	);

	const handleTokenToggle = useCallback(
		async (id: string, status: string) => {
			const actionKey = buildActionKey("token:toggle", id);
			if (isActionPending(actionKey)) {
				return;
			}
			startAction(actionKey);
			try {
				const next = toggleStatus(status);
				await apiFetch(`/api/tokens/${id}`, {
					method: "PATCH",
					body: JSON.stringify({ status: next }),
				});
				await loadTokens();
				pushNotice("success", `令牌已${next === "active" ? "启用" : "停用"}`);
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[endAction, isActionPending, loadTokens, pushNotice, startAction, apiFetch],
	);

	const handleCheckinRunSite = useCallback(
		async (site: Site) => {
			const actionKey = buildActionKey("site:checkin", site.id);
			if (isActionPending(actionKey)) {
				return;
			}
			startAction(actionKey);
			try {
				const result = await apiFetch<{
					result: {
						id: string;
						name: string;
						status: "success" | "failed" | "skipped";
						message: string;
						checkin_date?: string | null;
					};
					runs_at: string;
				}>(`/api/sites/${site.id}/checkin`, { method: "POST" });
				await loadSites();
				const tone =
					result.result.status === "failed"
						? "warning"
						: result.result.status === "skipped"
							? "info"
							: "success";
				pushNotice(
					tone,
					`${site.name || "站点"}：${result.result.message || "签到完成"}`,
				);
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[endAction, isActionPending, loadSites, pushNotice, startAction, apiFetch],
	);

	const handleCheckinRunAll = useCallback(async () => {
		const actionKey = buildActionKey("site:checkinAll");
		if (isActionPending(actionKey)) {
			return;
		}
		startAction(actionKey);
		try {
			const result = await apiFetch<{
				results: Array<{
					id: string;
					name: string;
					status: "success" | "failed" | "skipped";
					message: string;
					checkin_date?: string | null;
				}>;
				summary: CheckinSummary;
				runs_at: string;
			}>("/api/sites/checkin-all", {
				method: "POST",
			});
			await loadSites();
			setCheckinSummary(result.summary);
			setCheckinLastRun(result.runs_at);
			pushNotice(
				result.summary.failed > 0 ? "warning" : "success",
				result.summary.failed > 0
					? "一键签到完成，有部分站点失败。"
					: "一键签到完成。",
			);
		} catch (error) {
			pushNotice("error", (error as Error).message);
		} finally {
			endAction(actionKey);
		}
	}, [
		apiFetch,
		endAction,
		isActionPending,
		loadSites,
		pushNotice,
		startAction,
	]);

	const handleUsageRefresh = useCallback(async () => {
		const actionKey = buildActionKey("usage:refresh");
		if (isActionPending(actionKey)) {
			return;
		}
		startAction(actionKey);
		try {
			await loadUsage();
			pushNotice("success", "日志已刷新");
		} catch (error) {
			pushNotice("error", (error as Error).message);
		} finally {
			endAction(actionKey);
		}
	}, [endAction, isActionPending, loadUsage, pushNotice, startAction]);

	const handleRuntimeEventsRefresh = useCallback(async () => {
		const actionKey = buildActionKey("runtime-events:refresh");
		if (isActionPending(actionKey)) {
			return;
		}
		startAction(actionKey);
		try {
			await loadRuntimeEvents();
			pushNotice("success", "系统日志已刷新");
		} catch (error) {
			pushNotice("error", (error as Error).message);
		} finally {
			endAction(actionKey);
		}
	}, [endAction, isActionPending, loadRuntimeEvents, pushNotice, startAction]);

	const filteredSites = useMemo(
		() => filterSites(data.sites, siteSearch),
		[data.sites, siteSearch],
	);
	const sortedSites = useMemo(
		() => sortSites(filteredSites, siteSort),
		[filteredSites, siteSort],
	);
	const siteTotal = sortedSites.length;
	const siteTotalPages = useMemo(
		() => Math.max(1, Math.ceil(siteTotal / sitePageSize)),
		[siteTotal, sitePageSize],
	);
	const pagedSites = useMemo(() => {
		const start = (sitePage - 1) * sitePageSize;
		return sortedSites.slice(start, start + sitePageSize);
	}, [sitePage, sitePageSize, sortedSites]);
	const tokenTotal = data.tokens.length;
	const tokenTotalPages = useMemo(
		() => Math.max(1, Math.ceil(tokenTotal / tokenPageSize)),
		[tokenTotal, tokenPageSize],
	);
	const pagedTokens = useMemo(() => {
		const start = (tokenPage - 1) * tokenPageSize;
		return data.tokens.slice(start, start + tokenPageSize);
	}, [data.tokens, tokenPage, tokenPageSize]);
	const usageTotalPages = useMemo(
		() => Math.max(1, Math.ceil(usageTotal / usagePageSize)),
		[usagePageSize, usageTotal],
	);
	const runtimeEventsTotalPages = useMemo(
		() => Math.max(1, Math.ceil(runtimeEventsTotal / runtimeEventsPageSize)),
		[runtimeEventsPageSize, runtimeEventsTotal],
	);

	useEffect(() => {
		setSitePage((prev) => Math.min(prev, siteTotalPages));
	}, [siteTotalPages]);

	useEffect(() => {
		setSitePage(1);
	}, [siteSearch, siteSort.key, siteSort.direction]);

	useEffect(() => {
		setTokenPage((prev) => Math.min(prev, tokenTotalPages));
	}, [tokenTotalPages]);

	useEffect(() => {
		setUsagePage((prev) => Math.min(prev, usageTotalPages));
	}, [usageTotalPages]);

	useEffect(() => {
		setRuntimeEventsPage((prev) => Math.min(prev, runtimeEventsTotalPages));
	}, [runtimeEventsTotalPages]);

	const activeLabel = useMemo(
		() => tabs.find((tab) => tab.id === activeTab)?.label ?? "管理台",
		[activeTab],
	);
	const loginNotice = notices[notices.length - 1] ?? null;

	const renderContent = () => {
		if (loading) {
			return (
				<div class="app-card animate-fade-up p-5">
					<div class="flex items-center gap-3 text-sm text-[color:var(--app-ink-muted)]">
						<span class="h-2.5 w-2.5 animate-pulse rounded-full bg-[color:var(--app-accent)]" />
						正在加载数据...
					</div>
					<div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
						<div class="h-20 rounded-xl bg-white/70" />
						<div class="h-20 rounded-xl bg-white/60" />
						<div class="h-20 rounded-xl bg-white/80" />
					</div>
				</div>
			);
		}
		if (activeTab === "dashboard") {
			return (
				<DashboardView
					dashboard={data.dashboard}
					isRefreshing={
						isActionPending(buildActionKey("dashboard:refresh")) ||
						isActionPending(buildActionKey("dashboard:filter"))
					}
					query={dashboardQuery}
					channels={data.sites}
					tokens={data.tokens}
					onQueryChange={handleDashboardQueryChange}
					onApply={handleDashboardApply}
					onRefresh={handleDashboardRefresh}
				/>
			);
		}
		if (activeTab === "channels") {
			return (
				<SitesView
					siteForm={siteForm}
					sitePage={sitePage}
					sitePageSize={sitePageSize}
					siteTotal={siteTotal}
					siteTotalPages={siteTotalPages}
					pagedSites={pagedSites}
					editingSite={editingSite}
					isSiteModalOpen={isSiteModalOpen}
					summary={checkinSummary}
					lastRun={checkinLastRun}
					siteSearch={siteSearch}
					siteSort={siteSort}
					isActionPending={isActionPending}
					onCreate={openSiteCreate}
					onCloseModal={closeSiteModal}
					onEdit={startSiteEdit}
					onSubmit={handleSiteSubmit}
					onTest={handleSiteTest}
					onCheckin={handleCheckinRunSite}
					onToggle={handleSiteToggle}
					onDelete={requestSiteDelete}
					onPageChange={handleSitePageChange}
					onPageSizeChange={handleSitePageSizeChange}
					onSearchChange={handleSiteSearchChange}
					onSortChange={handleSiteSortChange}
					onFormChange={handleSiteFormChange}
					onRunAll={handleCheckinRunAll}
					onTestAll={handleSiteTestAll}
				/>
			);
		}
		if (activeTab === "models") {
			return <ModelsView models={data.models} />;
		}
		if (activeTab === "tokens") {
			return (
				<TokensView
					pagedTokens={pagedTokens}
					tokenPage={tokenPage}
					tokenPageSize={tokenPageSize}
					tokenTotal={tokenTotal}
					tokenTotalPages={tokenTotalPages}
					isTokenModalOpen={isTokenModalOpen}
					isActionPending={isActionPending}
					sites={data.sites}
					onCreate={openTokenCreate}
					onCloseModal={closeTokenModal}
					onPageChange={handleTokenPageChange}
					onPageSizeChange={handleTokenPageSizeChange}
					tokenForm={tokenForm}
					editingToken={editingToken}
					onSubmit={handleTokenSubmit}
					onFormChange={handleTokenFormChange}
					onEdit={openTokenEdit}
					onReveal={handleTokenReveal}
					onToggle={handleTokenToggle}
					onDelete={requestTokenDelete}
				/>
			);
		}
		if (activeTab === "usage") {
			return (
				<UsageView
					usage={data.usage}
					total={usageTotal}
					page={usagePage}
					pageSize={usagePageSize}
					filters={usageFilters}
					isRefreshing={
						isActionPending(buildActionKey("usage:refresh")) ||
						isActionPending(buildActionKey("usage:load"))
					}
					sites={data.sites}
					tokens={data.tokens}
					models={data.models}
					onRefresh={handleUsageRefresh}
					onPageChange={handleUsagePageChange}
					onPageSizeChange={handleUsagePageSizeChange}
					onFiltersChange={handleUsageFiltersChange}
					onSearch={handleUsageSearch}
					onClear={handleUsageClear}
				/>
			);
		}
		if (activeTab === "runtime_events") {
			return (
				<RuntimeEventsView
					events={data.runtime_events}
					total={runtimeEventsTotal}
					page={runtimeEventsPage}
					pageSize={runtimeEventsPageSize}
					filters={runtimeEventFilters}
					isRefreshing={
						isActionPending(buildActionKey("runtime-events:refresh")) ||
						isActionPending(buildActionKey("runtime-events:load"))
					}
					onRefresh={handleRuntimeEventsRefresh}
					onPageChange={handleRuntimeEventsPageChange}
					onPageSizeChange={handleRuntimeEventsPageSizeChange}
					onFiltersChange={handleRuntimeEventFiltersChange}
					onSearch={handleRuntimeEventSearch}
					onClear={handleRuntimeEventClear}
				/>
			);
		}
		if (activeTab === "settings") {
			return (
				<SettingsView
					settingsForm={settingsForm}
					adminPasswordSet={data.settings?.admin_password_set ?? false}
					cacheConfig={data.settings?.cache_config ?? null}
					isRefreshingCache={isActionPending(
						buildActionKey("settings:cache:refresh"),
					)}
					runtimeConfig={data.settings?.runtime_config ?? null}
					usageQueueStatus={data.settings?.usage_queue_status ?? null}
					isSaving={isActionPending(buildActionKey("settings:submit"))}
					onSubmit={handleSettingsSubmit}
					onFormChange={handleSettingsFormChange}
					onRefreshCache={handleCacheRefresh}
				/>
			);
		}
		return <div class="app-card p-5">未知模块</div>;
	};

	return (
		<div class="app-shell relative min-h-screen antialiased">
			<div aria-hidden="true" class="app-background" />
			{token ? (
				<AppLayout
					tabs={tabs}
					activeTab={activeTab}
					activeLabel={activeLabel}
					token={token}
					notices={notices}
					onDismissNotice={dismissNotice}
					onTabChange={handleTabChange}
					onLogout={handleLogout}
				>
					{renderContent()}
				</AppLayout>
			) : (
				<LoginView
					isSubmitting={isActionPending(buildActionKey("login:submit"))}
					notice={loginNotice}
					onSubmit={handleLogin}
				/>
			)}
			{confirmState && (
				<Dialog open={Boolean(confirmState)} onClose={closeConfirm}>
					<DialogContent
						aria-labelledby="confirm-title"
						aria-modal="true"
						class="max-w-md"
					>
						<DialogHeader>
							<div>
								<DialogTitle id="confirm-title">
									{confirmState.title}
								</DialogTitle>
								<DialogDescription>{confirmState.message}</DialogDescription>
							</div>
							<Button size="sm" type="button" onClick={closeConfirm}>
								关闭
							</Button>
						</DialogHeader>
						<DialogFooter>
							<Button size="sm" type="button" onClick={closeConfirm}>
								取消
							</Button>
							<Button
								size="sm"
								variant={confirmState.tone === "error" ? "danger" : "primary"}
								type="button"
								disabled={confirmPending}
								onClick={handleConfirm}
							>
								{confirmPending
									? "处理中..."
									: (confirmState.confirmLabel ?? "确认")}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			)}
		</div>
	);
};

render(<App />, root);
