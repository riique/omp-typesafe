import { ask, choice, noul, score } from "./client";
import type { WireAnswer } from "./client";
import type { AmbiguityGateSettings } from "./config";
import { cap, isRecord } from "./text";

/**
 * Ambiguity gate: a composite clarity score over four weighted dimensions.
 * Jev rates each dimension on a concrete five-level rubric (0-4); the extension
 * turns that into `ambiguity = 1 - sum(w_d * score_d/4)` and, above threshold,
 * pushes the model to call omp's `ask` tool instead of deciding for the user.
 *
 * Everything here is pure except scoreAmbiguity(), which makes exactly one
 * systemOne call through src/client.ts. Nothing in this module throws.
 */

export type Dimension = "goal" | "constraints" | "criteria" | "context";

export const DIMENSIONS: Dimension[] = ["goal", "constraints", "criteria", "context"];

/** Human label used in steer/block text, so "criteria" reads as "success criteria". */
export const DIMENSION_LABEL: Record<Dimension, string> = {
	goal: "goal",
	constraints: "constraints",
	criteria: "success criteria",
	context: "code context",
};

export type GateTrigger = "plan_start" | "turn_end" | "propose";
export type GateDecision = "steer" | "block" | "would_block" | "none";

export interface AmbiguityScore {
	ts: string;
	trigger: GateTrigger;
	/** 0 (fully clear) to 1 (fully ambiguous). */
	ambiguity: number;
	/** Per-dimension clarity, normalized to 0..1. */
	dims: Record<Dimension, number>;
	weakest: Dimension;
	gap: string;
	userCanAnswer: number;
	decision: GateDecision;
}

export interface AmbiguityTelemetry {
	scores: AmbiguityScore[];
	asksObserved: number;
}

// ---- battery -------------------------------------------------------------------

/**
 * Five contrastive levels per dimension. Each level describes an observable state
 * of the task description, so the probability-weighted score divided by 4 is a
 * calibrated 0..1 clarity value rather than a vibe.
 */
const SCORE_LEVELS: Record<Dimension, readonly string[]> = {
	goal: [
		"The primary objective cannot be stated in one sentence at all; it is unclear what would even change",
		"An area is named but not an outcome: the objective is a topic, not a change",
		"An outcome is stated but the entities it acts on are unnamed or interchangeable",
		"A one-sentence objective with named entities, but a qualifier ('better', 'properly', 'like X') still carries the meaning",
		"A one-sentence objective with named entities and concrete verbs, and no qualifier left to interpret",
	],
	constraints: [
		"No boundaries, non-goals, or limits are stated or implied anywhere",
		"Only a vague preference is implied ('keep it simple'); nothing is actually ruled out",
		"One or two boundaries are stated, but the edges of the task are still open-ended",
		"Boundaries and non-goals are stated, but at least one relevant limit (compatibility, scope, dependency) is unaddressed",
		"Boundaries, non-goals, and limits are stated well enough that an out-of-scope change would be recognizable",
	],
	criteria: [
		"No notion of success is present; there is nothing to check against",
		"Success is described only as a feeling or a direction ('works better', 'is cleaner')",
		"Success is described behaviorally but with no observable trigger or expected result",
		"A test could be written for the main path, but the acceptance boundary for edge cases is undefined",
		"A test could be written today: the trigger, the expected result, and the failure condition are all determined",
	],
	context: [
		"The existing code is entirely unexamined; no file, symbol, or structure has been identified",
		"Files have been guessed at by name, but nothing has been read or confirmed",
		"Some relevant code has been read, but the named entities have not been mapped to real code structures",
		"The relevant code and its callers have been read, but one integration point or behavior is still unverified",
		"The relevant code, its callers, and its existing behavior are read and confirmed; every named entity maps to a real code structure",
	],
};

const SCORE_INSTRUCTIONS: Record<Dimension, string> = {
	goal: "How unambiguous is the primary objective and its key entities and relationships?",
	constraints: "How unambiguous are the boundaries, non-goals, and limits of this task?",
	criteria: "Could a test be written today that verifies this task succeeded?",
	context: "Is the existing code understood well enough to change it safely, and do the named entities map to real code structures?",
};

const GAP_OPTIONS: Record<Dimension, Record<string, string>> = {
	goal: {
		which_user: "It is unclear who the change is for, or whose workflow it serves",
		which_surface: "It is unclear which surface, entry point, or component should change",
		scope_boundary: "It is unclear how much of the system the objective is meant to cover",
		none: "The objective has no material gap",
	},
	constraints: {
		hard_limits: "A hard limit (performance, size, dependency, platform) has not been stated",
		non_goals: "It is unstated what is deliberately out of scope",
		compatibility: "It is unstated whether existing behavior or callers must keep working",
		none: "The constraints have no material gap",
	},
	criteria: {
		acceptance_test: "There is no stated observable check that would prove the task done",
		measurable_outcome: "The desired outcome has no measurable target or expected value",
		edge_cases: "The expected behavior at the edges or on failure is unstated",
		none: "The success criteria have no material gap",
	},
	context: {
		which_code: "It is unclear which existing code the change belongs in",
		existing_behavior: "The current behavior being changed has not been established",
		integration_points: "It is unclear what else depends on the code being changed",
		none: "The code context has no material gap",
	},
};

