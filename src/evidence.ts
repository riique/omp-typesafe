import { cap, isRecord } from "./text";

/**
 * Deterministic evidence collection via pi.exec — gives the reviewer something
 * to check rather than prose. All commands are bounded: 1500 ms each, run in
 * parallel waves, non-zero exits skip the step instead of failing the review.
 */

const PER_COMMAND_TIMEOUT_MS = 1500;
const MAX_DIFF_FILES = 3;
const MAX_SUSPECTS = 5;
const MAX_GREP_HITS = 10;
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]{2,}/g;

export interface Suspect {
	identifier: string;
	hits: string[];
}

export interface Evidence {
	repo: boolean;
	status?: string;
	diffStat?: string;
	fileDiffs?: string[];
	suspects?: Suspect[];
	commandsRun: string[];
}

export interface ExecLike {
	exec(cmd: string, args: string[], opts?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>;
}

let commandsRunThisTurn: string[] = [];

/** Track bash/eval tool activity so verification questions can tell "ran nothing" from "ran the tests". */
export function recordAction(toolName: string): void {
	if (toolName !== "bash" && toolName !== "eval") return;
	commandsRunThisTurn.push(toolName);
	if (commandsRunThisTurn.length > 32) commandsRunThisTurn = commandsRunThisTurn.slice(-32);
}

export function resetEvidenceTurn(): void {
	commandsRunThisTurn = [];
}

export function commandsThisTurn(): string[] {
	return [...commandsRunThisTurn];
}

async function execOut(pi: ExecLike, cmd: string, args: string[], cwd: string | undefined): Promise<string | null> {
	try {
		const raw = await pi.exec(cmd, args, { cwd, signal: AbortSignal.timeout(PER_COMMAND_TIMEOUT_MS) });
		if (!isRecord(raw)) return null;
		// pi.exec results expose `code` (with `killed`); accept `exitCode` for test doubles.
		const exitCode = typeof raw.code === "number" ? raw.code : typeof raw.exitCode === "number" ? raw.exitCode : 1;
		if (exitCode !== 0) return null;
		return typeof raw.stdout === "string" ? raw.stdout : "";
	} catch {
		return null;
	}
}

/** Identifiers appearing on removed lines but not added lines — surviving references to removed names. */
export function suspectIdentifiers(unifiedDiff: string): string[] {
	const removed = new Map<string, number>();
	const added = new Set<string>();
	for (const line of unifiedDiff.split("\n")) {
		if (line.startsWith("---") || line.startsWith("+++")) continue;
		if (line.startsWith("+")) {
			for (const token of line.match(IDENTIFIER) ?? []) added.add(token);
		} else if (line.startsWith("-")) {
			for (const token of line.match(IDENTIFIER) ?? []) removed.set(token, (removed.get(token) ?? 0) + 1);
		}
	}
	return [...removed.entries()]
		.filter(([id]) => !added.has(id))
		.sort((a, b) => b[1] - a[1])
		.slice(0, MAX_SUSPECTS)
		.map(([id]) => id);
}

/** Collect git evidence for the current working tree; fast no-op outside a repo. */
export async function collectEvidence(pi: ExecLike, cwd: string | undefined): Promise<Evidence> {
	const commandsRun = commandsThisTurn();
	const inside = await execOut(pi, "git", ["rev-parse", "--is-inside-work-tree"], cwd);
	if (inside === null || inside.trim() !== "true") {
		return { repo: false, commandsRun };
	}
	const [status, diffStat, nameOnly, unifiedZero] = await Promise.all([
		execOut(pi, "git", ["status", "--porcelain"], cwd),
		execOut(pi, "git", ["diff", "--stat"], cwd),
		execOut(pi, "git", ["diff", "--name-only"], cwd),
		execOut(pi, "git", ["diff", "-U0"], cwd),
	]);
	const files = (nameOnly ?? "")
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.slice(0, MAX_DIFF_FILES);
	const diffs = await Promise.all(files.map((f) => execOut(pi, "git", ["diff", "--unified=3", "--", f], cwd)));
	const fileDiffs = diffs
		.map((d) => (d === null ? "" : d))
		.filter((d) => d.length > 0)
		.map((d) => cap(d, 2000));
	const ids = suspectIdentifiers(unifiedZero ?? "");
	const greps = await Promise.all(ids.map((id) => execOut(pi, "git", ["grep", "-n", "-F", id], cwd)));
	const suspects: Suspect[] = [];
	for (let i = 0; i < ids.length; i++) {
		const hits = (greps[i] ?? "")
			.split("\n")
			.map((s) => s.trim())
			.filter((s) => s.length > 0)
			.slice(0, MAX_GREP_HITS)
			.map((s) => cap(s, 200));
		if (hits.length > 0) suspects.push({ identifier: ids[i], hits });
	}
	return {
		repo: true,
		status: cap(status ?? "", 1000),
		diffStat: cap(diffStat ?? "", 800),
		fileDiffs,
		suspects,
		commandsRun,
	};
}

/** Compact one-line summary for the note's evidence attribute. */
export function formatEvidenceAttribute(ev: Evidence): string {
	const parts: string[] = [];
	if (!ev.repo) {
		parts.push("no git repo");
	} else {
		const changed = (ev.status ?? "").split("\n").filter((s) => s.length > 0).length;
		if (changed > 0) parts.push(`${changed} uncommitted files`);
		for (const s of ev.suspects ?? []) parts.push(`git grep ${s.identifier} → ${s.hits[0]}`);
	}
	if (ev.commandsRun.length > 0) parts.push(`commands: ${[...new Set(ev.commandsRun)].join(",")}`);
	return cap(parts.join("; "), 300);
}
