function normalizeMessage(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function isLikelyHtmlPayload(value: string): boolean {
	return (
		/<!doctype\s+html/i.test(value) ||
		/<html[\s>]/i.test(value) ||
		/<head[\s>]/i.test(value) ||
		/<body[\s>]/i.test(value)
	);
}

function summarizeHtmlPayload(value: string): string {
	const title = normalizeMessage(
		value.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? null,
	);
	const headline = normalizeMessage(
		value.match(/<h1[^>]*>([^<]+)<\/h1>/i)?.[1] ?? null,
	);
	return `html_success_page: title=${title ?? "-"}, headline=${headline ?? "-"}`;
}

export function extractProbeText(payload: unknown): string {
	if (!payload || typeof payload !== "object") {
		return "";
	}
	const record = payload as Record<string, unknown>;
	if (typeof record.output_text === "string") {
		return record.output_text.trim();
	}
	const choices = record.choices;
	if (!Array.isArray(choices) || choices.length === 0) {
		return "";
	}
	const firstChoice =
		choices[0] && typeof choices[0] === "object"
			? (choices[0] as Record<string, unknown>)
			: null;
	if (!firstChoice) {
		return "";
	}
	if (typeof firstChoice.text === "string") {
		return firstChoice.text.trim();
	}
	const message =
		firstChoice.message && typeof firstChoice.message === "object"
			? (firstChoice.message as Record<string, unknown>)
			: null;
	if (!message) {
		return "";
	}
	const content = message.content;
	if (typeof content === "string") {
		return content.trim();
	}
	if (!Array.isArray(content)) {
		return "";
	}
	for (const item of content) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const textValue = (item as Record<string, unknown>).text;
		if (typeof textValue === "string" && textValue.trim().length > 0) {
			return textValue.trim();
		}
	}
	return "";
}

export type SuccessfulResponseInspection = {
	ok: boolean;
	code: string;
	message: string;
	outputText: string | null;
};

export async function inspectSuccessfulResponse(
	response: Response,
	options: {
		requireOutputText?: boolean;
	} = {},
): Promise<SuccessfulResponseInspection> {
	const requireOutputText = options.requireOutputText === true;
	const contentType = (
		response.headers.get("content-type") ?? ""
	).toLowerCase();
	if (contentType.includes("text/html")) {
		const text = await response.text().catch(() => "");
		return {
			ok: false,
			code: "html_success_page",
			message: summarizeHtmlPayload(text),
			outputText: null,
		};
	}

	if (contentType.includes("application/json")) {
		const payload = (await response
			.clone()
			.json()
			.catch(() => null)) as Record<string, unknown> | null;
		if (payload && typeof payload === "object" && !Array.isArray(payload)) {
			if ("error" in payload) {
				return {
					ok: false,
					code: "abnormal_success_response",
					message:
						"abnormal_success_response: success payload contains error field",
					outputText: null,
				};
			}
			const outputText = normalizeMessage(extractProbeText(payload));
			if (requireOutputText && !outputText) {
				return {
					ok: false,
					code: "completion_probe_missing_text",
					message:
						"completion_probe_missing_text: success payload contains no probe text",
					outputText: null,
				};
			}
			return {
				ok: true,
				code: "service_request_succeeded",
				message: "service_request_succeeded",
				outputText,
			};
		}
	}

	const text = normalizeMessage(
		await response
			.clone()
			.text()
			.catch(() => ""),
	);
	if (!text) {
		return {
			ok: false,
			code: "empty_success_body",
			message: "empty_success_body: success response body is empty",
			outputText: null,
		};
	}
	if (isLikelyHtmlPayload(text)) {
		return {
			ok: false,
			code: "html_success_page",
			message: summarizeHtmlPayload(text),
			outputText: null,
		};
	}
	return {
		ok: true,
		code: "service_request_succeeded",
		message: "service_request_succeeded",
		outputText: text,
	};
}