export function buildAmbiguityBattery(): Record<string, unknown> {
	const questions: Record<string, unknown> = {};
	for (const dim of DIMENSIONS) {
		questions[`${dim}_clarity`] = score(SCORE_INSTRUCTIONS[dim], [...SCORE_LEVELS[dim]]);
		questions[`gap_${dim}`] = choice(
			`Which piece is most likely missing from the ${DIMENSION_LABEL[dim]} of this task?`,
			GAP_OPTIONS[dim],
		);
	}
	questions.user_can_answer = noul(
		"The remaining ambiguity is a product or preference decision the user must make, not something the agent could resolve by reading the code.",
		{
			true: "Only the user can settle what remains; reading more code would not resolve it.",
			false: "The agent could resolve what remains by reading or running something.",
		},
	);
	return questions;
}

// ---- composite math ------------------------------------------------------------

export type Weights = Record<Dimension, number>;

/** ambiguity = 1 - sum(w_d * clarity_d), with clarity already normalized to 0..1. */
export function compositeAmbiguity(dims: Record<Dimension, number>, weights: Weights): number {
	let clarity = 0;
	for (const dim of DIMENSIONS) clarity += weights[dim] * clamp01(dims[dim]);
	return clamp01(1 - clarity);
}

/** The dimension with the largest weighted shortfall w_d * (1 - clarity_d). */
export function weakestDimension(dims: Record<Dimension, number>, weights: Weights): Dimension {
	let best: Dimension = DIMENSIONS[0];
	let bestShortfall = -1;
	for (const dim of DIMENSIONS) {
		const shortfall = weights[dim] * (1 - clamp01(dims[dim]));
		if (shortfall > bestShortfall) {
			bestShortfall = shortfall;
			best = dim;
		}
	}
	return best;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

// ---- question drafting ---------------------------------------------------------

const VERB = /\b(add|build|create|implement|rename|refactor|fix|update|remove|delete|support|migrate|change|make)\s+(?:the\s+|a\s+|an\s+)?([A-Za-z0-9_.\-/]+(?:\s+[A-Za-z0-9_.\-/]+)?)/i;

/** First noun-ish phrase after an action verb in the task text; "this change" when none. */
export function taskEntity(task: string): string {
	const match = VERB.exec(task ?? "");
	const phrase = match?.[2]?.trim();
	return phrase && phrase.length > 1 ? cap(phrase, 60) : "this change";
}

const TEMPLATES: Record<Dimension, Record<string, string>> = {
	goal: {
		which_user: "Who is {entity} for — which user or caller should it serve?",
		which_surface: "Which surface should {entity} land on?",
		scope_boundary: "How far should {entity} go — the narrow case only, or everywhere it could apply?",
		none: "What exactly should {entity} do when it is finished?",
	},
	constraints: {
		hard_limits: "Are there hard limits {entity} must respect (performance, dependencies, platform)?",
		non_goals: "What is explicitly out of scope for {entity}?",
		compatibility: "Must the existing behavior around {entity} keep working unchanged?",
		none: "What boundaries should {entity} stay inside?",
	},
	criteria: {
		acceptance_test: "What check would prove {entity} is done correctly?",
		measurable_outcome: "What measurable outcome should {entity} reach?",
		edge_cases: "How should {entity} behave at the edges or on failure?",
		none: "How will we know {entity} succeeded?",
	},
	context: {
		which_code: "Which existing code should {entity} live in?",
		existing_behavior: "What is the current behavior around {entity} meant to be?",
		integration_points: "What else depends on {entity} and must be kept working?",
		none: "Which part of the codebase does {entity} belong to?",
	},
};

/** Deterministic, concrete question the model is told to ask; it may rephrase. */
export function draftQuestion(dimension: Dimension, gap: string, task: string): string {
	const byGap = TEMPLATES[dimension];
	const template = byGap[gap] ?? byGap.none;
	return template.replace("{entity}", taskEntity(task));
}

// ---- propose detection ---------------------------------------------------------

const PROPOSE_PREFIX = "xd://propose";

/** True when a `write` tool call targets the plan-submission virtual device. */
export function isProposeWrite(input: unknown): boolean {
	if (!isRecord(input)) return false;
	for (const key of ["path", "file_path"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim().startsWith(PROPOSE_PREFIX)) return true;
	}
	return false;
}

// ---- per-session state ---------------------------------------------------------

export interface AskRecord {
	question: string;
	answer: string;
}

const asks: AskRecord[] = [];
const scores: AmbiguityScore[] = [];
const ASK_CAP = 32;
const SCORE_CAP = 64;

export function resetAmbiguitySession(): void {
	asks.length = 0;
	scores.length = 0;
}

export function recordAsk(question: string, answer: string): void {
	asks.push({ question: cap(question, 400), answer: cap(answer, 400) });
	if (asks.length > ASK_CAP) asks.shift();
}

export function getAsks(): AskRecord[] {
	return [...asks];
}

export function asksObserved(): number {
	return asks.length;
}

export function recordScore(entry: AmbiguityScore): void {
	scores.push(entry);
	if (scores.length > SCORE_CAP) scores.shift();
}

export function getAmbiguityTelemetry(): AmbiguityTelemetry {
	return { scores: [...scores], asksObserved: asks.length };
}

export function getLastAmbiguityScore(): AmbiguityScore | null {
	return scores.length > 0 ? scores[scores.length - 1] : null;
}

// ---- scoring -------------------------------------------------------------------

export interface AmbiguityState {
	task: string;
	plan_so_far?: string;
	questions_already_asked?: string[];
	answers_received?: string[];
	evidence?: unknown;
}

export interface AmbiguityResult {
	ambiguity: number;
	dims: Record<Dimension, number>;
	weakest: Dimension;
	gap: string;
	userCanAnswer: number;
	question: string;
}

interface AskerLike {
	logger?: { debug?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void };
}

function num(answer: WireAnswer | undefined, key: string): number | null {
	if (!answer) return null;
	const value = answer[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One Jev call producing the composite score. Returns null on any failure so
 * callers treat it as decision "none" and never block on an API problem.
 */
export async function scoreAmbiguity(
	_pi: AskerLike,
	state: AmbiguityState,
	cfg: AmbiguityGateSettings,
): Promise<AmbiguityResult | null> {
	try {
		const { result } = await ask(state as unknown as Record<string, unknown>, buildAmbiguityBattery(), {
			timeoutMs: cfg.timeoutMs,
			maxRetries: 0,
		});
		const answers = result.answers ?? {};
		const dims = {} as Record<Dimension, number>;
		const gaps = {} as Record<Dimension, string>;
		for (const dim of DIMENSIONS) {
			const raw = num(answers[`${dim}_clarity`] as WireAnswer | undefined, "score") ?? 0;
			dims[dim] = clamp01(raw / 4);
			const gapAnswer = answers[`gap_${dim}`] as WireAnswer | undefined;
			gaps[dim] = typeof gapAnswer?.choice === "string" ? gapAnswer.choice : "none";
		}
		const weakest = weakestDimension(dims, cfg.weights);
		const gap = gaps[weakest];
		return {
			ambiguity: compositeAmbiguity(dims, cfg.weights),
			dims,
			weakest,
			gap,
			userCanAnswer: num(answers.user_can_answer as WireAnswer | undefined, "noul") ?? 0,
			question: draftQuestion(weakest, gap, state.task),
		};
	} catch {
		return null;
	}
}

// ---- message rendering ---------------------------------------------------------

export const GATE_CUSTOM_TYPE = "ai.typesafe.ambiguity";

function fmt(value: number): string {
	return value.toFixed(2);
}

/** The `<ambiguity-gate>` aside/steer body sent to the model. */
export function buildGateNote(result: AmbiguityResult, threshold: number): string {
	return (
		`<ambiguity-gate score="${fmt(result.ambiguity)}" threshold="${fmt(threshold)}" ` +
		`weakest="${result.weakest}" gap="${result.gap}">\n` +
		`Ask the user before deciding: ${result.question} ` +
		`Offer 2-4 concrete options. Use the ask tool; do not assume.\n` +
		`</ambiguity-gate>`
	);
}

/**
 * Propose-gate decision: block only with a UI (headless omp has no `ask` tool,
 * so the intent is recorded as would_block and the plan is let through).
 */
export function proposeDecision(
	result: Pick<AmbiguityResult, "ambiguity" | "userCanAnswer">,
	cfg: AmbiguityGateSettings,
	hasUI: boolean,
): GateDecision {
	if (!cfg.blockPropose) return "none";
	if (result.ambiguity <= cfg.threshold) return "none";
	if (result.userCanAnswer < cfg.userCanAnswerFloor) return "none";
	return hasUI ? "block" : "would_block";
}

/** The block reason returned from the propose tool_call hook. */
export function buildBlockReason(result: AmbiguityResult, threshold: number): string {
	return (
		`Ambiguity ${fmt(result.ambiguity)} > ${fmt(threshold)} (weakest: ${DIMENSION_LABEL[result.weakest]}). ` +
		`Ask the user first with the ask tool: ${result.question} Then resubmit the plan.`
	);
}
