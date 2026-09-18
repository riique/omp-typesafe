import { runGrade } from "../../lib/grade-common";
import task from "./task.json";

export async function grade(cwd: string) {
	return runGrade(cwd, task);
}
