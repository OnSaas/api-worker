import { useMemo, useState } from "hono/jsx/dom";
import {
	Button,
	Card,
	Chip,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	Input,
	MultiSelect,
	Pagination,
	Skeleton,
} from "../components/ui";
import type { RuntimeEvent, RuntimeEventQuery } from "../core/types";
import { buildPageItems, formatDateTime } from "../core/utils";

type RuntimeEventsViewProps = {
	events: RuntimeEvent[];
	total: number;
	page: number;
	pageSize: number;
	filters: RuntimeEventQuery;
	isRefreshing: boolean;
	onRefresh: () => void;
	onPageChange: (next: number) => void;
	onPageSizeChange: (next: number) => void;
	onFiltersChange: (patch: Partial<RuntimeEventQuery>) => void;
	onSearch: () => void;
	onClear: () => void;
};

const pageSizeOptions = [50, 100, 200];

const levelLabelMap: Record<string, string> = {
	info: "信息",
	warning: "警告",
	error: "错误",
};

const levelVariantMap: Record<string, "default" | "success" | "danger"> = {
	info: "default",
	warning: "default",
	error: "danger",
};

const formatContext = (value: string | null | undefined): string => {
	if (!value) {
		return "无";
	}
	try {
		const parsed = JSON.parse(value);
		return JSON.stringify(parsed, null, 2);
	} catch {
		return value;
	}
};

