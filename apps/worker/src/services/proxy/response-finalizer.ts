import {
	resolveStreamMetaPartialReason,
	shouldMarkStreamMetaPartial,
	shouldParseSuccessStreamUsage,
} from "../../../../shared-core/src";
import { adaptChatResponse } from "../chat-response-adapter";
import { buildResponsesAffinityKey, writeHotJson } from "../hot-kv";
import { getSuccessfulUsageWarning } from "../proxy-request-guards";
import {
	ATTEMPT_RESPONSE_ID_HEADER,
	ATTEMPT_STREAM_EVENTS_SEEN_HEADER,
	ATTEMPT_STREAM_FIRST_TOKEN_LATENCY_HEADER,
	ATTEMPT_STREAM_META_PARTIAL_HEADER,
	ATTEMPT_STREAM_META_REASON_HEADER,
	ATTEMPT_STREAM_USAGE_PROCESSED_HEADER,
	parseBooleanHeader,
	parseOptionalCountHeader,
	parseOptionalLatencyHeader,
} from "./attempt-transport";
import { extractOpenAiResponseIdFromJson } from "./response-helpers";
import {
	buildAttemptFailureSummary,
	normalizeMessage,
	scheduleDbWrite,
	supportsAbortSignalEvents,
} from "./shared";
import { parseUsageFromSse } from "../../utils/usage";

export function buildAttemptFailureResponse(ctx: any): Response | null {
	const {
		selectedResponse,
		attemptsExecuted,
		attemptFailures,
		ordered,
		traceId,
		responsesToolCallMismatchChannels,
		withTraceHeader,
		jsonErrorWithTrace,
		lastErrorDetails,
		callTokenMap,
		downstreamModel,
		downstreamProvider,
		buildNoRoutableChannelsMeta,
		recordEarlyUsage,
		NO_ROUTABLE_CHANNELS_ERROR_CODE,
	} = ctx;

	if (selectedResponse) {
		return null;
	}

	ctx.responseAttemptCount = attemptsExecuted;
	if (attemptFailures.length > 0) {
		const summary = buildAttemptFailureSummary(attemptFailures);
		const payload = {
			error: "proxy_all_attempts_failed",
			code: "proxy_all_attempts_failed",
			trace_id: traceId,
			attempt_total: ordered.length,
			attempt_failed: attemptFailures.length,
			status_counts: summary.statusCounts,
			code_counts: summary.codeCounts,
			top_reason: summary.topReason,
			failures: attemptFailures.map((failure: any) => ({
				attempt_index: failure.attemptIndex,
				channel_id: failure.channelId,
				channel_name: failure.channelName,
				http_status: failure.httpStatus,
				error_code: failure.errorCode,
				error_message: failure.errorMessage,
				latency_ms: failure.latencyMs,
			})),
			responses_tool_call_mismatch_channels:
				responsesToolCallMismatchChannels.length > 0
					? responsesToolCallMismatchChannels
					: undefined,
		};
		return withTraceHeader(ctx.c.json(payload, 503));
	}

	if (lastErrorDetails) {
		const errorCode = lastErrorDetails.errorCode ?? "upstream_unavailable";
		return jsonErrorWithTrace(502, errorCode, errorCode);
	}

	if (ordered.length > 0 && attemptsExecuted === 0) {
		const skippedChannels = Array.from(
			new Map(
				ordered.map((channel: any) => [
					channel.id,
					{
						channelId: channel.id,
						channelName: channel.name ?? null,
						reason: "skipped_before_upstream_call",
						recordModel: downstreamModel,
						upstreamProvider: downstreamProvider,
						hasModelList: (callTokenMap.get(channel.id) ?? []).some(
							(token: any) => Boolean(token.models_json),
						),
						tokenId: null,
						tokenName: null,
					},
				]),
			).values(),
		);
		recordEarlyUsage({
			status: 503,
			code: NO_ROUTABLE_CHANNELS_ERROR_CODE,
			message: NO_ROUTABLE_CHANNELS_ERROR_CODE,
			failureStage: "channel_select",
			failureReason: NO_ROUTABLE_CHANNELS_ERROR_CODE,
			usageSource: "none",
			errorMetaJson: buildNoRoutableChannelsMeta(skippedChannels),
		});
		return jsonErrorWithTrace(
			503,
			NO_ROUTABLE_CHANNELS_ERROR_CODE,
			NO_ROUTABLE_CHANNELS_ERROR_CODE,
		);
	}

	recordEarlyUsage({
		status: 502,
		code: "upstream_unavailable",
		message: "upstream_unavailable",
	});
	return jsonErrorWithTrace(
		502,
		"upstream_unavailable",
		"upstream_unavailable",
	);
}

