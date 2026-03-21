import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
	listRuntimeEvents,
	pruneRuntimeEvents,
} from "../services/runtime-events";
import { getRuntimeEventRetentionDays } from "../services/settings";

const runtimeEvents = new Hono<AppEnv>();

runtimeEvents.get("/", async (c) => {
	const query = c.req.query();
	const levels = query.levels
		? String(query.levels)
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean)
		: [];
	const codes = query.codes
		? String(query.codes)
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean)
		: [];
	const limit = Number(query.limit ?? 100);
	const offset = Number(query.offset ?? 0);
	const retentionDays = await getRuntimeEventRetentionDays(c.env.DB);
	await pruneRuntimeEvents(c.env.DB, retentionDays);
	const result = await listRuntimeEvents(c.env.DB, {
		from: query.from ? String(query.from) : null,
		to: query.to ? String(query.to) : null,
		levels,
		codes,
		requestId: query.request_id ? String(query.request_id) : null,
		sessionId: query.session_id ? String(query.session_id) : null,
		path: query.path ? String(query.path) : null,
		limit,
		offset,
	});
	return c.json(result);
});

export default runtimeEvents;
