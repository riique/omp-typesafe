#!/usr/bin/env bun
/**
 * Matrix runner for the omp-typesafe bench. See bench/README.md.
 *
 * bun run bench/run.ts --reps N [--tasks a,b] [--roles off,advisory,adversarial]
 *   [--types exec,plan] [--model <id>] [--concurrency 2] [--max-time 10m] [--dry-run]
 */
import { mkdir, readdir, appendFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readGlobalConfig } from "./lib/config";
import { overlayYaml } from "./lib/overlay";
import { prepareFixture } from "./lib/fixture";
import { runOmp, subprocessTimeoutMs } from "./lib/omp-run";
import {
	findLatestSessionFile,
	parseSessionEntries,
	extractCustomMessages,
	findPlanYoloHandoffTimestamp,
	splitNoteCountsByPhase,
	usageFromSessionEntries,
	usageFromStdout,
} from "./lib/session";
import {
	readTelemetry,
	severityBreakdown,
	channelBreakdown,
	splitHistoryByPhase,
	ambiguityAtPropose,
	wouldAsk,
	gateEvents,
} from "./lib/telemetry";
import { gradePlan } from "./grade-plan";

const ALL_ROLES = ["off", "advisory", "adversarial"] as const;
const ALL_TYPES = ["exec", "plan"] as const;
type Role = (typeof ALL_ROLES)[number];
type TaskType = (typeof ALL_TYPES)[number];

interface Args {
	reps: number;
	tasks?: string[];
	roles: Role[];
	types: TaskType[];
	model?: string;
	concurrency: number;
	maxTime: string;
	dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { reps: 1, roles: [...ALL_ROLES], types: [...ALL_TYPES], concurrency: 2, maxTime: "10m", dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		switch (a) {
			case "--reps":
				args.reps = Number.parseInt(next(), 10);
				break;
			case "--tasks":
				args.tasks = next().split(",").map((s) => s.trim()).filter(Boolean);
				break;
			case "--roles":
				args.roles = next().split(",").map((s) => s.trim()) as Role[];
				break;
			case "--types":
				args.types = next().split(",").map((s) => s.trim()) as TaskType[];
				break;
			case "--model":
				args.model = next();
				break;
			case "--concurrency":
				args.concurrency = Number.parseInt(next(), 10);
				break;
			case "--max-time":
				args.maxTime = next();
				break;
			case "--dry-run":
				args.dryRun = true;
				break;
			default:
				throw new Error(`unknown arg: ${a}`);
		}
	}
	return args;
}

interface TaskEntry {
	id: string;
	dir: string;
	spec: { id: string; execPrompt: string; planPrompt: string };
}

async function discoverTasks(filter?: string[]): Promise<TaskEntry[]> {
	const tasksDir = join(import.meta.dir, "tasks");
	const ids = (await readdir(tasksDir, { withFileTypes: true }))
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.filter((id) => !filter || filter.includes(id));
	const out: TaskEntry[] = [];
	for (const id of ids) {
		const dir = join(tasksDir, id);
		const spec = await Bun.file(join(dir, "task.json")).json();
		out.push({ id, dir, spec });
	}
	return out;
}

interface Cell {
	task: TaskEntry;
	role: Role;
	type: TaskType;
	rep: number;
}

function buildMatrix(tasks: TaskEntry[], args: Args): Cell[] {
	const cells: Cell[] = [];
	for (const task of tasks) {
		for (const role of args.roles) {
			for (const type of args.types) {
				for (let rep = 0; rep < args.reps; rep++) {
					cells.push({ task, role, type, rep });
				}
			}
		}
	}
	// Fisher-Yates shuffle so time-of-day / provider drift doesn't correlate with one condition.
	for (let i = cells.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[cells[i], cells[j]] = [cells[j], cells[i]];
	}
	return cells;
}

function cellName(c: Cell): string {
	return `${c.task.id}-${c.role}-${c.type}-${c.rep}`;
}

function envForCell(c: Cell): Record<string, string> {
	const env: Record<string, string> = {};
	if (c.role === "off") {
		env.TYPESAFE_REVIEW_ENABLED = "0";
	} else {
		env.TYPESAFE_ROLE = c.role;
	}
	return env;
}

