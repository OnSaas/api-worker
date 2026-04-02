import type { D1Database } from "@cloudflare/workers-types";
import {
	insertChannel,
	type ChannelInsertInput,
	updateChannel,
} from "./channel-repo";
import { replaceCallTokensForChannel } from "./channel-call-token-repo";
import { sha256Hex } from "../utils/crypto";
import { safeJsonParse } from "../utils/json";
import { nowIso } from "../utils/time";

const BACKUP_SCHEMA_VERSION = 1;

export type BackupSettingRecord = {
	key: string;
	value: string;
	updated_at: string | null;
};

export type BackupCallTokenRecord = {
	id: string;
	name: string;
	api_key: string;
	models_json: string | null;
	created_at: string | null;
	updated_at: string | null;
};

export type BackupSiteRecord = {
	id: string;
	name: string;
	base_url: string;
	api_key: string;
	weight: number;
	status: string;
	rate_limit: number;
	models_json: string;
	type: number;
	group_name: string | null;
	priority: number;
	metadata_json: string | null;
	system_token: string | null;
	system_userid: string | null;
	checkin_enabled: number;
	checkin_url: string | null;
	last_checkin_date: string | null;
	last_checkin_status: string | null;
	last_checkin_message: string | null;
	last_checkin_at: string | null;
	created_at: string | null;
	updated_at: string | null;
	call_tokens: BackupCallTokenRecord[];
};

export type BackupTokenRecord = {
	id: string;
	name: string;
	key_hash: string;
	key_prefix: string;
	token_plain: string | null;
	quota_total: number | null;
	quota_used: number;
	status: string;
	allowed_channels: string[] | null;
	expires_at: string | null;
	created_at: string | null;
	updated_at: string | null;
};

export type BackupMeta = {
	schema_version: number;
	exported_at: string;
	instance_id: string;
	revision: number;
	includes_sensitive_data: boolean;
	hash: string;
};

export type BackupPayload = {
	meta: BackupMeta;
	settings: BackupSettingRecord[];
	sites: BackupSiteRecord[];
	tokens: BackupTokenRecord[];
};

type ImportMode = "merge" | "replace";

export type BackupImportSummary = {
	settings: {
		created: number;
		updated: number;
		deleted: number;
	};
	sites: {
		created: number;
		updated: number;
		deleted: number;
		call_tokens_replaced: number;
	};
	tokens: {
		created: number;
		updated: number;
		deleted: number;
	};
};

export type BackupImportResult = {
	summary: BackupImportSummary;
	mode: ImportMode;
	dry_run: boolean;
};

type BackupTokenRow = {
	id: string;
	name: string;
	key_hash: string;
	key_prefix: string;
	token_plain: string | null;
	quota_total: number | null;
	quota_used: number | null;
	status: string;
	allowed_channels: string | null;
	expires_at: string | null;
	created_at: string | null;
	updated_at: string | null;
};

type ChannelRow = {
	id: string;
	name: string;
	base_url: string;
	api_key: string;
	weight: number | null;
	status: string;
	rate_limit: number | null;
	models_json: string | null;
	type: number | null;
	group_name: string | null;
	priority: number | null;
	metadata_json: string | null;
	system_token: string | null;
	system_userid: string | null;
	checkin_enabled: number | boolean | null;
	checkin_url: string | null;
	last_checkin_date: string | null;
	last_checkin_status: string | null;
	last_checkin_message: string | null;
	last_checkin_at: string | null;
	created_at: string | null;
	updated_at: string | null;
};

type CallTokenRow = {
	id: string;
	channel_id: string;
	name: string;
	api_key: string;
	models_json: string | null;
	created_at: string | null;
	updated_at: string | null;
};

const toInt = (value: unknown, fallback: number) => {
	const parsed = Number(value);
	if (Number.isNaN(parsed)) {
		return fallback;
	}
	return Math.floor(parsed);
};

const normalizeIsoOrNull = (value: unknown): string | null => {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	const parsed = Date.parse(trimmed);
	if (Number.isNaN(parsed)) {
		return null;
	}
	return new Date(parsed).toISOString();
};

const normalizeAllowedChannels = (value: unknown): string[] | null => {
	if (!Array.isArray(value)) {
		return null;
	}
	const normalized = value
		.map((item) => String(item ?? "").trim())
		.filter((item) => item.length > 0);
	if (normalized.length === 0) {
		return null;
	}
	return Array.from(new Set(normalized));
};

