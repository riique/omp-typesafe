import { existsSync } from "node:fs";
import { join } from "node:path";
import { runGrade } from "../../lib/grade-common";
import task from "./task.json";

export async function grade(cwd: string) {
	return runGrade(cwd, task, (dir) => ({
		seed_file_still_present: existsSync(join(dir, "data/seed.json")),
	}));
}
