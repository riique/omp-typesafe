import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * ambiguity.ts unit tests. The native judge client is mocked so scoreAmbiguity
 * runs without network access and returns queued answers.
 */

interface QueuedAnswer {
	type: string;
	[key: string]: unknown;
}

let queuedAnswers: Record<string, QueuedAnswer> = {};
let askShouldThrow = false;

mock.module("../src/client", () => ({
	judgeAvailable: () => true,
	ask: async (_ctx: unknown, _state: unknown, _questions: unknown, _opts: unknown) => {
		if (askShouldThrow) throw new Error("boom");
		return {
			result: {
				model: "jev-test",
				api: "openrouter-decisions",
				provider: "openrouter",
				answers: queuedAnswers,
				usage: { input_tokens: 10, output_tokens: 0, cost: 0 },
			},
			requestId: "test-request",
		};
	},
	describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
	noul: (instructions: string, opts?: { true?: string; false?: string }) => ({
		type: "noul",
		instructions,
		...opts,
	}),
	choice: (instructions: string, criteria: Record<string, string>) => ({
		type: "choice",
		instructions,
		criteria,
	}),
	score: (instructions: string, levels: readonly string[]) => ({
		type: "score",
		instructions,
		levels: [...levels],
	}),
}));

const {
	DIMENSIONS,
	buildAmbiguityBattery,
	buildBlockReason,
	buildGateNote,
	compositeAmbiguity,
	draftQuestion,
	getAmbiguityTelemetry,
	isProposeWrite,
	proposeDecision,
	recordAsk,
	recordScore,
	resetAmbiguitySession,
	scoreAmbiguity,
	taskEntity,
	weakestDimension,
} = await import("../src/ambiguity");
const { DEFAULT_CONFIG } = await import("../src/config");
const { resetReviewerSession, shouldEmit } = await import("../src/reviewer");

const W = DEFAULT_CONFIG.ambiguityGate.weights;
const GATE_CFG = DEFAULT_CONFIG.ambiguityGate;

function dims(goal: number, constraints: number, criteria: number, context: number) {
	return { goal, constraints, criteria, context };
}

describe("compositeAmbiguity — deep-interview brownfield weights", () => {
	test("all dimensions fully clear gives 0", () => {
		expect(compositeAmbiguity(dims(1, 1, 1, 1), W)).toBeCloseTo(0, 10);
	});

	test("all dimensions fully unclear gives 1", () => {
		expect(compositeAmbiguity(dims(0, 0, 0, 0), W)).toBeCloseTo(1, 10);
	});

	test("half-clear everywhere gives 0.5", () => {
		expect(compositeAmbiguity(dims(0.5, 0.5, 0.5, 0.5), W)).toBeCloseTo(0.5, 10);
	});

	test("a worked example: 1 - (0.35*1 + 0.25*0.5 + 0.25*0.75 + 0.15*1) = 0.1875", () => {
		expect(compositeAmbiguity(dims(1, 0.5, 0.75, 1), W)).toBeCloseTo(0.1875, 10);
	});

	test("only goal unclear costs exactly the goal weight", () => {
		expect(compositeAmbiguity(dims(0, 1, 1, 1), W)).toBeCloseTo(0.35, 10);
	});

	test("only context unclear costs exactly the context weight", () => {
		expect(compositeAmbiguity(dims(1, 1, 1, 0), W)).toBeCloseTo(0.15, 10);
	});

	test("out-of-range dimension values are clamped to 0..1", () => {
		expect(compositeAmbiguity(dims(5, 1, 1, 1), W)).toBeCloseTo(0, 10);
		expect(compositeAmbiguity(dims(-3, 1, 1, 1), W)).toBeCloseTo(0.35, 10);
	});

	test("the weights sum to 1 so the score spans the full range", () => {
		expect(W.goal + W.constraints + W.criteria + W.context).toBeCloseTo(1, 10);
	});
});

describe("weakestDimension — largest weighted shortfall", () => {
	test("picks the dimension with the biggest weighted gap, not the lowest raw score", () => {
		// context is lower raw (0.2) but goal's shortfall is 0.35*0.5=0.175 > 0.15*0.8=0.12.
		expect(weakestDimension(dims(0.5, 1, 1, 0.2), W)).toBe("goal");
	});

	test("picks context when its gap dominates despite the small weight", () => {
		expect(weakestDimension(dims(1, 1, 1, 0), W)).toBe("context");
	});

	test("picks constraints over criteria at equal clarity by tie-break order", () => {
		expect(weakestDimension(dims(1, 0.4, 0.4, 1), W)).toBe("constraints");
	});

	test("a fully clear task still returns a dimension", () => {
		expect(DIMENSIONS).toContain(weakestDimension(dims(1, 1, 1, 1), W));
	});
});

