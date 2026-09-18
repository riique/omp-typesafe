import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * reviewer.ts unit tests. The `@typesafe-ai/sdk`-backed client wrapper (src/client.ts) is
 * mocked so tests run with no network: `ask` returns a queued, fully controlled answer set,
 * and `noul`/`choice`/`score` are simple pass-through question builders (their exact shape is
 * never inspected by reviewer.ts before it hands them to `ask`). `pi.sendMessage` is a fake
 * recorder so delivery can be asserted without a real omp host.
 */

interface QueuedAnswer {
	type: string;
	[key: string]: unknown;
}

let queuedAnswers: Record<string, QueuedAnswer> = {};
let apiKeyPresentValue = true;

mock.module("../src/client", () => ({
	apiKeyPresent: () => apiKeyPresentValue,
	ask: async (_state: unknown, _questions: unknown, _opts: unknown) => ({
		result: {
			model: "jev-test",
			answers: queuedAnswers,
			usage: { input_tokens: 10, output_tokens: 0 },
		},
		requestId: "test-request",
	}),
	describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
	noul: (instructions: string, opts?: { true?: string; false?: string }) => ({ type: "noul", instructions, ...opts }),
	choice: (instructions: string, criteria: Record<string, string>) => ({ type: "choice", instructions, criteria }),
	score: (instructions: string, levels: readonly string[]) => ({ type: "score", instructions, levels: [...levels] }),
}));

const { review, buildBattery, getLastReviewRecord } = await import("../src/reviewer");
const { resetReviewerSession, beginTurn } = await import("../src/reviewer");

function noulAnswer(value: number, confidence = 0.9): QueuedAnswer {
	return { type: "noul", noul: value, confidence };
}

function scoreAnswer(value: number, confidence = 0.9): QueuedAnswer {
	return { type: "score", score: value, confidence };
}

function choiceAnswer(value: string, confidence = 0.9): QueuedAnswer {
	return { type: "choice", choice: value, confidence };
}

/** Build a full answer set for a battery: all noul ids default to 0, overrides applied on top. */
function answersFor(kind: "action" | "message" | "turn", role: "adversarial" | "advisory", opts: {
	severity: number;
	nouls?: Record<string, number>;
	defect?: string;
}): Record<string, QueuedAnswer> {
	const battery = buildBattery(kind, role);
	const answers: Record<string, QueuedAnswer> = { severity: scoreAnswer(opts.severity) };
	for (const id of battery.noulIds) {
		answers[id] = noulAnswer(opts.nouls?.[id] ?? 0);
	}
	answers[battery.defectKey] = choiceAnswer(opts.defect ?? "none");
	return answers;
}

class FakePi {
	sent: { message: unknown; options: unknown }[] = [];
	logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
	sendMessage(message: unknown, options?: unknown) {
		this.sent.push({ message, options });
		return undefined;
	}
}

function idleCtx(isIdle = false) {
	return { hasUI: false, isIdle: () => isIdle, sessionManager: { getBranch: () => [] } };
}

beforeEach(() => {
	queuedAnswers = {};
	apiKeyPresentValue = true;
	resetReviewerSession();
	beginTurn();
});

describe("severity derivation — adversarial", () => {
	test("low score, no noul above floor -> none, nothing delivered", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 0.5 });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(outcome.decision).toBe("none");
		expect(pi.sent.length).toBe(0);
	});

	test("score in concern band -> concern, delivered", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.6, defect: "unclassified" });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		expect(outcome.severity).toBe("concern");
		expect(outcome.decision).toBe("delivered");
		expect(pi.sent.length).toBe(1);
	});

	test("score in blocker band -> blocker, delivered with triggerTurn", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 2.6 });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(outcome.severity).toBe("blocker");
		expect(outcome.decision).toBe("delivered");
		const opts = pi.sent[0]?.options as Record<string, unknown>;
		expect(opts.triggerTurn).toBe(true);
	});

	test("low score but a noul above the default floor (0.45) -> nit, suppressed by default (emitNits=false)", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 0.2, nouls: { requirement_missed: 0.6 } });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(), {}, "adversarial");
		expect(outcome.severity).toBe("nit");
		expect(outcome.decision).toBe("suppressed");
		expect(outcome.reason).toBe("nits_disabled");
	});
});

