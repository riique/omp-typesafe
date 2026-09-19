import { spawnSync } from "node:child_process";

export interface OmpRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	wallMs: number;
	argv: string[];
	timedOut: boolean;
}

export function runOmp(argv: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number }): OmpRunResult {
	const start = Date.now();
	const r = spawnSync("omp", argv, {
		cwd: opts.cwd,
		env: { ...process.env, ...opts.env },
		encoding: "utf8",
		timeout: opts.timeoutMs,
		maxBuffer: 64 * 1024 * 1024,
	});
	const wallMs = Date.now() - start;
	return {
		exitCode: r.status,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
		wallMs,
		argv,
		timedOut: r.error?.message?.includes("ETIMEDOUT") ?? false,
	};
}

/** Parse "10m" / "1h" / "600" style durations (matches omp's --max-time) into milliseconds. */
export function parseDuration(spec: string): number {
	const m = spec.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
	if (!m) throw new Error(`invalid duration: ${spec}`);
	const value = Number.parseFloat(m[1]);
	const unit = (m[2] ?? "s").toLowerCase();
	const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
	return value * mult[unit];
}

/**
 * The subprocess timeout (our own kill switch, distinct from omp's own
 * --max-time) must give omp room to actually hit --max-time and exit
 * cleanly. Phase 0 smoke found plan-mode runs on a trivial 2-file fixture
 * took 90-130s in print mode (it waits out any late reviewer turns before
 * exiting), so a tight harness timeout risks killing a run that --max-time
 * itself would have let finish. Floor of 15 minutes regardless of a smaller
 * --max-time, plus a 5-minute margin above --max-time otherwise.
 */
export function subprocessTimeoutMs(maxTimeSpec: string): number {
	const maxTimeMs = parseDuration(maxTimeSpec);
	const FLOOR_MS = 15 * 60_000;
	const MARGIN_MS = 5 * 60_000;
	return Math.max(maxTimeMs + MARGIN_MS, FLOOR_MS);
}
