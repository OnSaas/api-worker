import { useEffect, useMemo, useState } from "hono/jsx/dom";
import {
	Button,
	Card,
	Chip,
	ColumnPicker,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	Input,
	MultiSelect,
	Pagination,
	Skeleton,
	Tooltip,
} from "../components/ui";
import type {
	ModelItem,
	Site,
	Token,
	UsageLog,
	UsageQuery,
} from "../core/types";
import {
	buildPageItems,
	buildUsageStatusDetail,
	formatDateTime,
	loadColumnPrefs,
	persistColumnPrefs,
} from "../core/utils";

type UsageViewProps = {
	usage: UsageLog[];
	total: number;
	page: number;
	pageSize: number;
	filters: UsageQuery;
	isRefreshing: boolean;
	sites: Site[];
	tokens: Token[];
	models: ModelItem[];
	onRefresh: () => void;
	onPageChange: (next: number) => void;
	onPageSizeChange: (next: number) => void;
	onFiltersChange: (patch: Partial<UsageQuery>) => void;
	onSearch: () => void;
	onClear: () => void;
};

const pageSizeOptions = [50, 100, 200];

const formatTokens = (value: number | null | undefined) =>
	value === null || value === undefined ? "-" : value;

const formatSeconds = (value: number | null | undefined) => {
	if (value === null || value === undefined || Number.isNaN(value)) {
		return "-";
	}
	return `${(value / 1000).toFixed(2)} s`;
};

const formatStream = (value: boolean | number | null | undefined) => {
	if (value === null || value === undefined) {
		return "-";
	}
	if (typeof value === "number") {
		return value > 0 ? "是" : "否";
	}
	return value ? "是" : "否";
};

type ParsedErrorMeta = {
	text: string | null;
	record: Record<string, unknown> | null;
};

const parseErrorMeta = (value: string | null | undefined): ParsedErrorMeta => {
	if (!value) {
		return { text: null, record: null };
	}
	try {
		const parsed = JSON.parse(value);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return {
				text: JSON.stringify(parsed, null, 2),
				record: parsed as Record<string, unknown>,
			};
		}
		return {
			text: JSON.stringify(parsed, null, 2),
			record: null,
		};
	} catch {
		return { text: value, record: null };
	}
};

const readMetaString = (
	record: Record<string, unknown> | null,
	key: string,
): string | null => {
	const value = record?.[key];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
};

const readMetaStringArray = (
	record: Record<string, unknown> | null,
	key: string,
): string[] => {
	const value = record?.[key];
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((item) => (typeof item === "string" ? item.trim() : ""))
		.filter((item) => item.length > 0);
};

const formatChannelLabel = (log: UsageLog): string => {
	if (log.channel_name) {
		return log.channel_name;
	}
	if (log.channel_id) {
		return log.channel_id;
	}
	if (
		log.failure_stage === "request" &&
		log.error_code === "responses_tool_call_chain_mismatch"
	) {
		return "聚合结果";
	}
	if (
		log.failure_stage === "request" ||
		log.failure_stage === "request_validation"
	) {
		return "请求级";
	}
	return "-";
};

/**
 * Renders the usage logs view.
 *
 * Args:
 *   props: Usage view props.
 *
 * Returns:
 *   Usage JSX element.
 */
