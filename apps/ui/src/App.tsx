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
	initialBackupSettings,
	initialDashboardQuery,
	initialData,
	initialSettingsForm,
	initialSiteForm,
	initialTokenForm,
	tabs,
} from "./core/constants";
import {
	filterSites,
	filterSitesByCooldown,
	getSuggestedActionLabel,
	getVerificationStageTone,
	getVerificationVerdictLabel,
	summarizeVerificationResults,
	type SiteCooldownFilter,
	type SiteSortState,
	sortSites,
} from "./core/sites";
import type {
	AdminData,
	BackupImportMode,
	BackupManualAction,
	BackupImportResult,
	BackupSettings,
	BackupSyncResult,
	CheckinSummary,
	DashboardData,
	DashboardQuery,
	NoticeMessage,
	NoticeTone,
	Settings,
	SettingsForm,
	SiteChannelRefreshBatchReport,
	Site,
	SiteForm,
	SiteTaskResultState,
	SiteTaskReportMap,
	SiteVerificationBatchReport,
	SiteVerificationResult,
	SiteType,
	TabId,
	Token,
	TokenForm,
	UsageQuery,
	UsageResponse,
} from "./core/types";
import {
	formatChinaDateTimeMinute,
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
	settings: "/settings",
};

const pathToTab: Record<string, TabId> = {
	"/": "dashboard",
	"/channels": "channels",
	"/models": "models",
	"/tokens": "tokens",
	"/usage": "usage",
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

type SiteVerificationDialogState = {
	title: string;
	result: SiteVerificationResult;
};

type EditableBackupSettings = Pick<
	BackupSettings,
	| "enabled"
	| "schedule_time"
	| "sync_mode"
	| "conflict_policy"
	| "import_mode"
	| "webdav_url"
	| "webdav_username"
	| "webdav_password"
	| "webdav_path"
	| "keep_versions"
>;

const buildActionKey = (scope: string, id?: string) =>
	id ? `${scope}:${id}` : scope;

const getVerificationStageClass = (tone: string) => {
	if (tone === "success") {
		return "border-emerald-200 bg-emerald-50/80 text-emerald-700";
	}
	if (tone === "warning") {
		return "border-amber-200 bg-amber-50/80 text-amber-700";
	}
	if (tone === "danger") {
		return "border-rose-200 bg-rose-50/80 text-rose-700";
	}
	return "border-white/60 bg-white/70 text-[color:var(--app-ink-muted)]";
};

const pickEditableBackupSettings = (
	settings: BackupSettings,
): EditableBackupSettings => ({
	enabled: settings.enabled,
	schedule_time: settings.schedule_time,
	sync_mode: settings.sync_mode,
	conflict_policy: settings.conflict_policy,
	import_mode: settings.import_mode,
	webdav_url: settings.webdav_url,
	webdav_username: settings.webdav_username,
	webdav_password: settings.webdav_password,
	webdav_path: settings.webdav_path,
	keep_versions: settings.keep_versions,
});

const initialUsageQuery: UsageQuery = {
	channel_ids: [],
	token_ids: [],
	models: [],
	statuses: [],
	from: "",
	to: "",
};

const buildRecommendedSettingsForm = (
	currentAdminPassword: string,
): SettingsForm => ({
	...initialSettingsForm,
	admin_password: currentAdminPassword,
	channel_disable_error_codes: [
		...initialSettingsForm.channel_disable_error_codes,
	],
	proxy_retry_sleep_error_codes: [
		...initialSettingsForm.proxy_retry_sleep_error_codes,
	],
	proxy_retry_return_error_codes: [
		...initialSettingsForm.proxy_retry_return_error_codes,
	],
	proxy_retry_max_retries: "3",
	channel_recovery_probe_enabled: true,
});

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
	const [settingsFormSnapshot, setSettingsFormSnapshot] =
		useState<SettingsForm>(initialSettingsForm);
	const [backupSettings, setBackupSettings] = useState<BackupSettings>(
		initialBackupSettings,
	);
	const [backupSettingsSnapshot, setBackupSettingsSnapshot] =
		useState<EditableBackupSettings>(() =>
			pickEditableBackupSettings(initialBackupSettings),
		);
	const [backupImportMode, setBackupImportMode] =
		useState<BackupImportMode>("merge");
	const [backupImportFile, setBackupImportFile] = useState<File | null>(null);
	const [retryErrorCodeOptions, setRetryErrorCodeOptions] = useState<string[]>(
		[],
	);
	const [sitePage, setSitePage] = useState(1);
	const [sitePageSize, setSitePageSize] = useState(() =>
		loadPageSizePref("pageSize:sites", 10),
	);
	const [siteSearch, setSiteSearch] = useState("");
	const [siteCooldownFilter, setSiteCooldownFilter] =
		useState<SiteCooldownFilter>("all");
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
	const [editingSite, setEditingSite] = useState<Site | null>(null);
	const [siteForm, setSiteForm] = useState<SiteForm>(() => ({
		...initialSiteForm,
	}));
	const [isSiteModalOpen, setSiteModalOpen] = useState(false);
	const [isTokenModalOpen, setTokenModalOpen] = useState(false);
	const [siteTaskReports, setSiteTaskReports] = useState<SiteTaskReportMap>({});
	const [siteVerificationDialog, setSiteVerificationDialog] =
		useState<SiteVerificationDialogState | null>(null);
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

	const closeSiteVerificationDialog = useCallback(() => {
		setSiteVerificationDialog(null);
	}, []);

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
			task_reports?: SiteTaskReportMap;
		}>("/api/sites");
		setData((prev) => ({
			...prev,
			sites: result.sites,
		}));
		setSiteTaskReports(result.task_reports ?? {});
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

	const loadSettings = useCallback(async () => {
		const settings = await apiFetch<Settings>("/api/settings");
		setData((prev) => ({ ...prev, settings }));
	}, [apiFetch]);

	const loadRetryErrorCodes = useCallback(async () => {
		const result = await apiFetch<{
			items?: Array<{ error_code?: string | null }>;
		}>("/api/usage/error-codes?limit=500");
		const codes = Array.from(
			new Set(
				(result.items ?? [])
					.map((item) => String(item.error_code ?? "").trim())
					.filter(Boolean),
			),
		).sort((left, right) => left.localeCompare(right));
		setRetryErrorCodeOptions(codes);
	}, [apiFetch]);

	const loadBackupSettings = useCallback(async () => {
		const settings = await apiFetch<BackupSettings>("/api/backup/sync-config");
		setBackupSettings(settings);
		setBackupSettingsSnapshot(pickEditableBackupSettings(settings));
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
					await Promise.all([
						loadSettings(),
						loadRetryErrorCodes(),
						loadBackupSettings(),
					]);
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
			loadRetryErrorCodes,
			loadBackupSettings,
			loadSettings,
			loadSites,
			loadTokens,
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
		const runtimeSettings =
			data.settings.runtime_settings ?? data.settings.runtime_config;
		const nextSettingsForm: SettingsForm = {
			log_retention_days: String(data.settings.log_retention_days ?? 30),
			session_ttl_hours: String(data.settings.session_ttl_hours ?? 12),
			admin_password: "",
			checkin_schedule_time: data.settings.checkin_schedule_time ?? "00:10",
			channel_refresh_enabled: data.settings.channel_refresh_enabled ?? false,
			channel_refresh_schedule_time:
				data.settings.channel_refresh_schedule_time ?? "02:40",
			channel_recovery_probe_enabled:
				data.settings.channel_recovery_probe_enabled ?? false,
			channel_recovery_probe_schedule_time:
				data.settings.channel_recovery_probe_schedule_time ?? "03:10",
			proxy_model_failure_cooldown_minutes: String(
				runtimeSettings?.model_failure_cooldown_minutes ?? 720,
			),
			proxy_model_failure_cooldown_threshold: String(
				runtimeSettings?.model_failure_cooldown_threshold ?? 3,
			),
			channel_disable_error_codes:
				runtimeSettings?.channel_disable_error_codes ?? [
					"account_deactivated",
					"insufficient_balance",
					"insufficient_user_quota",
					"permission_error",
				],
			channel_disable_error_threshold: String(
				runtimeSettings?.channel_disable_error_threshold ?? 3,
			),
			channel_disable_error_code_minutes: String(
				runtimeSettings?.channel_disable_error_code_minutes ?? 1440,
			),
			proxy_upstream_timeout_ms: String(
				runtimeSettings?.upstream_timeout_ms ?? 180000,
			),
			proxy_retry_max_retries: String(runtimeSettings?.retry_max_retries ?? 5),
			proxy_retry_sleep_ms: String(runtimeSettings?.retry_sleep_ms ?? 500),
			proxy_retry_sleep_error_codes:
				runtimeSettings?.retry_sleep_error_codes ?? [
					"system_cpu_overloaded",
					"system_disk_overloaded",
				],
			proxy_retry_return_error_codes:
				runtimeSettings?.retry_return_error_codes ?? [
					"no_available_channels",
					"upstream_cooldown",
					"responses_previous_response_id_required",
					"responses_affinity_missing",
					"responses_affinity_channel_disabled",
					"responses_affinity_channel_not_allowed",
					"responses_affinity_channel_model_unavailable",
					"responses_affinity_channel_cooldown",
					"responses_tool_call_chain_mismatch",
					"invalid_function_parameters",
				],
			proxy_zero_completion_as_error_enabled:
				runtimeSettings?.zero_completion_as_error_enabled ?? true,
			proxy_stream_usage_mode: runtimeSettings?.stream_usage_mode ?? "lite",
			proxy_stream_usage_max_parsers: String(
				runtimeSettings?.stream_usage_max_parsers ?? 0,
			),
			proxy_stream_usage_parse_timeout_ms: String(
				runtimeSettings?.stream_usage_parse_timeout_ms ?? 0,
			),
			proxy_responses_affinity_ttl_seconds: String(
				runtimeSettings?.responses_affinity_ttl_seconds ?? 86400,
			),
			proxy_stream_options_capability_ttl_seconds: String(
				runtimeSettings?.stream_options_capability_ttl_seconds ?? 604800,
			),
			proxy_attempt_worker_fallback_enabled:
				runtimeSettings?.attempt_worker_fallback_enabled ?? true,
			proxy_attempt_worker_fallback_threshold: String(
				runtimeSettings?.attempt_worker_fallback_threshold ?? 3,
			),
			proxy_large_request_offload_threshold_bytes: String(
				runtimeSettings?.large_request_offload_threshold_bytes ?? 32768,
			),
			site_task_concurrency: String(
				runtimeSettings?.site_task_concurrency ?? 4,
			),
			site_task_timeout_ms: String(
				runtimeSettings?.site_task_timeout_ms ?? 12000,
			),
			site_task_fallback_enabled:
				runtimeSettings?.site_task_fallback_enabled ?? true,
		};
		setSettingsForm(nextSettingsForm);
		setSettingsFormSnapshot(nextSettingsForm);
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

	const handleBackupSettingsChange = useCallback(
		(patch: Partial<BackupSettings>) => {
			setBackupSettings((prev) => ({ ...prev, ...patch }));
		},
		[],
	);

	const handleBackupImportModeChange = useCallback((mode: BackupImportMode) => {
		setBackupImportMode(mode);
	}, []);

	const handleBackupImportFileChange = useCallback((file: File | null) => {
		setBackupImportFile(file);
	}, []);

	const handleApplyRecommendedConfig = useCallback(() => {
		setSettingsForm((prev) =>
			buildRecommendedSettingsForm(prev.admin_password),
		);
		setBackupSettings((prev) => ({
			...prev,
			enabled: true,
			schedule_time: "04:20",
			sync_mode: "push",
			conflict_policy: "local_wins",
			import_mode: "merge",
			keep_versions: 30,
			webdav_path: prev.webdav_path.trim() || "api-worker-backup",
		}));
		pushNotice("info", "已应用推荐配置，请点击保存设置生效。");
	}, [pushNotice]);

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

	const handleSiteCooldownFilterChange = useCallback(
		(next: SiteCooldownFilter) => {
			setSiteCooldownFilter(next);
		},
		[],
	);

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
									priority: 0,
								},
							]
						: [];
			const tokenForms =
				callTokens.length > 0
					? callTokens.map((token) => ({
							id: token.id,
							name: token.name,
							api_key: token.api_key,
							priority: token.priority,
						}))
					: [
							{
								name: "主调用令牌",
								api_key: "",
								priority: 0,
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

	const openVerificationResult = useCallback(
		(title: string, result: SiteVerificationResult) => {
			setSiteVerificationDialog({ title, result });
		},
		[],
	);

	const storeSiteTaskReport = useCallback((report: SiteTaskResultState) => {
		if (!report) {
			return;
		}
		setSiteTaskReports((prev) => ({
			...prev,
			[report.kind]: report,
		}));
	}, []);

	const syncRefreshTaskItem = useCallback(
		(item: SiteChannelRefreshBatchReport["items"][number], runsAt: string) => {
			setSiteTaskReports((prev) => {
				const current = prev["refresh-active"];
				const nextItems =
					current?.kind === "refresh-active"
						? [
								item,
								...current.report.items.filter(
									(existing) => existing.site_id !== item.site_id,
								),
							]
						: [item];
				const success = nextItems.filter(
					(entry) => entry.status === "success",
				).length;
				return {
					...prev,
					"refresh-active": {
						kind: "refresh-active",
						runs_at: runsAt,
						report: {
							summary: {
								total: nextItems.length,
								success,
								failed: nextItems.length - success,
							},
							items: nextItems,
							runs_at: runsAt,
						},
					},
				};
			});
		},
		[],
	);

	const handleSiteVerify = useCallback(
		async (id: string) => {
			const actionKey = buildActionKey("site:verify", id);
			if (isActionPending(actionKey)) {
				return;
			}
			startAction(actionKey);
			try {
				const result = await apiFetch<SiteVerificationResult>(
					`/api/sites/${id}/verify`,
					{
						method: "POST",
					},
				);
				await loadSites();
				openVerificationResult("站点验证结果", result);
				pushNotice(
					result.verdict === "serving" || result.verdict === "recoverable"
						? "success"
						: result.verdict === "degraded"
							? "warning"
							: "error",
					result.message,
				);
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
			loadSites,
			openVerificationResult,
			pushNotice,
			startAction,
		],
	);

	const handleSiteVerifyAll = useCallback(async () => {
		const actionKey = buildActionKey("site:verifyAll");
		if (isActionPending(actionKey)) {
			return;
		}
		if (data.sites.length === 0) {
			pushNotice("warning", "暂无站点可验证");
			return;
		}
		startAction(actionKey);
		try {
			const report = await apiFetch<SiteVerificationBatchReport>(
				"/api/sites/verify-batch",
				{
					method: "POST",
				},
			);
			await loadSites();
			storeSiteTaskReport({
				kind: "verify-active",
				runs_at: report.runs_at,
				report,
			});
			const summary = report.summary;
			if (summary.total === 0) {
				pushNotice("info", "当前没有启用渠道可检查");
				return;
			}
			pushNotice(
				summary.failed > 0 || summary.not_recoverable > 0
					? "warning"
					: "success",
				`检查完成：正常 ${summary.serving}，异常 ${summary.degraded + summary.failed}。`,
			);
		} catch (error) {
			pushNotice("error", (error as Error).message);
		} finally {
			endAction(actionKey);
		}
	}, [
		apiFetch,
		data.sites.length,
		endAction,
		isActionPending,
		loadSites,
		pushNotice,
		startAction,
		storeSiteTaskReport,
	]);

	const handleSiteRecoveryEvaluate = useCallback(async () => {
		const actionKey = buildActionKey("site:recoveryEvaluate");
		if (isActionPending(actionKey)) {
			return;
		}
		startAction(actionKey);
		try {
			const report = await apiFetch<SiteVerificationBatchReport>(
				"/api/sites/recovery-evaluate",
				{
					method: "POST",
				},
			);
			await loadSites();
			if (report.summary.total === 0) {
				pushNotice("info", "当前没有已禁用站点需要评估恢复");
				return;
			}
			storeSiteTaskReport({
				kind: "verify-disabled",
				runs_at: report.runs_at,
				report,
			});
			pushNotice(
				report.summary.recoverable > 0 ? "success" : "warning",
				`检查完成：恢复 ${report.summary.recoverable}，未恢复 ${report.summary.not_recoverable + report.summary.failed}。`,
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
		storeSiteTaskReport,
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
					priority: index,
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
					pushNotice("info", `站点已${actionLabel}，正在自动验证...`);
					await handleSiteVerify(siteId);
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
			handleSiteVerify,
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
			const sessionTtlHours = Number(settingsForm.session_ttl_hours);
			const failureCooldownMinutes = Number(
				settingsForm.proxy_model_failure_cooldown_minutes,
			);
			const failureCooldownThreshold = Number(
				settingsForm.proxy_model_failure_cooldown_threshold,
			);
			const channelDisableErrorThreshold = Number(
				settingsForm.channel_disable_error_threshold,
			);
			const channelDisableErrorCodeMinutes = Number(
				settingsForm.channel_disable_error_code_minutes,
			);
			const upstreamTimeoutMs = Number(settingsForm.proxy_upstream_timeout_ms);
			const retryMaxRetries = Number(settingsForm.proxy_retry_max_retries);
			const retrySleepMs = Number(settingsForm.proxy_retry_sleep_ms);
			const channelRefreshScheduleTime =
				settingsForm.channel_refresh_schedule_time.trim();
			const channelRecoveryProbeScheduleTime =
				settingsForm.channel_recovery_probe_schedule_time.trim();
			const normalizeErrorCodeList = (value: string[]): string[] => {
				return Array.from(
					new Set(
						value.map((item) => String(item ?? "").trim()).filter(Boolean),
					),
				);
			};
			const retrySleepErrorCodes = normalizeErrorCodeList(
				settingsForm.proxy_retry_sleep_error_codes,
			);
			const retryReturnErrorCodes = normalizeErrorCodeList(
				settingsForm.proxy_retry_return_error_codes,
			);
			const channelDisableErrorCodes = normalizeErrorCodeList(
				settingsForm.channel_disable_error_codes,
			);
			const streamUsageMode = settingsForm.proxy_stream_usage_mode
				.trim()
				.toLowerCase();
			const shouldValidateDeepStreamParse = streamUsageMode !== "off";
			const streamUsageMaxParsers = Number(
				settingsForm.proxy_stream_usage_max_parsers,
			);
			const streamUsageParseTimeoutMs = Number(
				settingsForm.proxy_stream_usage_parse_timeout_ms,
			);
			const responsesAffinityTtlSeconds = Number(
				settingsForm.proxy_responses_affinity_ttl_seconds,
			);
			const streamOptionsCapabilityTtlSeconds = Number(
				settingsForm.proxy_stream_options_capability_ttl_seconds,
			);
			const attemptWorkerFallbackThreshold = Number(
				settingsForm.proxy_attempt_worker_fallback_threshold,
			);
			const largeRequestOffloadThresholdBytes = Number(
				settingsForm.proxy_large_request_offload_threshold_bytes,
			);
			const siteTaskConcurrency = Number(settingsForm.site_task_concurrency);
			const siteTaskTimeoutMs = Number(settingsForm.site_task_timeout_ms);
			if (
				Number.isNaN(retention) ||
				retention < 1 ||
				Number.isNaN(sessionTtlHours) ||
				sessionTtlHours < 1
			) {
				pushNotice("warning", "请填写有效的日志保留天数与会话时长");
				return;
			}
			if (Number.isNaN(failureCooldownMinutes) || failureCooldownMinutes < 0) {
				pushNotice("warning", "失败冷却时长需为非负整数");
				return;
			}
			if (
				Number.isNaN(failureCooldownThreshold) ||
				failureCooldownThreshold < 1 ||
				!Number.isInteger(failureCooldownThreshold)
			) {
				pushNotice("warning", "连续失败次数阈值需为正整数");
				return;
			}
			if (
				Number.isNaN(channelDisableErrorThreshold) ||
				channelDisableErrorThreshold < 1 ||
				!Number.isInteger(channelDisableErrorThreshold)
			) {
				pushNotice("warning", "渠道禁用阈值需为正整数");
				return;
			}
			if (
				Number.isNaN(channelDisableErrorCodeMinutes) ||
				channelDisableErrorCodeMinutes < 0 ||
				!Number.isInteger(channelDisableErrorCodeMinutes)
			) {
				pushNotice("warning", "命中后禁用时长需为非负整数");
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
			if (
				Number.isNaN(retrySleepMs) ||
				retrySleepMs < 0 ||
				!Number.isInteger(retrySleepMs)
			) {
				pushNotice("warning", "统一等待时间需为非负整数");
				return;
			}
			if (!["full", "lite", "off"].includes(streamUsageMode)) {
				pushNotice("warning", "解析策略需为 FULL / LITE / OFF");
				return;
			}
			if (shouldValidateDeepStreamParse) {
				if (Number.isNaN(streamUsageMaxParsers) || streamUsageMaxParsers < 0) {
					pushNotice("warning", "并发上限需为非负整数");
					return;
				}
				if (
					Number.isNaN(streamUsageParseTimeoutMs) ||
					streamUsageParseTimeoutMs < 0
				) {
					pushNotice("warning", "解析参数需为非负整数");
					return;
				}
			}
			if (
				Number.isNaN(responsesAffinityTtlSeconds) ||
				responsesAffinityTtlSeconds < 60 ||
				!Number.isInteger(responsesAffinityTtlSeconds)
			) {
				pushNotice("warning", "Responses 粘滞 TTL 需为不小于 60 的整数");
				return;
			}
			if (
				Number.isNaN(streamOptionsCapabilityTtlSeconds) ||
				streamOptionsCapabilityTtlSeconds < 60 ||
				!Number.isInteger(streamOptionsCapabilityTtlSeconds)
			) {
				pushNotice("warning", "stream_options 能力 TTL 需为不小于 60 的整数");
				return;
			}
			if (
				Number.isNaN(attemptWorkerFallbackThreshold) ||
				attemptWorkerFallbackThreshold < 1 ||
				!Number.isInteger(attemptWorkerFallbackThreshold)
			) {
				pushNotice("warning", "调用执行器异常阈值需为正整数");
				return;
			}
			if (
				Number.isNaN(largeRequestOffloadThresholdBytes) ||
				largeRequestOffloadThresholdBytes < 0 ||
				!Number.isInteger(largeRequestOffloadThresholdBytes)
			) {
				pushNotice("warning", "大请求下沉阈值需为非负整数");
				return;
			}
			if (
				Number.isNaN(siteTaskConcurrency) ||
				siteTaskConcurrency < 1 ||
				!Number.isInteger(siteTaskConcurrency)
			) {
				pushNotice("warning", "站点任务并发需为正整数");
				return;
			}
			if (
				Number.isNaN(siteTaskTimeoutMs) ||
				siteTaskTimeoutMs < 1 ||
				!Number.isInteger(siteTaskTimeoutMs)
			) {
				pushNotice("warning", "站点任务超时需为正整数");
				return;
			}
			if (!/^\d{2}:\d{2}$/.test(channelRecoveryProbeScheduleTime)) {
				pushNotice("warning", "禁用渠道抽测时间需为 HH:mm");
				return;
			}
			if (!/^\d{2}:\d{2}$/.test(channelRefreshScheduleTime)) {
				pushNotice("warning", "启用渠道更新时间需为 HH:mm");
				return;
			}
			const backupScheduleTime = backupSettings.schedule_time.trim();
			if (!/^\d{2}:\d{2}$/.test(backupScheduleTime)) {
				pushNotice("warning", "定时备份时间需为 HH:mm");
				return;
			}
			const backupKeepVersions = Number(backupSettings.keep_versions);
			if (
				Number.isNaN(backupKeepVersions) ||
				backupKeepVersions < 1 ||
				!Number.isInteger(backupKeepVersions)
			) {
				pushNotice("warning", "备份历史保留数量需为正整数");
				return;
			}
			const settingsChanged =
				JSON.stringify(settingsForm) !== JSON.stringify(settingsFormSnapshot);
			const backupChanged =
				JSON.stringify(pickEditableBackupSettings(backupSettings)) !==
				JSON.stringify(backupSettingsSnapshot);
			if (!settingsChanged && !backupChanged) {
				return;
			}
			startAction(actionKey);
			const payload: Record<string, unknown> = {
				log_retention_days: retention,
				session_ttl_hours: sessionTtlHours,
				checkin_schedule_time:
					settingsForm.checkin_schedule_time.trim() || "00:10",
				channel_refresh_enabled: settingsForm.channel_refresh_enabled,
				channel_refresh_schedule_time: channelRefreshScheduleTime,
				channel_recovery_probe_enabled:
					settingsForm.channel_recovery_probe_enabled,
				channel_recovery_probe_schedule_time: channelRecoveryProbeScheduleTime,
				proxy_model_failure_cooldown_minutes: failureCooldownMinutes,
				proxy_model_failure_cooldown_threshold: failureCooldownThreshold,
				channel_disable_error_threshold: channelDisableErrorThreshold,
				channel_disable_error_code_minutes: channelDisableErrorCodeMinutes,
				proxy_upstream_timeout_ms: upstreamTimeoutMs,
				proxy_retry_max_retries: retryMaxRetries,
				proxy_retry_sleep_ms: retrySleepMs,
				proxy_retry_sleep_error_codes: retrySleepErrorCodes,
				proxy_retry_return_error_codes: retryReturnErrorCodes,
				channel_disable_error_codes: channelDisableErrorCodes,
				proxy_zero_completion_as_error_enabled:
					settingsForm.proxy_zero_completion_as_error_enabled,
				proxy_stream_usage_mode: streamUsageMode,
				proxy_stream_usage_max_parsers: streamUsageMaxParsers,
				proxy_stream_usage_parse_timeout_ms: streamUsageParseTimeoutMs,
				proxy_responses_affinity_ttl_seconds: responsesAffinityTtlSeconds,
				proxy_stream_options_capability_ttl_seconds:
					streamOptionsCapabilityTtlSeconds,
				proxy_attempt_worker_fallback_enabled:
					settingsForm.proxy_attempt_worker_fallback_enabled,
				proxy_attempt_worker_fallback_threshold: attemptWorkerFallbackThreshold,
				proxy_large_request_offload_threshold_bytes:
					largeRequestOffloadThresholdBytes,
				site_task_concurrency: siteTaskConcurrency,
				site_task_timeout_ms: siteTaskTimeoutMs,
				site_task_fallback_enabled: settingsForm.site_task_fallback_enabled,
			};
			const password = settingsForm.admin_password.trim();
			if (password) {
				payload.admin_password = password;
			}
			try {
				if (backupChanged) {
					await apiFetch("/api/backup/sync-config", {
						method: "PUT",
						body: JSON.stringify({
							enabled: backupSettings.enabled,
							schedule_time: backupScheduleTime,
							sync_mode: backupSettings.sync_mode,
							conflict_policy: backupSettings.conflict_policy,
							import_mode: backupSettings.import_mode,
							webdav_url: backupSettings.webdav_url.trim(),
							webdav_username: backupSettings.webdav_username.trim(),
							webdav_password: backupSettings.webdav_password.trim(),
							webdav_path: backupSettings.webdav_path.trim(),
							keep_versions: backupKeepVersions,
						}),
					});
				}
				if (settingsChanged) {
					await apiFetch("/api/settings", {
						method: "PUT",
						body: JSON.stringify(payload),
					});
				}
				await Promise.all([
					loadSettings(),
					loadRetryErrorCodes(),
					loadBackupSettings(),
				]);
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
			backupSettings,
			endAction,
			isActionPending,
			loadBackupSettings,
			loadRetryErrorCodes,
			loadSettings,
			pushNotice,
			settingsForm,
			settingsFormSnapshot,
			startAction,
			backupSettingsSnapshot,
		],
	);

	const handleBackupExport = useCallback(async () => {
		const actionKey = buildActionKey("backup:export");
		if (isActionPending(actionKey)) {
			return;
		}
		startAction(actionKey);
		try {
			const payload = await apiFetch<unknown>("/api/backup/export");
			const exportedAt = new Date()
				.toISOString()
				.replace(/[-:]/g, "")
				.replace(/\..*$/, "")
				.replace("T", "-");
			const blob = new Blob([JSON.stringify(payload, null, 2)], {
				type: "application/json;charset=utf-8",
			});
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `api-worker-backup-${exportedAt}.json`;
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(url);
			pushNotice("success", "备份已导出");
		} catch (error) {
			pushNotice("error", (error as Error).message);
		} finally {
			endAction(actionKey);
		}
	}, [apiFetch, endAction, isActionPending, pushNotice, startAction]);

	const handleBackupImport = useCallback(async () => {
		const actionKey = buildActionKey("backup:import");
		if (isActionPending(actionKey)) {
			return;
		}
		if (!backupImportFile) {
			pushNotice("warning", "请先选择备份文件");
			return;
		}
		startAction(actionKey);
		try {
			const text = await backupImportFile.text();
			const payload = JSON.parse(text) as unknown;
			const result = await apiFetch<BackupImportResult>("/api/backup/import", {
				method: "POST",
				body: JSON.stringify({
					payload,
					mode: backupImportMode,
					dry_run: false,
				}),
			});
			await Promise.all([
				loadSites(),
				loadTokens(),
				loadSettings(),
				loadBackupSettings(),
				loadRetryErrorCodes(),
			]);
			setBackupImportFile(null);
			pushNotice(
				"success",
				`导入完成：站点 +${result.summary.sites.created}/${result.summary.sites.updated}，令牌 +${result.summary.tokens.created}/${result.summary.tokens.updated}`,
			);
		} catch (error) {
			pushNotice("error", (error as Error).message);
		} finally {
			endAction(actionKey);
		}
	}, [
		apiFetch,
		backupImportFile,
		backupImportMode,
		endAction,
		isActionPending,
		loadBackupSettings,
		loadRetryErrorCodes,
		loadSettings,
		loadSites,
		loadTokens,
		pushNotice,
		startAction,
	]);

	const handleBackupSyncNow = useCallback(
		async (action: BackupManualAction) => {
			const actionKey = buildActionKey(`backup:${action}`);
			if (
				isActionPending(actionKey) ||
				isActionPending(buildActionKey("backup:push")) ||
				isActionPending(buildActionKey("backup:pull"))
			) {
				return;
			}
			startAction(actionKey);
			try {
				const result = await apiFetch<BackupSyncResult>(
					"/api/backup/sync-now",
					{
						method: "POST",
						body: JSON.stringify({ action }),
					},
				);
				await loadBackupSettings();
				if (result.action === "pull") {
					await Promise.all([
						loadSites(),
						loadTokens(),
						loadSettings(),
						loadRetryErrorCodes(),
					]);
				}
				pushNotice("success", action === "push" ? "上传完成" : "下载完成");
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
			loadBackupSettings,
			loadRetryErrorCodes,
			loadSettings,
			loadSites,
			loadTokens,
			pushNotice,
			startAction,
		],
	);

	const handleBackupPushNow = useCallback(async () => {
		await handleBackupSyncNow("push");
	}, [handleBackupSyncNow]);

	const handleBackupPullNow = useCallback(async () => {
		await handleBackupSyncNow("pull");
	}, [handleBackupSyncNow]);

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

	const handleClearCoolingModel = useCallback(
		async (siteId: string, model: string) => {
			const actionKey = buildActionKey(
				"site:clearCooling",
				`${siteId}:${model}`,
			);
			if (isActionPending(actionKey)) {
				return;
			}
			startAction(actionKey);
			try {
				await apiFetch(`/api/sites/${siteId}/cooling-models/reset`, {
					method: "POST",
					body: JSON.stringify({ model }),
				});
				await loadSites();
				pushNotice("success", `已解除模型冷却：${model}`);
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[apiFetch, endAction, isActionPending, loadSites, pushNotice, startAction],
	);

	const handleDisableFailedSite = useCallback(
		async (site: SiteVerificationResult) => {
			const actionKey = buildActionKey("site:disableFailed", site.site_id);
			if (isActionPending(actionKey)) {
				return;
			}
			startAction(actionKey);
			try {
				await apiFetch(`/api/sites/${site.site_id}`, {
					method: "PATCH",
					body: JSON.stringify({ status: "disabled" }),
				});
				await loadSites();
				setSiteTaskReports((prev) => {
					const current = prev["verify-active"];
					if (!current || current.kind !== "verify-active") {
						return prev;
					}
					const nextItems = current.report.items.filter(
						(item) => item.site_id !== site.site_id,
					);
					return {
						...prev,
						"verify-active": {
							kind: "verify-active",
							runs_at: current.runs_at,
							report: {
								...current.report,
								items: nextItems,
								summary: summarizeVerificationResults(nextItems),
							},
						},
					};
				});
				pushNotice("success", `已禁用站点：${site.site_name}`);
			} catch (error) {
				pushNotice("error", (error as Error).message);
			} finally {
				endAction(actionKey);
			}
		},
		[apiFetch, endAction, isActionPending, loadSites, pushNotice, startAction],
	);

	const handleDisableAllFailedSites = useCallback(async () => {
		const report = siteTaskReports["verify-active"];
		const failedItems =
			report?.kind === "verify-active"
				? report.report.items.filter((item) => item.verdict === "failed")
				: [];
		if (!report || failedItems.length === 0) {
			pushNotice("info", "当前没有可禁用的失败站点");
			return;
		}
		const actionKey = buildActionKey("site:disableFailedAll");
		if (isActionPending(actionKey)) {
			return;
		}
		startAction(actionKey);
		try {
			const settled = await Promise.allSettled(
				failedItems.map(async (item) => {
					await apiFetch(`/api/sites/${item.site_id}`, {
						method: "PATCH",
						body: JSON.stringify({ status: "disabled" }),
					});
					return item.site_id;
				}),
			);
			const successIds = settled
				.filter(
					(item): item is PromiseFulfilledResult<string> =>
						item.status === "fulfilled",
				)
				.map((item) => item.value);
			const failedCount = settled.length - successIds.length;
			await loadSites();
			setSiteTaskReports((prev) => {
				const current = prev["verify-active"];
				if (
					!current ||
					current.kind !== "verify-active" ||
					successIds.length === 0
				) {
					return prev;
				}
				const successSet = new Set(successIds);
				const nextItems = current.report.items.filter(
					(item) => !successSet.has(item.site_id),
				);
				return {
					...prev,
					"verify-active": {
						kind: "verify-active",
						runs_at: current.runs_at,
						report: {
							...current.report,
							items: nextItems,
							summary: summarizeVerificationResults(nextItems),
						},
					},
				};
			});
			if (failedCount > 0) {
				pushNotice(
					"warning",
					`批量禁用完成，成功 ${successIds.length} 个，失败 ${failedCount} 个。`,
				);
			} else {
				pushNotice("success", `已批量禁用 ${successIds.length} 个失败站点。`);
			}
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
		siteTaskReports,
	]);

	const requestDisableAllFailedSites = useCallback(() => {
		const report = siteTaskReports["verify-active"];
		const failedItems =
			report?.kind === "verify-active"
				? report.report.items.filter((item) => item.verdict === "failed")
				: [];
		if (!report || failedItems.length === 0) {
			pushNotice("info", "当前没有可禁用的失败站点");
			return;
		}
		const names = failedItems
			.slice(0, 5)
			.map((item) => item.site_name)
			.join("、");
		const suffix =
			failedItems.length > 5 ? ` 等 ${failedItems.length} 个站点` : "";
		openConfirm({
			title: "批量禁用失败站点",
			message: `将禁用以下验证失败站点：${names}${suffix}。确认继续吗？`,
			confirmLabel: "禁用全部失败站点",
			tone: "error",
			onConfirm: () => handleDisableAllFailedSites(),
		});
	}, [handleDisableAllFailedSites, openConfirm, pushNotice, siteTaskReports]);

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
			storeSiteTaskReport({
				kind: "checkin",
				runs_at: result.runs_at,
				summary: result.summary,
				items: result.results,
			});
			if (result.summary.total === 0) {
				pushNotice("info", "当前没有开启签到的站点");
				return;
			}
			pushNotice(
				result.summary.failed > 0 ? "warning" : "success",
				result.summary.failed > 0
					? "批量签到完成，有部分站点失败。"
					: "批量签到完成。",
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
		storeSiteTaskReport,
	]);

	const handleRefreshSite = useCallback(
		async (site: Site) => {
			const actionKey = buildActionKey("site:refresh", site.id);
			if (isActionPending(actionKey)) {
				return;
			}
			startAction(actionKey);
			try {
				const result = await apiFetch<
					SiteChannelRefreshBatchReport["items"][number]
				>(`/api/sites/${site.id}/refresh`, {
					method: "POST",
				});
				await loadSites();
				syncRefreshTaskItem(result, new Date().toISOString());
				pushNotice(
					result.status === "success" ? "success" : "warning",
					`${site.name || "站点"}：${result.message}`,
				);
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
			loadSites,
			pushNotice,
			startAction,
			syncRefreshTaskItem,
		],
	);

	const handleRefreshActiveSites = useCallback(async () => {
		const actionKey = buildActionKey("site:refreshAll");
		if (isActionPending(actionKey)) {
			return;
		}
		startAction(actionKey);
		try {
			const report = await apiFetch<SiteChannelRefreshBatchReport>(
				"/api/sites/refresh-active",
				{
					method: "POST",
				},
			);
			await loadSites();
			storeSiteTaskReport({
				kind: "refresh-active",
				runs_at: report.runs_at,
				report,
			});
			if (report.summary.total === 0) {
				pushNotice("info", "当前没有启用渠道可更新");
				return;
			}
			pushNotice(
				report.summary.failed > 0 ? "warning" : "success",
				report.summary.failed > 0
					? `更新完成，失败 ${report.summary.failed} 个。`
					: "更新完成。",
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
		storeSiteTaskReport,
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

	const filteredSites = useMemo(
		() =>
			filterSitesByCooldown(
				filterSites(data.sites, siteSearch),
				siteCooldownFilter,
			),
		[data.sites, siteCooldownFilter, siteSearch],
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

	useEffect(() => {
		setSitePage((prev) => Math.min(prev, siteTotalPages));
	}, [siteTotalPages]);

	useEffect(() => {
		setSitePage(1);
	}, [siteCooldownFilter, siteSearch, siteSort.key, siteSort.direction]);

	useEffect(() => {
		setTokenPage((prev) => Math.min(prev, tokenTotalPages));
	}, [tokenTotalPages]);

	useEffect(() => {
		setUsagePage((prev) => Math.min(prev, usageTotalPages));
	}, [usageTotalPages]);

	const activeLabel = useMemo(
		() => tabs.find((tab) => tab.id === activeTab)?.label ?? "管理台",
		[activeTab],
	);
	const hasPendingSettingsChanges = useMemo(() => {
		const settingsChanged =
			JSON.stringify(settingsForm) !== JSON.stringify(settingsFormSnapshot);
		const backupChanged =
			JSON.stringify(pickEditableBackupSettings(backupSettings)) !==
			JSON.stringify(backupSettingsSnapshot);
		return settingsChanged || backupChanged;
	}, [
		backupSettings,
		backupSettingsSnapshot,
		settingsForm,
		settingsFormSnapshot,
	]);
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
					sites={data.sites}
					siteForm={siteForm}
					sitePage={sitePage}
					sitePageSize={sitePageSize}
					siteTotal={siteTotal}
					siteTotalPages={siteTotalPages}
					pagedSites={pagedSites}
					editingSite={editingSite}
					isSiteModalOpen={isSiteModalOpen}
					taskReports={siteTaskReports}
					siteSearch={siteSearch}
					siteCooldownFilter={siteCooldownFilter}
					siteSort={siteSort}
					isActionPending={isActionPending}
					onCreate={openSiteCreate}
					onCloseModal={closeSiteModal}
					onEdit={startSiteEdit}
					onSubmit={handleSiteSubmit}
					onVerify={handleSiteVerify}
					onCheckin={handleCheckinRunSite}
					onRefreshSite={handleRefreshSite}
					onToggle={handleSiteToggle}
					onDelete={requestSiteDelete}
					onPageChange={handleSitePageChange}
					onPageSizeChange={handleSitePageSizeChange}
					onSearchChange={handleSiteSearchChange}
					onCooldownFilterChange={handleSiteCooldownFilterChange}
					onSortChange={handleSiteSortChange}
					onFormChange={handleSiteFormChange}
					onRunAll={handleCheckinRunAll}
					onVerifyAll={handleSiteVerifyAll}
					onEvaluateRecovery={handleSiteRecoveryEvaluate}
					onRefreshAll={handleRefreshActiveSites}
					onDisableFailedSite={handleDisableFailedSite}
					onDisableAllFailedSites={requestDisableAllFailedSites}
					onClearCoolingModel={handleClearCoolingModel}
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
		if (activeTab === "settings") {
			return (
				<SettingsView
					settingsForm={settingsForm}
					adminPasswordSet={data.settings?.admin_password_set ?? false}
					runtimeConfig={data.settings?.runtime_config ?? null}
					retryErrorCodeOptions={retryErrorCodeOptions}
					isSaving={isActionPending(buildActionKey("settings:submit"))}
					hasPendingSettingsChanges={hasPendingSettingsChanges}
					backupSettings={backupSettings}
					backupImportMode={backupImportMode}
					backupImportFileName={backupImportFile?.name ?? ""}
					isBackupExporting={isActionPending(buildActionKey("backup:export"))}
					isBackupImporting={isActionPending(buildActionKey("backup:import"))}
					isBackupPushing={isActionPending(buildActionKey("backup:push"))}
					isBackupPulling={isActionPending(buildActionKey("backup:pull"))}
					onSubmit={handleSettingsSubmit}
					onFormChange={handleSettingsFormChange}
					onBackupSettingsChange={handleBackupSettingsChange}
					onBackupExport={handleBackupExport}
					onBackupImportModeChange={handleBackupImportModeChange}
					onBackupImportFileChange={handleBackupImportFileChange}
					onBackupImport={handleBackupImport}
					onBackupPushNow={handleBackupPushNow}
					onBackupPullNow={handleBackupPullNow}
					onApplyRecommendedConfig={handleApplyRecommendedConfig}
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
			{siteVerificationDialog && (
				<Dialog
					open={Boolean(siteVerificationDialog)}
					onClose={closeSiteVerificationDialog}
				>
					<DialogContent
						aria-labelledby="site-verification-title"
						aria-modal="true"
						class="max-w-4xl"
					>
						<DialogHeader>
							<div>
								<DialogTitle id="site-verification-title">
									{siteVerificationDialog.title}
								</DialogTitle>
								<DialogDescription>
									{siteVerificationDialog.result.site_name} ·{" "}
									{getVerificationVerdictLabel(
										siteVerificationDialog.result.verdict,
									)}
									。{siteVerificationDialog.result.message}
								</DialogDescription>
							</div>
							<Button
								size="sm"
								type="button"
								onClick={closeSiteVerificationDialog}
							>
								关闭
							</Button>
						</DialogHeader>
						<div class="mt-3 grid gap-3 md:grid-cols-2">
							{(
								[
									[
										"连接验证",
										siteVerificationDialog.result.stages.connectivity,
									],
									["能力验证", siteVerificationDialog.result.stages.capability],
									["服务验证", siteVerificationDialog.result.stages.service],
									["恢复评估", siteVerificationDialog.result.stages.recovery],
								] as const
							).map(([label, stage]) => {
								const tone = getVerificationStageTone(stage.status);
								return (
									<div
										class={`rounded-2xl border px-4 py-4 ${getVerificationStageClass(
											tone,
										)}`}
										key={label}
									>
										<div class="flex items-center justify-between gap-3">
											<p class="text-sm font-semibold">{label}</p>
											<span class="text-xs font-semibold uppercase tracking-widest">
												{stage.status}
											</span>
										</div>
										<p class="mt-2 text-xs">{stage.message}</p>
										<p class="mt-2 text-[11px] opacity-80">
											code: {stage.code}
										</p>
									</div>
								);
							})}
						</div>
						<div class="mt-4 grid gap-3 rounded-2xl border border-white/60 bg-white/75 px-4 py-4 md:grid-cols-2">
							<div>
								<p class="text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]">
									验证模型
								</p>
								<p class="mt-1 text-sm font-semibold text-[color:var(--app-ink)]">
									{siteVerificationDialog.result.selected_model ?? "未选择"}
								</p>
							</div>
							<div>
								<p class="text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]">
									检查时间
								</p>
								<p class="mt-1 text-sm font-semibold text-[color:var(--app-ink)]">
									{formatChinaDateTimeMinute(
										siteVerificationDialog.result.checked_at,
									)}
								</p>
							</div>
							<div>
								<p class="text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]">
									建议动作
								</p>
								<p class="mt-1 text-sm font-semibold text-[color:var(--app-ink)]">
									{getSuggestedActionLabel(
										siteVerificationDialog.result.suggested_action,
									)}
								</p>
							</div>
							<div>
								<p class="text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]">
									调用令牌
								</p>
								<p class="mt-1 text-sm font-semibold text-[color:var(--app-ink)]">
									{siteVerificationDialog.result.selected_token?.name ??
										"未命中"}
								</p>
							</div>
							<div>
								<p class="text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]">
									上游状态
								</p>
								<p class="mt-1 text-sm font-semibold text-[color:var(--app-ink)]">
									{siteVerificationDialog.result.trace.upstream_status ?? "-"}
								</p>
							</div>
						</div>
						<DialogFooter>
							<Button
								size="sm"
								type="button"
								onClick={closeSiteVerificationDialog}
							>
								关闭
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
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
