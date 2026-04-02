import type {
	DurableObjectNamespace,
	DurableObjectState,
} from "@cloudflare/workers-types";
import type { Bindings } from "../env";
import {
	beijingDateString,
	computeBeijingScheduleTime,
	computeNextBeijingRun,
} from "../utils/time";
import { runCheckinAll } from "./checkin-runner";
import { recoverDisabledChannels } from "./channel-recovery";
import { invalidateSelectionHotCache } from "./hot-kv";
import { executeBackupSync } from "./backup-sync";
import {
	getBackupScheduleEnabled,
	getBackupScheduleTime,
	getChannelRecoveryProbeEnabled,
	getChannelRecoveryProbeScheduleTime,
	getCheckinScheduleTime,
} from "./settings";

const SCHEDULER_NAME = "checkin-scheduler";
const LAST_RUN_DATE_KEY = "last_run_date";
const CHANNEL_RECOVERY_LAST_RUN_DATE_KEY = "channel_recovery_last_run_date";
const BACKUP_LAST_RUN_DATE_KEY = "backup_last_run_date";
const INTERNAL_IMMEDIATE_RESCHEDULE_DELAY_MS = 1000;

export const getCheckinSchedulerStub = (namespace: DurableObjectNamespace) =>
	namespace.get(namespace.idFromName(SCHEDULER_NAME));

export const shouldRunCheckin = (
	now: Date,
	scheduleTime: string,
	lastRunDate: string | null,
) => {
	const today = beijingDateString(now);
	if (lastRunDate && lastRunDate === today) {
		return false;
	}
	const scheduledAt = computeBeijingScheduleTime(now, scheduleTime);
	return now.getTime() >= scheduledAt.getTime();
};

export const shouldResetLastRun = (currentTime: string, nextTime: string) =>
	currentTime !== nextTime;

export const computeNextAlarmAt = (
	now: Date,
	scheduleTime: string,
	reset: boolean,
	immediateDelayMs = INTERNAL_IMMEDIATE_RESCHEDULE_DELAY_MS,
) => {
	if (!reset) {
		return computeNextBeijingRun(now, scheduleTime);
	}
	const scheduledAt = computeBeijingScheduleTime(now, scheduleTime);
	if (now.getTime() >= scheduledAt.getTime()) {
		const delay = Math.max(0, Math.floor(immediateDelayMs));
		return new Date(now.getTime() + delay);
	}
	return scheduledAt;
};

type RescheduleResult = {
	nextRunAt: string | null;
	checkinNextRunAt: string | null;
	channelRecoveryNextRunAt: string | null;
	backupNextRunAt: string | null;
};

export class CheckinScheduler {
	private state: DurableObjectState;
	private env: Bindings;