function argvForCell(c: Cell, runDir: string, model: string, maxTime: string): string[] {
	const argv = [
		"-p",
		"--mode",
		"json",
		"--cwd",
		join(runDir, "repo"),
		"--model",
		model,
		"--approval-mode",
		"yolo",
		"--no-lsp",
		"--max-time",
		maxTime,
		"--session-dir",
		join(runDir, "sessions"),
		"--config",
		join(runDir, "overlay.yml"),
	];
	if (c.type === "plan") {
		argv.push("--plan-yolo", "--plan-yolo-into", model);
	}
	const prompt = c.type === "plan" ? c.task.spec.planPrompt : c.task.spec.execPrompt;
	argv.push(prompt);
	return argv;
}

async function sourceTypesafeApiKey(): Promise<string | undefined> {
	const path = join(process.env.HOME ?? "", ".config", "agent-secrets.env");
	try {
		const text = await Bun.file(path).text();
		for (const line of text.split("\n")) {
			const m = line.match(/^\s*export\s+TYPESAFE_API_KEY=(.+?)\s*$/);
			if (m) return m[1].replace(/^["']|["']$/g, "");
		}
	} catch {
		// no secrets file; fall through to whatever is already in the environment
	}
	return process.env.TYPESAFE_API_KEY;
}

/**
 * All the per-run fields derivable from files already on disk under a run
 * dir (sessions/, typesafe.json, stdout.log) rather than from the omp
 * invocation itself. Shared by runCell (live run, has stdout in memory) and
 * regradeResultsDir (backfill, reads stdout.log from disk) so the two paths
 * can never drift apart on what they compute from the same inputs — that
 * drift is exactly what caused an earlier telemetry-field mismatch report.
 */
async function deriveNoteAndTelemetryFields(runDir: string, stdoutForUsageFallback?: string) {
	const sessionPath = findLatestSessionFile(join(runDir, "sessions"));
	const sessionEntries = sessionPath ? parseSessionEntries(sessionPath) : [];
	const sessionNotes = extractCustomMessages(sessionEntries);
	const noteCounts: Record<string, number> = {};
	for (const note of sessionNotes) {
		noteCounts[note.customType] = (noteCounts[note.customType] ?? 0) + 1;
	}
	// Plan cells switch from read-only planning to full-access execution at the
	// plan-yolo-handoff custom message; split notes on either side of it so
	// "did the reviewer behave differently while planning vs implementing" is
	// answerable. Exec-type cells never see this marker, so both splits fall
	// back to treating everything as exec-phase.
	const handoffTs = findPlanYoloHandoffTimestamp(sessionNotes);
	const { planPhaseNotes, execPhaseNotes } = splitNoteCountsByPhase(sessionNotes, handoffTs);

	// Usage has no single summary event (Phase 0 check 4): sum message_end
	// entries in the session JSONL, falling back to stdout only if no session
	// file was found or it carried no message_end entries. For a backfill
	// (no live stdout passed in), fall back to the saved stdout.log file.
	let stdoutText = stdoutForUsageFallback;
	if (stdoutText === undefined) {
		try {
			stdoutText = await Bun.file(join(runDir, "stdout.log")).text();
		} catch {
			stdoutText = "";
		}
	}
	const usage = usageFromSessionEntries(sessionEntries) ?? usageFromStdout(stdoutText);
	const mainTokens = usage?.totalTokens ?? null;
	const mainCostUsd = usage?.costUsd ?? null;

	// Extension telemetry (absent for role "off": no TYPESAFE_BENCH_LOG write happens).
	const telemetry = await readTelemetry(join(runDir, "typesafe.json"));
	const noteSeverityCounts = telemetry ? severityBreakdown(telemetry.history ?? []) : null;
	const noteChannelCounts = telemetry ? channelBreakdown(telemetry.history ?? []) : null;
	const typesafeCostUsd = telemetry?.costUsd ?? null;
	const historyPhaseSplit = telemetry ? splitHistoryByPhase(telemetry.history ?? [], handoffTs) : null;
	const planPhaseSeverityCounts = historyPhaseSplit ? severityBreakdown(historyPhaseSplit.planPhase) : null;
	const execPhaseSeverityCounts = historyPhaseSplit ? severityBreakdown(historyPhaseSplit.execPhase) : null;

	// Ambiguity-gate telemetry (optional: absent on older typesafe.json dumps).
	const ambiguityPropose = ambiguityAtPropose(telemetry);
	const ambiguityWouldAsk = wouldAsk(telemetry);
	const ambiguityGateEvents = gateEvents(telemetry);
	const asksObserved = telemetry?.ambiguity?.asksObserved ?? null;

	return {
		sessionPath,
		noteCounts,
		planPhaseNotes,
		execPhaseNotes,
		mainTokens,
		mainCostUsd,
		noteSeverityCounts,
		noteChannelCounts,
		planPhaseSeverityCounts,
		execPhaseSeverityCounts,
		typesafeCostUsd,
		ambiguityAtPropose: ambiguityPropose,
		wouldAsk: ambiguityWouldAsk,
		gateEvents: ambiguityGateEvents,
		asksObserved,
		reviewerStats: telemetry?.stats ?? null,
	};
}

async function runCell(
	c: Cell,
	runsRootDir: string,
	globalCfg: { disabledExtensions: string[]; defaultModel: string },
	args: Args,
	typesafeApiKey: string | undefined,
): Promise<Record<string, unknown>> {
	const name = cellName(c);
	const runDir = join(runsRootDir, name);
	await mkdir(runDir, { recursive: true });
	await mkdir(join(runDir, "plans"), { recursive: true });

	const repoDir = join(runDir, "repo");
	await prepareFixture(join(c.task.dir, "fixture"), repoDir);

	const overlayPath = join(runDir, "overlay.yml");
	await writeFile(overlayPath, overlayYaml(globalCfg.disabledExtensions, join(runDir, "plans")));

	const model = args.model ?? globalCfg.defaultModel;
	const argv = argvForCell(c, runDir, model, args.maxTime);
	const env: Record<string, string> = {
		...envForCell(c),
		TYPESAFE_BENCH_LOG: join(runDir, "typesafe.json"),
	};
	if (typesafeApiKey) env.TYPESAFE_API_KEY = typesafeApiKey;

	if (args.dryRun) {
		const envStr = Object.entries(env).map(([k, v]) => `${k}=${k === "TYPESAFE_API_KEY" ? "<redacted>" : v}`).join(" ");
		console.log(`# ${name}`);
		console.log(`${envStr} omp ${argv.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
		return { task: c.task.id, role: c.role, type: c.type, rep: c.rep, dryRun: true };
	}

	const result = runOmp(argv, { cwd: repoDir, env, timeoutMs: subprocessTimeoutMs(args.maxTime) });
	await writeFile(join(runDir, "stdout.log"), result.stdout);
	await writeFile(join(runDir, "stderr.log"), result.stderr);
	await writeFile(
		join(runDir, "meta.json"),
		JSON.stringify({ argv: result.argv, exitCode: result.exitCode, wallMs: result.wallMs, timedOut: result.timedOut, envKeys: Object.keys(env) }, null, 2),
	);

	const derived = await deriveNoteAndTelemetryFields(runDir, result.stdout);
	const { sessionPath } = derived;

	let gradeResult: { score: number; success: boolean; checks: Record<string, boolean> } | null = null;
	try {
		const graderMod = await import(join(c.task.dir, "grade.ts"));
		// Extra context beyond the repo dir, for graders that need to inspect
		// the session transcript (e.g. over-scoped-ask checking for an `ask`
		// tool call or a stated assumption). Ignored by graders that only take
		// `cwd`.
		gradeResult = await graderMod.grade(repoDir, { sessionPath, runDir });
	} catch (err) {
		gradeResult = { score: 0, success: false, checks: { grader_threw: false } };
		await writeFile(join(runDir, "grade-error.log"), String(err));
	}

	// Plan-side grading (plan cells only): newest .md under <runDir>/plans (the
	// overlay's plan.autosaveDir), checklist regex + blind LLM judge.
	let planGrade: Awaited<ReturnType<typeof gradePlan>> | null = null;
	if (c.type === "plan") {
		try {
			planGrade = await gradePlan(runDir, c.task.dir);
		} catch (err) {
			await writeFile(join(runDir, "plan-grade-error.log"), String(err));
		}
	}

	return {
		task: c.task.id,
		role: c.role,
		type: c.type,
		rep: c.rep,
		model,
		dir: runDir,
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		wallMs: result.wallMs,
		success: gradeResult.success,
		score: gradeResult.score,
		checks: gradeResult.checks,
		...derived,
		planPath: planGrade?.planPath ?? null,
		planChecklistScore: planGrade?.checklistScore ?? null,
		planJudgeScore: planGrade?.judgeScore ?? null,
	};
}

/**
 * Re-runs the deterministic execution grader (not omp) for every row already
 * recorded in <resultsDir>/runs.jsonl, in place. Cheap: the repo copies under
 * each run's `repo/` dir survive the run, so this just re-invokes each task's
 * grade.ts against them — useful when the grader itself was buggy (e.g. the
 * git-grep `-e` fix) and re-running omp would be wasteful. Skips rows with no
 * `dir` (e.g. stale --dry-run rows).
 */
async function regradeResultsDir(resultsDir: string): Promise<{ total: number; regraded: number; nowSuccessful: number; telemetryRefreshed: number }> {
	const runsPath = join(resultsDir, "runs.jsonl");
	const lines = (await Bun.file(runsPath).text()).split("\n").map((l) => l.trim());
	let total = 0;
	let regraded = 0;
	let nowSuccessful = 0;
	let telemetryRefreshed = 0;

	const outLines: string[] = [];
	for (const line of lines) {
		if (!line) continue;
		const row = JSON.parse(line) as Record<string, unknown>;
		if (typeof row.dir === "string" && typeof row.task === "string") {
			total++;

			// Re-derive noteCounts/severity/channel/usage/ambiguity-gate fields
			// from files already on disk (sessions/, typesafe.json, stdout.log) —
			// the same function the live runner uses, so this can never drift
			// from what a fresh run would have recorded.
			try {
				const derived = await deriveNoteAndTelemetryFields(row.dir);
				Object.assign(row, derived);
				telemetryRefreshed++;
			} catch (err) {
				console.error(`[regrade] telemetry refresh failed for ${row.dir}: ${err}`);
			}

			try {
				const taskDir = join(import.meta.dir, "tasks", row.task);
				const graderMod = await import(join(taskDir, "grade.ts"));
				const repoDir = join(row.dir, "repo");
				const grade = await graderMod.grade(repoDir, { sessionPath: row.sessionPath ?? null, runDir: row.dir });
				row.score = grade.score;
				row.success = grade.success;
				row.checks = grade.checks;
				regraded++;
				if (grade.success) nowSuccessful++;
			} catch (err) {
				console.error(`[regrade] failed for ${row.dir}: ${err}`);
			}

			// Plan-side fields (planPath/planChecklistScore/planJudgeScore) are
			// deliberately left untouched here — that's what grade-plan.ts
			// --rescore is for, and it's a separate (LLM-judge, cached) cost.
		}
		outLines.push(JSON.stringify(row));
	}

	await writeFile(runsPath, `${outLines.join("\n")}\n`);
	return { total, regraded, nowSuccessful, telemetryRefreshed };
}

async function main(): Promise<void> {
	const cliArgs = process.argv.slice(2);
	if (cliArgs[0] === "--regrade") {
		const resultsDirArg = cliArgs[1];
		if (!resultsDirArg) throw new Error("usage: bun run bench/run.ts --regrade <resultsDir>");
		const resultsDir = resultsDirArg.startsWith("/") ? resultsDirArg : resolve(process.cwd(), resultsDirArg);
		const summary = await regradeResultsDir(resultsDir);
		console.log(JSON.stringify(summary, null, 2));
		return;
	}

	const args = parseArgs(process.argv.slice(2));
	if (!Number.isFinite(args.reps) || args.reps < 1) throw new Error("--reps must be a positive integer");

	const globalCfg = await readGlobalConfig();
	const tasks = await discoverTasks(args.tasks);
	if (tasks.length === 0) throw new Error("no tasks matched --tasks filter");

	const cells = buildMatrix(tasks, args);

	const runId = args.dryRun ? "dry-run" : new Date().toISOString().replace(/[:.]/g, "-");
	const resultsDir = resolve(import.meta.dir, "results", runId);
	const runsRootDir = join(resultsDir, "runs");
	if (!args.dryRun) await mkdir(runsRootDir, { recursive: true });

	const typesafeApiKey = args.dryRun ? undefined : await sourceTypesafeApiKey();
	const runsJsonlPath = join(resultsDir, "runs.jsonl");

	let cursor = 0;
	async function worker(): Promise<void> {
		while (cursor < cells.length) {
			const c = cells[cursor++];
			const row = await runCell(c, runsRootDir, globalCfg, args, typesafeApiKey);
			if (!args.dryRun) {
				await appendFile(runsJsonlPath, `${JSON.stringify(row)}\n`);
				console.log(`[${cellName(c)}] exit=${row.exitCode} success=${row.success} score=${row.score}`);
			}
		}
	}

	const workerCount = args.dryRun ? 1 : Math.max(1, args.concurrency);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));

	if (!args.dryRun) {
		console.log(`\nWrote ${cells.length} rows to ${runsJsonlPath}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