const parseAllowedChannels = (value: string | null): string[] | null => {
	const parsed = safeJsonParse<unknown>(value, null);
	return normalizeAllowedChannels(parsed);
};

const normalizeSettingRecords = (input: unknown): BackupSettingRecord[] => {
	if (!Array.isArray(input)) {
		return [];
	}
	const map = new Map<string, BackupSettingRecord>();
	for (const item of input) {
		const row = item as Record<string, unknown>;
		const key = String(row.key ?? "").trim();
		if (!key) {
			continue;
		}
		const value = String(row.value ?? "");
		map.set(key, {
			key,
			value,
			updated_at: normalizeIsoOrNull(row.updated_at),
		});
	}
	return Array.from(map.values()).sort((left, right) =>
		left.key.localeCompare(right.key),
	);
};

const normalizeCallTokenRecords = (
	input: unknown,
	channelId: string,
): BackupCallTokenRecord[] => {
	if (!Array.isArray(input)) {
		return [];
	}
	const result: BackupCallTokenRecord[] = [];
	for (const item of input) {
		const row = item as Record<string, unknown>;
		const apiKey = String(row.api_key ?? "").trim();
		if (!apiKey) {
			continue;
		}
		const id = String(row.id ?? "").trim() || `ct_${crypto.randomUUID()}`;
		result.push({
			id,
			name: String(row.name ?? "").trim() || "调用令牌",
			api_key: apiKey,
			models_json:
				typeof row.models_json === "string" && row.models_json.trim().length > 0
					? row.models_json
					: null,
			created_at: normalizeIsoOrNull(row.created_at),
			updated_at: normalizeIsoOrNull(row.updated_at),
		});
	}
	return result.sort((left, right) => left.id.localeCompare(right.id));
};

const normalizeSiteRecords = (input: unknown): BackupSiteRecord[] => {
	if (!Array.isArray(input)) {
		return [];
	}
	const result: BackupSiteRecord[] = [];
	for (const item of input) {
		const row = item as Record<string, unknown>;
		const id = String(row.id ?? "").trim();
		const name = String(row.name ?? "").trim();
		const baseUrl = String(row.base_url ?? "").trim();
		const apiKey = String(row.api_key ?? "").trim();
		if (!id || !name || !baseUrl || !apiKey) {
			continue;
		}
		const callTokens = normalizeCallTokenRecords(row.call_tokens, id);
		result.push({
			id,
			name,
			base_url: baseUrl,
			api_key: apiKey,
			weight: Math.max(1, toInt(row.weight, 1)),
			status: String(row.status ?? "active").trim() || "active",
			rate_limit: Math.max(0, toInt(row.rate_limit, 0)),
			models_json:
				typeof row.models_json === "string" && row.models_json.trim().length > 0
					? row.models_json
					: "[]",
			type: Math.max(1, toInt(row.type, 1)),
			group_name:
				typeof row.group_name === "string" && row.group_name.trim().length > 0
					? row.group_name
					: null,
			priority: Math.max(0, toInt(row.priority, 0)),
			metadata_json:
				typeof row.metadata_json === "string" &&
				row.metadata_json.trim().length > 0
					? row.metadata_json
					: null,
			system_token:
				typeof row.system_token === "string" &&
				row.system_token.trim().length > 0
					? row.system_token
					: null,
			system_userid:
				typeof row.system_userid === "string" &&
				row.system_userid.trim().length > 0
					? row.system_userid
					: null,
			checkin_enabled:
				typeof row.checkin_enabled === "boolean"
					? row.checkin_enabled
						? 1
						: 0
					: Math.max(0, Math.min(1, toInt(row.checkin_enabled, 0))),
			checkin_url:
				typeof row.checkin_url === "string" && row.checkin_url.trim().length > 0
					? row.checkin_url
					: null,
			last_checkin_date:
				typeof row.last_checkin_date === "string" &&
				row.last_checkin_date.trim().length > 0
					? row.last_checkin_date.trim()
					: null,
			last_checkin_status:
				typeof row.last_checkin_status === "string" &&
				row.last_checkin_status.trim().length > 0
					? row.last_checkin_status
					: null,
			last_checkin_message:
				typeof row.last_checkin_message === "string" &&
				row.last_checkin_message.trim().length > 0
					? row.last_checkin_message
					: null,
			last_checkin_at: normalizeIsoOrNull(row.last_checkin_at),
			created_at: normalizeIsoOrNull(row.created_at),
			updated_at: normalizeIsoOrNull(row.updated_at),
			call_tokens: callTokens,
		});
	}
	return result.sort((left, right) => left.id.localeCompare(right.id));
};

