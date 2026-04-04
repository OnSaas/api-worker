import type { D1Database } from "@cloudflare/workers-types";
import { executeBackupSync } from "./backup-sync";
import { getBackupSettings, markBackupPendingChanges } from "./settings";
import { nowIso } from "../utils/time";

export async function triggerBackupAfterDataChange(
	db: D1Database,
): Promise<void> {
	await markBackupPendingChanges(db, nowIso());
	const settings = await getBackupSettings(db);
	if (!settings.enabled || !settings.config_ready) {
		return;
	}
	try {
		await executeBackupSync(db, {
			reason: "change",
			overrideMode: "push",
		});
	} catch {
		// Keep the main write path successful and leave pending_changes for retry.
	}
}
