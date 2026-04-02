import { describe, expect, it } from "vitest";
import { resolveBackupSyncError, selectTwoWayAction } from "./backup-sync";

const meta = (revision: number, hash: string) => ({
	schema_version: 1,
	exported_at: "2026-01-01T00:00:00.000Z",
	instance_id: "instance-1",
	revision,
	includes_sensitive_data: true,
	hash,
});

describe("selectTwoWayAction", () => {
	it("returns noop when hash is the same", () => {
		const action = selectTwoWayAction(
			meta(10, "same"),
			meta(20, "same"),
			"local_wins",
		);
		expect(action).toBe("noop");
	});

	it("returns push when local revision is newer", () => {
		const action = selectTwoWayAction(
			meta(21, "local"),
			meta(20, "remote"),
			"remote_wins",
		);
		expect(action).toBe("push");
	});

	it("returns pull when remote revision is newer", () => {
		const action = selectTwoWayAction(
			meta(20, "local"),
			meta(21, "remote"),
			"local_wins",
		);
		expect(action).toBe("pull");
	});

	it("returns push for equal revision when conflict policy is local_wins", () => {
		const action = selectTwoWayAction(
			meta(20, "local"),
			meta(20, "remote"),
			"local_wins",
		);
		expect(action).toBe("push");
	});

	it("returns pull for equal revision when conflict policy is remote_wins", () => {
		const action = selectTwoWayAction(
			meta(20, "local"),
			meta(20, "remote"),
			"remote_wins",
		);
		expect(action).toBe("pull");
	});
});

describe("resolveBackupSyncError", () => {
	it("maps missing webdav url to readable message", () => {
		const result = resolveBackupSyncError(
			new Error("backup_webdav_url_required"),
		);
		expect(result.status).toBe(400);
		expect(result.code).toBe("backup_webdav_url_required");
		expect(result.userMessage).toContain("未配置 WebDAV 地址");
	});

	it("maps remote latest missing to conflict status", () => {
		const result = resolveBackupSyncError(
			new Error("backup_remote_latest_missing"),
		);
		expect(result.status).toBe(409);
		expect(result.userMessage).toContain("远端没有 latest.json");
	});

	it("maps webdav put status code with actionable hint", () => {
		const result = resolveBackupSyncError(new Error("webdav_put_failed_401"));
		expect(result.status).toBe(400);
		expect(result.code).toBe("webdav_put_failed");
		expect(result.userMessage).toContain("写入 WebDAV 文件失败");
		expect(result.userMessage).toContain("鉴权失败");
		expect(result.userMessage).toContain("\n");
	});
});
