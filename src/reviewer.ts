import { apiKeyPresent, ask, describeError, choice, noul, score } from "./client";
import type { WireAnswer } from "./client";
import { getConfig } from "./config";
import type { TypesafeRole } from "./config";
import { planModeActive, scanBranch } from "./branch";
import type { EntryView } from "./branch";
import { cap, escapeAttr, fmt2 } from "./text";
import { formatEvidenceAttribute } from "./evidence";
import type { Evidence } from "./evidence";

/**
 * Reviewer core: batteries, severity derivation, emission guard, delivery.
 * Every trigger funnels through review(); failures never propagate.
 */

export type ReviewKind = "action" | "message" | "turn";
export type Severity = "nit" | "concern" | "blocker";

const SEVERITY_LEVELS = [
	"Nothing to raise",
	"Nit: cleanup, simplification, or a low-risk edge case",
	"Concern: material risk, missed constraint, or likely wrong direction",
	"Blocker: continuing will waste work or produce a broken result",
] as const;

// Native advisor's own severity vocabulary (verbatim from omp://advisor-watchdog.md's `advise`
// tool table), used for the advisory role so both roles map onto the same delivery table.
const ADVISORY_SEVERITY_LEVELS = [
	"Nothing to add",
	"Nit: cleanup, simplification, or a low-risk edge case",
	"Concern: material risk, likely wrong direction, missing constraint, or hallucinated API",
	"Blocker: continuing would clearly waste work or produce broken output",
] as const;

const ADVISORY_THEMES: Record<string, string> = {
	none: "Nothing notable",
	verify_first: "A cheap check would raise confidence before continuing",
	simplify: "A materially simpler approach exists",
	update_callers: "Another file, caller, test, or doc needs a matching change",
	clarify_with_user: "Worth confirming an ambiguity with the user",
	consider_requirement: "A requirement or constraint has not yet been considered",
};

interface NoulDef {
	id: string;
	instructions: string;
	whenTrue: string;
	whenFalse: string;
}

