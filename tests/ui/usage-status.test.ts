import { describe, expect, it } from "vitest";
import { buildUsageStatusDetail } from "../../apps/ui/src/core/utils";

const buildLog = (partial: Partial<{ status: string; upstream_status: number | null; error_code: string | null; error_message: string | null }>) => ({
	id: "1",
	model: "gpt-4",
	channel_id: "c1",
	token_id: "t1",
	total_tokens: 1,
	latency_ms: 100,
	status: partial.status ?? "ok",
	upstream_status: partial.upstream_status ?? null,
	error_code: partial.error_code ?? null,
	error_message: partial.error_message ?? null,
	created_at: "2026-03-14T00:00:00Z",
});

describe("usage status detail", () => {
	it("renders success label", () => {
		const detail = buildUsageStatusDetail(buildLog({ status: "ok" }) as any);
		expect(detail.label).toBe("成功");
		expect(detail.tone).toBe("success");
	});

	it("renders failure with status and code", () => {
		const detail = buildUsageStatusDetail(
			buildLog({
				status: "error",
				upstream_status: 403,
				error_code: "authentication_error",
				error_message: "Invalid API key",
			}) as any,
		);
		expect(detail.label).toContain("失败");
		expect(detail.label).toContain("403");
		expect(detail.label).toContain("authentication_error");
		expect(detail.message).toBe("Invalid API key");
	});
});
