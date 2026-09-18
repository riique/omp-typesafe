/**
 * Reads the extension's TYPESAFE_BENCH_LOG dump (written on session_shutdown
 * per the parent plan's Phase 1.4): { role, stats, usage, costUsd, history }.
 * Each `history` record carries { role, kind, severity, decision, channel,
 * defect } (confirmed contract). Absent for `off`-role runs, where no file
 * is ever written.
 */
export interface TelemetryHistoryRecord {
	role: string;
	kind: string;
	severity: string;
	decision: string;
	channel: string;
	defect: string;
	/** ISO timestamp, when present; used to split plan-phase vs exec-phase notes on plan-yolo cells. */
	ts?: string;
}

/** One ambiguity-gate score, written by the extension at a plan_start/turn_end/propose checkpoint. */
export interface AmbiguityScore {
	ts: string;
	trigger: "plan_start" | "turn_end" | "propose";
	ambiguity: number;
	dims: { goal: number; constraints: number; criteria: number; context: number };
	weakest: string;
	gap: string;
	userCanAnswer: number;
	decision: "steer" | "block" | "would_block" | "none";
}

/** Ambiguity-gate telemetry block, optional: absent on runs recorded before the gate was added to the extension. */
export interface AmbiguityTelemetry {
	scores: AmbiguityScore[];
	asksObserved: number;
}

export interface TelemetryLog {
	role: string;
	stats: Record<string, unknown>;
	usage: Record<string, unknown>;
	costUsd: number;
	history: TelemetryHistoryRecord[];
	/** Optional: absent on runs recorded before the ambiguity gate was added to the extension. */
	ambiguity?: AmbiguityTelemetry;
}

/** The last "propose"-trigger ambiguity score, or null if there is none (including when `ambiguity` is absent). */
export function ambiguityAtPropose(t: TelemetryLog | null | undefined): AmbiguityScore | null {
	const scores = t?.ambiguity?.scores;
	if (!scores || scores.length === 0) return null;
	const proposeScores = scores.filter((s) => s.trigger === "propose");
	if (proposeScores.length === 0) return null;
	return proposeScores[proposeScores.length - 1];
}

/** True if any ambiguity score in this telemetry carries a steer/block/would_block decision. */
export function wouldAsk(t: TelemetryLog | null | undefined): boolean {
	const scores = t?.ambiguity?.scores;
	if (!scores) return false;
	return scores.some((s) => s.decision === "steer" || s.decision === "block" || s.decision === "would_block");
}

/** Counts ambiguity scores by decision (e.g. {"steer": 1, "none": 3}). */
export function gateEvents(t: TelemetryLog | null | undefined): Record<string, number> {
	const out: Record<string, number> = {};
	const scores = t?.ambiguity?.scores;
	if (!scores) return out;
	for (const s of scores) {
		if (typeof s.decision === "string") out[s.decision] = (out[s.decision] ?? 0) + 1;
	}
	return out;
}

export async function readTelemetry(path: string): Promise<TelemetryLog | null> {
	try {
		return (await Bun.file(path).json()) as TelemetryLog;
	} catch {
		return null;
	}
}

/** Counts history records by severity (e.g. {"nit": 2, "concern": 1}). */
export function severityBreakdown(history: TelemetryHistoryRecord[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const h of history) {
		if (typeof h.severity === "string") out[h.severity] = (out[h.severity] ?? 0) + 1;
	}
	return out;
}

/** Counts history records by delivery channel (e.g. {"steer": 1, "aside": 2, "suppressed": 3}). */
export function channelBreakdown(history: TelemetryHistoryRecord[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const h of history) {
		if (typeof h.channel === "string") out[h.channel] = (out[h.channel] ?? 0) + 1;
	}
	return out;
}

/**
 * Splits history records into plan-phase (before the plan-yolo-handoff
 * timestamp) and exec-phase (at or after it) by each record's `ts`. Records
 * without a `ts` are dropped from both buckets rather than guessed at. If
 * `handoffTs` is null, every timestamped record is treated as exec-phase.
 */
export function splitHistoryByPhase(
	history: TelemetryHistoryRecord[],
	handoffTs: string | null,
): { planPhase: TelemetryHistoryRecord[]; execPhase: TelemetryHistoryRecord[] } {
	const planPhase: TelemetryHistoryRecord[] = [];
	const execPhase: TelemetryHistoryRecord[] = [];
	for (const h of history) {
		if (!h.ts) continue;
		(handoffTs && h.ts < handoffTs ? planPhase : execPhase).push(h);
	}
	return { planPhase, execPhase };
}