const SHARED_NOULS: Record<string, NoulDef> = {
	breaks_contract: {
		id: "breaks_contract",
		instructions: "This change breaks an existing caller, interface, or test that depended on the previous behavior.",
		whenTrue: "A caller, interface, or test relied on the previous behavior and now breaks.",
		whenFalse: "No existing caller, interface, or test breaks.",
	},
	unfounded_assumption: {
		id: "unfounded_assumption",
		instructions: "The action relies on an assumption about the codebase that was not verified by reading or running something first.",
		whenTrue: "The action acted on an unchecked belief about the codebase.",
		whenFalse: "Every assumption was verified by reading or running something first.",
	},
	incomplete_cutover: {
		id: "incomplete_cutover",
		instructions: "The change leaves the codebase half-migrated — old and new paths coexist, or callers were missed.",
		whenTrue: "Old and new paths coexist or callers were missed.",
		whenFalse: "The migration is complete or no migration was involved.",
	},
	not_what_was_asked: {
		id: "not_what_was_asked",
		instructions: "The action does not serve the user's stated task, or solves a different problem.",
		whenTrue: "The action serves a different problem than the user's stated task.",
		whenFalse: "The action serves the user's stated task.",
	},
	unverified_claim: {
		id: "unverified_claim",
		instructions: "The action's result is being treated as success without evidence that it actually works.",
		whenTrue: "Success is treated as established without evidence it works.",
		whenFalse: "The result is backed by actual evidence.",
	},
	hidden_destruction: {
		id: "hidden_destruction",
		instructions: "The action discarded work, data, or history that was not meant to be discarded.",
		whenTrue: "Work, data, or history was discarded that was not meant to be discarded.",
		whenFalse: "Nothing was discarded beyond what was intended.",
	},
	unsupported_claim: {
		id: "unsupported_claim",
		instructions: "The message asserts something about the code or its behavior that was not established by a command, test, or file that was actually read.",
		whenTrue: "The assertion was not established by a command, test, or file actually read.",
		whenFalse: "The assertion is backed by established evidence.",
	},
	requirement_missed: {
		id: "requirement_missed",
		instructions: "The message overlooks a requirement or constraint the user stated.",
		whenTrue: "A stated requirement or constraint is overlooked.",
		whenFalse: "All stated requirements are addressed.",
	},
	risky_api: {
		id: "risky_api",
		instructions: "The message proposes or relies on a dangerous, deprecated, or easily misused API or pattern.",
		whenTrue: "A dangerous, deprecated, or easily misused API or pattern is involved.",
		whenFalse: "No dangerous or deprecated pattern is involved.",
	},
	weak_verification: {
		id: "weak_verification",
		instructions: "The verification described is too weak to support the conclusion drawn.",
		whenTrue: "The verification is too weak to support the conclusion.",
		whenFalse: "The verification supports the conclusion.",
	},
	unnecessary_complexity: {
		id: "unnecessary_complexity",
		instructions: "The approach is more complex than the task requires.",
		whenTrue: "The approach is more complex than the task requires.",
		whenFalse: "The complexity matches the task.",
	},
	silent_scope_reduction: {
		id: "silent_scope_reduction",
		instructions: "The assistant narrowed the task or skipped requested work without saying so.",
		whenTrue: "The task was narrowed or requested work was skipped without saying so.",
		whenFalse: "The requested scope was preserved or the change was stated.",
	},
	worth_checking: {
		id: "worth_checking",
		instructions: "A cheap check (reading a file, running a test, grepping for callers) would raise confidence in this step and has not been done yet.",
		whenTrue: "A cheap check would raise confidence in this step and has not been done.",
		whenFalse: "The step is already backed by an adequate check, or none is needed.",
	},
	simpler_alternative: {
		id: "simpler_alternative",
		instructions: "A materially simpler approach to this step exists and would satisfy the user's task equally well.",
		whenTrue: "A materially simpler approach exists that would satisfy the task equally well.",
		whenFalse: "No materially simpler approach exists.",
	},
	related_update_needed: {
		id: "related_update_needed",
		instructions: "Another file, caller, test, or doc will need a matching change for this step to be complete.",
		whenTrue: "Another file, caller, test, or doc will need a matching change for this step to be complete.",
		whenFalse: "No related file, caller, test, or doc needs a matching change.",
	},
	should_clarify: {
		id: "should_clarify",
		instructions: "The task has an ambiguity that is worth confirming with the user before more work builds on the current interpretation.",
		whenTrue: "The task has an ambiguity worth confirming with the user before more work builds on it.",
		whenFalse: "The task is unambiguous enough to proceed without confirming.",
	},
	missing_consideration: {
		id: "missing_consideration",
		instructions: "A relevant requirement, edge case, or constraint from the task has not yet been considered.",
		whenTrue: "A relevant requirement, edge case, or constraint has not yet been considered.",
		whenFalse: "All relevant requirements, edge cases, and constraints have been considered.",
	},
	on_track: {
		id: "on_track",
		instructions: "The current step is a sound, direct move toward the user's stated task.",
		whenTrue: "The current step is a sound, direct move toward the user's stated task.",
		whenFalse: "The current step is not a sound, direct move toward the user's stated task.",
	},
};

const ACTION_NOUL_IDS = ["breaks_contract", "unfounded_assumption", "incomplete_cutover", "not_what_was_asked", "unverified_claim", "hidden_destruction"];
const MESSAGE_NOUL_IDS = ["unsupported_claim", "requirement_missed", "risky_api", "weak_verification", "unnecessary_complexity"];
const TURN_NOUL_IDS = ["requirement_missed", "weak_verification", "unnecessary_complexity", "silent_scope_reduction", "risky_api"];

// Advisory batteries mirror omp's native advisor question shape: on_track is a positive-polarity
// noul (high value = sound step) and is excluded from severity-escalation bookkeeping below.
const ADVISORY_ACTION_NOUL_IDS = ["worth_checking", "simpler_alternative", "related_update_needed", "on_track"];
const ADVISORY_MESSAGE_NOUL_IDS = ["should_clarify", "missing_consideration", "simpler_alternative", "on_track"];
const ADVISORY_TURN_NOUL_IDS = ["missing_consideration", "related_update_needed", "simpler_alternative", "should_clarify", "on_track"];
const ON_TRACK_SUPPRESS_FLOOR = 0.75;

