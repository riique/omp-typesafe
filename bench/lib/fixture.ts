import { cp } from "node:fs/promises";
import { spawnSync } from "node:child_process";

function run(cmd: string[], cwd: string): void {
	const r = spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: "pipe", encoding: "utf8" });
	if (r.status !== 0) {
		throw new Error(`command failed in ${cwd}: ${cmd.join(" ")}\n${r.stderr}`);
	}
}

/** Copy a fixture dir into a fresh temp repo and commit it, so grading can diff against HEAD. */
export async function prepareFixture(fixtureDir: string, destDir: string): Promise<void> {
	await cp(fixtureDir, destDir, { recursive: true });
	run(["git", "init", "-q"], destDir);
	run(["git", "config", "user.email", "bench@example.com"], destDir);
	run(["git", "config", "user.name", "bench"], destDir);
	run(["git", "add", "-A"], destDir);
	run(["git", "commit", "-q", "-m", "seed fixture"], destDir);
}
