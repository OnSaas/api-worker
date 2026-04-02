import type { D1Database } from "@cloudflare/workers-types";
import {
	createBackupPayload,
	importBackupPayload,
	parseBackupPayload,
	type BackupMeta,
	type BackupPayload,
} from "./backup";
import {
	getBackupSettings,
	setBackupSettings,
	type BackupConflictPolicy,
	type BackupSyncMode,
} from "./settings";
import {
	deleteWebdavFile,
	readWebdavJson,
	writeWebdavJson,
	type WebdavConfig,
} from "./webdav";
import { nowIso } from "../utils/time";

type SyncReason = "manual" | "schedule";

export type SyncAction = "push" | "pull" | "noop";

export type BackupSyncResult = {
	ok: boolean;
	mode: BackupSyncMode;
	action: SyncAction;
	synced_at: string;
	local_revision: number;
	remote_revision: number | null;
	message: string;
};

export type BackupSyncErrorInfo = {
	code: string;
	status: number;
	rawMessage: string;
	userMessage: string;
};

type BackupHistoryIndex = {
	items: string[];
};

const HISTORY_INDEX_FILE = "history/index.json";
const LATEST_FILE = "latest.json";

const getErrorMessage = (error: unknown): string => {
	if (error instanceof Error) {
		return error.message || "backup_sync_failed";
	}
	return String(error ?? "backup_sync_failed");
};

const parseErrorStatus = (
	rawMessage: string,
	prefix: string,
): number | null => {
	if (!rawMessage.startsWith(prefix)) {
		return null;
	}
	const status = Number(rawMessage.slice(prefix.length));
	if (Number.isNaN(status)) {
		return null;
	}
	return status;
};

const normalizeHttpStatusForSync = (status: number): number => {
	if (status >= 500) {
		return 502;
	}
	if (status === 404 || status === 409) {
		return status;
	}
	// 401/403 来自 WebDAV 远端鉴权，与当前后台登录态无关，统一回传 400 避免前端误触发退出登录。
	return 400;
};

const buildWebdavStatusMessage = (status: number): string => {
	if (status === 401) {
		return "鉴权失败，请检查 WebDAV 用户名/密码是否正确。";
	}
	if (status === 403) {
		return "权限不足，请确认账号有读写目标目录权限。";
	}
	if (status === 404) {
		return "目标目录或文件不存在，请检查 WebDAV 地址和目录配置。";
	}
	if (status === 405) {
		return "服务端不支持当前 WebDAV 方法（如 MKCOL/PUT）。";
	}
	if (status === 409) {
		return "目录冲突，请检查 WebDAV 目录层级是否可创建。";
	}
	if (status >= 500) {
		return "WebDAV 服务端异常，请稍后重试或检查服务状态。";
	}
	return "请检查 WebDAV 配置、目录权限与网络连通性。";
};

const buildTwoLineMessage = (summary: string, hint: string): string =>
	`${summary}\n${hint}`;