describe("severity derivation — advisory", () => {
	test("low score, no noul above floor -> none, nothing delivered", async () => {
		queuedAnswers = answersFor("message", "advisory", { severity: 0.5 });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(), {}, "advisory");
		expect(outcome.decision).toBe("none");
		expect(pi.sent.length).toBe(0);
	});

	test("score in concern band with a fired noul -> concern, delivered as <advisory>", async () => {
		queuedAnswers = answersFor("message", "advisory", {
			severity: 1.6,
			nouls: { missing_consideration: 0.8, on_track: 0.1 },
			defect: "consider_requirement",
		});
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "advisory");
		expect(outcome.severity).toBe("concern");
		expect(outcome.decision).toBe("delivered");
		expect(outcome.note).toContain("<advisory ");
		expect(outcome.note).toContain('advisor="TypeSafe"');
		expect(outcome.note).toContain('theme="consider_requirement"');
		expect(outcome.note).toContain("Consider this before continuing.");
		const sentMsg = pi.sent[0]?.message as Record<string, unknown>;
		expect(sentMsg.customType).toBe("ai.typesafe.advisory");
	});

	test("score in blocker band -> blocker, delivered as <advisory>", async () => {
		queuedAnswers = answersFor("message", "advisory", { severity: 2.6, defect: "consider_requirement" });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(), {}, "advisory");
		expect(outcome.severity).toBe("blocker");
		expect(outcome.note).toContain("<advisory ");
	});
});

describe("on_track suppression (advisory only)", () => {
	test("high on_track drops a concern-level note", async () => {
		queuedAnswers = answersFor("message", "advisory", {
			severity: 1.6,
			nouls: { missing_consideration: 0.8, on_track: 0.9 },
			defect: "consider_requirement",
		});
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "advisory");
		expect(outcome.decision).toBe("none");
		expect(pi.sent.length).toBe(0);
	});

	test("high on_track does NOT drop a blocker-level note", async () => {
		queuedAnswers = answersFor("message", "advisory", {
			severity: 2.6,
			nouls: { missing_consideration: 0.9, on_track: 0.95 },
			defect: "consider_requirement",
		});
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(), {}, "advisory");
		expect(outcome.severity).toBe("blocker");
		expect(outcome.decision).toBe("delivered");
		expect(pi.sent.length).toBe(1);
	});

	test("adversarial role is unaffected by an on_track-shaped answer (no such noul in its battery)", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.6, nouls: { requirement_missed: 0.8 } });
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		expect(outcome.decision).toBe("delivered");
	});
});

describe("both roles route identically for the same severity/context", () => {
	test("concern severity while idle -> nextTurn channel for both roles", async () => {
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.6 });
		const piA = new FakePi();
		const outA = await review(piA, "message", { task: "t" }, idleCtx(true), {}, "adversarial");

		resetReviewerSession();
		beginTurn();
		queuedAnswers = answersFor("message", "advisory", {
			severity: 1.6,
			nouls: { missing_consideration: 0.8, on_track: 0.1 },
			defect: "consider_requirement",
		});
		const piB = new FakePi();
		const outB = await review(piB, "message", { task: "t" }, idleCtx(true), {}, "advisory");

		expect(outA.channel).toBe("nextTurn");
		expect(outB.channel).toBe("nextTurn");
		expect(outA.channel).toBe(outB.channel);
	});

	test("blocker severity while active -> steer + triggerTurn for both roles", async () => {
		queuedAnswers = answersFor("action", "adversarial", { severity: 2.6, nouls: { breaks_contract: 0.9 } });
		const piA = new FakePi();
		const outA = await review(piA, "action", { task: "t" }, idleCtx(false), { toolCallId: "1" }, "adversarial");

		resetReviewerSession();
		beginTurn();
		queuedAnswers = answersFor("action", "advisory", { severity: 2.6, nouls: { related_update_needed: 0.9 } });
		const piB = new FakePi();
		const outB = await review(piB, "action", { task: "t" }, idleCtx(false), { toolCallId: "1" }, "advisory");

		expect(outA.channel).toBe("steer");
		expect(outB.channel).toBe("steer");
		const optsA = piA.sent[0]?.options as Record<string, unknown>;
		const optsB = piB.sent[0]?.options as Record<string, unknown>;
		expect(optsA.triggerTurn).toBe(true);
		expect(optsB.triggerTurn).toBe(true);
	});

	test("plan mode forces aside for both roles", async () => {
		const planEntries = [{ type: "custom_message", customType: "plan-mode-context", content: "" }];
		const planCtx = { hasUI: false, isIdle: () => false, sessionManager: { getBranch: () => planEntries } };

		queuedAnswers = answersFor("message", "adversarial", { severity: 2.6 });
		const piA = new FakePi();
		const outA = await review(piA, "message", { task: "t" }, planCtx, {}, "adversarial");

		resetReviewerSession();
		beginTurn();
		queuedAnswers = answersFor("message", "advisory", { severity: 2.6, defect: "consider_requirement" });
		const piB = new FakePi();
		const outB = await review(piB, "message", { task: "t" }, planCtx, {}, "advisory");

		expect(outA.channel).toBe("aside");
		expect(outB.channel).toBe("aside");
	});
});

