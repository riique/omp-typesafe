import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ReviewerNote {
	customType: string;
	timestamp: string | null;
	raw: unknown;
}

/** Recursively find the newest .jsonl under a session-dir tree (encoded-cwd subdirs). */
export function findLatestSessionFile(sessionDir: string): string | null {
	const found: { path: string; mtime: number }[] = [];
	function walk(dir: string): void {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(p);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(p);
			else if (e.endsWith(".jsonl")) found.push({ path: p, mtime: st.mtimeMs });
		}
	}
	walk(sessionDir);
	if (!found.length) return null;
	found.sort((a, b) => b.mtime - a.mtime);
	return found[0].path;
}

/**
 * Session JSONL: first 256 bytes are a fixed title slot, then one JSON object
 * per line (per the parent plan's confirmed session format). Lines that fail
 * to parse (e.g. the tail of the title header bleeding into line 1) are
 * dropped rather than throwing.
 */
export function parseSessionEntries(path: string): unknown[] {
	const text = readFileSync(path, "utf8");
	const body = text.length > 256 ? text.slice(256) : text;
	const entries: unknown[] = [];
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed));
		} catch {
			// skip malformed/partial line
		}
	}
	return entries;
}

/**
 * Custom-message notes appear as `type: "custom_message"` in the session
 * JSONL, and as `role: "custom"` in `--mode json` stdout (confirmed by the
 * team); both carry a string `customType`. Accepts either shape.
 */
export function extractCustomMessages(entries: unknown[]): ReviewerNote[] {
	const out: ReviewerNote[] = [];
	for (const e of entries) {
		if (!e || typeof e !== "object") continue;
		const rec = e as Record<string, unknown>;
		const isCustomMessage = rec.type === "custom_message" || rec.role === "custom";
		if (isCustomMessage && typeof rec.customType === "string") {
			out.push({
				customType: rec.customType,
				timestamp: typeof rec.timestamp === "string" ? rec.timestamp : null,
				raw: e,
			});
		}
	}
	return out;
}

/**
 * Finds the timestamp of the `plan-yolo-handoff` custom message, which marks
 * the moment a plan is approved and execution begins (confirmed by Phase 0).
 * Absent for exec-type cells and for plan cells that never reached approval.
 */
export function findPlanYoloHandoffTimestamp(notes: ReviewerNote[]): string | null {
	const handoff = notes.find((n) => n.customType === "plan-yolo-handoff");
	return handoff?.timestamp ?? null;
}

/**
 * Buckets notes into plan-phase (before the plan-yolo-handoff timestamp) and
 * exec-phase (at or after it) counts by customType. If `handoffTs` is null
 * (exec-type cells, or a plan cell whose handoff marker wasn't found), every
 * timestamped note is treated as exec-phase and every untimestamped note is
 * dropped from both buckets rather than guessed at.
 */
export function splitNoteCountsByPhase(
	notes: ReviewerNote[],
	handoffTs: string | null,
): { planPhaseNotes: Record<string, number>; execPhaseNotes: Record<string, number> } {
	const planPhaseNotes: Record<string, number> = {};
	const execPhaseNotes: Record<string, number> = {};
	for (const note of notes) {
		if (note.customType === "plan-yolo-handoff") continue;
		if (!note.timestamp) continue;
		const bucket = handoffTs && note.timestamp < handoffTs ? planPhaseNotes : execPhaseNotes;
		bucket[note.customType] = (bucket[note.customType] ?? 0) + 1;
	}
	return { planPhaseNotes, execPhaseNotes };
}

export interface UsageInfo {
	totalTokens: number;
	costUsd: number;
	messageCount: number;
}

/**
 * omp has no single session-summary usage event (confirmed: Phase 0 check 4).
 * Usage/cost is embedded per assistant message on `message_end` events as
 * `message.usage.totalTokens` and `message.usage.cost.total`. Sums across
 * every `message_end` entry found. Returns null if none are found (caller
 * decides whether to try a fallback source).
 */
function sumUsageFromEntries(entries: unknown[]): UsageInfo | null {
	let totalTokens = 0;
	let costUsd = 0;
	let messageCount = 0;
	for (const e of entries) {
		if (!e || typeof e !== "object") continue;
		const rec = e as Record<string, unknown>;
		if (rec.type !== "message_end") continue;
		const message = rec.message as Record<string, unknown> | undefined;
		const usage = message?.usage as Record<string, unknown> | undefined;
		if (!usage) continue;
		if (typeof usage.totalTokens === "number") totalTokens += usage.totalTokens;
		const cost = usage.cost as Record<string, unknown> | undefined;
		if (typeof cost?.total === "number") costUsd += cost.total;
		messageCount++;
	}
	return messageCount > 0 ? { totalTokens, costUsd, messageCount } : null;
}

/** Sums usage across `message_end` events in the session JSONL (preferred source). */
export function usageFromSessionEntries(entries: unknown[]): UsageInfo | null {
	return sumUsageFromEntries(entries);
}

/** Sums usage across `message_end` events in `--mode json` stdout (NDJSON), used when no session file was found. */
export function usageFromStdout(stdout: string): UsageInfo | null {
	const entries: unknown[] = [];
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed));
		} catch {
			// stdout may include non-JSON lines; skip them
		}
	}
	return sumUsageFromEntries(entries);
}
