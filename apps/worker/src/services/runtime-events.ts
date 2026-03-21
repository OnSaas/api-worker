import type { D1Database } from "@cloudflare/workers-types";
import { nowIso } from "../utils/time";

export type RuntimeEventLevel = "info" | "warning" | "error";
export const RUNTIME_EVENT_LEVEL_VALUES: RuntimeEventLevel[] = [
	"info",
	"warning",
	"error",
];

export type RuntimeEventInput = {
	level: RuntimeEventLevel;
	code: string;
	message: string;
	requestId?: string | null;
	sessionId?: string | null;
	requestPath?: string | null;
	method?: string | null;
	channelId?: string | null;
	tokenId?: string | null;
	model?: string | null;
	context?: Record<string, unknown> | null;
	createdAt?: string | null;
};

export type RuntimeEventRecord = {
	id: string;
	level: RuntimeEventLevel;
	code: string;
	message: string;
	request_id: string | null;
	session_id: string | null;
	request_path: string | null;
	method: string | null;
	channel_id: string | null;
	token_id: string | null;
	model: string | null;
	context_json: string | null;
	created_at: string;
};

export type RuntimeEventListOptions = {
	from?: string | null;
	to?: string | null;
	levels?: string[];
	codes?: string[];
	requestId?: string | null;
	sessionId?: string | null;
	path?: string | null;
	limit?: number;
	offset?: number;
};

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_CONTEXT_LENGTH = 16_000;
const RUNTIME_EVENT_LEVELS_KEY = "runtime_event_levels";
const RUNTIME_EVENT_LEVEL_SNAPSHOT_TTL_MS = 1000;
let lastRuntimeEventPruneAt = 0;
let lastRuntimeEventPruneRetention: number | null = null;
let runtimeEventLevelSnapshot: {
	value: Set<RuntimeEventLevel>;
	expiresAt: number;
} | null = null;

function normalizeRuntimeEventLevel(level: string): RuntimeEventLevel | null {
	const normalized = level.trim().toLowerCase();
	return RUNTIME_EVENT_LEVEL_VALUES.includes(normalized as RuntimeEventLevel)
		? (normalized as RuntimeEventLevel)
		: null;
}

export function normalizeRuntimeEventLevels(
	levels: string[],
): RuntimeEventLevel[] {
	const result: RuntimeEventLevel[] = [];
	const seen = new Set<RuntimeEventLevel>();
	for (const item of levels) {
		const level = normalizeRuntimeEventLevel(item);
		if (!level || seen.has(level)) {
			continue;
		}
		seen.add(level);
		result.push(level);
	}
	return result;
}

function parseRuntimeEventLevelsSetting(
	value: string | null,
): RuntimeEventLevel[] {
	if (value === null || value === undefined) {
		return [...RUNTIME_EVENT_LEVEL_VALUES];
	}
	const raw = value.trim();
	if (!raw) {
		return [];
	}
	return normalizeRuntimeEventLevels(raw.split(","));
}

async function readAllowedRuntimeEventLevels(
	db: D1Database,
): Promise<Set<RuntimeEventLevel>> {
	const now = Date.now();
	if (runtimeEventLevelSnapshot && runtimeEventLevelSnapshot.expiresAt > now) {
		return runtimeEventLevelSnapshot.value;
	}
	const row = await db
		.prepare("SELECT value FROM settings WHERE key = ?")
		.bind(RUNTIME_EVENT_LEVELS_KEY)
		.first<{ value?: string }>();
	const levels = parseRuntimeEventLevelsSetting(
		typeof row?.value === "string" ? row.value : null,
	);
	const value = new Set<RuntimeEventLevel>(levels);
	runtimeEventLevelSnapshot = {
		value,
		expiresAt: now + RUNTIME_EVENT_LEVEL_SNAPSHOT_TTL_MS,
	};
	return value;
}

export function resetRuntimeEventLevelSnapshot(): void {
	runtimeEventLevelSnapshot = null;
}

