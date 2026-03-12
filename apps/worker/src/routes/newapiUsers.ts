import { Hono } from "hono";
import type { AppEnv } from "../env";
import { newApiAuth } from "../middleware/newApiAuth";
import {
	listVerifiedModelsByChannel,
} from "../services/channel-model-capabilities";
import { listActiveChannels } from "../services/channel-repo";
import { getModelCapabilityTtlHours } from "../services/settings";
import { newApiSuccess } from "../utils/newapi-response";

const users = new Hono<AppEnv>({ strict: false });
users.use("*", newApiAuth);

users.get("/models", async (c) => {
	const channels = await listActiveChannels(c.env.DB);
	const ttlHours = await getModelCapabilityTtlHours(c.env.DB);
	const ttlSeconds = Math.max(1, Math.floor(ttlHours)) * 60 * 60;
	const map = await listVerifiedModelsByChannel(
		c.env.DB,
		channels.map((channel) => channel.id),
		ttlSeconds,
	);
	const modelSet = new Set<string>();
	for (const models of map.values()) {
		for (const id of models) {
			modelSet.add(id);
		}
	}
	const data = Array.from(modelSet).map((id) => ({
		id,
		name: id,
	}));
	return newApiSuccess(c, data);
});

export default users;
