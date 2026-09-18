#!/usr/bin/env bun
/**
 * Aggregates bench/results/<runId>/runs.jsonl into report.md: per (taskType,
 * role) means with 95% bootstrap CIs, the advisory-vs-adversarial and
 * vs-off contrasts, and a per-task breakdown.
 *
 * Usage: bun run bench/report.ts <resultsDir>
 * (resultsDir must contain runs.jsonl; report.md is written alongside it.)
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface RunRow {
	task: string;
	role: "off" | "advisory" | "adversarial";
	type: "exec" | "plan";
	rep: number;
	dir?: string;
	exitCode?: number | null;
	timedOut?: boolean;
	wallMs?: number;
	success: boolean;
	score: number;
	checks?: Record<string, boolean>;
	noteCounts?: Record<string, number>;
	/** noteCounts split on the plan-yolo-handoff timestamp (plan-type cells only; both equal noteCounts's shape for exec-type cells with everything in execPhaseNotes). */
	planPhaseNotes?: Record<string, number>;
	execPhaseNotes?: Record<string, number>;
	/** Main-model usage, summed from session-JSONL message_end entries (see lib/session.ts). */
	mainTokens?: number | null;
	mainCostUsd?: number | null;
	planPath?: string | null;
	planJudgeScore?: number | null;
	planChecklistScore?: number | null;
	/** Per-history-record severity counts from typesafe.json (history[].severity), null for role "off". */
	noteSeverityCounts?: Record<string, number> | null;
	/** Per-history-record delivery-channel counts from typesafe.json (history[].channel). */
	noteChannelCounts?: Record<string, number> | null;
	planPhaseSeverityCounts?: Record<string, number> | null;
	execPhaseSeverityCounts?: Record<string, number> | null;
	/** Jev spend for this run, from typesafe.json's costUsd (distinct from the main model's usage.costUsd). */
	typesafeCostUsd?: number | null;
	/** Last "propose"-trigger ambiguity score for this run, from typesafe.json's ambiguity block (optional field, absent on older runs). */
	ambiguityAtPropose?: {
		ts: string;
		trigger: string;
		ambiguity: number;
		dims: { goal: number; constraints: number; criteria: number; context: number };
		weakest: string;
		gap: string;
		userCanAnswer: number;
		decision: string;
	} | null;
	/** True if any ambiguity score in this run carries a steer/block/would_block decision. */
	wouldAsk?: boolean;
	/** Ambiguity-score counts by decision (e.g. {"steer": 1, "none": 3}). */
	gateEvents?: Record<string, number>;
	asksObserved?: number | null;
}

async function readRows(path: string): Promise<RunRow[]> {
	const text = await readFile(path, "utf8");
	return text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => JSON.parse(l) as RunRow);
}

function mean(xs: number[]): number {
	return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;
}

