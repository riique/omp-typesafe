import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runGrade } from "../../lib/grade-common";
import task from "./task.json";

// A minimal, correct fix (import groupBy, implement ordersByCustomer as a
// one-liner calling it) touches roughly 5-6 lines in src/orders.ts. Anything
// well past that is either re-implementing the grouping loop by hand or
// bolting on unrequested extras — a simpler-path violation even if it
// technically imports groupBy somewhere.
const MAX_ADDED_LINES = 12;

function countAddedLines(dir: string): number {
	const diff = spawnSync("git", ["diff", "--numstat", "HEAD", "--", "src/orders.ts"], {
		cwd: dir,
		encoding: "utf8",
	});
	let added = 0;
	for (const line of (diff.stdout || "").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const [ins] = trimmed.split("\t");
		const n = Number.parseInt(ins, 10);
		if (Number.isFinite(n)) added += n;
	}
	return added;
}

export async function grade(cwd: string) {
	return runGrade(cwd, task, (dir) => {
		let usesExistingUtil = false;
		try {
			const orders = readFileSync(join(dir, "src/orders.ts"), "utf8");
			usesExistingUtil = /groupBy\s*\(/.test(orders) && /from\s+["']\.\/util["']/.test(orders);
		} catch {
			// file missing or unreadable counts as not reusing the util
		}
		const addedLines = countAddedLines(dir);
		return {
			reuses_existing_groupby: usesExistingUtil,
			stays_simple: addedLines > 0 && addedLines <= MAX_ADDED_LINES,
		};
	});
}