export const UsageView = ({
	usage,
	total,
	page,
	pageSize,
	filters,
	isRefreshing,
	sites,
	tokens,
	models,
	onRefresh,
	onPageChange,
	onPageSizeChange,
	onFiltersChange,
	onSearch,
	onClear,
}: UsageViewProps) => {
	const [activeErrorLog, setActiveErrorLog] = useState<UsageLog | null>(null);
	const usageColumns = [
		{ id: "time", label: "时间", locked: true },
		{ id: "model", label: "模型" },
		{ id: "channel", label: "渠道" },
		{ id: "token", label: "令牌" },
		{ id: "prompt_tokens", label: "输入 Tokens" },
		{ id: "completion_tokens", label: "输出 Tokens" },
		{ id: "latency", label: "用时 (s)" },
		{ id: "first_token", label: "首 token 延迟 (s)" },
		{ id: "stream", label: "流式" },
		{ id: "reasoning", label: "推理强度" },
		{ id: "status", label: "状态码" },
	];
	const [visibleColumns, setVisibleColumns] = useState(() =>
		loadColumnPrefs(
			"columns:usage",
			usageColumns.map((column) => column.id),
		),
	);
	const visibleColumnSet = useMemo(
		() => new Set(visibleColumns),
		[visibleColumns],
	);
	const visibleColumnCount = visibleColumns.length;
	const updateVisibleColumns = (next: string[]) => {
		setVisibleColumns(next);
		persistColumnPrefs("columns:usage", next);
	};
	const totalPages = useMemo(
		() => Math.max(1, Math.ceil(total / pageSize)),
		[total, pageSize],
	);
	const displayPages = total === 0 ? 0 : totalPages;
	const pageItems = useMemo(
		() => buildPageItems(page, totalPages),
		[page, totalPages],
	);
	const closeErrorModal = () => setActiveErrorLog(null);
	const hasFilters =
		filters.channel_ids.length > 0 ||
		filters.token_ids.length > 0 ||
		filters.models.length > 0 ||
		filters.statuses.length > 0 ||
		filters.from.trim() ||
		filters.to.trim();
	const showSkeleton = isRefreshing && usage.length === 0;
	const channelOptions = useMemo(
		() =>
			sites.map((site) => ({
				value: site.id,
				label: site.name ?? site.id,
			})),
		[sites],
	);
	const tokenOptions = useMemo(
		() =>
			tokens.map((token) => ({
				value: token.id,
				label: token.name || token.id,
			})),
		[tokens],
	);
	const modelOptions = useMemo(
		() =>
			models.map((model) => ({
				value: model.id,
				label: model.id,
			})),
		[models],
	);
	const statusOptions = useMemo(() => {
		const codes = new Set<string>();
		for (const log of usage) {
			if (log.upstream_status !== null && log.upstream_status !== undefined) {
				codes.add(String(log.upstream_status));
			}
		}
		for (const value of filters.statuses) {
			if (/^\d+$/.test(value)) {
				codes.add(value);
			}
		}
		return Array.from(codes)
			.sort((a, b) => Number(a) - Number(b))
			.map((value) => ({ value, label: value }));
	}, [filters.statuses, usage]);
	const parsedErrorMeta = useMemo(
		() => parseErrorMeta(activeErrorLog?.error_meta_json),
		[activeErrorLog],
	);
	const errorMetaText = parsedErrorMeta.text;
	const errorMetaRecord = parsedErrorMeta.record;
	const policyAction = readMetaString(errorMetaRecord, "policy_action");
	const resolvedPolicyAction = readMetaString(
		errorMetaRecord,
		"policy_resolved_action",
	);
	const policyMatchedKey = readMetaString(
		errorMetaRecord,
		"policy_matched_key",
	);
	const policyMatchedSet = readMetaString(
		errorMetaRecord,
		"policy_matched_set",
	);
	const normalizedErrorCode = readMetaString(
		errorMetaRecord,
		"normalized_error_code",
	);
	const policyLookupKeys = readMetaStringArray(
		errorMetaRecord,
		"policy_lookup_keys",
	);

	useEffect(() => {
		if (!activeErrorLog) {
			return;
		}
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				closeErrorModal();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [activeErrorLog]);

	return (
		<div class="space-y-5">
			<div class="app-panel animate-fade-up space-y-4">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div>
						<h3 class="app-title text-lg">使用日志</h3>
						<p class="app-subtitle">追踪每次调用的令牌与关键性能指标。</p>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<Button
							class="h-9 px-4 text-xs"
							size="sm"
							type="button"
							disabled={isRefreshing}
							onClick={onRefresh}
						>
							{isRefreshing ? "刷新中..." : "刷新"}
						</Button>
					</div>
				</div>
				<Card
					variant="compact"
					class="app-layer-raised app-toolbar-card space-y-3 p-4"
				>
					<div class="flex flex-wrap items-center justify-between gap-3">
						<div class="text-xs font-semibold uppercase tracking-widest text-[color:var(--app-ink-muted)]">
							筛选模块
						</div>
						<ColumnPicker
							columns={usageColumns}
							value={visibleColumns}
							onChange={updateVisibleColumns}
						/>
					</div>
					<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						<div>
							<label
								class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]"
								for="usage-from"
							>
								开始日期
							</label>
							<Input
								id="usage-from"
								type="date"
								value={filters.from}
								onInput={(event) =>
									onFiltersChange({
										from: (event.currentTarget as HTMLInputElement).value,
									})
								}
							/>
						</div>
						<div>
							<label
								class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]"
								for="usage-to"
							>
								结束日期
							</label>
							<Input
								id="usage-to"
								type="date"
								value={filters.to}
								onInput={(event) =>
									onFiltersChange({
										to: (event.currentTarget as HTMLInputElement).value,
									})
								}
							/>
						</div>
						<div>
							<p class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]">
								渠道
							</p>
							<MultiSelect
								class="w-full"
								options={channelOptions}
								value={filters.channel_ids}
								placeholder="选择渠道"
								searchPlaceholder="搜索渠道"
								emptyLabel="暂无匹配渠道"
								onChange={(next) => onFiltersChange({ channel_ids: next })}
							/>
						</div>
					</div>
					<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						<div>
							<p class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]">
								令牌
							</p>
							<MultiSelect
								class="w-full"
								options={tokenOptions}
								value={filters.token_ids}
								placeholder="选择令牌"
								searchPlaceholder="搜索令牌"
								emptyLabel="暂无匹配令牌"
								onChange={(next) => onFiltersChange({ token_ids: next })}
							/>
						</div>
						<div>
							<p class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]">
								模型
							</p>
							<MultiSelect
								class="w-full"
								options={modelOptions}
								value={filters.models}
								placeholder="选择模型"
								searchPlaceholder="搜索模型"
								emptyLabel="暂无匹配模型"
								onChange={(next) => onFiltersChange({ models: next })}
							/>
						</div>
						<div>
							<p class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]">
								状态
							</p>
							<MultiSelect
								class="w-full"
								options={statusOptions}
								value={filters.statuses}
								placeholder="选择状态"
								searchPlaceholder="搜索状态"
								emptyLabel="暂无匹配状态"
								onChange={(next) => onFiltersChange({ statuses: next })}
							/>
						</div>
						<div class="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
							<Button
								class="h-9 px-4 text-[11px]"
								size="sm"
								variant="primary"
								type="button"
								disabled={isRefreshing}
								onClick={onSearch}
							>
								搜索
							</Button>
							<Button
								class="h-9 px-4 text-[11px]"
								size="sm"
								variant="ghost"
								type="button"
								disabled={isRefreshing || !hasFilters}
								onClick={onClear}
							>
								清空
							</Button>
						</div>
					</div>
				</Card>
				<div class="app-surface app-data-shell overflow-hidden">
					<div class="h-[360px] overflow-auto sm:h-[440px]">
						<table class="app-table min-w-[960px] w-full text-xs sm:text-sm">
							<thead>
								<tr>
									{visibleColumnSet.has("time") && (
										<th class="sticky top-0 bg-[color:var(--app-surface-strong)]/95">
											时间
										</th>
									)}
									{visibleColumnSet.has("model") && (
										<th class="sticky top-0 bg-[color:var(--app-surface-strong)]/95">
											模型
										</th>
									)}
									{visibleColumnSet.has("channel") && (
										<th class="sticky top-0 bg-[color:var(--app-surface-strong)]/95">
											渠道
										</th>
									)}
									{visibleColumnSet.has("token") && (
										<th class="sticky top-0 bg-[color:var(--app-surface-strong)]/95">
											令牌
										</th>
									)}
									{visibleColumnSet.has("prompt_tokens") && (
										<th class="sticky top-0 bg-[color:var(--app-surface-strong)]/95">
											输入 Tokens
										</th>
									)}
									{visibleColumnSet.has("completion_tokens") && (
										<th class="sticky top-0 bg-[color:var(--app-surface-strong)]/95">
											输出 Tokens
										</th>
									)}
									{visibleColumnSet.has("latency") && (
										<th class="sticky top-0 bg-[color:var(--app-surface-strong)]/95">
											用时 (s)
										</th>
									)}
									{visibleColumnSet.has("first_token") && (
										<th class="sticky top-0 bg-[color:var(--app-surface-strong)]/95">
											<Tooltip content="首个 token 返回的等待时间。">
												<span>首 token 延迟 (s)</span>
											</Tooltip>
										</th>
									)}
									{visibleColumnSet.has("stream") && (
										<th class="sticky top-0 bg-[color:var(--app-surface-strong)]/95">
											流式
										</th>
									)}
									{visibleColumnSet.has("reasoning") && (
										<th class="sticky top-0 bg-[color:var(--app-surface-strong)]/95">
											<Tooltip content="模型推理强度等级。">
												<span>推理强度</span>
											</Tooltip>
										</th>
									)}
									{visibleColumnSet.has("status") && (
										<th class="sticky top-0 bg-[color:var(--app-surface-strong)]/95">
											状态码
										</th>
									)}
								</tr>
							</thead>
							<tbody>
								{showSkeleton ? (
									Array.from({ length: 6 }).map((_, rowIndex) => (
										<tr key={`skeleton-${rowIndex}`}>
											{Array.from({ length: visibleColumnCount }).map(
												(_, cellIndex) => (
													<td class="px-3 py-2.5" key={`cell-${cellIndex}`}>
														<Skeleton class="h-3 w-full" />
													</td>
												),
											)}
										</tr>
									))
								) : usage.length === 0 ? (
									<tr>
										<td
											class="px-3 py-10 text-center text-sm text-[color:var(--app-ink-muted)]"
											colSpan={visibleColumnCount}
										>
											<div class="flex flex-col items-center gap-3">
												<span>暂无日志，先完成一次调用吧。</span>
												<Button
													class="h-8 px-4 text-[11px]"
													size="sm"
													variant="primary"
													type="button"
													onClick={onRefresh}
													disabled={isRefreshing}
												>
													立即刷新
												</Button>
											</div>
										</td>
									</tr>
								) : (
									usage.map((log) => {
										const statusDetail = buildUsageStatusDetail(log);
										return (
											<tr key={log.id}>
												{visibleColumnSet.has("time") && (
													<td class="px-3 py-2.5 text-left text-xs text-[color:var(--app-ink)] sm:text-sm">
														{formatDateTime(log.created_at)}
													</td>
												)}
												{visibleColumnSet.has("model") && (
													<td class="px-3 py-2.5 text-left text-xs text-[color:var(--app-ink)] sm:text-sm">
														{log.model ?? "-"}
													</td>
												)}
												{visibleColumnSet.has("channel") && (
													<td class="px-3 py-2.5 text-left text-xs text-[color:var(--app-ink)] sm:text-sm">
														{formatChannelLabel(log)}
													</td>
												)}
												{visibleColumnSet.has("token") && (
													<td class="px-3 py-2.5 text-left text-xs text-[color:var(--app-ink)] sm:text-sm">
														{log.token_name ?? log.token_id ?? "-"}
													</td>
												)}
												{visibleColumnSet.has("prompt_tokens") && (
													<td class="px-3 py-2.5 text-left text-xs text-[color:var(--app-ink)] sm:text-sm">
														{formatTokens(log.prompt_tokens)}
													</td>
												)}
												{visibleColumnSet.has("completion_tokens") && (
													<td class="px-3 py-2.5 text-left text-xs text-[color:var(--app-ink)] sm:text-sm">
														{formatTokens(log.completion_tokens)}
													</td>
												)}
												{visibleColumnSet.has("latency") && (
													<td class="px-3 py-2.5 text-left text-xs text-[color:var(--app-ink)] sm:text-sm">
														{formatSeconds(log.latency_ms)}
													</td>
												)}
												{visibleColumnSet.has("first_token") && (
													<td class="px-3 py-2.5 text-left text-xs text-[color:var(--app-ink)] sm:text-sm">
														{formatSeconds(log.first_token_latency_ms)}
													</td>
												)}
												{visibleColumnSet.has("stream") && (
													<td class="px-3 py-2.5 text-left text-xs text-[color:var(--app-ink)] sm:text-sm">
														{formatStream(log.stream)}
													</td>
												)}
												{visibleColumnSet.has("reasoning") && (
													<td class="px-3 py-2.5 text-left text-xs text-[color:var(--app-ink)] sm:text-sm">
														{log.reasoning_effort ?? "-"}
													</td>
												)}
												{visibleColumnSet.has("status") && (
													<td class="px-3 py-2.5 text-left text-xs text-[color:var(--app-ink)] sm:text-sm">
														<button
															class="app-focus inline-flex items-center border-0 bg-transparent p-0"
															type="button"
															onClick={() => setActiveErrorLog(log)}
														>
															<Chip
																class="text-[10px]"
																variant={statusDetail.tone}
															>
																{statusDetail.label}
															</Chip>
														</button>
													</td>
												)}
											</tr>
										);
									})
								)}
							</tbody>
						</table>
					</div>
				</div>
				<div class="app-pagination-bar flex flex-col gap-3 text-xs text-[color:var(--app-ink-muted)] sm:flex-row sm:items-center sm:justify-between">
					<div class="flex flex-wrap items-center gap-2">
						<span class="text-xs text-[color:var(--app-ink-muted)]">
							共 {displayPages} 页 · {total} 条
						</span>
						<Pagination
							page={page}
							totalPages={totalPages}
							items={pageItems}
							onPageChange={onPageChange}
							disabled={isRefreshing}
						/>
					</div>
					<div class="app-page-size-control">
						<span class="app-page-size-control__label">每页</span>
						<div class="app-page-size-control__chips">
							{pageSizeOptions.map((size) => (
								<button
									class={`app-page-size-chip ${
										pageSize === size ? "app-page-size-chip--active" : ""
									}`}
									key={size}
									type="button"
									disabled={isRefreshing}
									onClick={() => onPageSizeChange(size)}
								>
									{size}
								</button>
							))}
						</div>
					</div>
				</div>
			</div>
			{activeErrorLog ? (
				<Dialog open={Boolean(activeErrorLog)} onClose={closeErrorModal}>
					<DialogContent
						aria-labelledby="usage-error-title"
						aria-modal="true"
						class="max-w-2xl"
					>
						<DialogHeader>
							<div>
								<DialogTitle id="usage-error-title">错误详情</DialogTitle>
								<DialogDescription>
									状态码{" "}
									{activeErrorLog.upstream_status !== null &&
									activeErrorLog.upstream_status !== undefined
										? activeErrorLog.upstream_status
										: "未知"}
								</DialogDescription>
								{activeErrorLog.error_code ? (
									<p class="mt-1 text-xs text-[color:var(--app-ink-muted)]">
										错误码: {activeErrorLog.error_code}
									</p>
								) : null}
							</div>
							<Button size="sm" type="button" onClick={closeErrorModal}>
								关闭
							</Button>
						</DialogHeader>
						<Card
							variant="compact"
							class="mt-4 text-xs text-[color:var(--app-ink)]"
						>
							<div class="grid gap-2">
								<div class="flex items-center justify-between gap-3">
									<span class="text-[color:var(--app-ink-muted)]">时间</span>
									<span>{formatDateTime(activeErrorLog.created_at)}</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-[color:var(--app-ink-muted)]">模型</span>
									<span>{activeErrorLog.model ?? "-"}</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-[color:var(--app-ink-muted)]">渠道</span>
									<span>{formatChannelLabel(activeErrorLog)}</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-[color:var(--app-ink-muted)]">令牌</span>
									<span>
										{activeErrorLog.token_name ??
											activeErrorLog.token_id ??
											"-"}
									</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-[color:var(--app-ink-muted)]">耗时</span>
									<span>{formatSeconds(activeErrorLog.latency_ms)}</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-[color:var(--app-ink-muted)]">
										异常阶段
									</span>
									<span>{activeErrorLog.failure_stage ?? "-"}</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-[color:var(--app-ink-muted)]">
										失败原因
									</span>
									<span>{activeErrorLog.failure_reason ?? "-"}</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-[color:var(--app-ink-muted)]">
										Usage 来源
									</span>
									<span>{activeErrorLog.usage_source ?? "-"}</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-[color:var(--app-ink-muted)]">
										策略动作
									</span>
									<span>{policyAction ?? "-"}</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-[color:var(--app-ink-muted)]">
										策略命中
									</span>
									<span>
										{policyMatchedSet && policyMatchedKey
											? `${policyMatchedSet}:${policyMatchedKey}`
											: "-"}
									</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-[color:var(--app-ink-muted)]">
										归一错误码
									</span>
									<span>{normalizedErrorCode ?? "-"}</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-[color:var(--app-ink-muted)]">查找键</span>
									<span>
										{policyLookupKeys.length > 0
											? policyLookupKeys.join(", ")
											: "-"}
									</span>
								</div>
								{resolvedPolicyAction &&
								resolvedPolicyAction !== policyAction ? (
									<div class="flex items-center justify-between gap-3">
										<span class="text-[color:var(--app-ink-muted)]">
											本地策略动作
										</span>
										<span>{resolvedPolicyAction}</span>
									</div>
								) : null}
							</div>
						</Card>
						{activeErrorLog.error_message ? (
							<Card
								variant="compact"
								class="mt-3 text-xs text-[color:var(--app-ink)]"
							>
								<div class="text-[11px] font-semibold uppercase tracking-widest text-[color:var(--app-ink-muted)]">
									错误摘要
								</div>
								<pre class="mt-2 h-40 overflow-auto whitespace-pre-wrap break-words text-[color:var(--app-ink)]">
									{activeErrorLog.error_message}
								</pre>
							</Card>
						) : (
							<p class="mt-3 text-[11px] text-[color:var(--app-ink-muted)]">
								暂无错误摘要，请结合状态码与错误码排查。
							</p>
						)}
						{errorMetaText ? (
							<Card
								variant="compact"
								class="mt-3 text-xs text-[color:var(--app-ink)]"
							>
								<div class="text-[11px] font-semibold uppercase tracking-widest text-[color:var(--app-ink-muted)]">
									诊断元数据
								</div>
								<pre class="mt-2 h-32 overflow-auto whitespace-pre-wrap break-words text-[color:var(--app-ink)]">
									{errorMetaText}
								</pre>
							</Card>
						) : null}
					</DialogContent>
				</Dialog>
			) : null}
		</div>
	);
};