function median(xs: number[]): number {
	if (!xs.length) return Number.NaN;
	const sorted = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 95% bootstrap CI on the mean, via resampling with replacement. */
function bootstrapCI(xs: number[], iterations = 2000): [number, number] | null {
	if (xs.length < 2) return null;
	const means: number[] = [];
	for (let i = 0; i < iterations; i++) {
		const sample: number[] = [];
		for (let j = 0; j < xs.length; j++) sample.push(xs[Math.floor(Math.random() * xs.length)]);
		means.push(mean(sample));
	}
	means.sort((a, b) => a - b);
	const lo = means[Math.floor(0.025 * means.length)];
	const hi = means[Math.floor(0.975 * means.length)];
	return [lo, hi];
}

function fmt(n: number | undefined | null, digits = 3): string {
	if (n === undefined || n === null || Number.isNaN(n)) return "n/a";
	return n.toFixed(digits);
}

function fmtCI(ci: [number, number] | null): string {
	if (!ci) return "n/a";
	return `[${fmt(ci[0])}, ${fmt(ci[1])}]`;
}

interface CellStats {
	role: string;
	type: string;
	n: number;
	meanSuccess: number;
	successCI: [number, number] | null;
	meanScore: number;
	scoreCI: [number, number] | null;
	medianWallMs: number;
	meanTokens: number | null;
	meanNotes: number | null;
	meanUsd: number | null;
	meanJevUsd: number | null;
	severityTotals: Record<string, number>;
	meanPlanChecklistScore: number | null;
	meanPlanJudgeScore: number | null;
	planFilesFound: number;
	planCells: number;
	/** Fraction of runs where wouldAsk was true (null-safe: undefined if no run in this cell has telemetry). */
	wouldAskRate: number | null;
	/** Mean ambiguity-at-propose score, plan cells only (null for exec cells or when no run has the field). */
	meanAmbiguityAtPropose: number | null;
}

function computeCell(rows: RunRow[], role: string, type: string): CellStats {
	const subset = rows.filter((r) => r.role === role && r.type === type);
	const successVals = subset.map((r) => (r.success ? 1 : 0));
	const scoreVals = subset.map((r) => r.score);
	const wallVals = subset.map((r) => r.wallMs ?? Number.NaN).filter((v) => !Number.isNaN(v));
	const tokenVals = subset.map((r) => r.mainTokens).filter((v): v is number => typeof v === "number");
	// Prefer the extension's own severity-tagged history (typesafe.json) for note
	// counts; fall back to session custom_message counts if telemetry is absent.
	const noteVals = subset.map((r) => {
		if (r.noteSeverityCounts) return Object.values(r.noteSeverityCounts).reduce((a, b) => a + b, 0);
		return Object.values(r.noteCounts ?? {}).reduce((a, b) => a + b, 0);
	});
	const usdVals = subset.map((r) => r.mainCostUsd).filter((v): v is number => typeof v === "number");
	const jevUsdVals = subset.map((r) => r.typesafeCostUsd).filter((v): v is number => typeof v === "number");
	const checklistVals = subset.map((r) => r.planChecklistScore).filter((v): v is number => typeof v === "number");
	const judgeVals = subset.map((r) => r.planJudgeScore).filter((v): v is number => typeof v === "number");

	const severityTotals: Record<string, number> = {};
	for (const r of subset) {
		for (const [sev, count] of Object.entries(r.noteSeverityCounts ?? {})) {
			severityTotals[sev] = (severityTotals[sev] ?? 0) + count;
		}
	}

	// Ambiguity-gate telemetry is optional; only compute over rows that carry it.
	const wouldAskVals = subset.filter((r) => typeof r.wouldAsk === "boolean").map((r) => (r.wouldAsk ? 1 : 0));
	const ambiguityProposeVals = subset
		.map((r) => r.ambiguityAtPropose?.ambiguity)
		.filter((v): v is number => typeof v === "number");

	return {
		role,
		type,
		n: subset.length,
		meanSuccess: mean(successVals),
		successCI: bootstrapCI(successVals),
		meanScore: mean(scoreVals),
		scoreCI: bootstrapCI(scoreVals),
		medianWallMs: median(wallVals),
		meanTokens: tokenVals.length ? mean(tokenVals) : null,
		meanNotes: noteVals.length ? mean(noteVals) : null,
		meanUsd: usdVals.length ? mean(usdVals) : null,
		meanJevUsd: jevUsdVals.length ? mean(jevUsdVals) : null,
		severityTotals,
		meanPlanChecklistScore: checklistVals.length ? mean(checklistVals) : null,
		meanPlanJudgeScore: judgeVals.length ? mean(judgeVals) : null,
		planFilesFound: subset.filter((r) => r.planPath).length,
		planCells: subset.length,
		wouldAskRate: wouldAskVals.length ? mean(wouldAskVals) : null,
		meanAmbiguityAtPropose: type === "plan" && ambiguityProposeVals.length ? mean(ambiguityProposeVals) : null,
	};
}

function renderCellTable(cells: CellStats[]): string {
	const header =
		"| role | type | n | mean success | 95% CI | mean score | 95% CI | median wall (ms) | mean tokens | mean notes/run | mean Jev USD | would-ask rate | mean ambiguity at propose |";
	const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|---|";
	const lines = cells.map(
		(c) =>
			`| ${c.role} | ${c.type} | ${c.n} | ${fmt(c.meanSuccess)} | ${fmtCI(c.successCI)} | ${fmt(c.meanScore)} | ${fmtCI(c.scoreCI)} | ${fmt(c.medianWallMs, 0)} | ${c.meanTokens ? fmt(c.meanTokens, 0) : "n/a"} | ${c.meanNotes !== null ? fmt(c.meanNotes, 1) : "n/a"} | ${c.meanJevUsd !== null ? fmt(c.meanJevUsd, 4) : "n/a"} | ${c.wouldAskRate !== null ? fmt(c.wouldAskRate) : "n/a"} | ${c.meanAmbiguityAtPropose !== null ? fmt(c.meanAmbiguityAtPropose) : "n/a"} |`,
	);
	return [header, sep, ...lines].join("\n");
}

/** Per-task ambiguity-at-propose scores and weakest dimension (plan-type, non-off rows only; null-safe when telemetry is absent). */
function renderAmbiguityGateTable(rows: RunRow[]): string {
	const planRows = rows.filter((r) => r.type === "plan" && r.role !== "off");
	const withAmbiguity = planRows.filter((r) => r.ambiguityAtPropose);
	if (withAmbiguity.length === 0) {
		return "_No ambiguity-at-propose telemetry found (field absent on these runs, or no plan-type non-off rows)._";
	}
	const header = "| task | role | rep | ambiguity at propose | weakest dim | decision |";
	const sep = "|---|---|---|---|---|---|";
	const lines = withAmbiguity.map((r) => {
		const a = r.ambiguityAtPropose!;
		return `| ${r.task} | ${r.role} | ${r.rep} | ${fmt(a.ambiguity)} | ${a.weakest} | ${a.decision} |`;
	});
	return [header, sep, ...lines].join("\n");
}

function renderPlanTable(cells: CellStats[]): string {
	const planCells = cells.filter((c) => c.type === "plan");
	if (planCells.length === 0) return "_No plan-type cells in this run._";
	const header = "| role | plan found | mean checklist score | mean judge score |";
	const sep = "|---|---|---|---|";
	const lines = planCells.map(
		(c) => `| ${c.role} | ${c.planFilesFound}/${c.planCells} | ${fmt(c.meanPlanChecklistScore)} | ${fmt(c.meanPlanJudgeScore)} |`,
	);
	return [header, sep, ...lines].join("\n");
}

/** Plan-phase vs exec-phase note counts for plan-type rows (split on the plan-yolo-handoff timestamp). */
function renderPhaseSplitTable(rows: RunRow[]): string {
	const planRows = rows.filter((r) => r.type === "plan" && r.role !== "off");
	if (planRows.length === 0) return "_No non-off plan-type rows in this run._";
	const sum = (counts: Record<string, number> | undefined) => Object.values(counts ?? {}).reduce((a, b) => a + b, 0);
	const roles = [...new Set(planRows.map((r) => r.role))];
	const header = "| role | n | mean plan-phase notes | mean exec-phase notes |";
	const sep = "|---|---|---|---|";
	const lines = roles.map((role) => {
		const subset = planRows.filter((r) => r.role === role);
		const planVals = subset.map((r) => sum(r.planPhaseNotes));
		const execVals = subset.map((r) => sum(r.execPhaseNotes));
		return `| ${role} | ${subset.length} | ${fmt(mean(planVals), 1)} | ${fmt(mean(execVals), 1)} |`;
	});
	return [header, sep, ...lines].join("\n");
}

function renderSeverityTable(cells: CellStats[]): string {
	const severities = [...new Set(cells.flatMap((c) => Object.keys(c.severityTotals)))].sort();
	if (severities.length === 0) return "_No telemetry with severity data found (role \"off\" runs never write it; check runs used advisory/adversarial)._";
	const header = `| role | type | ${severities.join(" | ")} |`;
	const sep = `|---|---|${severities.map(() => "---").join("|")}|`;
	const lines = cells
		.filter((c) => c.role !== "off")
		.map((c) => `| ${c.role} | ${c.type} | ${severities.map((s) => c.severityTotals[s] ?? 0).join(" | ")} |`);
	return [header, sep, ...lines].join("\n");
}

function contrastLine(a: CellStats, b: CellStats, label: string): string {
	const diff = a.meanSuccess - b.meanSuccess;
	const scoreDiff = a.meanScore - b.meanScore;
	return `- **${label}**: success ${fmt(a.meanSuccess)} vs ${fmt(b.meanSuccess)} (diff ${fmt(diff)}), score ${fmt(a.meanScore)} vs ${fmt(b.meanScore)} (diff ${fmt(scoreDiff)}). n=${a.n}/${b.n}.`;
}

function renderPerTaskTable(rows: RunRow[]): string {
	const tasks = [...new Set(rows.map((r) => r.task))].sort();
	const roles = [...new Set(rows.map((r) => r.role))];
	const types = [...new Set(rows.map((r) => r.type))];
	const header = `| task | ${roles.flatMap((r) => types.map((t) => `${r}/${t}`)).join(" | ")} |`;
	const sep = `|---|${roles.flatMap(() => types.map(() => "---")).join("|")}|`;
	const lines = tasks.map((task) => {
		const cells = roles.flatMap((role) =>
			types.map((type) => {
				const subset = rows.filter((r) => r.task === task && r.role === role && r.type === type);
				if (!subset.length) return "n/a";
				return `${fmt(mean(subset.map((r) => (r.success ? 1 : 0))), 2)} (n=${subset.length})`;
			}),
		);
		return `| ${task} | ${cells.join(" | ")} |`;
	});
	return [header, sep, ...lines].join("\n");
}

async function main(): Promise<void> {
	const resultsDirArg = process.argv[2];
	if (!resultsDirArg) {
		console.error("usage: bun run bench/report.ts <resultsDir>");
		process.exit(1);
	}
	const resultsDir = resolve(process.cwd(), resultsDirArg);
	const runsPath = join(resultsDir, "runs.jsonl");
	const rows = await readRows(runsPath);

	const roles = [...new Set(rows.map((r) => r.role))];
	const types = [...new Set(rows.map((r) => r.type))];
	const cells = roles.flatMap((role) => types.map((type) => computeCell(rows, role, type)));

	const byKey = new Map(cells.map((c) => [`${c.role}/${c.type}`, c]));
	const contrasts: string[] = [];
	for (const type of types) {
		const adv = byKey.get(`advisory/${type}`);
		const adver = byKey.get(`adversarial/${type}`);
		const off = byKey.get(`off/${type}`);
		if (adv && adver) contrasts.push(contrastLine(adv, adver, `advisory vs adversarial (${type})`));
		if (adv && off) contrasts.push(contrastLine(adv, off, `advisory vs off (${type})`));
		if (adver && off) contrasts.push(contrastLine(adver, off, `adversarial vs off (${type})`));
	}

	const md = [
		`# Bench report — ${resultsDirArg}`,
		"",
		`Generated ${new Date().toISOString()} from ${rows.length} rows in \`runs.jsonl\`.`,
		"",
		"## Per (role, type) summary",
		"",
		renderCellTable(cells),
		"",
		"## Contrasts",
		"",
		...contrasts,
		"",
		"## Notes delivered by severity (sum of history[].severity across runs, from typesafe.json)",
		"",
		renderSeverityTable(cells),
		"",
		"## Plan grading (plan-type cells only)",
		"",
		renderPlanTable(cells),
		"",
		"## Plan-phase vs exec-phase notes (plan-type cells, split on the plan-yolo-handoff marker)",
		"",
		renderPhaseSplitTable(rows),
		"",
		"## Ambiguity gate",
		"",
		renderAmbiguityGateTable(rows),
		"",
		"## Per-task success rate (fraction, n = reps)",
		"",
		renderPerTaskTable(rows),
		"",
	].join("\n");

	const outPath = join(resultsDir, "report.md");
	await writeFile(outPath, md);
	console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
