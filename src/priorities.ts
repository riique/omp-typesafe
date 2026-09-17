import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cap } from "./text";

/**
 * ADVERSARY.md review priorities, mirroring WATCHDOG.md discovery:
 * user-level file first, then <dir>/ADVERSARY.md and <dir>/.omp/ADVERSARY.md
 * for every directory from the git root (or $HOME) down to cwd.
 * Missing files are normal; total output capped.
 */

const TOTAL_CAP = 2000;

function ancestorDirs(cwd: string): string[] {
	const start = resolve(cwd || homedir());
	const stop = homedir();
	const out: string[] = [];
	let dir = start;
	for (let i = 0; i < 64; i++) {
		out.push(dir);
		if (dir === stop || existsSync(join(dir, ".git"))) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// Outermost ancestor first, descending toward cwd.
	return out.reverse();
}

/** Collect and concatenate ADVERSARY.md files; empty string when none exist. */
export async function loadPriorities(cwd: string): Promise<string> {
	const files: string[] = [join(homedir(), ".omp", "agent", "ADVERSARY.md")];
	for (const dir of ancestorDirs(cwd)) {
		files.push(join(dir, "ADVERSARY.md"), join(dir, ".omp", "ADVERSARY.md"));
	}
	const chunks: string[] = [];
	let total = 0;
	for (const path of files) {
		try {
			const text = await Bun.file(path).text();
			if (text.trim().length === 0) continue;
			chunks.push(text);
			total += text.length;
			if (total >= TOTAL_CAP) break;
		} catch {
			// Missing or unreadable priority files are normal.
		}
	}
	const joined = cap(chunks.join("\n\n"), TOTAL_CAP);
	return joined;
}