const normalizeTokenRecords = async (
	input: unknown,
): Promise<BackupTokenRecord[]> => {
	if (!Array.isArray(input)) {
		return [];
	}
	const result: BackupTokenRecord[] = [];
	for (const item of input) {
		const row = item as Record<string, unknown>;
		const id = String(row.id ?? "").trim();
		const name = String(row.name ?? "").trim();
		if (!id || !name) {
			continue;
		}
		const tokenPlain =
			typeof row.token_plain === "string" && row.token_plain.trim().length > 0
				? row.token_plain
				: null;
		let keyHash = String(row.key_hash ?? "").trim();
		if (!keyHash && tokenPlain) {
			keyHash = await sha256Hex(tokenPlain);
		}
		if (!keyHash) {
			continue;
		}
		const keyPrefix =
			String(row.key_prefix ?? "").trim() ||
			(tokenPlain ? tokenPlain.slice(0, 8) : keyHash.slice(0, 8));
		result.push({
			id,
			name,
			key_hash: keyHash,
			key_prefix: keyPrefix,
			token_plain: tokenPlain,
			quota_total:
				row.quota_total === null || row.quota_total === undefined
					? null
					: Number(row.quota_total),
			quota_used: Math.max(0, toInt(row.quota_used, 0)),
			status: String(row.status ?? "active").trim() || "active",
			allowed_channels: normalizeAllowedChannels(row.allowed_channels),
			expires_at: normalizeIsoOrNull(row.expires_at),
			created_at: normalizeIsoOrNull(row.created_at),
			updated_at: normalizeIsoOrNull(row.updated_at),
		});
	}
	return result.sort((left, right) => left.id.localeCompare(right.id));
};

const normalizePayloadMeta = async (
	payload: Record<string, unknown>,
): Promise<{
	settings: BackupSettingRecord[];
	sites: BackupSiteRecord[];
	tokens: BackupTokenRecord[];
	hash: string;
	meta: Record<string, unknown>;
}> => {
	const settings = normalizeSettingRecords(payload.settings);
	const sites = normalizeSiteRecords(payload.sites);
	const tokens = await normalizeTokenRecords(payload.tokens);
	const hash = await computeBackupHash({
		settings,
		sites,
		tokens,
	});
	return {
		settings,
		sites,
		tokens,
		hash,
		meta:
			typeof payload.meta === "object" && payload.meta !== null
				? (payload.meta as Record<string, unknown>)
				: {},
	};
};