export async function finalizeSelectedResponse(ctx: any): Promise<Response> {
	const {
		selectedResponse,
		selectedChannel,
		isStream,
		selectedImmediateUsage,
		selectedParsedStreamUsage,
		selectedHasUsageHeaders,
		streamUsageMode,
		streamUsageOptions,
		streamUsageParseTimeoutMs,
		selectedRequestPath,
		markStreamMetaPartial,
		recordAttemptLog,
		selectedAttemptIndex,
		selectedAttemptStartedAt,
		selectedAttemptLatencyMs,
		selectedAttemptUpstreamRequestId,
		selectedUpstreamProvider,
		selectedUpstreamModel,
		downstreamModel,
		endpointType,
		STREAM_META_PARTIAL_CODE,
		USAGE_OBSERVE_FAILURE_STAGE,
		canResolveResponsesAffinity,
		downstreamProvider,
		tokenRecord,
		c,
		responsesAffinityTtlSeconds,
		selectedUpstreamEndpoint,
		traceId,
		selectedHasUsageSignal,
		selectedImmediateUsageSource,
		buildDirectErrorResponse,
		recordAttemptUsage,
		requestStart,
		downstreamSignal,
		recordSelectedClientDisconnect,
		recordSelectedStreamUsage,
		DOWNSTREAM_CLIENT_ABORT_ERROR_CODE,
		RESPONSE_ADAPT_FAILED_CODE,
		jsonErrorWithTrace,
	} = ctx;

	if (!selectedResponse) {
		throw new Error("selectedResponse is required");
	}

	let responseToReturn = selectedResponse;
	let selectedStreamUsageContext: any = null;

	if (selectedChannel && isStream) {
		const streamUsageProcessed = parseBooleanHeader(
			selectedResponse.headers.get(ATTEMPT_STREAM_USAGE_PROCESSED_HEADER),
		);
		let usage = selectedImmediateUsage;
		let usageSource: "header" | "stream" | "none" = selectedImmediateUsage
			? "header"
			: "none";
		let streamMetaPartial = false;
		let streamMetaReason: string | null = null;
		let firstTokenLatencyMs: number | null = null;
		let eventsSeen = 0;

		if (streamUsageProcessed) {
			streamMetaPartial = parseBooleanHeader(
				selectedResponse.headers.get(ATTEMPT_STREAM_META_PARTIAL_HEADER),
			);
			streamMetaReason =
				normalizeMessage(
					selectedResponse.headers.get(ATTEMPT_STREAM_META_REASON_HEADER),
				) ?? null;
			firstTokenLatencyMs = parseOptionalLatencyHeader(
				selectedResponse.headers.get(ATTEMPT_STREAM_FIRST_TOKEN_LATENCY_HEADER),
			);
			eventsSeen =
				parseOptionalCountHeader(
					selectedResponse.headers.get(ATTEMPT_STREAM_EVENTS_SEEN_HEADER),
				) ?? 0;
		} else if (selectedParsedStreamUsage) {
			if (selectedParsedStreamUsage.usage) {
				usage = selectedParsedStreamUsage.usage;
				usageSource = "stream";
			}
			firstTokenLatencyMs = selectedParsedStreamUsage.firstTokenLatencyMs;
			eventsSeen = selectedParsedStreamUsage.eventsSeen ?? 0;
			streamMetaPartial = shouldMarkStreamMetaPartial({
				mode: streamUsageMode as "full" | "lite" | "off",
				hasImmediateUsage: Boolean(selectedImmediateUsage),
				hasParsedUsage: Boolean(selectedParsedStreamUsage.usage),
				eventsSeen,
			});
			if (streamMetaPartial) {
				streamMetaReason = resolveStreamMetaPartialReason({
					mode: streamUsageMode as "full" | "lite" | "off",
					timedOut: selectedParsedStreamUsage.timedOut,
					eventsSeen,
				});
			}
		} else if (
			shouldParseSuccessStreamUsage(streamUsageMode as "full" | "lite" | "off")
		) {
			try {
				const streamUsage = await parseUsageFromSse(selectedResponse.clone(), {
					...streamUsageOptions,
					timeoutMs: streamUsageParseTimeoutMs,
				});
				if (streamUsage.usage) {
					usage = streamUsage.usage;
					usageSource = "stream";
				}
				firstTokenLatencyMs = streamUsage.firstTokenLatencyMs;
				eventsSeen = streamUsage.eventsSeen ?? 0;
				streamMetaPartial = shouldMarkStreamMetaPartial({
					mode: streamUsageMode as "full" | "lite" | "off",
					hasImmediateUsage: Boolean(selectedImmediateUsage),
					hasParsedUsage: Boolean(streamUsage.usage),
					eventsSeen,
				});
				if (streamMetaPartial) {
					streamMetaReason = resolveStreamMetaPartialReason({
						mode: streamUsageMode as "full" | "lite" | "off",
						timedOut: streamUsage.timedOut,
						eventsSeen,
					});
				}
			} catch {
				streamMetaPartial = !selectedImmediateUsage;
				if (streamMetaPartial) {
					streamMetaReason = resolveStreamMetaPartialReason({
						mode: streamUsageMode as "full" | "lite" | "off",
						timedOut: true,
					});
				}
			}
		} else {
			streamMetaPartial = shouldMarkStreamMetaPartial({
				mode: streamUsageMode as "full" | "lite" | "off",
				hasImmediateUsage: Boolean(selectedImmediateUsage),
				hasParsedUsage: false,
			});
			if (streamMetaPartial) {
				streamMetaReason = resolveStreamMetaPartialReason({
					mode: streamUsageMode as "full" | "lite" | "off",
				});
			}
		}

		if (streamMetaPartial) {
			const reason = streamMetaReason ?? STREAM_META_PARTIAL_CODE;
			markStreamMetaPartial({
				reason,
				path: selectedRequestPath,
				eventsSeen,
				hasImmediateUsage: Boolean(selectedImmediateUsage),
				hasUsageHeaders: selectedHasUsageHeaders,
			});
			if (
				selectedAttemptIndex !== null &&
				selectedAttemptStartedAt &&
				selectedAttemptLatencyMs !== null
			) {
				recordAttemptLog({
					attemptIndex: selectedAttemptIndex,
					channelId: selectedChannel.id,
					provider: selectedUpstreamProvider,
					model: selectedUpstreamModel ?? downstreamModel,
					status: "warn",
					errorClass: "stream_meta",
					errorCode: STREAM_META_PARTIAL_CODE,
					httpStatus: selectedResponse.status,
					latencyMs: selectedAttemptLatencyMs,
					upstreamRequestId: selectedAttemptUpstreamRequestId,
					startedAt: selectedAttemptStartedAt,
					endedAt: new Date().toISOString(),
				});
			}
		}

		const usageWarning = getSuccessfulUsageWarning({
			isStream,
			endpointType,
			usage,
		});
		if (
			usageWarning &&
			selectedAttemptIndex !== null &&
			selectedAttemptStartedAt &&
			selectedAttemptLatencyMs !== null
		) {
			recordAttemptLog({
				attemptIndex: selectedAttemptIndex,
				channelId: selectedChannel.id,
				provider: selectedUpstreamProvider,
				model: selectedUpstreamModel ?? downstreamModel,
				status: "warn",
				errorClass: "usage_observe",
				errorCode: usageWarning.code,
				httpStatus: selectedResponse.status,
				latencyMs: selectedAttemptLatencyMs,
				upstreamRequestId: selectedAttemptUpstreamRequestId,
				startedAt: selectedAttemptStartedAt,
				endedAt: new Date().toISOString(),
			});
		}

		selectedStreamUsageContext = {
			usage,
			usageSource,
			firstTokenLatencyMs,
			status: streamMetaPartial || usageWarning ? "warn" : "ok",
			errorCode:
				usageWarning?.code ??
				(streamMetaPartial ? STREAM_META_PARTIAL_CODE : null),
			errorMessage:
				usageWarning?.message ??
				(streamMetaPartial ? STREAM_META_PARTIAL_CODE : null),
			failureStage:
				usageWarning || streamMetaPartial
					? USAGE_OBSERVE_FAILURE_STAGE
					: "usage_finalize",
			failureReason:
				usageWarning?.code ??
				(streamMetaPartial ? STREAM_META_PARTIAL_CODE : null),
		};
	}

	if (
		canResolveResponsesAffinity &&
		selectedChannel &&
		downstreamProvider === "openai" &&
		endpointType === "responses"
	) {
		const task = (async () => {
			const contentType = selectedResponse.headers.get("content-type") ?? "";
			let responseId =
				normalizeMessage(
					selectedResponse.headers.get(ATTEMPT_RESPONSE_ID_HEADER),
				) ?? null;
			if (
				!responseId &&
				!isStream &&
				contentType.includes("application/json")
			) {
				const payload = await selectedResponse
					.clone()
					.json()
					.catch(() => null);
				responseId = extractOpenAiResponseIdFromJson(payload);
			}
			if (!responseId) {
				return;
			}
			await writeHotJson(
				c.env.KV_HOT,
				buildResponsesAffinityKey(responseId),
				{
					channelId: selectedChannel.id,
					tokenId: tokenRecord.id,
					model: downstreamModel,
					updatedAt: new Date().toISOString(),
				},
				responsesAffinityTtlSeconds,
			);
		})();
		scheduleDbWrite(c, task);
	}

	if (
		selectedUpstreamProvider &&
		selectedUpstreamEndpoint &&
		(endpointType === "chat" || endpointType === "responses")
	) {
		ctx.responseAttemptCount = ctx.attemptsExecuted;
		try {
			const transformed = await adaptChatResponse({
				response: selectedResponse,
				upstreamProvider: selectedUpstreamProvider,
				downstreamProvider,
				upstreamEndpoint: selectedUpstreamEndpoint,
				downstreamEndpoint: endpointType,
				model: selectedUpstreamModel ?? downstreamModel,
				isStream,
			});
			if (transformed !== selectedResponse) {
				responseToReturn = transformed;
			}
		} catch (error) {
			console.error("proxy_response_adapt_failed", {
				traceId,
				path: selectedRequestPath,
				message:
					error instanceof Error ? error.message : "response_adapt_failed",
			});
			return jsonErrorWithTrace(
				502,
				RESPONSE_ADAPT_FAILED_CODE,
				RESPONSE_ADAPT_FAILED_CODE,
			);
		}
	}

	if (downstreamSignal?.aborted === true) {
		recordSelectedClientDisconnect(
			selectedStreamUsageContext
				? {
						usage: selectedStreamUsageContext.usage,
						usageSource: selectedStreamUsageContext.usageSource,
						firstTokenLatencyMs: selectedStreamUsageContext.firstTokenLatencyMs,
					}
				: undefined,
		);
		return ctx.downstreamAbortResponse();
	}

	if (selectedChannel && !isStream) {
		const selectedLatencyMs = Date.now() - requestStart;
		if (!selectedImmediateUsage) {
			const usageMissingCode = selectedHasUsageSignal
				? "usage_missing.non_stream.signal_present_unparseable"
				: "usage_missing.non_stream.signal_absent";
			recordAttemptUsage({
				channelId: selectedChannel.id,
				requestPath: selectedRequestPath,
				latencyMs: selectedLatencyMs,
				firstTokenLatencyMs: selectedAttemptLatencyMs ?? selectedLatencyMs,
				usage: null,
				status: "error",
				upstreamStatus: selectedResponse.status,
				errorCode: usageMissingCode,
				errorMessage: `usage_missing: ${usageMissingCode}`,
				failureStage: "usage_finalize",
				failureReason: usageMissingCode,
				usageSource: selectedImmediateUsageSource,
			});
			return buildDirectErrorResponse(
				selectedResponse.status,
				usageMissingCode,
			);
		}
		recordAttemptUsage({
			channelId: selectedChannel.id,
			requestPath: selectedRequestPath,
			latencyMs: selectedLatencyMs,
			firstTokenLatencyMs: selectedAttemptLatencyMs ?? selectedLatencyMs,
			usage: selectedImmediateUsage,
			status: "ok",
			upstreamStatus: selectedResponse.status,
			failureStage: "usage_finalize",
			usageSource: selectedImmediateUsageSource,
		});
	}

	if (selectedChannel && isStream && selectedStreamUsageContext) {
		if (!responseToReturn.body) {
			recordSelectedStreamUsage(selectedStreamUsageContext);
		} else {
			const headers = new Headers(responseToReturn.headers);
			headers.delete("content-length");
			const source = responseToReturn.body;
			const reader = source.getReader();
			let finalized = false;
			let readerCancelled = false;
			let firstByteSent = false;
			const cancelReader = (reason?: unknown) => {
				if (readerCancelled) {
					return Promise.resolve();
				}
				readerCancelled = true;
				return reader.cancel(reason).catch(() => undefined);
			};
			const finalizeStreamDisconnect = () => {
				if (finalized) {
					return;
				}
				finalized = true;
				recordSelectedClientDisconnect({
					usage: selectedStreamUsageContext.usage,
					usageSource: selectedStreamUsageContext.usageSource,
					firstTokenLatencyMs: selectedStreamUsageContext.firstTokenLatencyMs,
					failureReason: firstByteSent
						? "client_disconnected.after_first_byte"
						: "client_disconnected.before_first_byte",
				});
			};
			const finalizeStreamError = (error: unknown) => {
				if (finalized) {
					return;
				}
				finalized = true;
				const failureReason = firstByteSent
					? "downstream_stream_failed.after_first_byte"
					: "downstream_stream_failed.before_first_byte";
				const message =
					error instanceof Error ? error.message : "downstream_stream_failed";
				recordSelectedStreamUsage({
					usage: selectedStreamUsageContext.usage,
					usageSource: selectedStreamUsageContext.usageSource,
					firstTokenLatencyMs: selectedStreamUsageContext.firstTokenLatencyMs,
					status: "error",
					errorCode: "downstream_stream_failed",
					errorMessage: `downstream_stream_failed: ${message}`,
					failureStage: "downstream_response",
					failureReason,
					errorMetaJson: JSON.stringify({
						type: "downstream_stream_failed",
						phase: firstByteSent ? "after_first_byte" : "before_first_byte",
						message,
					}),
				});
				if (
					selectedAttemptIndex !== null &&
					selectedAttemptStartedAt &&
					selectedAttemptLatencyMs !== null
				) {
					recordAttemptLog({
						attemptIndex: selectedAttemptIndex,
						channelId: selectedChannel.id,
						provider: selectedUpstreamProvider,
						model: selectedUpstreamModel ?? downstreamModel,
						status: "error",
						errorClass: "downstream_response",
						errorCode: "downstream_stream_failed",
						httpStatus: selectedResponse.status,
						latencyMs: selectedAttemptLatencyMs,
						upstreamRequestId: selectedAttemptUpstreamRequestId,
						startedAt: selectedAttemptStartedAt,
						endedAt: new Date().toISOString(),
					});
				}
			};
			const finalizeStreamSuccess = () => {
				if (finalized) {
					return;
				}
				finalized = true;
				recordSelectedStreamUsage(selectedStreamUsageContext);
			};
			const abortListener = () => {
				finalizeStreamDisconnect();
				void cancelReader(DOWNSTREAM_CLIENT_ABORT_ERROR_CODE);
			};
			if (supportsAbortSignalEvents(downstreamSignal)) {
				downstreamSignal.addEventListener("abort", abortListener, {
					once: true,
				});
			}
			const observedStream = new ReadableStream<Uint8Array>({
				async start(controller) {
					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) {
								finalizeStreamSuccess();
								controller.close();
								return;
							}
							if (value.byteLength > 0) {
								firstByteSent = true;
							}
							controller.enqueue(value);
						}
					} catch (error) {
						if (finalized || downstreamSignal?.aborted === true) {
							finalizeStreamDisconnect();
							return;
						}
						finalizeStreamError(error);
						controller.error(error);
					} finally {
						if (supportsAbortSignalEvents(downstreamSignal)) {
							downstreamSignal.removeEventListener("abort", abortListener);
						}
						reader.releaseLock();
					}
				},
				cancel(reason) {
					finalizeStreamDisconnect();
					if (supportsAbortSignalEvents(downstreamSignal)) {
						downstreamSignal.removeEventListener("abort", abortListener);
					}
					return cancelReader(reason);
				},
			});
			responseToReturn = new Response(observedStream, {
				status: responseToReturn.status,
				statusText: responseToReturn.statusText,
				headers,
			});
		}
	}

	return responseToReturn;
}
