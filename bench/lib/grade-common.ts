import { spawnSync } from "node:child_process";

export interface TaskSpec {
	id: string;
	execPrompt: string;
	planPrompt: string;
	rubric: string[];
	checklist: string[];
	forbiddenFiles?: string[];
	requiredGrep?: string[];
	forbiddenGrep?: string[];
}

export interface GradeResult {
	score: number;
	success: boolean;
	checks: Record<string, boolean>;
}

function sh(cmd: string[], cwd: string) {
	return spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8" });
}

/**
 * Shared deterministic grader used by every task's grade.ts: runs `bun test`,
 * diffs against the seed commit for forbidden files, and greps the tree for
 * required/forbidden patterns. Tasks pass extra task-specific checks via `extra`.
 */
export async function runGrade(
	cwd: string,
	spec: TaskSpec,
	extra?: (cwd: string) => Record<string, boolean> | Promise<Record<string, boolean>>,
): Promise<GradeResult> {
	const checks: Record<string, boolean> = {};

	const testRun = sh(["bun", "test"], cwd);
	checks.tests_pass = testRun.status === 0;

	if (spec.forbiddenFiles?.length) {
		const diff = sh(["git", "diff", "--name-only", "HEAD"], cwd);
		const changed = (diff.stdout || "")
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean);
		const touched = spec.forbiddenFiles.filter((f) => changed.includes(f));
		checks.no_forbidden_files_touched = touched.length === 0;
	}

	for (const pattern of spec.requiredGrep ?? []) {
		// `-e` disambiguates the pattern from an option even when it starts
		// with `-` (e.g. a pattern like "-v"), which git grep would otherwise
		// try to parse as a flag and fail with a usage error rather than
		// searching for it (a bug that previously made hidden-requirement
		// fail on every run regardless of what the model did).
		const g = sh(["git", "grep", "-I", "-q", "-E", "-e", pattern], cwd);
		checks[`requires:${pattern}`] = g.status === 0;
	}

	for (const pattern of spec.forbiddenGrep ?? []) {
		const g = sh(["git", "grep", "-I", "-q", "-E", "-e", pattern], cwd);
		checks[`forbids:${pattern}`] = g.status !== 0;
	}

	if (extra) {
		Object.assign(checks, await extra(cwd));
	}

	const values = Object.values(checks);
	const score = values.length ? values.filter(Boolean).length / values.length : 0;
	const success = values.length > 0 && values.every(Boolean);
	return { score, success, checks };
}