export const RuntimeEventsView = ({
	events,
	total,
	page,
	pageSize,
	filters,
	isRefreshing,
	onRefresh,
	onPageChange,
	onPageSizeChange,
	onFiltersChange,
	onSearch,
	onClear,
}: RuntimeEventsViewProps) => {
	const [activeEvent, setActiveEvent] = useState<RuntimeEvent | null>(null);
	const levelOptions = [
		{ value: "info", label: "信息" },
		{ value: "warning", label: "警告" },
		{ value: "error", label: "错误" },
	];
	const codeOptions = useMemo(() => {
		const set = new Set<string>();
		for (const item of events) {
			if (item.code) {
				set.add(item.code);
			}
		}
		for (const code of filters.codes) {
			if (code) {
				set.add(code);
			}
		}
		return Array.from(set)
			.sort((a, b) => a.localeCompare(b))
			.map((code) => ({ value: code, label: code }));
	}, [events, filters.codes]);
	const totalPages = useMemo(
		() => Math.max(1, Math.ceil(total / pageSize)),
		[total, pageSize],
	);
	const displayPages = total === 0 ? 0 : totalPages;
	const pageItems = useMemo(
		() => buildPageItems(page, totalPages),
		[page, totalPages],
	);
	const hasFilters =
		filters.levels.length > 0 ||
		filters.codes.length > 0 ||
		filters.request_id.trim() ||
		filters.session_id.trim() ||
		filters.path.trim() ||
		filters.from.trim() ||
		filters.to.trim();
	const showSkeleton = isRefreshing && events.length === 0;

	return (
		<div class="space-y-5">
			<div class="app-panel animate-fade-up space-y-4">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div>
						<h3 class="app-title text-lg">系统日志</h3>
						<p class="app-subtitle">查看代理运行时事件与错误上下文。</p>
					</div>
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

				<Card
					variant="compact"
					class="app-layer-raised app-toolbar-card space-y-3 p-4"
				>
					<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						<div>
							<label
								class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]"
								for="runtime-from"
							>
								开始日期
							</label>
							<Input
								id="runtime-from"
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
								for="runtime-to"
							>
								结束日期
							</label>
							<Input
								id="runtime-to"
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
								级别
							</p>
							<MultiSelect
								class="w-full"
								options={levelOptions}
								value={filters.levels}
								placeholder="选择级别"
								searchPlaceholder="搜索级别"
								emptyLabel="暂无匹配级别"
								onChange={(next) => onFiltersChange({ levels: next })}
							/>
						</div>
					</div>

					<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						<div>
							<p class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]">
								错误码
							</p>
							<MultiSelect
								class="w-full"
								options={codeOptions}
								value={filters.codes}
								placeholder="选择错误码"
								searchPlaceholder="搜索错误码"
								emptyLabel="暂无匹配错误码"
								onChange={(next) => onFiltersChange({ codes: next })}
							/>
						</div>
						<div>
							<label
								class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]"
								for="runtime-request-id"
							>
								Request ID
							</label>
							<Input
								id="runtime-request-id"
								value={filters.request_id}
								placeholder="输入 request_id"
								onInput={(event) =>
									onFiltersChange({
										request_id: (event.currentTarget as HTMLInputElement).value,
									})
								}
							/>
						</div>
						<div>
							<label
								class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]"
								for="runtime-session-id"
							>
								Session ID
							</label>
							<Input
								id="runtime-session-id"
								value={filters.session_id}
								placeholder="输入 session_id"
								onInput={(event) =>
									onFiltersChange({
										session_id: (event.currentTarget as HTMLInputElement).value,
									})
								}
							/>
						</div>
						<div class="sm:col-span-2 lg:col-span-3">
							<label
								class="mb-1.5 block text-xs uppercase tracking-widest text-[color:var(--app-ink-muted)]"
								for="runtime-path"
							>
								路径
							</label>
							<Input
								id="runtime-path"
								value={filters.path}
								placeholder="输入请求路径"
								onInput={(event) =>
									onFiltersChange({
										path: (event.currentTarget as HTMLInputElement).value,
									})
								}
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
						<table class="app-table min-w-[1100px] w-full text-xs sm:text-sm">
							<thead>
								<tr>
									<th class="sticky top-0 bg-[color:var(--app-surface-strong)]/95">
										时间
									</th>
									<th class="sticky top-0 bg-[color:var(--app-surface-strong)]/95">
										级别
									</th>
									<th class="sticky top-0 bg-[color:var(--app-surface-strong)]/95">
										错误码
									</th>
									<th class="sticky top-0 bg-[color:var(--app-surface-strong)]/95">
										路径
									</th>
									<th class="sticky top-0 bg-[color:var(--app-surface-strong)]/95">
										Request ID
									</th>
									<th class="sticky top-0 bg-[color:var(--app-surface-strong)]/95">
										摘要
									</th>
								</tr>
							</thead>
							<tbody>
								{showSkeleton ? (
									Array.from({ length: 6 }).map((_, rowIndex) => (
										<tr key={`runtime-skeleton-${rowIndex}`}>
											{Array.from({ length: 6 }).map((__, cellIndex) => (
												<td
													class="px-3 py-2.5"
													key={`runtime-cell-${cellIndex}`}
												>
													<Skeleton class="h-3 w-full" />
												</td>
											))}
										</tr>
									))
								) : events.length === 0 ? (
									<tr>
										<td
											class="px-3 py-10 text-center text-sm text-[color:var(--app-ink-muted)]"
											colSpan={6}
										>
											暂无系统日志，先执行一次请求吧。
										</td>
									</tr>
								) : (
									events.map((event) => (
										<tr key={event.id}>
											<td class="px-3 py-2.5 text-left text-xs text-[color:var(--app-ink)] sm:text-sm">
												{formatDateTime(event.created_at)}
											</td>
											<td class="px-3 py-2.5 text-left text-xs text-[color:var(--app-ink)] sm:text-sm">
												<Chip
													class="text-[10px]"
													variant={levelVariantMap[event.level] ?? "default"}
												>
													{levelLabelMap[event.level] ?? event.level}
												</Chip>
											</td>
											<td class="px-3 py-2.5 text-left text-xs text-[color:var(--app-ink)] sm:text-sm">
												{event.code}
											</td>
											<td class="px-3 py-2.5 text-left text-xs text-[color:var(--app-ink)] sm:text-sm">
												{event.request_path ?? "-"}
											</td>
											<td class="px-3 py-2.5 text-left text-xs text-[color:var(--app-ink)] sm:text-sm">
												{event.request_id ?? "-"}
											</td>
											<td class="px-3 py-2.5 text-left text-xs text-[color:var(--app-ink)] sm:text-sm">
												<button
													class="app-focus border-0 bg-transparent p-0 text-left text-[color:var(--app-ink)]"
													type="button"
													onClick={() => setActiveEvent(event)}
												>
													{event.message || "-"}
												</button>
											</td>
										</tr>
									))
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

			{activeEvent ? (
				<Dialog
					open={Boolean(activeEvent)}
					onClose={() => setActiveEvent(null)}
				>
					<DialogContent class="max-w-2xl">
						<DialogHeader>
							<div>
								<DialogTitle>系统日志详情</DialogTitle>
								<DialogDescription>{activeEvent.code}</DialogDescription>
							</div>
							<Button
								size="sm"
								type="button"
								onClick={() => setActiveEvent(null)}
							>
								关闭
							</Button>
						</DialogHeader>
						<Card
							variant="compact"
							class="mt-3 text-xs text-[color:var(--app-ink)]"
						>
							<div class="grid gap-2">
								<div class="flex items-center justify-between gap-3">
									<span class="text-[color:var(--app-ink-muted)]">时间</span>
									<span>{formatDateTime(activeEvent.created_at)}</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-[color:var(--app-ink-muted)]">级别</span>
									<span>
										{levelLabelMap[activeEvent.level] ?? activeEvent.level}
									</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-[color:var(--app-ink-muted)]">路径</span>
									<span>{activeEvent.request_path ?? "-"}</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-[color:var(--app-ink-muted)]">
										Request ID
									</span>
									<span>{activeEvent.request_id ?? "-"}</span>
								</div>
								<div class="flex items-center justify-between gap-3">
									<span class="text-[color:var(--app-ink-muted)]">
										Session ID
									</span>
									<span>{activeEvent.session_id ?? "-"}</span>
								</div>
							</div>
						</Card>
						<Card
							variant="compact"
							class="mt-3 text-xs text-[color:var(--app-ink)]"
						>
							<div class="text-[11px] font-semibold uppercase tracking-widest text-[color:var(--app-ink-muted)]">
								消息
							</div>
							<pre class="mt-2 whitespace-pre-wrap break-words">
								{activeEvent.message}
							</pre>
						</Card>
						<Card
							variant="compact"
							class="mt-3 text-xs text-[color:var(--app-ink)]"
						>
							<div class="text-[11px] font-semibold uppercase tracking-widest text-[color:var(--app-ink-muted)]">
								上下文
							</div>
							<pre class="mt-2 h-56 overflow-auto whitespace-pre-wrap break-words">
								{formatContext(activeEvent.context_json)}
							</pre>
						</Card>
					</DialogContent>
				</Dialog>
			) : null}
		</div>
	);
};
