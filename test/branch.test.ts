import { describe, expect, test } from "bun:test";
import { PLAN_MODE_MARKERS, planModeActive, scanBranch } from "../src/branch";

describe("planModeActive", () => {
	test("matches plan-mode-context on custom_message (observed in real omp --plan-yolo sessions)", () => {
		const entries = scanBranch([{ type: "custom_message", customType: "plan-mode-context", content: "x" }]);
		expect(planModeActive(entries)).toBe(true);
	});
	test("matches every marker on both custom and custom_message entries", () => {
		for (const marker of PLAN_MODE_MARKERS) {
			for (const type of ["custom", "custom_message"]) {
				expect(planModeActive(scanBranch([{ type, customType: marker, content: "" }]))).toBe(true);
			}
		}
	});
	test("ignores other custom types and the plan-yolo-handoff marker", () => {
		const entries = scanBranch([
			{ type: "custom", customType: "tool_execution_start" },
			{ type: "custom_message", customType: "plan-yolo-handoff", content: "" },
			{ type: "custom_message", customType: "ai.typesafe.adversary", content: "" },
		]);
		expect(planModeActive(entries)).toBe(false);
	});
});