describe("isProposeWrite", () => {
	test("matches the path key", () => {
		expect(isProposeWrite({ path: "xd://propose" })).toBe(true);
	});

	test("matches the file_path key", () => {
		expect(isProposeWrite({ file_path: "xd://propose" })).toBe(true);
	});

	test("matches a longer path under the propose device", () => {
		expect(isProposeWrite({ path: "xd://propose/plan.md" })).toBe(true);
	});

	test("tolerates surrounding whitespace", () => {
		expect(isProposeWrite({ file_path: "  xd://propose  " })).toBe(true);
	});

	test("rejects an ordinary file write", () => {
		expect(isProposeWrite({ path: "/tmp/plan.md" })).toBe(false);
	});

	test("rejects another virtual device", () => {
		expect(isProposeWrite({ path: "xd://other" })).toBe(false);
	});

	test("rejects non-record and missing input", () => {
		expect(isProposeWrite(undefined)).toBe(false);
		expect(isProposeWrite("xd://propose")).toBe(false);
		expect(isProposeWrite({})).toBe(false);
	});
});

describe("proposeDecision — block vs would_block by hasUI", () => {
	const ambiguous = { ambiguity: 0.31, userCanAnswer: 0.9 };

	test("blocks with a UI", () => {
		expect(proposeDecision(ambiguous, GATE_CFG, true)).toBe("block");
	});

	test("records would_block headless instead of blocking", () => {
		expect(proposeDecision(ambiguous, GATE_CFG, false)).toBe("would_block");
	});

	test("a clear task is never gated", () => {
		expect(proposeDecision({ ambiguity: 0.1, userCanAnswer: 0.9 }, GATE_CFG, true)).toBe("none");
	});

	test("ambiguity exactly at the threshold passes", () => {
		expect(proposeDecision({ ambiguity: 0.2, userCanAnswer: 0.9 }, GATE_CFG, true)).toBe("none");
	});

	test("ambiguity the agent could resolve itself is not gated", () => {
		expect(proposeDecision({ ambiguity: 0.6, userCanAnswer: 0.2 }, GATE_CFG, true)).toBe("none");
	});

	test("blockPropose: false disables the gate entirely", () => {
		expect(proposeDecision(ambiguous, { ...GATE_CFG, blockPropose: false }, true)).toBe("none");
	});
});

describe("question drafting", () => {
	test("extracts the entity after an action verb", () => {
		expect(taskEntity("Add a rate limiter to the API")).toBe("rate limiter");
	});

	test("falls back when no verb is present", () => {
		expect(taskEntity("hmm")).toBe("this change");
	});

	test("fills the entity into the dimension/gap template", () => {
		const q = draftQuestion("constraints", "non_goals", "Add a rate limiter to the API");
		expect(q).toBe("What is explicitly out of scope for rate limiter?");
	});

	test("an unknown gap falls back to the dimension's generic template", () => {
		const q = draftQuestion("criteria", "not_a_gap", "Rename the parser module");
		expect(q).toContain("How will we know");
	});
});

describe("gate message rendering", () => {
	const result = {
		ambiguity: 0.46,
		dims: dims(0.5, 0.25, 1, 1),
		weakest: "constraints" as const,
		gap: "scope_boundary",
		userCanAnswer: 0.8,
		question: "What is explicitly out of scope?",
	};

	test("the aside carries score, threshold, weakest, gap and the drafted question", () => {
		const note = buildGateNote(result, 0.2);
		expect(note).toContain('<ambiguity-gate score="0.46" threshold="0.20" weakest="constraints" gap="scope_boundary">');
		expect(note).toContain("What is explicitly out of scope?");
		expect(note).toContain("Use the ask tool");
		expect(note).toContain("</ambiguity-gate>");
	});

	test("the block reason names the numbers, the weakest dimension label, and the question", () => {
		const reason = buildBlockReason({ ...result, weakest: "criteria" }, 0.2);
		expect(reason).toContain("Ambiguity 0.46 > 0.20 (weakest: success criteria)");
		expect(reason).toContain("Ask the user first with the ask tool");
		expect(reason).toContain("Then resubmit");
	});
});

describe("battery shape", () => {
	test("one score and one gap choice per dimension, plus user_can_answer", () => {
		const battery = buildAmbiguityBattery() as Record<string, { type: string; levels?: string[] }>;
		for (const dim of DIMENSIONS) {
			expect(battery[`${dim}_clarity`].type).toBe("score");
			expect(battery[`${dim}_clarity`].levels).toHaveLength(5);
			expect(battery[`gap_${dim}`].type).toBe("choice");
		}
		expect(battery.user_can_answer.type).toBe("noul");
		expect(Object.keys(battery)).toHaveLength(9);
	});
});