export function resolveBackupSyncError(error: unknown): BackupSyncErrorInfo {
	const rawMessage = getErrorMessage(error).trim() || "backup_sync_failed";

	if (rawMessage === "backup_webdav_url_required") {
		return {
			code: rawMessage,
			status: 400,
			rawMessage,
			userMessage: buildTwoLineMessage(
				"同步失败：未配置 WebDAV 地址。",
				"请在“系统设置 > 数据备份与同步”填写 WebDAV 地址后重试。",
			),
		};
	}
	if (rawMessage === "backup_webdav_username_required") {
		return {
			code: rawMessage,
			status: 400,
			rawMessage,
			userMessage: buildTwoLineMessage(
				"同步失败：未配置 WebDAV 用户名。",
				"请在“系统设置 > 数据备份与同步”填写用户名后重试。",
			),
		};
	}
	if (rawMessage === "backup_remote_latest_missing") {
		return {
			code: rawMessage,
			status: 409,
			rawMessage,
			userMessage: buildTwoLineMessage(
				"同步失败：远端没有 latest.json 备份文件。",
				"当前模式需要从远端拉取，请先执行一次“推送同步”或“导出并上传备份”。",
			),
		};
	}
	const getStatus = parseErrorStatus(rawMessage, "webdav_get_failed_");
	if (getStatus !== null) {
		return {
			code: "webdav_get_failed",
			status: normalizeHttpStatusForSync(getStatus),
			rawMessage,
			userMessage: buildTwoLineMessage(
				`同步失败：读取 WebDAV 文件失败（HTTP ${getStatus}）。`,
				buildWebdavStatusMessage(getStatus),
			),
		};
	}
	const putStatus = parseErrorStatus(rawMessage, "webdav_put_failed_");
	if (putStatus !== null) {
		return {
			code: "webdav_put_failed",
			status: normalizeHttpStatusForSync(putStatus),
			rawMessage,
			userMessage: buildTwoLineMessage(
				`同步失败：写入 WebDAV 文件失败（HTTP ${putStatus}）。`,
				buildWebdavStatusMessage(putStatus),
			),
		};
	}
	const mkcolStatus = parseErrorStatus(rawMessage, "webdav_mkcol_failed_");
	if (mkcolStatus !== null) {
		return {
			code: "webdav_mkcol_failed",
			status: normalizeHttpStatusForSync(mkcolStatus),
			rawMessage,
			userMessage: buildTwoLineMessage(
				`同步失败：创建 WebDAV 目录失败（HTTP ${mkcolStatus}）。`,
				buildWebdavStatusMessage(mkcolStatus),
			),
		};
	}
	const deleteStatus = parseErrorStatus(rawMessage, "webdav_delete_failed_");
	if (deleteStatus !== null) {
		return {
			code: "webdav_delete_failed",
			status: normalizeHttpStatusForSync(deleteStatus),
			rawMessage,
			userMessage: buildTwoLineMessage(
				`同步失败：清理 WebDAV 历史文件失败（HTTP ${deleteStatus}）。`,
				buildWebdavStatusMessage(deleteStatus),
			),
		};
	}
	if (rawMessage.includes("fetch")) {
		return {
			code: "webdav_fetch_failed",
			status: 502,
			rawMessage,
			userMessage: buildTwoLineMessage(
				"同步失败：连接 WebDAV 服务异常（网络或服务不可达）。",
				"请检查 WebDAV 地址、网络连通性与证书配置。",
			),
		};
	}
	return {
		code: "backup_sync_failed",
		status: 500,
		rawMessage,
		userMessage: buildTwoLineMessage(
			`同步失败：${rawMessage}。`,
			"请检查 WebDAV 配置、目录权限与网络状态后重试。",
		),
	};
}

const toTimestampFileName = (iso: string) =>
	iso.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

const normalizeRevision = (meta: BackupMeta | null | undefined): number => {
	if (!meta) {
		return 0;
	}
	const revision = Number(meta.revision);
	if (Number.isNaN(revision)) {
		return 0;
	}
	return Math.floor(revision);
};

const normalizeHash = (meta: BackupMeta | null | undefined): string =>
	String(meta?.hash ?? "").trim();

export function selectTwoWayAction(
	localMeta: BackupMeta,
	remoteMeta: BackupMeta,
	conflictPolicy: BackupConflictPolicy,
): SyncAction {
	const localHash = normalizeHash(localMeta);
	const remoteHash = normalizeHash(remoteMeta);
	if (localHash && remoteHash && localHash === remoteHash) {
		return "noop";
	}
	const localRevision = normalizeRevision(localMeta);
	const remoteRevision = normalizeRevision(remoteMeta);
	if (localRevision > remoteRevision) {
		return "push";
	}
	if (localRevision < remoteRevision) {
		return "pull";
	}
	return conflictPolicy === "remote_wins" ? "pull" : "push";
}

const buildWebdavConfig = (
	baseUrl: string,
	path: string,
	username: string,
	password: string,
): WebdavConfig => ({
	baseUrl,
	path,
	credentials: {
		username,
		password,
	},
});

const validateWebdavConfig = (config: {
	webdav_url: string;
	webdav_username: string;
}) => {
	if (!config.webdav_url.trim()) {
		throw new Error("backup_webdav_url_required");
	}
	if (!config.webdav_username.trim()) {
		throw new Error("backup_webdav_username_required");
	}
};

const updateHistoryIndex = async (
	config: WebdavConfig,
	entry: string,
	keepVersions: number,
): Promise<void> => {
	const current = await readWebdavJson<BackupHistoryIndex>(
		config,
		HISTORY_INDEX_FILE,
	);
	const normalized = Array.from(
		new Set([entry, ...(current?.items ?? []).filter(Boolean)]),
	);
	const keep = Math.max(1, Math.floor(keepVersions));
	const toKeep = normalized.slice(0, keep);
	const toDelete = normalized.slice(keep);
	await writeWebdavJson(config, HISTORY_INDEX_FILE, { items: toKeep });
	for (const item of toDelete) {
		await deleteWebdavFile(config, `history/${item}`);
	}
};

