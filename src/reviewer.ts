import { apiKeyPresent, ask, describeError, choice, noul, score } from "./client";
import type { WireAnswer } from "./client";
import { getConfig } from "./config";
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
};

const ACTION_NOUL_IDS = ["breaks_contract", "unfounded_assumption", "incomplete_cutover", "not_what_was_asked", "unverified_claim", "hidden_destruction"];
const MESSAGE_NOUL_IDS = ["unsupported_claim", "requirement_missed", "risky_api", "weak_verification", "unnecessary_complexity"];
const TURN_NOUL_IDS = ["requirement_missed", "weak_verification", "unnecessary_complexity", "silent_scope_reduction", "risky_api"];

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

/** Build the full question battery for a review kind. */
export function buildBattery(kind: ReviewKind) {
	const noulIds = kind === "action" ? ACTION_NOUL_IDS : kind === "message" ? MESSAGE_NOUL_IDS : TURN_NOUL_IDS;
	const defectCriteria = kind === "action" ? ACTION_DEFECTS : EXTENDED_DEFECTS;
	const questions = {
		...noulQuestions(noulIds),
		severity: score(SEVERITY_INSTRUCTION[kind], [...SEVERITY_LEVELS]),
		defect_class: choice("Which best describes the defect, if any?", defectCriteria),
	};
	return { questions, noulIds };
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
export async function review(pi: PiLike, kind: ReviewKind, state: Record<string, unknown>, ctx: CtxLike, opts: ReviewOpts = {}): Promise<ReviewOutcome> {
	const cfg = getConfig().adversary;
	const toolCallId = opts.toolCallId;
	const stateSummary: Record<string, string> = {};
	for (const [key, value] of Object.entries(state)) {
		if (typeof value === "string") stateSummary[key] = `${value.length} chars`;
		else stateSummary[key] = cap(JSON.stringify(value) ?? "object", 80);
	}
	const blank = { stateSummary, ...(toolCallId ? { toolCallId } : {}) };
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
		const { questions, noulIds } = buildBattery(kind);
		const { result } = await ask(state, questions, { timeoutMs: cfg.timeoutMs, maxRetries: 0 });
		const usage = { inputTokens: result.usage?.input_tokens ?? 0, outputTokens: result.usage?.output_tokens ?? 0 };
		const answers = result.answers ?? {};
		const severityAnswer = answers.severity as WireAnswer | undefined;
		const sevScore = numField(severityAnswer, "score") ?? 0;
		const severity: Severity | "none" =
			sevScore >= cfg.blocker_severity ? "blocker" : sevScore >= cfg.concern_severity ? "concern" : "pending";
		let maxNoul = 0;
		const fired: { id: string; value: number }[] = [];
		for (const id of noulIds) {
			const value = extractNoul(answers[id] as WireAnswer | undefined) ?? 0;
			if (value > maxNoul) maxNoul = value;
			if (value >= cfg.noul_floor) fired.push({ id, value });
		}
		const finalSeverity: Severity | "none" = severity === "pending" ? (maxNoul >= cfg.noul_floor ? "nit" : "none") : severity;
		const defectAnswer = answers.defect_class as WireAnswer | undefined;
		const rawDefect = typeof defectAnswer?.choice === "string" ? defectAnswer.choice : "unclassified";
		const defectConfidence = numField(defectAnswer, "confidence");
		const defect = rawDefect !== "none" && defectConfidence !== null && defectConfidence >= 0.5 ? rawDefect : "unclassified";
		const severityConfidence = numField(severityAnswer, "confidence");
		const scores: Record<string, number> = { severity: sevScore };
		for (const f of fired) scores[f.id] = f.value;

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
		const note = buildNote(kind, finalSeverity, defect, fired, severityConfidence, evidenceAttr);

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
		await pi.sendMessage({ customType: "ai.typesafe.adversary", content: note, attribution: "agent" }, options);
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

