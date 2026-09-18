#!/usr/bin/env bun
/**
 * Plan-side grading for a single run dir: finds the newest saved plan,
 * scores it against task.json's checklist (regex grep) and rubric (LLM
 * judge, blind to condition), caching judge calls by sha256(plan+rubric).
 *
 * Usage: bun run bench/grade-plan.ts <runDir> <taskDir>
 * Exposes gradePlan() for programmatic use from report.ts.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface PlanGrade {
	planPath: string | null;
	checklistScore: number | null;
	checklistMatches: Record<string, boolean>;
	judgeScore: number | null;
	judgeCriteria: { id: string; met: boolean; reason: string }[] | null;
}

async function findNewestPlan(runDir: string): Promise<string | null> {
	const plansDir = join(runDir, "plans");
	const candidates: { path: string; mtime: number }[] = [];
	if (existsSync(plansDir)) {
		for (const name of await readdir(plansDir)) {
			if (!name.endsWith(".md")) continue;
			const path = join(plansDir, name);
			const st = await stat(path);
			candidates.push({ path, mtime: st.mtimeMs });
		}
	}
	if (candidates.length === 0) {
		const fallback = join(runDir, "repo", "PLAN.md");
		if (existsSync(fallback)) {
			const st = await stat(fallback);
			candidates.push({ path: fallback, mtime: st.mtimeMs });
		}
	}
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => b.mtime - a.mtime);
	return candidates[0].path;
}

function checklistScore(planText: string, checklist: string[]): { score: number; matches: Record<string, boolean> } {
	const matches: Record<string, boolean> = {};
	for (const pattern of checklist) {
		try {
			matches[pattern] = new RegExp(pattern, "i").test(planText);
		} catch {
			matches[pattern] = false;
		}
	}
	const values = Object.values(matches);
	const score = values.length ? values.filter(Boolean).length / values.length : 0;
	return { score, matches };
}

const JUDGE_CACHE_DIR = join(import.meta.dir, "results", "judge-cache");
const CACHE_KEY_SEPARATOR = "::rubric::";

function judgePrompt(planText: string, rubric: string[]): string {
	const criteriaList = rubric.map((c, i) => `${i}. ${c}`).join("\n");
	return [
		"You are a blind grader. You will be shown a PLAN and a numbered RUBRIC of yes/no criteria.",
		"For each rubric item, judge strictly from the plan text alone whether it is met.",
		"Respond with ONLY a JSON object of the exact shape:",
		'{"criteria":[{"id":"0","met":true,"reason":"..."}, ...]}',
		"One entry per rubric item, in order, id as the rubric item's index (as a string). No prose outside the JSON.",
		"",
		"RUBRIC:",
		criteriaList,
		"",
		"PLAN:",
		"---",
		planText,
		"---",
	].join("\n");
}

async function callJudge(planText: string, rubric: string[]): Promise<{ id: string; met: boolean; reason: string }[]> {
	const hash = createHash("sha256")
		.update(planText + CACHE_KEY_SEPARATOR + JSON.stringify(rubric))
		.digest("hex");
	await mkdir(JUDGE_CACHE_DIR, { recursive: true });
	const cachePath = join(JUDGE_CACHE_DIR, `${hash}.json`);
	if (existsSync(cachePath)) {
		return JSON.parse(await readFile(cachePath, "utf8"));
	}

	const prompt = judgePrompt(planText, rubric);
	const r = spawnSync("claude", ["-p", "--model", "claude-opus-5", "--output-format", "json", prompt], {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	if (r.status !== 0) {
		throw new Error(`judge invocation failed: ${r.stderr}`);
	}

	// `claude -p --output-format json` always returns a *valid JSON* result
	// envelope (session_id, usage, cost, etc.) whose `.result` field holds the
	// assistant's actual reply as a string. Since the envelope itself parses
	// cleanly, a naive "try parsing stdout as the criteria object" never fails
	// and silently succeeds with the wrong shape (no top-level `criteria`).
	// Parse the envelope first and always pull the reply out of `.result`.
	type CriteriaPayload = { criteria: { id: string; met: boolean; reason: string }[] };
	const envelope = JSON.parse(r.stdout) as { result?: string; criteria?: unknown };
	let parsed: CriteriaPayload;
	if (Array.isArray(envelope.criteria)) {
		// Direct shape (e.g. --output-format json without the envelope, older/other CLI versions).
		parsed = envelope as CriteriaPayload;
	} else if (typeof envelope.result === "string") {
		const jsonMatch = envelope.result.match(/\{[\s\S]*\}/);
		if (!jsonMatch) throw new Error(`judge result had no JSON body: ${envelope.result.slice(0, 500)}`);
		parsed = JSON.parse(jsonMatch[0]) as CriteriaPayload;
	} else {
		throw new Error(`unexpected judge output shape: ${r.stdout.slice(0, 500)}`);
	}
	if (!Array.isArray(parsed.criteria)) {
		throw new Error(`judge output missing a criteria array: ${JSON.stringify(parsed).slice(0, 500)}`);
	}

	await writeFile(cachePath, JSON.stringify(parsed.criteria, null, 2));
	return parsed.criteria;
}

export async function gradePlan(runDir: string, taskDir: string): Promise<PlanGrade> {
	const task = await Bun.file(join(taskDir, "task.json")).json();
	const planPath = await findNewestPlan(runDir);
	if (!planPath) {
		return { planPath: null, checklistScore: null, checklistMatches: {}, judgeScore: null, judgeCriteria: null };
	}
	const planText = await readFile(planPath, "utf8");
	const { score: cScore, matches } = checklistScore(planText, task.checklist as string[]);

	let judgeCriteria: { id: string; met: boolean; reason: string }[] | null = null;
	let judgeScore: number | null = null;
	try {
		judgeCriteria = await callJudge(planText, task.rubric as string[]);
		judgeScore = judgeCriteria.length ? judgeCriteria.filter((c) => c.met).length / judgeCriteria.length : null;
	} catch (err) {
		console.error(`[grade-plan] judge failed for ${runDir}: ${err}`);
	}

	return { planPath, checklistScore: cScore, checklistMatches: matches, judgeScore, judgeCriteria };
}

function resolvePath(p: string): string {
	return p.startsWith("/") ? p : join(process.cwd(), p);
}

/**
 * Re-scores every plan-type row already recorded in <resultsDir>/runs.jsonl,
 * in place, without re-running omp. Useful when the judge itself was buggy
 * (bad output parsing, etc.) — fix the judge, then re-score existing runs.
 * Skips rows with no `dir` (e.g. --dry-run rows) or non-"plan" type.
 */