const ACTION_DEFECTS: Record<string, string> = {
	none: "Routine, sound action",
	contract_break: "Breaks an existing caller or interface",
	missed_callsite: "Left references to the old behavior",
	unverified_assumption: "Acted on an unchecked belief about the code",
	scope_drift: "Outside the requested task",
	data_loss: "Discarded work or history",
	test_gap: "Behavior change with no exercised check",
};

const EXTENDED_DEFECTS: Record<string, string> = {
	...ACTION_DEFECTS,
	weak_verification: "Verification too weak for the claim",
	overcomplication: "More complex than needed",
};

const SEVERITY_ORDER: Record<Severity, number> = { nit: 0, concern: 1, blocker: 2 };

const KIND_NOUN: Record<ReviewKind, string> = { action: "action", message: "response", turn: "turn" };

const SEVERITY_INSTRUCTION: Record<ReviewKind, string> = {
	action: "Rate the most serious defect present in this action.",
	message: "Rate the most serious defect present in this response.",
	turn: "Rate the most serious defect present in this turn's delta.",
};

const CONTENT_FREE_NOTES = new Set(["stop", "done", "complete", "no issue", "no issues continue", "lgtm", "nothing to add"]);
const NOTE_HISTORY_CAP = 256;
const RING_BUFFER_CAP = 50;
const MAX_MESSAGE_REVIEWS_PER_TURN = 3;

export interface UiLike {
	notify(message: string, level?: string): unknown;
}

export interface CtxLike {
	hasUI?: boolean;
	ui?: UiLike;
	isIdle?: () => boolean;
	sessionManager?: { getBranch?: () => unknown };
}

export interface PiLike {
	sendMessage(message: unknown, options?: unknown): unknown;
	logger?: {
		debug?: (...a: unknown[]) => void;
		info?: (...a: unknown[]) => void;
		warn?: (...a: unknown[]) => void;
		error?: (...a: unknown[]) => void;
	};
}

export interface ReviewOutcome {
	severity: Severity | "none";
	note?: string;
	decision: "delivered" | "delivered_inline" | "suppressed" | "none" | "error";
	channel?: "aside" | "steer" | "nextTurn";
	reason?: string;
}

export interface ReviewRecord {
	ts: string;
	kind: ReviewKind;
	role: TypesafeRole;
	toolCallId?: string;
	severity: Severity | "none";
	decision: ReviewOutcome["decision"];
	channel?: string;
	reason?: string;
	fired?: string[];
	defect?: string;
	scores?: Record<string, number>;
	stateSummary?: Record<string, string>;
	note?: string;
	error?: string;
	usage: { inputTokens: number; outputTokens: number };
}

// ---- per-session mutable state -------------------------------------------------

const ringBuffer: ReviewRecord[] = [];
const noteHistory: { key: string; sev: number }[] = [];
const stats = {
	delivered: { nit: 0, concern: 0, blocker: 0 },
	suppressed: {} as Record<string, number>,
	downgraded: 0,
	errors: 0,
	steers: 0,
};
let callsThisTurn = 0;
let messageReviewsThisTurn = 0;
let immuneRemaining = 0;
let unavailableNotified = false;

export function resetReviewerSession(): void {
	ringBuffer.length = 0;
	noteHistory.length = 0;
	stats.delivered.nit = 0;
	stats.delivered.concern = 0;
	stats.delivered.blocker = 0;
	for (const key of Object.keys(stats.suppressed)) delete stats.suppressed[key];
	stats.downgraded = 0;
	stats.errors = 0;
	stats.steers = 0;
	callsThisTurn = 0;
	messageReviewsThisTurn = 0;
	immuneRemaining = 0;
	unavailableNotified = false;
}

/** Consume one unit of the per-turn call budget; false when exhausted. */
export function consumeCallBudget(): boolean {
	const max = getConfig().adversary.maxCallsPerTurn;
	if (callsThisTurn >= max) return false;
	callsThisTurn += 1;
	return true;
}

export function beginTurn(): void {
	callsThisTurn = 0;
	messageReviewsThisTurn = 0;
}

/** Permit another message review this turn? */
export function canReviewMessage(): boolean {
	return messageReviewsThisTurn < MAX_MESSAGE_REVIEWS_PER_TURN;
}

export function recordMessageReviewed(): void {
	messageReviewsThisTurn += 1;
}

/** Turn completed: decrement the steer-immunity counter. */
export function endTurn(): void {
	if (immuneRemaining > 0) immuneRemaining -= 1;
}

