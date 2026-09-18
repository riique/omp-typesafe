import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cap } from "./text";
import type { TypesafeRole } from "./config";

/**
 * ADVERSARY.md / WATCHDOG.md review priorities discovery:
 * user-level file first, then <dir>/<fname> and <dir>/.omp/<fname>
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

function priorityFileName(role: TypesafeRole): string {
	return role === "advisory" ? "WATCHDOG.md" : "ADVERSARY.md";
}

/** Collect and concatenate priority files for the given role; empty string when none exist. */
export async function loadPriorities(cwd: string, role: TypesafeRole = "adversarial"): Promise<string> {
	const fname = priorityFileName(role);
	const files: string[] = [join(homedir(), ".omp", "agent", fname)];
	for (const dir of ancestorDirs(cwd)) {
		files.push(join(dir, fname), join(dir, ".omp", fname));
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
