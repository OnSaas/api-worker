import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
	executeBackupSync,
	resolveBackupSyncError,
} from "../services/backup-sync";
import {
	createBackupPayload,
	importBackupPayload,
	parseBackupPayload,
} from "../services/backup";
import { getCheckinSchedulerStub } from "../services/checkin-scheduler";
import { getBackupSettings, setBackupSettings } from "../services/settings";
import { jsonError } from "../utils/http";

const backup = new Hono<AppEnv>();

backup.get("/export", async (c) => {
	const settings = await getBackupSettings(c.env.DB);
	const payload = await createBackupPayload(c.env.DB, settings.instance_id);
	return c.json(payload);
});

backup.post("/import", async (c) => {
	const body = (await c.req.json().catch(() => null)) as {
		payload?: unknown;
		mode?: "merge" | "replace";
		dry_run?: boolean;
	} | null;
	if (!body) {
		return jsonError(
			c,
			400,
			"backup_payload_required",
			"backup_payload_required",
		);
	}
	const hasInlinePayload =
		typeof body === "object" &&
		body !== null &&
		(Object.hasOwn(body, "meta") ||
			Object.hasOwn(body, "settings") ||
			Object.hasOwn(body, "sites") ||
			Object.hasOwn(body, "tokens"));
	const rawPayload = body.payload ?? (hasInlinePayload ? body : null);
	if (!rawPayload) {
		return jsonError(
			c,
			400,
			"backup_payload_required",
			"backup_payload_required",
		);
	}
	const parsed = await parseBackupPayload(rawPayload);
	if (!parsed) {
		return jsonError(
			c,
			400,
			"invalid_backup_payload",
			"invalid_backup_payload",
		);
	}
	const result = await importBackupPayload(c.env.DB, parsed.payload, {
		mode: body.mode === "replace" ? "replace" : "merge",
		dryRun: Boolean(body.dry_run),
	});
	if (!body.dry_run) {
		const scheduler = getCheckinSchedulerStub(c.env.CHECKIN_SCHEDULER);
		await scheduler.fetch("https://checkin-scheduler/reschedule", {
			method: "POST",
		});
	}
	return c.json({
		...result,
		warning: parsed.warning,
	});
});

backup.get("/sync-config", async (c) => {
	const settings = await getBackupSettings(c.env.DB);
	return c.json(settings);
});

backup.put("/sync-config", async (c) => {
	const body = (await c.req.json().catch(() => null)) as {
		enabled?: boolean;
		schedule_time?: string;
		sync_mode?: "push" | "pull" | "two_way";
		conflict_policy?: "local_wins" | "remote_wins";
		import_mode?: "merge" | "replace";
		webdav_url?: string;
		webdav_username?: string;
		webdav_password?: string;
		webdav_path?: string;
		keep_versions?: number;
	} | null;
	if (!body) {
		return jsonError(
			c,
			400,
			"backup_config_required",
			"backup_config_required",
		);
	}
	await setBackupSettings(c.env.DB, {
		enabled: body.enabled,
		schedule_time: body.schedule_time,
		sync_mode: body.sync_mode,
		conflict_policy: body.conflict_policy,
		import_mode: body.import_mode,
		webdav_url: body.webdav_url,
		webdav_username: body.webdav_username,
		webdav_password: body.webdav_password,
		webdav_path: body.webdav_path,
		keep_versions: body.keep_versions,
	});
	const scheduler = getCheckinSchedulerStub(c.env.CHECKIN_SCHEDULER);
	await scheduler.fetch("https://checkin-scheduler/reschedule", {
		method: "POST",
	});
	const settings = await getBackupSettings(c.env.DB);
	return c.json({
		ok: true,
		settings,
	});
});

backup.post("/sync-now", async (c) => {
	const body = (await c.req.json().catch(() => null)) as {
		action?: "push" | "pull";
		mode?: "push" | "pull" | "two_way";
	} | null;
	const overrideMode =
		body?.action === "push" || body?.action === "pull"
			? body.action
			: body?.mode;
	try {
		const result = await executeBackupSync(c.env.DB, {
			reason: "manual",
			overrideMode,
		});
		return c.json(result);
	} catch (error) {
		const errorInfo = resolveBackupSyncError(error);
		return jsonError(
			c,
			errorInfo.status as 400 | 401 | 403 | 404 | 409 | 500 | 502,
			errorInfo.userMessage,
			errorInfo.code,
		);
	}
});

backup.post("/validate", async (c) => {
	const body = (await c.req.json().catch(() => null)) as {
		payload?: unknown;
	} | null;
	const parsed = await parseBackupPayload(body?.payload ?? null);
	if (!parsed) {
		return jsonError(
			c,
			400,
			"invalid_backup_payload",
			"invalid_backup_payload",
		);
	}
	return c.json({
		ok: true,
		meta: parsed.payload.meta,
		warning: parsed.warning,
		stats: {
			settings: parsed.payload.settings.length,
			sites: parsed.payload.sites.length,
			tokens: parsed.payload.tokens.length,
		},
	});
});

export default backup;
