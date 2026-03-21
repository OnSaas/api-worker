import type {
	D1Database,
	DurableObjectNamespace,
	ExecutionContext,
} from "@cloudflare/workers-types";
import type { Bindings } from "../env";
import {
	recordChannelModelError,
	upsertChannelModelCapabilities,
} from "./channel-model-capabilities";
import { recordRuntimeEvent } from "./runtime-events";
import type { UsageInput } from "./usage";
import { recordUsage } from "./usage";

export type UsageQueueEvent =
	| {
			type: "usage";
			payload: UsageInput;
	  }
	| {
			type: "capability_upsert";
			payload: {
				channelId: string;
				models: string[];
				nowSeconds?: number;
			};
	  }
	| {
			type: "model_error";
			payload: {
				channelId: string;
				model: string | null;
				errorCode: string;
				nowSeconds?: number;
			};
	  };

type QueueMessage<T> = {
	body: T;
	ack: () => void;
	retry: () => void;
};

type QueueBatchLike<T> = {
	queue: string;
	messages: QueueMessage<T>[];
};

function resolveNowSeconds(value?: number): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	return Math.floor(Date.now() / 1000);
}

export async function processUsageQueueEvent(
	db: D1Database,
	event: UsageQueueEvent,
	cacheVersionStore?: DurableObjectNamespace,
): Promise<void> {
	if (event.type === "usage") {
		await recordUsage(db, event.payload, cacheVersionStore);
		return;
	}
	if (event.type === "capability_upsert") {
		const nowSeconds = resolveNowSeconds(event.payload.nowSeconds);
		await upsertChannelModelCapabilities(
			db,
			event.payload.channelId,
			event.payload.models,
			nowSeconds,
		);
		return;
	}
	if (event.type === "model_error") {
		const nowSeconds = resolveNowSeconds(event.payload.nowSeconds);
		await recordChannelModelError(
			db,
			event.payload.channelId,
			event.payload.model,
			event.payload.errorCode,
			nowSeconds,
		);
	}
}

export async function handleUsageQueue(
	batch: QueueBatchLike<UsageQueueEvent>,
	env: Bindings,
	ctx: ExecutionContext,
): Promise<void> {
	const tasks = batch.messages.map(async (message) => {
		try {
			await processUsageQueueEvent(
				env.DB,
				message.body,
				env.CACHE_VERSION_STORE,
			);
			message.ack();
		} catch (error) {
			await recordRuntimeEvent(env.DB, {
				level: "error",
				code: "usage_queue_consume_failed",
				message: "usage_queue_consume_failed",
				context: {
					queue: batch.queue,
					error: error instanceof Error ? error.message : String(error),
				},
			}).catch(() => undefined);
			message.retry();
		}
	});
	ctx.waitUntil(Promise.all(tasks));
}