describe("scoreAmbiguity", () => {
	const pi = { logger: {} };
	const ctx = {
		models: {
			resolve: () => ({
				provider: "openrouter",
				id: "~typesafe/jev-latest",
				api: "openrouter-decisions",
			}),
		},
		modelRegistry: {},
		sessionManager: { getSessionId: () => "test-session" },
	};

	beforeEach(() => {
		askShouldThrow = false;
		resetAmbiguitySession();
		queuedAnswers = {
			goal_clarity: { type: "score", score: 2 },
			constraints_clarity: { type: "score", score: 1 },
			criteria_clarity: { type: "score", score: 4 },
			context_clarity: { type: "score", score: 4 },
			gap_goal: { type: "choice", choice: "which_surface" },
			gap_constraints: { type: "choice", choice: "non_goals" },
			gap_criteria: { type: "choice", choice: "none" },
			gap_context: { type: "choice", choice: "none" },
			user_can_answer: { type: "noul", noul: 0.82 },
		};
	});

	test("normalizes 0-4 scores to 0..1 and composes the ambiguity", async () => {
		const out = await scoreAmbiguity(pi, { task: "Add a rate limiter to the API" }, GATE_CFG, ctx);
		expect(out).not.toBeNull();
		// clarity = 0.35*0.5 + 0.25*0.25 + 0.25*1 + 0.15*1 = 0.6375
		expect(out!.ambiguity).toBeCloseTo(0.3625, 10);
		expect(out!.dims.goal).toBeCloseTo(0.5, 10);
		expect(out!.userCanAnswer).toBeCloseTo(0.82, 10);
	});

	test("selects the weakest dimension and its gap, and drafts from that pair", async () => {
		const out = await scoreAmbiguity(pi, { task: "Add a rate limiter to the API" }, GATE_CFG, ctx);
		// shortfalls: goal 0.35*0.5=0.175, constraints 0.25*0.75=0.1875 — constraints is weakest.
		expect(out!.weakest).toBe("constraints");
		expect(out!.gap).toBe("non_goals");
		expect(out!.question).toBe("What is explicitly out of scope for rate limiter?");
	});

	test("a Jev failure yields null so the caller decides none and never blocks", async () => {
		askShouldThrow = true;
		expect(await scoreAmbiguity(pi, { task: "anything" }, GATE_CFG, ctx)).toBeNull();
	});

	test("missing answers degrade to zero clarity rather than throwing", async () => {
		queuedAnswers = {};
		const out = await scoreAmbiguity(pi, { task: "anything" }, GATE_CFG, ctx);
		expect(out!.ambiguity).toBeCloseTo(1, 10);
		expect(out!.userCanAnswer).toBe(0);
	});
});

describe("steer dedupe via reviewer's shouldEmit", () => {
	beforeEach(() => {
		resetReviewerSession();
	});

	test("the same weakest dimension only steers once", () => {
		expect(shouldEmit("gate|constraints", 1)).toBe(true);
		expect(shouldEmit("gate|constraints", 1)).toBe(false);
	});

	test("a different weakest dimension steers again", () => {
		expect(shouldEmit("gate|constraints", 1)).toBe(true);
		expect(shouldEmit("gate|criteria", 1)).toBe(true);
	});

	test("resetting the session clears the gate history", () => {
		expect(shouldEmit("gate|goal", 1)).toBe(true);
		resetReviewerSession();
		expect(shouldEmit("gate|goal", 1)).toBe(true);
	});
});

describe("telemetry", () => {
	beforeEach(() => {
		resetAmbiguitySession();
	});

	test("records scores and observed asks in the bench-log shape", () => {
		recordAsk("Which surface?", "The CLI");
		recordScore({
			ts: "2026-01-01T00:00:00.000Z",
			trigger: "propose",
			ambiguity: 0.31,
			dims: dims(0.5, 0.25, 1, 1),
			weakest: "constraints",
			gap: "non_goals",
			userCanAnswer: 0.8,
			decision: "would_block",
		});
		const telemetry = getAmbiguityTelemetry();
		expect(telemetry.asksObserved).toBe(1);
		expect(telemetry.scores).toHaveLength(1);
		expect(telemetry.scores[0]).toEqual({
			ts: "2026-01-01T00:00:00.000Z",
			trigger: "propose",
			ambiguity: 0.31,
			dims: { goal: 0.5, constraints: 0.25, criteria: 1, context: 1 },
			weakest: "constraints",
			gap: "non_goals",
			userCanAnswer: 0.8,
			decision: "would_block",
		});
	});

	test("a fresh session starts empty", () => {
		expect(getAmbiguityTelemetry()).toEqual({ scores: [], asksObserved: 0 });
	});
});
