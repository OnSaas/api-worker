export async function runProxyAttempts(ctx: any): Promise<any> {
	const {
		ordered,
		callTokenMap,
		downstreamModel,
		verifiedModelsByChannel,
		endpointType,
		downstreamProvider,
		traceId,
		shouldTryLargeRequestDispatch,
		prepareAttemptRequest,
		c,
		targetPath,
		effectiveRequestText,
		parsedBody,
		isStream,
		shouldSkipHeavyBodyParsing,
		querySuffix,
		upstreamTimeoutMs,
		streamUsageOptions,
		ensureNormalizedChat,
		ensureNormalizedEmbedding,
		ensureNormalizedImage,
		loadStreamOptionsCapability,
		attemptBindingPolicy,
		attemptBindingState,
		dispatchRetryConfig,
		downstreamSignal,
		downstreamAbortResponse,
		recordEarlyUsage,
		jsonErrorWithTrace,
		hasUsageHeaders,
		hasUsageJsonHint,
		parseUsageFromHeaders,
		parseUsageFromJson,
		parseBooleanHeader,
		ATTEMPT_STREAM_USAGE_PROCESSED_HEADER,
		parseOptionalLatencyHeader,
		ATTEMPT_STREAM_FIRST_TOKEN_LATENCY_HEADER,
		parseOptionalCountHeader,
		ATTEMPT_STREAM_EVENTS_SEEN_HEADER,
		readAttemptStreamAbnormal,
		shouldParseSuccessStreamUsage,
		streamUsageMode,
		parseUsageFromSse,
		streamUsageParseTimeoutMs,
		detectAbnormalSuccessResponse,
		detectAbnormalStreamSuccessResponse,
		resolveFailureWithMeta,
		recordAttemptUsage,
		recordAttemptLog,
		appendAttemptFailure,
		scheduleModelCooldown,
		applyDisableAction,
		continueAfterFailure,
		buildDirectErrorResponse,
		shouldTreatMissingUsageAsError,
		parsedBodyInitialized,
		buildUsageMissingFailure,
		shouldTreatZeroCompletionAsError,
		zeroCompletionAsErrorEnabled,
		buildZeroCompletionFailure,
		buildSelectedAttemptState,
		scheduleUsageEvent,
		nowSeconds,
		extractErrorDetails,
		mergeErrorMetaJson,
		buildUpstreamDiagnosticMeta,
		parseStreamUsageOnFailure,
		evaluateUpstreamHttpFailure,
		responsesRequestHints,
		hasChatToolOutput,
		buildFetchExceptionFailure,
		usageErrorMessageMaxLength,
		PROXY_UPSTREAM_TIMEOUT_ERROR_CODE,
		PROXY_UPSTREAM_FETCH_ERROR_CODE,
		executeAttemptViaWorker,
		executeDispatchViaWorker,
		isStreamOptionsUnsupportedMessage,
		saveStreamOptionsCapability,
		resolveChannelAttemptTarget,
		recordSelectedClientDisconnect,
	} = ctx;
	let {
		selectedResponse,
		selectedChannel,
		selectedAttemptTokenId,
		selectedAttemptTokenName,
		selectedUpstreamProvider,
		selectedUpstreamEndpoint,
		selectedUpstreamModel,
		selectedRequestPath,
		selectedImmediateUsage,
		selectedImmediateUsageSource,
		selectedHasUsageSignal,
		selectedParsedStreamUsage,
		selectedHasUsageHeaders,
		selectedAttemptIndex,
		selectedAttemptStartedAt,
		selectedAttemptLatencyMs,
		selectedAttemptUpstreamRequestId,
		lastErrorDetails,
		attemptsExecuted,
		responsesToolCallMismatchChannels,
		attemptFailures,
		blockedChannelIds,
	} = ctx.state;
	const dispatchAttempts: any[] = [];
	const dispatchAttemptMeta: any[] = [];
	let dispatchHandled = false;
	let dispatchStopRetry = false;
	const done = (earlyResponse: Response | null = null) => ({
		earlyResponse,
		selectedResponse,
		selectedChannel,
		selectedAttemptTokenId,
		selectedAttemptTokenName,
		selectedUpstreamProvider,
		selectedUpstreamEndpoint,
		selectedUpstreamModel,
		selectedRequestPath,
		selectedImmediateUsage,
		selectedImmediateUsageSource,
		selectedHasUsageSignal,
		selectedParsedStreamUsage,
		selectedHasUsageHeaders,
		selectedAttemptIndex,
		selectedAttemptStartedAt,
		selectedAttemptLatencyMs,
		selectedAttemptUpstreamRequestId,
		lastErrorDetails,
		attemptsExecuted,
		responsesToolCallMismatchChannels,
		attemptFailures,
		blockedChannelIds,
	});
	if (shouldTryLargeRequestDispatch) {
		for (const channel of ordered) {
			const attemptStart = Date.now();
			const attemptStartedAt = new Date(attemptStart).toISOString();
			const attemptTarget = resolveChannelAttemptTarget({
				channel,
				tokens: callTokenMap.get(channel.id) ?? [],
				downstreamModel,
				verifiedModelsByChannel,
				endpointType,
				downstreamProvider,
				selectionKey: `${traceId}:${channel.id}:${downstreamModel ?? "*"}`,
			});
			if (!attemptTarget.eligible) {
				continue;
			}
			const preparedAttempt = await prepareAttemptRequest({
				channel,
				attemptTarget,
				requestHeaders: new Headers(c.req.header()),
				targetPath,
				effectiveRequestText,
				parsedBody,
				downstreamProvider,
				endpointType,
				isStream,
				shouldSkipHeavyBodyParsing,
				querySuffix,
				upstreamTimeoutMs,
				streamUsageOptions,
				ensureNormalizedChat,
				ensureNormalizedEmbedding,
				ensureNormalizedImage,
				loadStreamOptionsCapability,
			});
			if (!preparedAttempt) {
				continue;
			}
			dispatchAttempts.push({
				channelId: channel.id,
				method: c.req.method,
				target: preparedAttempt.target,
				fallbackTarget: preparedAttempt.fallbackTarget,
				headers: Array.from(preparedAttempt.headers.entries()),
				bodyText: preparedAttempt.bodyText,
				timeoutMs: upstreamTimeoutMs,
				responsePath: preparedAttempt.responsePath,
				fallbackPath: preparedAttempt.fallbackPath,
				streamUsage: streamUsageOptions,
				streamOptionsInjected: preparedAttempt.streamOptionsInjected,
				strippedBodyText: preparedAttempt.strippedBodyText,
			});
			dispatchAttemptMeta.push({
				channel,
				upstreamProvider: preparedAttempt.upstreamProvider as any,
				upstreamModel: preparedAttempt.upstreamModel,
				recordModel: preparedAttempt.recordModel,
				tokenSelection: preparedAttempt.tokenSelection,
				attemptStartedAt,
				streamOptionsHandled: preparedAttempt.streamOptionsHandled,
				target: preparedAttempt.target,
				fallbackTarget: preparedAttempt.fallbackTarget,
				requestHeaders: new Headers(preparedAttempt.headers),
			});
		}
		if (dispatchAttempts.length > 0) {
			const dispatchResult = await executeDispatchViaWorker(
				c,
				{
					attempts: dispatchAttempts,
					retryConfig: dispatchRetryConfig,
					streamUsage: streamUsageOptions,
				},
				attemptBindingPolicy,
				attemptBindingState,
				dispatchRetryConfig,
				downstreamSignal,
				downstreamAbortResponse,
			);
			if (downstreamSignal?.aborted === true) {
				return done(downstreamAbortResponse());
			}
			if (dispatchResult?.kind === "binding_error") {
				recordEarlyUsage({
					status: 503,
					code: dispatchResult.errorCode,
					message: dispatchResult.errorMessage,
					failureStage: "attempt_dispatch",
					failureReason: dispatchResult.errorCode,
					usageSource: "none",
					errorMetaJson: JSON.stringify({
						type: "attempt_worker_binding_error",
						latency_ms: dispatchResult.latencyMs,
					}),
				});
				return done(
					jsonErrorWithTrace(
						503,
						dispatchResult.errorCode,
						dispatchResult.errorCode,
					),
				);
			}
			if (dispatchResult?.kind === "attempt_worker_error") {
				recordEarlyUsage({
					status: 503,
					code: dispatchResult.errorCode,
					message: dispatchResult.errorMessage,
					failureStage: "attempt_dispatch_worker",
					failureReason: dispatchResult.errorCode,
					usageSource: "none",
					errorMetaJson:
						dispatchResult.errorMetaJson ??
						JSON.stringify({
							type: "attempt_worker_internal_error",
							http_status: dispatchResult.httpStatus,
							latency_ms: dispatchResult.latencyMs,
						}),
				});
				return done(
					jsonErrorWithTrace(
						503,
						dispatchResult.errorCode,
						dispatchResult.errorCode,
					),
				);
			}
			if (dispatchResult?.kind === "success") {
				dispatchHandled = true;
				dispatchStopRetry = dispatchResult.stopRetry;
				const resolvedIndex = Math.min(
					dispatchAttemptMeta.length - 1,
					Math.max(0, dispatchResult.attemptIndex),
				);
				const meta = dispatchAttemptMeta[resolvedIndex];
				if (meta) {
					const attemptNumber = resolvedIndex + 1;
					attemptsExecuted = Math.max(attemptsExecuted, attemptNumber);
					const response = dispatchResult.response;
					const responsePath = dispatchResult.responsePath;
					const attemptLatencyMs = dispatchResult.latencyMs;
					const attemptUpstreamRequestId = dispatchResult.upstreamRequestId;
					if (response.ok) {
						const hasUsageHeaderSignal = hasUsageHeaders(response.headers);
						const headerUsage = parseUsageFromHeaders(response.headers);
						let jsonUsage: any = null;
						let hasUsageJsonSignal = false;
						if (
							!isStream &&
							response.headers.get("content-type")?.includes("application/json")
						) {
							const data = await response
								.clone()
								.json()
								.catch(() => null);
							hasUsageJsonSignal = hasUsageJsonHint(data);
							jsonUsage = parseUsageFromJson(data);
						}
						let immediateUsage = jsonUsage ?? headerUsage;
						const immediateUsageSource = jsonUsage
							? "json"
							: headerUsage
								? "header"
								: "none";
						const streamUsageProcessed = isStream
							? parseBooleanHeader(
									response.headers.get(ATTEMPT_STREAM_USAGE_PROCESSED_HEADER),
								)
							: false;
						let parsedSuccessStreamUsage: any = null;
						if (isStream) {
							if (streamUsageProcessed) {
								parsedSuccessStreamUsage = {
									usage: headerUsage,
									firstTokenLatencyMs: parseOptionalLatencyHeader(
										response.headers.get(
											ATTEMPT_STREAM_FIRST_TOKEN_LATENCY_HEADER,
										),
									),
									eventsSeen:
										parseOptionalCountHeader(
											response.headers.get(ATTEMPT_STREAM_EVENTS_SEEN_HEADER),
										) ?? 0,
									abnormal: readAttemptStreamAbnormal(response.headers),
								};
								if (parsedSuccessStreamUsage?.usage) {
									immediateUsage = parsedSuccessStreamUsage.usage;
								}
							} else if (
								shouldParseSuccessStreamUsage(
									streamUsageMode as "full" | "lite" | "off",
								)
							) {
								parsedSuccessStreamUsage = await parseUsageFromSse(
									response.clone(),
									{
										...streamUsageOptions,
										timeoutMs: streamUsageParseTimeoutMs,
									},
								).catch(() => null);
								if (parsedSuccessStreamUsage?.usage) {
									immediateUsage = parsedSuccessStreamUsage.usage;
								}
							}
						}
						const abnormalResponse =
							parsedSuccessStreamUsage?.abnormal ??
							(await detectAbnormalSuccessResponse(response)) ??
							(isStream &&
							!parsedSuccessStreamUsage &&
							shouldParseSuccessStreamUsage(
								streamUsageMode as "full" | "lite" | "off",
							)
								? await detectAbnormalStreamSuccessResponse(response)
								: null);
						if (abnormalResponse) {
							const failureDecision = resolveFailureWithMeta({
								errorCode: abnormalResponse.errorCode,
								errorMessage: abnormalResponse.errorMessage,
								errorMetaJson: abnormalResponse.errorMetaJson,
							});
							lastErrorDetails = {
								upstreamStatus: response.status,
								errorCode: abnormalResponse.errorCode,
								errorMessage: abnormalResponse.errorMessage,
								errorMetaJson: failureDecision.errorMetaJson,
							};
							recordAttemptUsage({
								channelId: meta.channel.id,
								requestPath: responsePath,
								latencyMs: attemptLatencyMs,
								firstTokenLatencyMs: isStream ? null : attemptLatencyMs,
								usage: null,
								status: "error",
								upstreamStatus: response.status,
								errorCode: abnormalResponse.errorCode,
								errorMessage: abnormalResponse.errorMessage,
								failureStage: "upstream_response",
								failureReason: abnormalResponse.errorCode,
								usageSource: "none",
								errorMetaJson: failureDecision.errorMetaJson,
							});
							recordAttemptLog({
								attemptIndex: attemptNumber,
								channelId: meta.channel.id,
								provider: meta.upstreamProvider,
								model: meta.upstreamModel ?? downstreamModel,
								status: "error",
								errorClass: "upstream_response",
								errorCode: abnormalResponse.errorCode,
								httpStatus: response.status,
								latencyMs: attemptLatencyMs,
								upstreamRequestId: attemptUpstreamRequestId,
								startedAt: meta.attemptStartedAt,
								endedAt: new Date().toISOString(),
							});
							appendAttemptFailure({
								attemptIndex: attemptNumber,
								channel: meta.channel,
								httpStatus: response.status,
								errorCode: abnormalResponse.errorCode,
								errorMessage: abnormalResponse.errorMessage,
								latencyMs: attemptLatencyMs,
							});
							scheduleModelCooldown({
								channelId: meta.channel.id,
								model: meta.recordModel,
								upstreamStatus: response.status,
								errorCode: abnormalResponse.errorCode,
								errorMessage: abnormalResponse.errorMessage,
							});
							if (downstreamModel && downstreamModel !== meta.recordModel) {
								scheduleModelCooldown({
									channelId: meta.channel.id,
									model: downstreamModel,
									upstreamStatus: response.status,
									errorCode: abnormalResponse.errorCode,
									errorMessage: abnormalResponse.errorMessage,
								});
							}
							const action = failureDecision.action;
							if (action === "return") {
								return done(
									buildDirectErrorResponse(
										response.status,
										abnormalResponse.errorCode,
									),
								);
							}
							if (action === "disable") {
								await applyDisableAction({
									channelId: meta.channel.id,
									errorCode: abnormalResponse.errorCode,
								});
							} else if (!(await continueAfterFailure(attemptNumber, action))) {
								dispatchStopRetry = true;
							}
						} else {
							const hasAnyUsageSignal =
								hasUsageHeaderSignal || hasUsageJsonSignal;
							const failOnMissingUsage = shouldTreatMissingUsageAsError({
								isStream,
								bodyParsingSkipped:
									shouldSkipHeavyBodyParsing && !parsedBodyInitialized,
								hasUsageSignal: hasAnyUsageSignal,
							});
							if (!isStream && !immediateUsage && failOnMissingUsage) {
								const usageMissing =
									buildUsageMissingFailure(hasAnyUsageSignal);
								const usageMissingCode = usageMissing.errorCode;
								const usageMissingMessage = usageMissing.errorMessage;
								const failureDecision = resolveFailureWithMeta({
									errorCode: usageMissingCode,
									errorMessage: usageMissingMessage,
								});
								lastErrorDetails = {
									upstreamStatus: response.status,
									errorCode: usageMissingCode,
									errorMessage: usageMissingMessage,
									errorMetaJson: failureDecision.errorMetaJson,
								};
								recordAttemptUsage({
									channelId: meta.channel.id,
									requestPath: responsePath,
									latencyMs: attemptLatencyMs,
									firstTokenLatencyMs: attemptLatencyMs,
									usage: null,
									status: "error",
									upstreamStatus: response.status,
									errorCode: usageMissingCode,
									errorMessage: usageMissingMessage,
									failureStage: "usage_finalize",
									failureReason: usageMissingCode,
									usageSource: immediateUsageSource,
									errorMetaJson: failureDecision.errorMetaJson,
								});
								recordAttemptLog({
									attemptIndex: attemptNumber,
									channelId: meta.channel.id,
									provider: meta.upstreamProvider,
									model: meta.upstreamModel ?? downstreamModel,
									status: "error",
									errorClass: "usage_finalize",
									errorCode: usageMissingCode,
									httpStatus: response.status,
									latencyMs: attemptLatencyMs,
									upstreamRequestId: attemptUpstreamRequestId,
									startedAt: meta.attemptStartedAt,
									endedAt: new Date().toISOString(),
								});
								appendAttemptFailure({
									attemptIndex: attemptNumber,
									channel: meta.channel,
									httpStatus: response.status,
									errorCode: usageMissingCode,
									errorMessage: usageMissingMessage,
									latencyMs: attemptLatencyMs,
								});
								const action = failureDecision.action;
								if (action === "return") {
									return done(
										buildDirectErrorResponse(response.status, usageMissingCode),
									);
								}
								if (action === "disable") {
									await applyDisableAction({
										channelId: meta.channel.id,
										errorCode: usageMissingCode,
									});
								} else if (
									!(await continueAfterFailure(attemptNumber, action))
								) {
									dispatchStopRetry = true;
								}
							} else if (
								shouldTreatZeroCompletionAsError({
									enabled: zeroCompletionAsErrorEnabled,
									endpointType,
									usage: immediateUsage,
								})
							) {
								const zeroCompletion = buildZeroCompletionFailure(
									immediateUsage?.completionTokens,
								);
								const zeroCompletionMessage = zeroCompletion.errorMessage;
								const failureDecision = resolveFailureWithMeta({
									errorCode: zeroCompletion.errorCode,
									errorMessage: zeroCompletionMessage,
								});
								lastErrorDetails = {
									upstreamStatus: response.status,
									errorCode: zeroCompletion.errorCode,
									errorMessage: zeroCompletionMessage,
									errorMetaJson: failureDecision.errorMetaJson,
								};
								recordAttemptUsage({
									channelId: meta.channel.id,
									requestPath: responsePath,
									latencyMs: attemptLatencyMs,
									firstTokenLatencyMs: attemptLatencyMs,
									usage: immediateUsage,
									status: "error",
									upstreamStatus: response.status,
									errorCode: zeroCompletion.errorCode,
									errorMessage: zeroCompletionMessage,
									failureStage: "usage_finalize",
									failureReason: zeroCompletion.errorCode,
									usageSource: immediateUsageSource,
									errorMetaJson: failureDecision.errorMetaJson,
								});
								recordAttemptLog({
									attemptIndex: attemptNumber,
									channelId: meta.channel.id,
									provider: meta.upstreamProvider,
									model: meta.upstreamModel ?? downstreamModel,
									status: "error",
									errorClass: "usage_finalize",
									errorCode: zeroCompletion.errorCode,
									httpStatus: response.status,
									latencyMs: attemptLatencyMs,
									upstreamRequestId: attemptUpstreamRequestId,
									startedAt: meta.attemptStartedAt,
									endedAt: new Date().toISOString(),
								});
								appendAttemptFailure({
									attemptIndex: attemptNumber,
									channel: meta.channel,
									httpStatus: response.status,
									errorCode: zeroCompletion.errorCode,
									errorMessage: zeroCompletionMessage,
									latencyMs: attemptLatencyMs,
								});
								const action = failureDecision.action;
								if (action === "return") {
									return done(
										buildDirectErrorResponse(
											response.status,
											zeroCompletion.errorCode,
										),
									);
								}
								if (action === "disable") {
									await applyDisableAction({
										channelId: meta.channel.id,
										errorCode: zeroCompletion.errorCode,
									});
								} else if (
									!(await continueAfterFailure(attemptNumber, action))
								) {
									dispatchStopRetry = true;
								}
							} else {
								recordAttemptLog({
									attemptIndex: attemptNumber,
									channelId: meta.channel.id,
									provider: meta.upstreamProvider,
									model: meta.upstreamModel ?? downstreamModel,
									status: "ok",
									httpStatus: response.status,
									latencyMs: attemptLatencyMs,
									upstreamRequestId: attemptUpstreamRequestId,
									startedAt: meta.attemptStartedAt,
									endedAt: new Date().toISOString(),
								});
								const selectedState = buildSelectedAttemptState({
									channel: meta.channel,
									upstreamProvider: meta.upstreamProvider,
									responsePath,
									fallbackEndpointType: endpointType,
									upstreamModel: meta.upstreamModel,
									immediateUsage,
									immediateUsageSource,
									hasAnyUsageSignal,
									parsedSuccessStreamUsage,
									hasUsageHeaderSignal,
									attemptNumber,
									attemptStartedAt: meta.attemptStartedAt,
									attemptLatencyMs,
									attemptUpstreamRequestId,
									tokenSelection: meta.tokenSelection,
								});
								selectedChannel = selectedState.selectedChannel;
								selectedUpstreamProvider =
									selectedState.selectedUpstreamProvider;
								selectedUpstreamEndpoint =
									selectedState.selectedUpstreamEndpoint;
								selectedUpstreamModel = selectedState.selectedUpstreamModel;
								selectedResponse = response;
								selectedRequestPath = selectedState.selectedRequestPath;
								selectedImmediateUsage = selectedState.selectedImmediateUsage;
								selectedImmediateUsageSource =
									selectedState.selectedImmediateUsageSource;
								selectedHasUsageSignal = selectedState.selectedHasUsageSignal;
								selectedParsedStreamUsage =
									selectedState.selectedParsedStreamUsage;
								selectedHasUsageHeaders = selectedState.selectedHasUsageHeaders;
								selectedAttemptTokenId = selectedState.selectedAttemptTokenId;
								selectedAttemptTokenName =
									selectedState.selectedAttemptTokenName;
								selectedAttemptIndex = selectedState.selectedAttemptIndex;
								selectedAttemptStartedAt =
									selectedState.selectedAttemptStartedAt;
								selectedAttemptLatencyMs =
									selectedState.selectedAttemptLatencyMs;
								selectedAttemptUpstreamRequestId =
									selectedState.selectedAttemptUpstreamRequestId;
								lastErrorDetails = null;
								if (meta.recordModel) {
									scheduleUsageEvent({
										type: "capability_upsert",
										payload: {
											channelId: meta.channel.id,
											models: [meta.recordModel],
											nowSeconds,
										},
									});
								}
							}
						}
					} else {
						const errorInfo = await extractErrorDetails(response);
						const errorMetaJson = mergeErrorMetaJson(
							errorInfo.errorMetaJson,
							buildUpstreamDiagnosticMeta({
								target: meta.target,
								fallbackTarget: meta.fallbackTarget,
								requestHeaders: meta.requestHeaders,
								response,
							}),
						);
						const failureUsage = await parseStreamUsageOnFailure(response);
						const evaluatedFailure = evaluateUpstreamHttpFailure({
							errorCode: errorInfo.errorCode,
							errorMessage: errorInfo.errorMessage,
							responseStatus: response.status,
							errorMetaJson,
							downstreamProvider,
							hasResponsesFunctionCallOutput:
								responsesRequestHints?.hasFunctionCallOutput === true,
							hasChatToolOutput,
							streamOptionsHandled: meta.streamOptionsHandled,
						});
						if (evaluatedFailure.responsesToolCallMismatch) {
							responsesToolCallMismatchChannels.push(meta.channel.id);
						}
						const failureDecision = resolveFailureWithMeta({
							errorCode: evaluatedFailure.finalErrorCode,
							errorMessage: evaluatedFailure.normalizedErrorMessage,
							errorMetaJson: evaluatedFailure.errorMetaJson,
							overrideAction:
								dispatchResult.errorAction !== "retry"
									? dispatchResult.errorAction
									: null,
						});
						lastErrorDetails = {
							upstreamStatus: response.status,
							errorCode: evaluatedFailure.finalErrorCode,
							errorMessage: evaluatedFailure.normalizedErrorMessage,
							errorMetaJson: failureDecision.errorMetaJson,
						};
						recordAttemptUsage({
							channelId: meta.channel.id,
							requestPath: responsePath,
							latencyMs: attemptLatencyMs,
							firstTokenLatencyMs: isStream ? null : attemptLatencyMs,
							usage: failureUsage.usage,
							status: "error",
							upstreamStatus: response.status,
							errorCode: evaluatedFailure.finalErrorCode,
							errorMessage: evaluatedFailure.normalizedErrorMessage,
							failureStage: "upstream_response",
							failureReason: evaluatedFailure.finalErrorCode,
							usageSource: failureUsage.usageSource,
							errorMetaJson: failureDecision.errorMetaJson,
						});
						recordAttemptLog({
							attemptIndex: attemptNumber,
							channelId: meta.channel.id,
							provider: meta.upstreamProvider,
							model: meta.upstreamModel ?? downstreamModel,
							status: "error",
							errorClass: evaluatedFailure.errorClass,
							errorCode: evaluatedFailure.finalErrorCode,
							httpStatus: response.status,
							latencyMs: attemptLatencyMs,
							upstreamRequestId: attemptUpstreamRequestId,
							startedAt: meta.attemptStartedAt,
							endedAt: new Date().toISOString(),
						});
						appendAttemptFailure({
							attemptIndex: attemptNumber,
							channel: meta.channel,
							httpStatus: response.status,
							errorCode: evaluatedFailure.finalErrorCode,
							errorMessage: evaluatedFailure.normalizedErrorMessage,
							latencyMs: attemptLatencyMs,
						});
						scheduleModelCooldown({
							channelId: meta.channel.id,
							model: meta.recordModel,
							upstreamStatus: response.status,
							errorCode: evaluatedFailure.finalErrorCode,
							errorMessage: evaluatedFailure.normalizedErrorMessage,
						});
						if (downstreamModel && downstreamModel !== meta.recordModel) {
							scheduleModelCooldown({
								channelId: meta.channel.id,
								model: downstreamModel,
								upstreamStatus: response.status,
								errorCode: evaluatedFailure.finalErrorCode,
								errorMessage: evaluatedFailure.normalizedErrorMessage,
							});
						}
						const action = failureDecision.action;
						if (action === "return") {
							return done(
								buildDirectErrorResponse(
									response.status,
									evaluatedFailure.finalErrorCode,
								),
							);
						}
						if (action === "disable") {
							await applyDisableAction({
								channelId: meta.channel.id,
								errorCode: evaluatedFailure.finalErrorCode,
							});
						}
					}
				}
			}
		}
	}
	if (downstreamSignal?.aborted === true) {
		recordSelectedClientDisconnect();
		return done(downstreamAbortResponse());
	}
	if (dispatchHandled && !selectedResponse && !dispatchStopRetry) {
		dispatchHandled = false;
	}
	if (!dispatchHandled) {
		for (const [attemptIndex, channel] of ordered.entries()) {
			if (downstreamSignal?.aborted === true) {
				return done(downstreamAbortResponse());
			}
			if (
				attemptIndex < attemptsExecuted ||
				blockedChannelIds.has(channel.id)
			) {
				continue;
			}
			const attemptNumber = attemptIndex + 1;
			const attemptTarget = resolveChannelAttemptTarget({
				channel,
				tokens: callTokenMap.get(channel.id) ?? [],
				downstreamModel,
				verifiedModelsByChannel,
				endpointType,
				downstreamProvider,
				selectionKey: `${traceId}:${channel.id}:${downstreamModel ?? "*"}`,
				selectionOffset: attemptNumber - 1,
			});
			if (!attemptTarget.eligible) {
				continue;
			}
			attemptsExecuted = Math.max(attemptsExecuted, attemptNumber);
			const attemptStart = Date.now();
			const attemptStartedAt = new Date(attemptStart).toISOString();
			const preparedAttempt = await prepareAttemptRequest({
				channel,
				attemptTarget,
				requestHeaders: new Headers(c.req.header()),
				targetPath,
				effectiveRequestText,
				parsedBody,
				downstreamProvider,
				endpointType,
				isStream,
				shouldSkipHeavyBodyParsing,
				querySuffix,
				upstreamTimeoutMs,
				streamUsageOptions,
				ensureNormalizedChat,
				ensureNormalizedEmbedding,
				ensureNormalizedImage,
				loadStreamOptionsCapability,
			});
			if (!preparedAttempt) {
				continue;
			}
			const upstreamProvider = preparedAttempt.upstreamProvider as any;
			const upstreamModel = preparedAttempt.upstreamModel;
			const recordModel = preparedAttempt.recordModel;
			const tokenSelection = preparedAttempt.tokenSelection;
			const headers = preparedAttempt.headers;
			const upstreamRequestPath = preparedAttempt.responsePath;
			const upstreamFallbackPath = preparedAttempt.fallbackPath;
			const upstreamBodyText = preparedAttempt.bodyText;
			const shouldHandleStreamOptions = preparedAttempt.streamOptionsHandled;
			const streamOptionsInjected = preparedAttempt.streamOptionsInjected;
			const strippedStreamOptionsBodyText = preparedAttempt.strippedBodyText;
			const target = preparedAttempt.target;

			try {
				const fallbackTarget = preparedAttempt.fallbackTarget;

				const attemptResult = await executeAttemptViaWorker(
					c,
					{
						method: c.req.method,
						target,
						fallbackTarget,
						headers: Array.from(headers.entries()),
						bodyText: upstreamBodyText,
						timeoutMs: upstreamTimeoutMs,
						responsePath: upstreamRequestPath,
						fallbackPath: upstreamFallbackPath,
						streamUsage: streamUsageOptions,
					},
					attemptBindingPolicy,
					attemptBindingState,
					dispatchRetryConfig,
					downstreamSignal,
					downstreamAbortResponse,
				);
				if (
					attemptResult.kind === "aborted" ||
					downstreamSignal?.aborted === true
				) {
					return done(downstreamAbortResponse());
				}
				if (
					attemptResult.kind === "binding_error" ||
					attemptResult.kind === "attempt_worker_error"
				) {
					const errorMetaJson =
						attemptResult.kind === "attempt_worker_error"
							? (attemptResult.errorMetaJson ??
								JSON.stringify({
									type: "attempt_worker_internal_error",
									http_status: attemptResult.httpStatus,
									latency_ms: attemptResult.latencyMs,
								}))
							: JSON.stringify({
									type: "attempt_worker_binding_error",
									latency_ms: attemptResult.latencyMs,
								});
					lastErrorDetails = {
						upstreamStatus: null,
						errorCode: attemptResult.errorCode,
						errorMessage: attemptResult.errorMessage,
						errorMetaJson,
					};
					const failureDecision = resolveFailureWithMeta({
						errorCode: attemptResult.errorCode,
						errorMessage: attemptResult.errorMessage,
						errorMetaJson,
					});
					lastErrorDetails.errorMetaJson = failureDecision.errorMetaJson;
					recordAttemptUsage({
						channelId: channel.id,
						requestPath: upstreamRequestPath,
						latencyMs: attemptResult.latencyMs,
						firstTokenLatencyMs: null,
						usage: null,
						status: "error",
						upstreamStatus: null,
						errorCode: attemptResult.errorCode,
						errorMessage: attemptResult.errorMessage,
						failureStage: "attempt_call",
						failureReason: attemptResult.errorCode,
						usageSource: "none",
						errorMetaJson: failureDecision.errorMetaJson,
					});
					recordAttemptLog({
						attemptIndex: attemptNumber,
						channelId: channel.id,
						provider: upstreamProvider,
						model: upstreamModel ?? downstreamModel,
						status: "error",
						errorClass:
							attemptResult.kind === "attempt_worker_error"
								? "attempt_worker"
								: "attempt_binding",
						errorCode: attemptResult.errorCode,
						httpStatus:
							attemptResult.kind === "attempt_worker_error"
								? attemptResult.httpStatus
								: null,
						latencyMs: attemptResult.latencyMs,
						startedAt: attemptStartedAt,
						endedAt: new Date().toISOString(),
					});
					appendAttemptFailure({
						attemptIndex: attemptNumber,
						channel,
						httpStatus:
							attemptResult.kind === "attempt_worker_error"
								? attemptResult.httpStatus
								: null,
						errorCode: attemptResult.errorCode,
						errorMessage: attemptResult.errorMessage,
						latencyMs: attemptResult.latencyMs,
					});
					const action = failureDecision.action;
					if (action === "return") {
						return done(
							buildDirectErrorResponse(
								attemptResult.kind === "attempt_worker_error"
									? attemptResult.httpStatus
									: 503,
								attemptResult.errorCode,
							),
						);
					}
					if (action === "disable") {
						await applyDisableAction({
							channelId: channel.id,
							errorCode: attemptResult.errorCode,
						});
						continue;
					}
					if (!(await continueAfterFailure(attemptNumber, action))) {
						break;
					}
					continue;
				}
				let {
					response,
					responsePath,
					latencyMs: attemptLatencyMs,
					upstreamRequestId: attemptUpstreamRequestId,
				} = attemptResult;

				if (
					shouldHandleStreamOptions &&
					streamOptionsInjected &&
					!response.ok
				) {
					const details = await extractErrorDetails(response);
					if (isStreamOptionsUnsupportedMessage(details.errorMessage)) {
						saveStreamOptionsCapability(channel.id, false);
						const retried = await executeAttemptViaWorker(
							c,
							{
								method: c.req.method,
								target,
								fallbackTarget,
								headers: Array.from(headers.entries()),
								bodyText: strippedStreamOptionsBodyText,
								timeoutMs: upstreamTimeoutMs,
								responsePath: upstreamRequestPath,
								fallbackPath: upstreamFallbackPath,
								streamUsage: streamUsageOptions,
							},
							attemptBindingPolicy,
							attemptBindingState,
							dispatchRetryConfig,
							downstreamSignal,
							downstreamAbortResponse,
						);
						if (
							retried.kind === "aborted" ||
							downstreamSignal?.aborted === true
						) {
							return done(downstreamAbortResponse());
						}
						if (
							retried.kind === "binding_error" ||
							retried.kind === "attempt_worker_error"
						) {
							const errorMetaJson =
								retried.kind === "attempt_worker_error"
									? (retried.errorMetaJson ??
										JSON.stringify({
											type: "attempt_worker_internal_error",
											http_status: retried.httpStatus,
											latency_ms: retried.latencyMs,
										}))
									: JSON.stringify({
											type: "attempt_worker_binding_error",
											latency_ms: retried.latencyMs,
										});
							lastErrorDetails = {
								upstreamStatus: null,
								errorCode: retried.errorCode,
								errorMessage: retried.errorMessage,
								errorMetaJson,
							};
							const failureDecision = resolveFailureWithMeta({
								errorCode: retried.errorCode,
								errorMessage: retried.errorMessage,
								errorMetaJson,
							});
							lastErrorDetails.errorMetaJson = failureDecision.errorMetaJson;
							recordAttemptUsage({
								channelId: channel.id,
								requestPath: upstreamRequestPath,
								latencyMs: retried.latencyMs,
								firstTokenLatencyMs: null,
								usage: null,
								status: "error",
								upstreamStatus: null,
								errorCode: retried.errorCode,
								errorMessage: retried.errorMessage,
								failureStage: "attempt_call",
								failureReason: retried.errorCode,
								usageSource: "none",
								errorMetaJson: failureDecision.errorMetaJson,
							});
							recordAttemptLog({
								attemptIndex: attemptNumber,
								channelId: channel.id,
								provider: upstreamProvider,
								model: upstreamModel ?? downstreamModel,
								status: "error",
								errorClass:
									retried.kind === "attempt_worker_error"
										? "attempt_worker"
										: "attempt_binding",
								errorCode: retried.errorCode,
								httpStatus:
									retried.kind === "attempt_worker_error"
										? retried.httpStatus
										: null,
								latencyMs: retried.latencyMs,
								startedAt: attemptStartedAt,
								endedAt: new Date().toISOString(),
							});
							appendAttemptFailure({
								attemptIndex: attemptNumber,
								channel,
								httpStatus:
									retried.kind === "attempt_worker_error"
										? retried.httpStatus
										: null,
								errorCode: retried.errorCode,
								errorMessage: retried.errorMessage,
								latencyMs: retried.latencyMs,
							});
							const action = failureDecision.action;
							if (action === "return") {
								return done(
									buildDirectErrorResponse(
										retried.kind === "attempt_worker_error"
											? retried.httpStatus
											: 503,
										retried.errorCode,
									),
								);
							}
							if (action === "disable") {
								await applyDisableAction({
									channelId: channel.id,
									errorCode: retried.errorCode,
								});
								continue;
							}
							if (!(await continueAfterFailure(attemptNumber, action))) {
								break;
							}
							continue;
						}
						response = retried.response;
						responsePath = retried.responsePath;
						attemptLatencyMs = retried.latencyMs;
						attemptUpstreamRequestId = retried.upstreamRequestId;
					}
				}
				if (shouldHandleStreamOptions && response.ok && streamOptionsInjected) {
					saveStreamOptionsCapability(channel.id, true);
				}

				if (response.ok) {
					const hasUsageHeaderSignal = hasUsageHeaders(response.headers);
					const headerUsage = parseUsageFromHeaders(response.headers);
					let jsonUsage: any = null;
					let hasUsageJsonSignal = false;
					if (
						!isStream &&
						response.headers.get("content-type")?.includes("application/json")
					) {
						const data = await response
							.clone()
							.json()
							.catch(() => null);
						hasUsageJsonSignal = hasUsageJsonHint(data);
						jsonUsage = parseUsageFromJson(data);
					}
					let immediateUsage = jsonUsage ?? headerUsage;
					const immediateUsageSource = jsonUsage
						? "json"
						: headerUsage
							? "header"
							: "none";
					const streamUsageProcessed = isStream
						? parseBooleanHeader(
								response.headers.get(ATTEMPT_STREAM_USAGE_PROCESSED_HEADER),
							)
						: false;
					let parsedSuccessStreamUsage: any = null;
					if (isStream) {
						if (streamUsageProcessed) {
							parsedSuccessStreamUsage = {
								usage: headerUsage,
								firstTokenLatencyMs: parseOptionalLatencyHeader(
									response.headers.get(
										ATTEMPT_STREAM_FIRST_TOKEN_LATENCY_HEADER,
									),
								),
								eventsSeen:
									parseOptionalCountHeader(
										response.headers.get(ATTEMPT_STREAM_EVENTS_SEEN_HEADER),
									) ?? 0,
								abnormal: readAttemptStreamAbnormal(response.headers),
							};
							if (parsedSuccessStreamUsage?.usage) {
								immediateUsage = parsedSuccessStreamUsage.usage;
							}
						} else if (
							shouldParseSuccessStreamUsage(
								streamUsageMode as "full" | "lite" | "off",
							)
						) {
							parsedSuccessStreamUsage = await parseUsageFromSse(
								response.clone(),
								{
									...streamUsageOptions,
									timeoutMs: streamUsageParseTimeoutMs,
								},
							).catch(() => null);
							if (parsedSuccessStreamUsage?.usage) {
								immediateUsage = parsedSuccessStreamUsage.usage;
							}
						}
					}
					const abnormalResponse =
						parsedSuccessStreamUsage?.abnormal ??
						(await detectAbnormalSuccessResponse(response)) ??
						(isStream &&
						!parsedSuccessStreamUsage &&
						shouldParseSuccessStreamUsage(
							streamUsageMode as "full" | "lite" | "off",
						)
							? await detectAbnormalStreamSuccessResponse(response)
							: null);
					if (abnormalResponse) {
						const failureDecision = resolveFailureWithMeta({
							errorCode: abnormalResponse.errorCode,
							errorMessage: abnormalResponse.errorMessage,
							errorMetaJson: abnormalResponse.errorMetaJson,
						});
						lastErrorDetails = {
							upstreamStatus: response.status,
							errorCode: abnormalResponse.errorCode,
							errorMessage: abnormalResponse.errorMessage,
							errorMetaJson: failureDecision.errorMetaJson,
						};
						recordAttemptUsage({
							channelId: channel.id,
							requestPath: responsePath,
							latencyMs: attemptLatencyMs,
							firstTokenLatencyMs: isStream ? null : attemptLatencyMs,
							usage: null,
							status: "error",
							upstreamStatus: response.status,
							errorCode: abnormalResponse.errorCode,
							errorMessage: abnormalResponse.errorMessage,
							failureStage: "upstream_response",
							failureReason: abnormalResponse.errorCode,
							usageSource: "none",
							errorMetaJson: failureDecision.errorMetaJson,
						});
						recordAttemptLog({
							attemptIndex: attemptNumber,
							channelId: channel.id,
							provider: upstreamProvider,
							model: upstreamModel ?? downstreamModel,
							status: "error",
							errorClass: "upstream_response",
							errorCode: abnormalResponse.errorCode,
							httpStatus: response.status,
							latencyMs: attemptLatencyMs,
							upstreamRequestId: attemptUpstreamRequestId,
							startedAt: attemptStartedAt,
							endedAt: new Date().toISOString(),
						});
						appendAttemptFailure({
							attemptIndex: attemptNumber,
							channel,
							httpStatus: response.status,
							errorCode: abnormalResponse.errorCode,
							errorMessage: abnormalResponse.errorMessage,
							latencyMs: attemptLatencyMs,
						});
						scheduleModelCooldown({
							channelId: channel.id,
							model: recordModel,
							upstreamStatus: response.status,
							errorCode: abnormalResponse.errorCode,
							errorMessage: abnormalResponse.errorMessage,
						});
						if (downstreamModel && downstreamModel !== recordModel) {
							scheduleModelCooldown({
								channelId: channel.id,
								model: downstreamModel,
								upstreamStatus: response.status,
								errorCode: abnormalResponse.errorCode,
								errorMessage: abnormalResponse.errorMessage,
							});
						}
						const action = failureDecision.action;
						if (action === "return") {
							return done(
								buildDirectErrorResponse(
									response.status,
									abnormalResponse.errorCode,
								),
							);
						}
						if (action === "disable") {
							await applyDisableAction({
								channelId: channel.id,
								errorCode: abnormalResponse.errorCode,
							});
							continue;
						}
						if (!(await continueAfterFailure(attemptNumber, action))) {
							break;
						}
						continue;
					}
					const hasAnyUsageSignal = hasUsageHeaderSignal || hasUsageJsonSignal;
					const failOnMissingUsage = shouldTreatMissingUsageAsError({
						isStream,
						bodyParsingSkipped:
							shouldSkipHeavyBodyParsing && !parsedBodyInitialized,
						hasUsageSignal: hasAnyUsageSignal,
					});
					if (!isStream && !immediateUsage && failOnMissingUsage) {
						const usageMissing = buildUsageMissingFailure(hasAnyUsageSignal);
						const usageMissingCode = usageMissing.errorCode;
						const usageMissingMessage = usageMissing.errorMessage;
						const failureDecision = resolveFailureWithMeta({
							errorCode: usageMissingCode,
							errorMessage: usageMissingMessage,
						});
						lastErrorDetails = {
							upstreamStatus: response.status,
							errorCode: usageMissingCode,
							errorMessage: usageMissingMessage,
							errorMetaJson: failureDecision.errorMetaJson,
						};
						recordAttemptUsage({
							channelId: channel.id,
							requestPath: responsePath,
							latencyMs: attemptLatencyMs,
							firstTokenLatencyMs: attemptLatencyMs,
							usage: null,
							status: "error",
							upstreamStatus: response.status,
							errorCode: usageMissingCode,
							errorMessage: usageMissingMessage,
							failureStage: "usage_finalize",
							failureReason: usageMissingCode,
							usageSource: immediateUsageSource,
							errorMetaJson: failureDecision.errorMetaJson,
						});
						recordAttemptLog({
							attemptIndex: attemptNumber,
							channelId: channel.id,
							provider: upstreamProvider,
							model: upstreamModel ?? downstreamModel,
							status: "error",
							errorClass: "usage_finalize",
							errorCode: usageMissingCode,
							httpStatus: response.status,
							latencyMs: attemptLatencyMs,
							upstreamRequestId: attemptUpstreamRequestId,
							startedAt: attemptStartedAt,
							endedAt: new Date().toISOString(),
						});
						appendAttemptFailure({
							attemptIndex: attemptNumber,
							channel,
							httpStatus: response.status,
							errorCode: usageMissingCode,
							errorMessage: usageMissingMessage,
							latencyMs: attemptLatencyMs,
						});
						const action = failureDecision.action;
						if (action === "return") {
							return done(
								buildDirectErrorResponse(response.status, usageMissingCode),
							);
						}
						if (action === "disable") {
							await applyDisableAction({
								channelId: channel.id,
								errorCode: usageMissingCode,
							});
							continue;
						}
						if (!(await continueAfterFailure(attemptNumber, action))) {
							break;
						}
						continue;
					}
					if (
						shouldTreatZeroCompletionAsError({
							enabled: zeroCompletionAsErrorEnabled,
							endpointType,
							usage: immediateUsage,
						})
					) {
						const zeroCompletion = buildZeroCompletionFailure(
							immediateUsage?.completionTokens,
						);
						const zeroCompletionMessage = zeroCompletion.errorMessage;
						const failureDecision = resolveFailureWithMeta({
							errorCode: zeroCompletion.errorCode,
							errorMessage: zeroCompletionMessage,
						});
						lastErrorDetails = {
							upstreamStatus: response.status,
							errorCode: zeroCompletion.errorCode,
							errorMessage: zeroCompletionMessage,
							errorMetaJson: failureDecision.errorMetaJson,
						};
						recordAttemptUsage({
							channelId: channel.id,
							requestPath: responsePath,
							latencyMs: attemptLatencyMs,
							firstTokenLatencyMs: attemptLatencyMs,
							usage: immediateUsage,
							status: "error",
							upstreamStatus: response.status,
							errorCode: zeroCompletion.errorCode,
							errorMessage: zeroCompletionMessage,
							failureStage: "usage_finalize",
							failureReason: zeroCompletion.errorCode,
							usageSource: immediateUsageSource,
							errorMetaJson: failureDecision.errorMetaJson,
						});
						recordAttemptLog({
							attemptIndex: attemptNumber,
							channelId: channel.id,
							provider: upstreamProvider,
							model: upstreamModel ?? downstreamModel,
							status: "error",
							errorClass: "usage_finalize",
							errorCode: zeroCompletion.errorCode,
							httpStatus: response.status,
							latencyMs: attemptLatencyMs,
							upstreamRequestId: attemptUpstreamRequestId,
							startedAt: attemptStartedAt,
							endedAt: new Date().toISOString(),
						});
						appendAttemptFailure({
							attemptIndex: attemptNumber,
							channel,
							httpStatus: response.status,
							errorCode: zeroCompletion.errorCode,
							errorMessage: zeroCompletionMessage,
							latencyMs: attemptLatencyMs,
						});
						const action = failureDecision.action;
						if (action === "return") {
							return done(
								buildDirectErrorResponse(
									response.status,
									zeroCompletion.errorCode,
								),
							);
						}
						if (action === "disable") {
							await applyDisableAction({
								channelId: channel.id,
								errorCode: zeroCompletion.errorCode,
							});
							continue;
						}
						if (!(await continueAfterFailure(attemptNumber, action))) {
							break;
						}
						continue;
					}

					recordAttemptLog({
						attemptIndex: attemptNumber,
						channelId: channel.id,
						provider: upstreamProvider,
						model: upstreamModel ?? downstreamModel,
						status: "ok",
						httpStatus: response.status,
						latencyMs: attemptLatencyMs,
						upstreamRequestId: attemptUpstreamRequestId,
						startedAt: attemptStartedAt,
						endedAt: new Date().toISOString(),
					});
					const selectedState = buildSelectedAttemptState({
						channel,
						upstreamProvider,
						responsePath,
						fallbackEndpointType: endpointType,
						upstreamModel,
						immediateUsage,
						immediateUsageSource,
						hasAnyUsageSignal,
						parsedSuccessStreamUsage,
						hasUsageHeaderSignal,
						attemptNumber,
						attemptStartedAt,
						attemptLatencyMs,
						attemptUpstreamRequestId,
					});
					selectedChannel = selectedState.selectedChannel;
					selectedUpstreamProvider = selectedState.selectedUpstreamProvider;
					selectedUpstreamEndpoint = selectedState.selectedUpstreamEndpoint;
					selectedUpstreamModel = selectedState.selectedUpstreamModel;
					selectedResponse = response;
					selectedRequestPath = selectedState.selectedRequestPath;
					selectedImmediateUsage = selectedState.selectedImmediateUsage;
					selectedImmediateUsageSource =
						selectedState.selectedImmediateUsageSource;
					selectedHasUsageSignal = selectedState.selectedHasUsageSignal;
					selectedParsedStreamUsage = selectedState.selectedParsedStreamUsage;
					selectedHasUsageHeaders = selectedState.selectedHasUsageHeaders;
					selectedAttemptIndex = selectedState.selectedAttemptIndex;
					selectedAttemptStartedAt = selectedState.selectedAttemptStartedAt;
					selectedAttemptLatencyMs = selectedState.selectedAttemptLatencyMs;
					selectedAttemptUpstreamRequestId =
						selectedState.selectedAttemptUpstreamRequestId;
					lastErrorDetails = null;
					if (recordModel) {
						scheduleUsageEvent({
							type: "capability_upsert",
							payload: {
								channelId: channel.id,
								models: [recordModel],
								nowSeconds,
							},
						});
					}
					break;
				}

				const errorInfo = await extractErrorDetails(response);
				const errorMetaJson = mergeErrorMetaJson(
					errorInfo.errorMetaJson,
					buildUpstreamDiagnosticMeta({
						target,
						fallbackTarget,
						requestHeaders: headers,
						response,
					}),
				);
				const failureUsage = await parseStreamUsageOnFailure(response);
				const evaluatedFailure = evaluateUpstreamHttpFailure({
					errorCode: errorInfo.errorCode,
					errorMessage: errorInfo.errorMessage,
					responseStatus: response.status,
					errorMetaJson,
					downstreamProvider,
					hasResponsesFunctionCallOutput:
						responsesRequestHints?.hasFunctionCallOutput === true,
					hasChatToolOutput,
					streamOptionsHandled: shouldHandleStreamOptions,
				});
				if (evaluatedFailure.responsesToolCallMismatch) {
					responsesToolCallMismatchChannels.push(channel.id);
				}
				const failureDecision = resolveFailureWithMeta({
					errorCode: evaluatedFailure.finalErrorCode,
					errorMessage: evaluatedFailure.normalizedErrorMessage,
					errorMetaJson: evaluatedFailure.errorMetaJson,
				});
				lastErrorDetails = {
					upstreamStatus: response.status,
					errorCode: evaluatedFailure.finalErrorCode,
					errorMessage: evaluatedFailure.normalizedErrorMessage,
					errorMetaJson: failureDecision.errorMetaJson,
				};
				recordAttemptUsage({
					channelId: channel.id,
					requestPath: responsePath,
					latencyMs: attemptLatencyMs,
					firstTokenLatencyMs: isStream ? null : attemptLatencyMs,
					usage: failureUsage.usage,
					status: "error",
					upstreamStatus: response.status,
					errorCode: evaluatedFailure.finalErrorCode,
					errorMessage: evaluatedFailure.normalizedErrorMessage,
					failureStage: "upstream_response",
					failureReason: evaluatedFailure.finalErrorCode,
					usageSource: failureUsage.usageSource,
					errorMetaJson: failureDecision.errorMetaJson,
				});
				recordAttemptLog({
					attemptIndex: attemptNumber,
					channelId: channel.id,
					provider: upstreamProvider,
					model: upstreamModel ?? downstreamModel,
					status: "error",
					errorClass: evaluatedFailure.errorClass,
					errorCode: evaluatedFailure.finalErrorCode,
					httpStatus: response.status,
					latencyMs: attemptLatencyMs,
					upstreamRequestId: attemptUpstreamRequestId,
					startedAt: attemptStartedAt,
					endedAt: new Date().toISOString(),
				});
				appendAttemptFailure({
					attemptIndex: attemptNumber,
					channel,
					httpStatus: response.status,
					errorCode: evaluatedFailure.finalErrorCode,
					errorMessage: evaluatedFailure.normalizedErrorMessage,
					latencyMs: attemptLatencyMs,
				});

				scheduleModelCooldown({
					channelId: channel.id,
					model: recordModel,
					upstreamStatus: response.status,
					errorCode: evaluatedFailure.finalErrorCode,
					errorMessage: evaluatedFailure.normalizedErrorMessage,
				});
				if (downstreamModel && downstreamModel !== recordModel) {
					scheduleModelCooldown({
						channelId: channel.id,
						model: downstreamModel,
						upstreamStatus: response.status,
						errorCode: evaluatedFailure.finalErrorCode,
						errorMessage: evaluatedFailure.normalizedErrorMessage,
					});
				}
				const action = failureDecision.action;
				if (action === "return") {
					return done(
						buildDirectErrorResponse(
							response.status,
							evaluatedFailure.finalErrorCode,
						),
					);
				}
				if (action === "disable") {
					await applyDisableAction({
						channelId: channel.id,
						errorCode: evaluatedFailure.finalErrorCode,
					});
					continue;
				}
				if (!(await continueAfterFailure(attemptNumber, action))) {
					break;
				}
			} catch (error) {
				if (downstreamSignal?.aborted === true) {
					return done(downstreamAbortResponse());
				}
				const fetchFailure = buildFetchExceptionFailure({
					error,
					maxLength: usageErrorMessageMaxLength,
					timeoutErrorCode: PROXY_UPSTREAM_TIMEOUT_ERROR_CODE,
					fetchErrorCode: PROXY_UPSTREAM_FETCH_ERROR_CODE,
				});
				const usageErrorCode = fetchFailure.errorCode;
				const usageErrorMessage = fetchFailure.errorMessage;
				const attemptLatencyMs = Date.now() - attemptStart;
				const failureDecision = resolveFailureWithMeta({
					errorCode: usageErrorCode,
					errorMessage: usageErrorMessage,
					errorMetaJson: fetchFailure.errorMetaJson,
				});
				lastErrorDetails = {
					upstreamStatus: null,
					errorCode: usageErrorCode,
					errorMessage: usageErrorMessage,
					errorMetaJson: failureDecision.errorMetaJson,
				};
				recordAttemptUsage({
					channelId: channel.id,
					requestPath: upstreamRequestPath,
					latencyMs: attemptLatencyMs,
					firstTokenLatencyMs: null,
					usage: null,
					status: "error",
					upstreamStatus: null,
					errorCode: lastErrorDetails.errorCode,
					errorMessage: lastErrorDetails.errorMessage,
					failureStage: "upstream_call",
					failureReason: usageErrorCode,
					usageSource: "none",
					errorMetaJson: failureDecision.errorMetaJson,
				});
				recordAttemptLog({
					attemptIndex: attemptNumber,
					channelId: channel.id,
					provider: upstreamProvider,
					model: upstreamModel ?? downstreamModel,
					status: "error",
					errorClass: fetchFailure.isTimeout ? "timeout" : "exception",
					errorCode: usageErrorCode,
					httpStatus: null,
					latencyMs: attemptLatencyMs,
					startedAt: attemptStartedAt,
					endedAt: new Date().toISOString(),
				});
				appendAttemptFailure({
					attemptIndex: attemptNumber,
					channel,
					httpStatus: null,
					errorCode: usageErrorCode,
					errorMessage: usageErrorMessage,
					latencyMs: attemptLatencyMs,
				});

				scheduleModelCooldown({
					channelId: channel.id,
					model: recordModel,
					upstreamStatus: null,
					errorCode: usageErrorCode,
					errorMessage: usageErrorMessage,
				});
				if (downstreamModel && downstreamModel !== recordModel) {
					scheduleModelCooldown({
						channelId: channel.id,
						model: downstreamModel,
						upstreamStatus: null,
						errorCode: usageErrorCode,
						errorMessage: usageErrorMessage,
					});
				}
				const action = failureDecision.action;
				if (action === "return") {
					return done(
						buildDirectErrorResponse(
							fetchFailure.isTimeout ? 504 : 502,
							usageErrorCode,
						),
					);
				}
				if (action === "disable") {
					await applyDisableAction({
						channelId: channel.id,
						errorCode: usageErrorCode,
					});
					continue;
				}
				if (!(await continueAfterFailure(attemptNumber, action))) {
					break;
				}
			}
		}
	}
	if (downstreamSignal?.aborted === true) {
		recordSelectedClientDisconnect();
		return done(downstreamAbortResponse());
	}
	return done();
}