/**
 * Shared emission guard over the note-history ring: true when a note with this
 * semantic key has not been emitted before at an equal or higher severity.
 * Records the key on success, so callers must only call it when about to emit.
 * Used by the reviewer's own dedupe and by the ambiguity gate (key `gate|<dim>`).
 */
export function shouldEmit(key: string, sev: number): boolean {
	const priorHighest = noteHistory
		.filter((h) => h.key === key)
		.reduce<number | null>((acc, h) => (acc === null || h.sev > acc ? h.sev : acc), null);
	if (priorHighest !== null && priorHighest >= sev) return false;
	noteHistory.push({ key, sev });
	if (noteHistory.length > NOTE_HISTORY_CAP) noteHistory.shift();
	return true;
}

/** True while a recent steer's immunity window is still open. */
export function isSteerImmune(): boolean {
	return immuneRemaining > 0;
}

export function getReviewHistory(): ReviewRecord[] {
	return [...ringBuffer];
}

export function getLastReviewRecord(): ReviewRecord | null {
	return ringBuffer.length > 0 ? ringBuffer[ringBuffer.length - 1] : null;
}

export function getReviewStats(): typeof stats {
	return {
		delivered: { ...stats.delivered },
		suppressed: { ...stats.suppressed },
		downgraded: stats.downgraded,
		errors: stats.errors,
		steers: stats.steers,
	};
}

// ---- batteries -----------------------------------------------------------------

function noulQuestions(ids: string[]) {
	const questions: Record<string, unknown> = {};
	for (const id of ids) {
		const def = SHARED_NOULS[id];
		questions[id] = noul(def.instructions, { true: def.whenTrue, false: def.whenFalse });
	}
	return questions;
}

export interface Battery {
	questions: Record<string, unknown>;
	/** All noul ids in the battery, including on_track for advisory (used to build the state). */
	noulIds: string[];
	/** noulIds minus on_track — the ids that participate in severity/fired escalation. */
	escalationNoulIds: string[];
	/** "theme" for advisory, "defect_class" for adversarial — the choice question's id. */
	defectKey: "defect_class" | "theme";
	severityLevels: readonly string[];
}

/** Build the full question battery for a review kind and role. */
export function buildBattery(kind: ReviewKind, role: TypesafeRole = "adversarial"): Battery {
	if (role === "advisory") {
		const noulIds =
			kind === "action" ? ADVISORY_ACTION_NOUL_IDS : kind === "message" ? ADVISORY_MESSAGE_NOUL_IDS : ADVISORY_TURN_NOUL_IDS;
		const escalationNoulIds = noulIds.filter((id) => id !== "on_track");
		const questions = {
			...noulQuestions(noulIds),
			severity: score(SEVERITY_INSTRUCTION[kind], [...ADVISORY_SEVERITY_LEVELS]),
			theme: choice("Which best describes what's worth raising, if anything?", ADVISORY_THEMES),
		};
		return { questions, noulIds, escalationNoulIds, defectKey: "theme", severityLevels: ADVISORY_SEVERITY_LEVELS };
	}
	const noulIds = kind === "action" ? ACTION_NOUL_IDS : kind === "message" ? MESSAGE_NOUL_IDS : TURN_NOUL_IDS;
	const defectCriteria = kind === "action" ? ACTION_DEFECTS : EXTENDED_DEFECTS;
	const questions = {
		...noulQuestions(noulIds),
		severity: score(SEVERITY_INSTRUCTION[kind], [...SEVERITY_LEVELS]),
		defect_class: choice("Which best describes the defect, if any?", defectCriteria),
	};
	return { questions, noulIds, escalationNoulIds: noulIds, defectKey: "defect_class", severityLevels: SEVERITY_LEVELS };
}

// ---- severity + guard ----------------------------------------------------------

function normalizeNote(text: string): string {
	return text.toLowerCase().normalize("NFKC").replace(/[^a-z0-9]+/g, " ").trim();
}