function serializeContext(
	context: Record<string, unknown> | null | undefined,
): string | null {
	if (!context) {
		return null;
	}
	try {
		const raw = JSON.stringify(context);
		if (!raw) {
			return null;
		}
		if (raw.length <= MAX_CONTEXT_LENGTH) {
			return raw;
		}
		return `${raw.slice(0, MAX_CONTEXT_LENGTH - 1)}…`;
	} catch {
		return null;
	}
}

function normalizeLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || Number.isNaN(limit)) {
		return 100;
	}
	return Math.min(Math.max(Math.floor(limit), 1), 500);
}

function normalizeOffset(offset: number | undefined): number {
	if (typeof offset !== "number" || Number.isNaN(offset)) {
		return 0;
	}
	return Math.max(0, Math.floor(offset));
}

export async function recordRuntimeEvent(
	db: D1Database,
	input: RuntimeEventInput,
): Promise<void> {
	const allowedLevels = await readAllowedRuntimeEventLevels(db);
	if (!allowedLevels.has(input.level)) {
		return;
	}
	const id = crypto.randomUUID();
	const createdAt = input.createdAt ?? nowIso();
	const contextJson = serializeContext(input.context ?? null);
	await db
		.prepare(
			"INSERT INTO runtime_events (id, level, code, message, request_id, session_id, request_path, method, channel_id, token_id, model, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			id,
			input.level,
			input.code,
			input.message,
			input.requestId ?? null,
			input.sessionId ?? null,
			input.requestPath ?? null,
			input.method ?? null,
			input.channelId ?? null,
			input.tokenId ?? null,
			input.model ?? null,
			contextJson,
			createdAt,
		)
		.run();
}

export async function listRuntimeEvents(
	db: D1Database,
	options: RuntimeEventListOptions,
): Promise<{
	events: RuntimeEventRecord[];
	total: number;
	limit: number;
	offset: number;
}> {
	const filters: string[] = [];
	const params: Array<string | number> = [];
	const from = options.from?.trim();
	const to = options.to?.trim();
	const requestId = options.requestId?.trim();
	const sessionId = options.sessionId?.trim();
	const path = options.path?.trim();
	const levels =
		options.levels?.map((item) => item.trim()).filter(Boolean) ?? [];
	const codes = options.codes?.map((item) => item.trim()).filter(Boolean) ?? [];
	const limit = normalizeLimit(options.limit);
	const offset = normalizeOffset(options.offset);

	if (from) {
		filters.push("created_at >= ?");
		params.push(from);
	}
	if (to) {
		filters.push("created_at <= ?");
		params.push(to);
	}
	if (requestId) {
		filters.push("request_id = ?");
		params.push(requestId);
	}
	if (sessionId) {
		filters.push("session_id = ?");
		params.push(sessionId);
	}
	if (path) {
		filters.push("request_path LIKE ?");
		params.push(`%${path}%`);
	}
	if (levels.length > 0) {
		const placeholders = levels.map(() => "?").join(", ");
		filters.push(`level IN (${placeholders})`);
		params.push(...levels);
	}
	if (codes.length > 0) {
		const placeholders = codes.map(() => "?").join(", ");
		filters.push(`code IN (${placeholders})`);
		params.push(...codes);
	}

	const whereSql = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
	const countRow = await db
		.prepare(`SELECT COUNT(*) AS total FROM runtime_events ${whereSql}`)
		.bind(...params)
		.first<{ total: number }>();
	const total = Number(countRow?.total ?? 0);
	const result = await db
		.prepare(
			`SELECT * FROM runtime_events ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
		)
		.bind(...params, limit, offset)
		.all<RuntimeEventRecord>();
	return {
		events: (result.results ?? []) as RuntimeEventRecord[],
		total,
		limit,
		offset,
	};
}

export async function pruneRuntimeEvents(
	db: D1Database,
	retentionDays: number,
): Promise<void> {
	const now = Date.now();
	if (
		lastRuntimeEventPruneRetention === retentionDays &&
		now - lastRuntimeEventPruneAt < PRUNE_INTERVAL_MS
	) {
		return;
	}
	lastRuntimeEventPruneRetention = retentionDays;
	lastRuntimeEventPruneAt = now;
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - retentionDays);
	await db
		.prepare("DELETE FROM runtime_events WHERE created_at < ?")
		.bind(cutoff.toISOString())
		.run();
}