	constructor(state: DurableObjectState, env: Bindings) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/reschedule") {
			let reset = false;
			try {
				const payload = (await request.json()) as { reset?: boolean };
				reset = Boolean(payload?.reset);
			} catch {
				reset = false;
			}
			const result = await this.reschedule(new Date(), reset);
			return new Response(JSON.stringify({ ok: true, ...result }), {
				headers: { "Content-Type": "application/json" },
			});
		}
		if (request.method === "GET" && url.pathname === "/status") {
			const lastRunDate =
				(await this.state.storage.get<string>(LAST_RUN_DATE_KEY)) ?? null;
			const channelRecoveryLastRunDate =
				(await this.state.storage.get<string>(
					CHANNEL_RECOVERY_LAST_RUN_DATE_KEY,
				)) ?? null;
			const backupLastRunDate =
				(await this.state.storage.get<string>(BACKUP_LAST_RUN_DATE_KEY)) ??
				null;
			return new Response(
				JSON.stringify({
					ok: true,
					last_run_date: lastRunDate,
					checkin_last_run_date: lastRunDate,
					channel_recovery_last_run_date: channelRecoveryLastRunDate,
					backup_last_run_date: backupLastRunDate,
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response("Not Found", { status: 404 });
	}

	async alarm(): Promise<void> {
		await this.handleAlarm();
	}

	private async handleAlarm(): Promise<void> {
		const now = new Date();
		const checkinScheduleTime = await getCheckinScheduleTime(this.env.DB);
		const checkinLastRunDate =
			(await this.state.storage.get<string>(LAST_RUN_DATE_KEY)) ?? null;
		if (shouldRunCheckin(now, checkinScheduleTime, checkinLastRunDate)) {
			await runCheckinAll(this.env.DB, now);
			await this.state.storage.put(LAST_RUN_DATE_KEY, beijingDateString(now));
		}
		const channelRecoveryEnabled = await getChannelRecoveryProbeEnabled(
			this.env.DB,
		);
		if (channelRecoveryEnabled) {
			const channelRecoveryScheduleTime =
				await getChannelRecoveryProbeScheduleTime(this.env.DB);
			const channelRecoveryLastRunDate =
				(await this.state.storage.get<string>(
					CHANNEL_RECOVERY_LAST_RUN_DATE_KEY,
				)) ?? null;
			if (
				shouldRunCheckin(
					now,
					channelRecoveryScheduleTime,
					channelRecoveryLastRunDate,
				)
			) {
				const recoveryResult = await recoverDisabledChannels(this.env.DB);
				if (recoveryResult.recovered > 0) {
					await invalidateSelectionHotCache(this.env.KV_HOT);
				}
				await this.state.storage.put(
					CHANNEL_RECOVERY_LAST_RUN_DATE_KEY,
					beijingDateString(now),
				);
			}
		}
		const backupEnabled = await getBackupScheduleEnabled(this.env.DB);
		if (backupEnabled) {
			const backupScheduleTime = await getBackupScheduleTime(this.env.DB);
			const backupLastRunDate =
				(await this.state.storage.get<string>(BACKUP_LAST_RUN_DATE_KEY)) ??
				null;
			if (shouldRunCheckin(now, backupScheduleTime, backupLastRunDate)) {
				try {
					await executeBackupSync(this.env.DB, { reason: "schedule" });
				} catch {
					// Swallow scheduler backup failures to keep alarm loop alive.
				} finally {
					await this.state.storage.put(
						BACKUP_LAST_RUN_DATE_KEY,
						beijingDateString(now),
					);
				}
			}
		}
		await this.reschedule(now);
	}

	private async reschedule(
		now: Date = new Date(),
		reset = false,
	): Promise<RescheduleResult> {
		const checkinScheduleTime = await getCheckinScheduleTime(this.env.DB);
		const channelRecoveryEnabled = await getChannelRecoveryProbeEnabled(
			this.env.DB,
		);
		const channelRecoveryScheduleTime =
			await getChannelRecoveryProbeScheduleTime(this.env.DB);
		const backupEnabled = await getBackupScheduleEnabled(this.env.DB);
		const backupScheduleTime = await getBackupScheduleTime(this.env.DB);
		if (reset) {
			await this.state.storage.delete(LAST_RUN_DATE_KEY);
			await this.state.storage.delete(CHANNEL_RECOVERY_LAST_RUN_DATE_KEY);
			await this.state.storage.delete(BACKUP_LAST_RUN_DATE_KEY);
		}
		const checkinNextRunAt = computeNextAlarmAt(
			now,
			checkinScheduleTime,
			reset,
		);
		const channelRecoveryNextRunAt = channelRecoveryEnabled
			? computeNextAlarmAt(now, channelRecoveryScheduleTime, reset)
			: null;
		const backupNextRunAt = backupEnabled
			? computeNextAlarmAt(now, backupScheduleTime, reset)
			: null;
		const nextCandidates = [
			checkinNextRunAt,
			channelRecoveryNextRunAt,
			backupNextRunAt,
		].filter((item): item is Date => Boolean(item));
		let nextRun = checkinNextRunAt;
		for (const candidate of nextCandidates) {
			if (candidate.getTime() < nextRun.getTime()) {
				nextRun = candidate;
			}
		}
		await this.state.storage.setAlarm(nextRun.getTime());
		return {
			nextRunAt: nextRun.toISOString(),
			checkinNextRunAt: checkinNextRunAt.toISOString(),
			channelRecoveryNextRunAt: channelRecoveryNextRunAt
				? channelRecoveryNextRunAt.toISOString()
				: null,
			backupNextRunAt: backupNextRunAt ? backupNextRunAt.toISOString() : null,
		};
	}
}