function numField(answer: WireAnswer | undefined, key: string): number | null {
	if (!answer) return null;
	const value = answer[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Extract a noul probability from a wire answer; null when absent. */
export function extractNoul(answer: WireAnswer | undefined): number | null {
	return numField(answer, "noul");
}

function record(pi: PiLike, kind: ReviewKind, entry: Omit<ReviewRecord, "ts" | "kind" | "usage">, usage: { inputTokens: number; outputTokens: number }): ReviewRecord {
	const full: ReviewRecord = { ts: new Date().toISOString(), kind, usage, ...entry };
	ringBuffer.push(full);
	if (ringBuffer.length > RING_BUFFER_CAP) ringBuffer.shift();
	pi.logger?.debug?.(`[typesafe] review kind=${kind} decision=${full.decision} severity=${full.severity}${full.reason ? ` reason=${full.reason}` : ""}${full.channel ? ` channel=${full.channel}` : ""}${full.toolCallId ? ` tool=${full.toolCallId}` : ""}`);
	return full;
}

function bumpSuppressed(reason: string): void {
	stats.suppressed[reason] = (stats.suppressed[reason] ?? 0) + 1;
}

function buildNote(kind: ReviewKind, severity: Severity, defect: string, fired: { id: string; value: number }[], confidence: number | null, evidenceText: string | undefined): string {
	const attrs: string[] = [
		`severity="${severity}"`,
		`defect="${escapeAttr(defect)}"`,
		'guidance="weigh, don\'t blindly obey"',
	];
	for (const f of fired) attrs.push(`${f.id}="${fmt2(f.value)}"`);
	if (confidence !== null) attrs.push(`confidence="${fmt2(confidence)}"`);
	if (evidenceText) attrs.push(`evidence="${escapeAttr(evidenceText)}"`);
	const firedNames = fired.map((f) => f.id).join(", ");
	const claim = `Adversarial review of the last ${KIND_NOUN[kind]} flags ${defect}${firedNames ? ` (${firedNames})` : ""}.`;
	return `<adversarial-note ${attrs.join(" ")}>\n${claim} Verify or refute before building on this.\n</adversarial-note>`;
}

/** Advisory role's note — mirrors omp's native `<advisory>` element shape exactly. */
function buildAdvisoryNote(kind: ReviewKind, severity: Severity, theme: string, fired: { id: string; value: number }[], confidence: number | null, evidenceText: string | undefined): string {
	const attrs: string[] = [
		'advisor="TypeSafe"',
		`severity="${severity}"`,
		'guidance="weigh, don\'t blindly obey"',
		`theme="${escapeAttr(theme)}"`,
	];
	for (const f of fired) attrs.push(`${f.id}="${fmt2(f.value)}"`);
	if (confidence !== null) attrs.push(`confidence="${fmt2(confidence)}"`);
	if (evidenceText) attrs.push(`evidence="${escapeAttr(evidenceText)}"`);
	const firedNames = fired.map((f) => f.id).join(", ");
	const top = fired.reduce<{ id: string; value: number } | null>((acc, f) => (acc === null || f.value > acc.value ? f : acc), null);
	const topDef = top ? SHARED_NOULS[top.id] : undefined;
	const claim = topDef
		? `${topDef.whenTrue} (${top!.id}).`
		: `TypeSafe advisory review of the last ${KIND_NOUN[kind]} raises ${theme}${firedNames ? ` (${firedNames})` : ""}.`;
	return `<advisory ${attrs.join(" ")}>\n${claim} Consider this before continuing.\n</advisory>`;
}

function routeDelivery(kind: ReviewKind, severity: Severity, entries: EntryView[], ctx: CtxLike): { channel: "aside" | "steer" | "nextTurn"; triggerTurn: boolean; immuneDowngrade: boolean } {
	let channel: "aside" | "steer" | "nextTurn";
	let triggerTurn = false;
	if (severity === "nit") {
		channel = "aside";
	} else if (severity === "blocker") {
		channel = "steer";
		triggerTurn = true;
	} else {
		channel = ctx.isIdle?.() === true ? "nextTurn" : "steer";
	}
	// Mid tool batch: only a blocker may steer.
	if (kind === "action" && channel === "steer" && severity !== "blocker") channel = "aside";
	// Plan mode: nothing steers.
	if (planModeActive(entries)) {
		if (channel !== "aside") channel = "aside";
		triggerTurn = false;
	}
	// Immune turns: downgrades steer to aside until turns have completed.
	let immuneDowngrade = false;
	if (channel === "steer" && immuneRemaining > 0) {
		channel = "aside";
		triggerTurn = false;
		immuneDowngrade = true;
	}
	return { channel, triggerTurn, immuneDowngrade };
}

export interface ReviewOpts {
	toolCallId?: string;
	/** Evidence object collected by evidence.ts; also carried inside `state` for the model. */
	evidence?: Evidence;
}

/**
 * Run one review: build the battery, ask Jev, derive severity, guard, deliver.
 * Never throws; all outcomes are recorded in the ring buffer.
 */
export async function review(pi: PiLike, kind: ReviewKind, state: Record<string, unknown>, ctx: CtxLike, opts: ReviewOpts = {}, role: TypesafeRole = "adversarial"): Promise<ReviewOutcome> {
	const cfg = getConfig().adversary;
	const toolCallId = opts.toolCallId;
	const stateSummary: Record<string, string> = {};
	for (const [key, value] of Object.entries(state)) {
		if (typeof value === "string") stateSummary[key] = `${value.length} chars`;
		else stateSummary[key] = cap(JSON.stringify(value) ?? "object", 80);
	}
	const blank = { stateSummary, role, ...(toolCallId ? { toolCallId } : {}) };
	let nonBlockerEmittedThisUpdate = 0;
	try {
		if (!apiKeyPresent()) {
			bumpSuppressed("no_api_key");
			record(pi, kind, { severity: "none", decision: "suppressed", reason: "no_api_key", ...blank }, { inputTokens: 0, outputTokens: 0 });
			return { severity: "none", decision: "suppressed", reason: "no_api_key" };
		}
		if (!consumeCallBudget()) {
			bumpSuppressed("call_budget");
			record(pi, kind, { severity: "none", decision: "suppressed", reason: "call_budget", ...blank }, { inputTokens: 0, outputTokens: 0 });
			return { severity: "none", decision: "suppressed", reason: "call_budget" };
		}
		const battery = buildBattery(kind, role);
		const { result } = await ask(state, battery.questions, { timeoutMs: cfg.timeoutMs, maxRetries: 0 });
		const usage = { inputTokens: result.usage?.input_tokens ?? 0, outputTokens: result.usage?.output_tokens ?? 0 };
		const answers = result.answers ?? {};
		const severityAnswer = answers.severity as WireAnswer | undefined;
		const sevScore = numField(severityAnswer, "score") ?? 0;
		const severity: Severity | "none" =
			sevScore >= cfg.blocker_severity ? "blocker" : sevScore >= cfg.concern_severity ? "concern" : "pending";
		let maxNoul = 0;
		const fired: { id: string; value: number }[] = [];
		for (const id of battery.escalationNoulIds) {
			const value = extractNoul(answers[id] as WireAnswer | undefined) ?? 0;
			if (value > maxNoul) maxNoul = value;
			if (value >= cfg.noul_floor) fired.push({ id, value });
		}
		let finalSeverity: Severity | "none" = severity === "pending" ? (maxNoul >= cfg.noul_floor ? "nit" : "none") : severity;
		const defectAnswer = answers[battery.defectKey] as WireAnswer | undefined;
		const rawDefect = typeof defectAnswer?.choice === "string" ? defectAnswer.choice : "unclassified";
		const defectConfidence = numField(defectAnswer, "confidence");
		const defect = rawDefect !== "none" && defectConfidence !== null && defectConfidence >= 0.5 ? rawDefect : "unclassified";
		const severityConfidence = numField(severityAnswer, "confidence");
		const scores: Record<string, number> = { severity: sevScore };
		for (const f of fired) scores[f.id] = f.value;

		// Advisory-only: a step the reviewer agrees is sound suppresses anything below a blocker.
		if (role === "advisory" && finalSeverity !== "none" && finalSeverity !== "blocker") {
			const onTrack = extractNoul(answers.on_track as WireAnswer | undefined) ?? 0;
			scores.on_track = onTrack;
			if (onTrack >= ON_TRACK_SUPPRESS_FLOOR) finalSeverity = "none";
		}

		if (finalSeverity === "none") {
			record(pi, kind, { severity: "none", decision: "none", scores, defect, ...blank }, usage);
			return { severity: "none", decision: "none" };
		}
		if (finalSeverity === "nit" && !cfg.emitNits) {
			bumpSuppressed("nits_disabled");
			record(pi, kind, { severity: "nit", decision: "suppressed", reason: "nits_disabled", scores, defect, fired: fired.map((f) => f.id), ...blank }, usage);
			return { severity: "nit", decision: "suppressed", reason: "nits_disabled" };
		}

		const evidenceAttr = opts.evidence ? formatEvidenceAttribute(opts.evidence) : undefined;
		const note =
			role === "advisory"
				? buildAdvisoryNote(kind, finalSeverity, defect, fired, severityConfidence, evidenceAttr)
				: buildNote(kind, finalSeverity, defect, fired, severityConfidence, evidenceAttr);

		const norm = normalizeNote(note);
		if (CONTENT_FREE_NOTES.has(norm) || norm.length < 20) {
			bumpSuppressed("content_free");
			record(pi, kind, { severity: finalSeverity, decision: "suppressed", reason: "content_free", scores, defect, ...blank }, usage);
			return { severity: finalSeverity, decision: "suppressed", reason: "content_free" };
		}
		// Severity-aware dedupe on the semantic content (kind + which questions fired),
		// not the exact text — probability drift between cycles must not revive a note.
		// A strictly higher severity than any prior note with the same key passes once
		// (genuine escalation nit → concern → blocker).
		const semanticKey = `${kind}|${fired.map((f) => f.id).sort().join(",")}`;
		const priorHighest = noteHistory
			.filter((h) => h.key === semanticKey)
			.reduce<number | null>((acc, h) => (acc === null || h.sev > acc ? h.sev : acc), null);
		if (priorHighest !== null && priorHighest >= SEVERITY_ORDER[finalSeverity]) {
			bumpSuppressed("duplicate");
			record(pi, kind, { severity: finalSeverity, decision: "suppressed", reason: "duplicate", scores, defect, ...blank }, usage);
			return { severity: finalSeverity, decision: "suppressed", reason: "duplicate" };
		}
		// Per-update budget: non-blocker notes are capped per review update; blockers exempt.
		if (finalSeverity !== "blocker" && nonBlockerEmittedThisUpdate >= cfg.maxNotesPerUpdate) {
			bumpSuppressed("update_budget");
			record(pi, kind, { severity: finalSeverity, decision: "suppressed", reason: "update_budget", scores, defect, ...blank }, usage);
			return { severity: finalSeverity, decision: "suppressed", reason: "update_budget" };
		}
		const branchEntries = scanBranch(ctx.sessionManager?.getBranch?.());
		const routed = routeDelivery(kind, finalSeverity, branchEntries, ctx);
		if (routed.immuneDowngrade) stats.downgraded += 1;

		noteHistory.push({ key: semanticKey, sev: SEVERITY_ORDER[finalSeverity] });
		if (noteHistory.length > NOTE_HISTORY_CAP) noteHistory.shift();

		const options: Record<string, unknown> = { deliverAs: routed.channel };
		if (routed.triggerTurn) options.triggerTurn = true;
		await pi.sendMessage({ customType: role === "advisory" ? "ai.typesafe.advisory" : "ai.typesafe.adversary", content: note, display: true, attribution: "agent" }, options);
		if (finalSeverity !== "blocker") nonBlockerEmittedThisUpdate += 1;
		stats.delivered[finalSeverity] += 1;
		if (routed.channel === "steer") {
			stats.steers += 1;
			immuneRemaining = cfg.immuneTurns;
		}
		record(pi, kind, { severity: finalSeverity, decision: "delivered", channel: routed.channel, scores, defect, fired: fired.map((f) => f.id), note, ...blank }, usage);
		return { severity: finalSeverity, note, decision: "delivered", channel: routed.channel };
	} catch (err) {
		stats.errors += 1;
		pi.logger?.warn?.(`[typesafe] review failed (${kind}): ${describeError(err)}`);
		if (!unavailableNotified) {
			unavailableNotified = true;
			if (ctx.hasUI === true && ctx.ui) ctx.ui.notify("TypeSafe adversary unavailable", "warn");
		}
		record(pi, kind, { severity: "none", decision: "error", error: describeError(err), ...blank }, { inputTokens: 0, outputTokens: 0 });
		return { severity: "none", decision: "error", reason: describeError(err) };
	}
}