describe("adversarial note format is unchanged", () => {
	test("note matches the documented <adversarial-note> shape exactly", async () => {
		queuedAnswers = {
			severity: scoreAnswer(1.6, 0.63),
			unsupported_claim: noulAnswer(0),
			requirement_missed: noulAnswer(0),
			risky_api: noulAnswer(0),
			weak_verification: noulAnswer(0),
			unnecessary_complexity: noulAnswer(0),
			defect_class: choiceAnswer("weak_verification", 0.8),
		};
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		expect(outcome.note).toBe(
			'<adversarial-note severity="concern" defect="weak_verification" guidance="weigh, don\'t blindly obey" confidence="0.63">\n' +
				"Adversarial review of the last response flags weak_verification. Verify or refute before building on this.\n" +
				"</adversarial-note>",
		);
		const sentMsg = pi.sent[0]?.message as Record<string, unknown>;
		expect(sentMsg.customType).toBe("ai.typesafe.adversary");
	});
});

describe("env / role wiring at the review() boundary", () => {
	test("role is taken from the explicit parameter, not any ambient config", async () => {
		queuedAnswers = answersFor("turn", "advisory", { severity: 1.6, nouls: { should_clarify: 0.7 }, defect: "clarify_with_user" });
		const pi = new FakePi();
		const outcome = await review(pi, "turn", { task: "t" }, idleCtx(true), {}, "advisory");
		expect(outcome.note).toContain("<advisory ");
		const sentMsg = pi.sent[0]?.message as Record<string, unknown>;
		expect(sentMsg.customType).toBe("ai.typesafe.advisory");
	});

	test("every ReviewRecord carries the role that produced it", async () => {
		queuedAnswers = answersFor("message", "advisory", { severity: 1.6, nouls: { should_clarify: 0.7 }, defect: "clarify_with_user" });
		const pi = new FakePi();
		await review(pi, "message", { task: "t" }, idleCtx(true), {}, "advisory");
		expect(getLastReviewRecord()?.role).toBe("advisory");

		resetReviewerSession();
		beginTurn();
		queuedAnswers = answersFor("message", "adversarial", { severity: 1.6 });
		const pi2 = new FakePi();
		await review(pi2, "message", { task: "t" }, idleCtx(true), {}, "adversarial");
		expect(getLastReviewRecord()?.role).toBe("adversarial");
	});

	test("role is recorded even on suppressed/none/error outcomes", async () => {
		apiKeyPresentValue = false;
		const pi = new FakePi();
		await review(pi, "message", { task: "t" }, idleCtx(), {}, "advisory");
		expect(getLastReviewRecord()?.role).toBe("advisory");
		apiKeyPresentValue = true;
	});

	test("no API key -> suppressed, no ask/sendMessage call regardless of role", async () => {
		apiKeyPresentValue = false;
		const pi = new FakePi();
		const outcome = await review(pi, "message", { task: "t" }, idleCtx(), {}, "advisory");
		expect(outcome.decision).toBe("suppressed");
		expect(outcome.reason).toBe("no_api_key");
		expect(pi.sent.length).toBe(0);
	});
});