const pushToWebdav = async (
	config: WebdavConfig,
	payload: BackupPayload,
	keepVersions: number,
): Promise<string> => {
	const fileName = `${toTimestampFileName(payload.meta.exported_at)}.json`;
	await writeWebdavJson(config, LATEST_FILE, payload);
	await writeWebdavJson(config, `history/${fileName}`, payload);
	await updateHistoryIndex(config, fileName, keepVersions);
	return fileName;
};

const pullFromWebdav = async (
	config: WebdavConfig,
): Promise<BackupPayload | null> => {
	const raw = await readWebdavJson<unknown>(config, LATEST_FILE);
	if (!raw) {
		return null;
	}
	const parsed = await parseBackupPayload(raw);
	return parsed?.payload ?? null;
};

const syncSuccess = async (
	db: D1Database,
	result: BackupSyncResult,
): Promise<BackupSyncResult> => {
	await setBackupSettings(db, {
		last_sync_at: result.synced_at,
		last_sync_status: "success",
		last_sync_message: result.message,
	});
	return result;
};

const syncFailure = async (db: D1Database, message: string): Promise<void> => {
	await setBackupSettings(db, {
		last_sync_at: nowIso(),
		last_sync_status: "failed",
		last_sync_message: message,
	});
};

export async function executeBackupSync(
	db: D1Database,
	options: {
		reason: SyncReason;
		overrideMode?: BackupSyncMode;
	} = {
		reason: "manual",
	},
): Promise<BackupSyncResult> {
	const settings = await getBackupSettings(db);
	const mode = options.overrideMode ?? settings.sync_mode;
	try {
		validateWebdavConfig(settings);
		const webdav = buildWebdavConfig(
			settings.webdav_url,
			settings.webdav_path,
			settings.webdav_username,
			settings.webdav_password,
		);
		const localPayload = await createBackupPayload(db, settings.instance_id);
		if (mode === "push") {
			const fileName = await pushToWebdav(
				webdav,
				localPayload,
				settings.keep_versions,
			);
			return syncSuccess(db, {
				ok: true,
				mode,
				action: "push",
				synced_at: nowIso(),
				local_revision: localPayload.meta.revision,
				remote_revision: localPayload.meta.revision,
				message: `backup_pushed_${fileName}`,
			});
		}
		const remotePayload = await pullFromWebdav(webdav);
		if (mode === "pull") {
			if (!remotePayload) {
				throw new Error("backup_remote_latest_missing");
			}
			await importBackupPayload(db, remotePayload, {
				mode: settings.import_mode,
				dryRun: false,
			});
			return syncSuccess(db, {
				ok: true,
				mode,
				action: "pull",
				synced_at: nowIso(),
				local_revision: localPayload.meta.revision,
				remote_revision: remotePayload.meta.revision,
				message: "backup_pulled",
			});
		}
		if (!remotePayload) {
			const fileName = await pushToWebdav(
				webdav,
				localPayload,
				settings.keep_versions,
			);
			return syncSuccess(db, {
				ok: true,
				mode,
				action: "push",
				synced_at: nowIso(),
				local_revision: localPayload.meta.revision,
				remote_revision: localPayload.meta.revision,
				message: `backup_remote_missing_push_${fileName}`,
			});
		}
		const action = selectTwoWayAction(
			localPayload.meta,
			remotePayload.meta,
			settings.conflict_policy,
		);
		if (action === "noop") {
			return syncSuccess(db, {
				ok: true,
				mode,
				action,
				synced_at: nowIso(),
				local_revision: localPayload.meta.revision,
				remote_revision: remotePayload.meta.revision,
				message: "backup_two_way_noop",
			});
		}
		if (action === "pull") {
			await importBackupPayload(db, remotePayload, {
				mode: settings.import_mode,
				dryRun: false,
			});
			return syncSuccess(db, {
				ok: true,
				mode,
				action,
				synced_at: nowIso(),
				local_revision: localPayload.meta.revision,
				remote_revision: remotePayload.meta.revision,
				message: "backup_two_way_pull",
			});
		}
		const fileName = await pushToWebdav(
			webdav,
			localPayload,
			settings.keep_versions,
		);
		return syncSuccess(db, {
			ok: true,
			mode,
			action,
			synced_at: nowIso(),
			local_revision: localPayload.meta.revision,
			remote_revision: localPayload.meta.revision,
			message: `backup_two_way_push_${fileName}`,
		});
	} catch (error) {
		const errorInfo = resolveBackupSyncError(error);
		await syncFailure(db, errorInfo.userMessage);
		throw error;
	}
}