const timestampMs = (value: string | null | undefined): number => {
	if (!value) {
		return 0;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
};

const computeRevision = (payload: {
	settings: BackupSettingRecord[];
	sites: BackupSiteRecord[];
	tokens: BackupTokenRecord[];
}): number => {
	let revision = 0;
	for (const row of payload.settings) {
		revision = Math.max(revision, timestampMs(row.updated_at));
	}
	for (const row of payload.sites) {
		revision = Math.max(
			revision,
			timestampMs(row.created_at),
			timestampMs(row.updated_at),
			timestampMs(row.last_checkin_at),
		);
		for (const token of row.call_tokens) {
			revision = Math.max(
				revision,
				timestampMs(token.created_at),
				timestampMs(token.updated_at),
			);
		}
	}
	for (const row of payload.tokens) {
		revision = Math.max(
			revision,
			timestampMs(row.created_at),
			timestampMs(row.updated_at),
			timestampMs(row.expires_at),
		);
	}
	return revision > 0 ? revision : Date.now();
};

export async function computeBackupHash(content: {
	settings: BackupSettingRecord[];
	sites: BackupSiteRecord[];
	tokens: BackupTokenRecord[];
}): Promise<string> {
	return sha256Hex(JSON.stringify(content));
}

export async function createBackupPayload(
	db: D1Database,
	instanceId: string,
): Promise<BackupPayload> {
	const settingsResult = await db
		.prepare("SELECT key, value, updated_at FROM settings ORDER BY key ASC")
		.all<BackupSettingRecord>();
	const settings = (settingsResult.results ?? [])
		.map((row) => ({
			key: String(row.key),
			value: String(row.value ?? ""),
			updated_at: normalizeIsoOrNull(row.updated_at),
		}))
		.sort((left, right) => left.key.localeCompare(right.key));

	const channelsResult = await db
		.prepare("SELECT * FROM channels ORDER BY id ASC")
		.all<ChannelRow>();
	const channelRows = channelsResult.results ?? [];
	const channelIds = channelRows.map((row) => row.id);
	let callTokenRows: CallTokenRow[] = [];
	if (channelIds.length > 0) {
		const placeholders = channelIds.map(() => "?").join(", ");
		const callTokenResult = await db
			.prepare(
				`SELECT * FROM channel_call_tokens WHERE channel_id IN (${placeholders}) ORDER BY channel_id ASC, id ASC`,
			)
			.bind(...channelIds)
			.all<CallTokenRow>();
		callTokenRows = callTokenResult.results ?? [];
	}
	const callTokenMap = new Map<string, BackupCallTokenRecord[]>();
	for (const row of callTokenRows) {
		const list = callTokenMap.get(row.channel_id) ?? [];
		list.push({
			id: row.id,
			name: row.name,
			api_key: row.api_key,
			models_json: row.models_json ?? null,
			created_at: normalizeIsoOrNull(row.created_at),
			updated_at: normalizeIsoOrNull(row.updated_at),
		});
		callTokenMap.set(row.channel_id, list);
	}
	const sites: BackupSiteRecord[] = channelRows.map((row) => ({
		id: row.id,
		name: row.name,
		base_url: row.base_url,
		api_key: row.api_key,
		weight: Math.max(1, toInt(row.weight, 1)),
		status: row.status,
		rate_limit: Math.max(0, toInt(row.rate_limit, 0)),
		models_json: row.models_json ?? "[]",
		type: Math.max(1, toInt(row.type, 1)),
		group_name: row.group_name ?? null,
		priority: Math.max(0, toInt(row.priority, 0)),
		metadata_json: row.metadata_json ?? null,
		system_token: row.system_token ?? null,
		system_userid: row.system_userid ?? null,
		checkin_enabled:
			typeof row.checkin_enabled === "boolean"
				? row.checkin_enabled
					? 1
					: 0
				: Math.max(0, Math.min(1, toInt(row.checkin_enabled, 0))),
		checkin_url: row.checkin_url ?? null,
		last_checkin_date: row.last_checkin_date ?? null,
		last_checkin_status: row.last_checkin_status ?? null,
		last_checkin_message: row.last_checkin_message ?? null,
		last_checkin_at: normalizeIsoOrNull(row.last_checkin_at),
		created_at: normalizeIsoOrNull(row.created_at),
		updated_at: normalizeIsoOrNull(row.updated_at),
		call_tokens: (callTokenMap.get(row.id) ?? []).sort((left, right) =>
			left.id.localeCompare(right.id),
		),
	}));

	const tokensResult = await db
		.prepare(
			"SELECT id, name, key_hash, key_prefix, token_plain, quota_total, quota_used, status, allowed_channels, expires_at, created_at, updated_at FROM tokens ORDER BY id ASC",
		)
		.all<BackupTokenRow>();
	const tokens: BackupTokenRecord[] = (tokensResult.results ?? []).map(
		(row) => ({
			id: row.id,
			name: row.name,
			key_hash: row.key_hash,
			key_prefix: row.key_prefix,
			token_plain: row.token_plain ?? null,
			quota_total:
				row.quota_total === null || row.quota_total === undefined
					? null
					: Number(row.quota_total),
			quota_used: Math.max(0, toInt(row.quota_used, 0)),
			status: row.status,
			allowed_channels: parseAllowedChannels(row.allowed_channels ?? null),
			expires_at: normalizeIsoOrNull(row.expires_at),
			created_at: normalizeIsoOrNull(row.created_at),
			updated_at: normalizeIsoOrNull(row.updated_at),
		}),
	);

	const hash = await computeBackupHash({ settings, sites, tokens });
	return {
		meta: {
			schema_version: BACKUP_SCHEMA_VERSION,
			exported_at: nowIso(),
			instance_id: instanceId,
			revision: computeRevision({ settings, sites, tokens }),
			includes_sensitive_data: true,
			hash,
		},
		settings,
		sites,
		tokens,
	};
}

export async function parseBackupPayload(
	input: unknown,
): Promise<{ payload: BackupPayload; warning: string | null } | null> {
	if (!input || typeof input !== "object") {
		return null;
	}
	const normalized = await normalizePayloadMeta(
		input as Record<string, unknown>,
	);
	const expectedHash = String(normalized.meta.hash ?? "").trim();
	let warning: string | null = null;
	if (expectedHash && expectedHash !== normalized.hash) {
		warning = "backup_hash_mismatch";
	}
	const revisionRaw = Number(normalized.meta.revision);
	const revision = Number.isNaN(revisionRaw)
		? computeRevision(normalized)
		: Math.floor(revisionRaw);
	const schemaVersionRaw = Number(normalized.meta.schema_version);
	const schemaVersion = Number.isNaN(schemaVersionRaw)
		? BACKUP_SCHEMA_VERSION
		: Math.floor(schemaVersionRaw);
	const payload: BackupPayload = {
		meta: {
			schema_version: schemaVersion,
			exported_at: normalizeIsoOrNull(normalized.meta.exported_at) ?? nowIso(),
			instance_id:
				String(normalized.meta.instance_id ?? "").trim() || crypto.randomUUID(),
			revision: revision > 0 ? revision : Date.now(),
			includes_sensitive_data: true,
			hash: normalized.hash,
		},
		settings: normalized.settings,
		sites: normalized.sites,
		tokens: normalized.tokens,
	};
	return { payload, warning };
}

const buildImportSummary = (): BackupImportSummary => ({
	settings: { created: 0, updated: 0, deleted: 0 },
	sites: { created: 0, updated: 0, deleted: 0, call_tokens_replaced: 0 },
	tokens: { created: 0, updated: 0, deleted: 0 },
});

export async function importBackupPayload(
	db: D1Database,
	backup: BackupPayload,
	options: {
		mode: ImportMode;
		dryRun?: boolean;
	},
): Promise<BackupImportResult> {
	const dryRun = Boolean(options.dryRun);
	const mode: ImportMode = options.mode === "replace" ? "replace" : "merge";
	const summary = buildImportSummary();
	const now = nowIso();
	const existingSettingsResult = await db
		.prepare("SELECT key FROM settings")
		.all<{ key: string }>();
	const existingSettingSet = new Set(
		(existingSettingsResult.results ?? []).map((item) => item.key),
	);
	for (const setting of backup.settings) {
		if (existingSettingSet.has(setting.key)) {
			summary.settings.updated += 1;
		} else {
			summary.settings.created += 1;
		}
	}
	if (mode === "replace") {
		summary.settings.deleted = existingSettingSet.size;
	}

	const existingChannelsResult = await db
		.prepare("SELECT id FROM channels")
		.all<{ id: string }>();
	const existingChannelSet = new Set(
		(existingChannelsResult.results ?? []).map((item) => item.id),
	);
	for (const site of backup.sites) {
		if (existingChannelSet.has(site.id)) {
			summary.sites.updated += 1;
		} else {
			summary.sites.created += 1;
		}
		summary.sites.call_tokens_replaced += site.call_tokens.length;
	}
	if (mode === "replace") {
		summary.sites.deleted = existingChannelSet.size;
	}

	const existingTokensResult = await db
		.prepare("SELECT id FROM tokens")
		.all<{ id: string }>();
	const existingTokenSet = new Set(
		(existingTokensResult.results ?? []).map((item) => item.id),
	);
	for (const token of backup.tokens) {
		if (existingTokenSet.has(token.id)) {
			summary.tokens.updated += 1;
		} else {
			summary.tokens.created += 1;
		}
	}
	if (mode === "replace") {
		summary.tokens.deleted = existingTokenSet.size;
	}

	if (dryRun) {
		return {
			summary,
			mode,
			dry_run: true,
		};
	}

	if (mode === "replace") {
		await db.prepare("DELETE FROM channel_call_tokens").run();
		await db.prepare("DELETE FROM channels").run();
		await db.prepare("DELETE FROM tokens").run();
		await db.prepare("DELETE FROM settings").run();
	}

	for (const setting of backup.settings) {
		const updatedAt = setting.updated_at ?? now;
		await db
			.prepare(
				"INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
			)
			.bind(setting.key, setting.value, updatedAt)
			.run();
	}

	for (const site of backup.sites) {
		const insertInput: ChannelInsertInput = {
			id: site.id,
			name: site.name,
			base_url: site.base_url,
			api_key: site.api_key,
			weight: site.weight,
			status: site.status,
			rate_limit: site.rate_limit,
			models_json: site.models_json,
			type: site.type,
			group_name: site.group_name,
			priority: site.priority,
			metadata_json: site.metadata_json,
			system_token: site.system_token,
			system_userid: site.system_userid,
			checkin_enabled: site.checkin_enabled,
			checkin_url: site.checkin_url,
			last_checkin_date: site.last_checkin_date,
			last_checkin_status: site.last_checkin_status,
			last_checkin_message: site.last_checkin_message,
			last_checkin_at: site.last_checkin_at,
			created_at: site.created_at ?? now,
			updated_at: site.updated_at ?? now,
		};
		if (existingChannelSet.has(site.id) && mode !== "replace") {
			await updateChannel(db, site.id, {
				name: insertInput.name,
				base_url: insertInput.base_url,
				api_key: insertInput.api_key,
				weight: insertInput.weight,
				status: insertInput.status,
				rate_limit: insertInput.rate_limit,
				models_json: insertInput.models_json,
				type: insertInput.type,
				group_name: insertInput.group_name,
				priority: insertInput.priority,
				metadata_json: insertInput.metadata_json,
				system_token: insertInput.system_token ?? null,
				system_userid: insertInput.system_userid ?? null,
				checkin_enabled: insertInput.checkin_enabled ?? 0,
				checkin_url: insertInput.checkin_url ?? null,
				last_checkin_date: insertInput.last_checkin_date ?? null,
				last_checkin_status: insertInput.last_checkin_status ?? null,
				last_checkin_message: insertInput.last_checkin_message ?? null,
				last_checkin_at: insertInput.last_checkin_at ?? null,
				updated_at: insertInput.updated_at,
			});
		} else {
			await insertChannel(db, insertInput);
		}
		await replaceCallTokensForChannel(
			db,
			site.id,
			site.call_tokens.map((token) => ({
				id: token.id || `ct_${crypto.randomUUID()}`,
				channel_id: site.id,
				name: token.name,
				api_key: token.api_key,
				created_at: token.created_at ?? now,
				updated_at: token.updated_at ?? now,
			})),
		);
	}

	for (const token of backup.tokens) {
		const allowedChannelsJson = token.allowed_channels
			? JSON.stringify(token.allowed_channels)
			: null;
		const quotaTotal =
			token.quota_total === null || token.quota_total === undefined
				? null
				: Number(token.quota_total);
		const quotaUsed = Math.max(0, toInt(token.quota_used, 0));
		const expiresAt = token.expires_at ?? null;
		const createdAt = token.created_at ?? now;
		const updatedAt = token.updated_at ?? now;
		if (existingTokenSet.has(token.id) && mode !== "replace") {
			await db
				.prepare(
					"UPDATE tokens SET name = ?, key_hash = ?, key_prefix = ?, token_plain = ?, quota_total = ?, quota_used = ?, status = ?, allowed_channels = ?, expires_at = ?, created_at = ?, updated_at = ? WHERE id = ?",
				)
				.bind(
					token.name,
					token.key_hash,
					token.key_prefix,
					token.token_plain,
					Number.isNaN(quotaTotal) ? null : quotaTotal,
					quotaUsed,
					token.status,
					allowedChannelsJson,
					expiresAt,
					createdAt,
					updatedAt,
					token.id,
				)
				.run();
		} else {
			await db
				.prepare(
					"INSERT INTO tokens (id, name, key_hash, key_prefix, token_plain, quota_total, quota_used, status, allowed_channels, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(
					token.id,
					token.name,
					token.key_hash,
					token.key_prefix,
					token.token_plain,
					Number.isNaN(quotaTotal) ? null : quotaTotal,
					quotaUsed,
					token.status,
					allowedChannelsJson,
					expiresAt,
					createdAt,
					updatedAt,
				)
				.run();
		}
	}

	return {
		summary,
		mode,
		dry_run: false,
	};
}