export async function rescoreResultsDir(resultsDir: string): Promise<{ total: number; rescored: number; nonNullJudge: number }> {
	const runsPath = join(resultsDir, "runs.jsonl");
	const lines = (await readFile(runsPath, "utf8")).split("\n").map((l) => l.trim());
	let total = 0;
	let rescored = 0;
	let nonNullJudge = 0;

	const outLines: string[] = [];
	for (const line of lines) {
		if (!line) continue;
		const row = JSON.parse(line) as Record<string, unknown>;
		if (row.type === "plan" && typeof row.dir === "string" && typeof row.task === "string") {
			total++;
			const taskDir = join(import.meta.dir, "tasks", row.task);
			const grade = await gradePlan(row.dir, taskDir);
			row.planPath = grade.planPath;
			row.planChecklistScore = grade.checklistScore;
			row.planJudgeScore = grade.judgeScore;
			rescored++;
			if (grade.judgeScore !== null) nonNullJudge++;
		}
		outLines.push(JSON.stringify(row));
	}

	await writeFile(runsPath, `${outLines.join("\n")}\n`);
	return { total, rescored, nonNullJudge };
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	if (argv[0] === "--rescore") {
		const resultsDirArg = argv[1];
		if (!resultsDirArg) {
			console.error("usage: bun run bench/grade-plan.ts --rescore <resultsDir>");
			process.exit(1);
		}
		const summary = await rescoreResultsDir(resolvePath(resultsDirArg));
		console.log(JSON.stringify(summary, null, 2));
	} else {
		const [runDirArg, taskDirArg] = argv;
		if (!runDirArg || !taskDirArg) {
			console.error("usage: bun run bench/grade-plan.ts <runDir> <taskDir>\n   or: bun run bench/grade-plan.ts --rescore <resultsDir>");
			process.exit(1);
		}
		gradePlan(resolvePath(runDirArg), resolvePath(taskDirArg)).then((r) => console.log(JSON.stringify(r, null, 2)));
	}
}
