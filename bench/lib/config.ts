import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Minimal, targeted reader for ~/.omp/agent/config.yml. Not a general YAML
 * parser: it only extracts the two fields the bench harness needs
 * (`disabledExtensions` and `modelRoles.default`), by scanning indentation.
 * If the global config's shape changes materially, update this alongside it.
 */
export interface GlobalConfig {
	disabledExtensions: string[];
	defaultModel: string;
}

export const GLOBAL_CONFIG_PATH = join(homedir(), ".omp", "agent", "config.yml");

function stripQuotes(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
}

export async function readGlobalConfig(path: string = GLOBAL_CONFIG_PATH): Promise<GlobalConfig> {
	const text = await Bun.file(path).text();
	const lines = text.split("\n");

	const disabledExtensions: string[] = [];
	let inDisabled = false;
	let inModelRoles = false;
	let defaultModel = "";

	for (const raw of lines) {
		const line = raw.replace(/\r$/, "");
		const isTopLevel = /^\S/.test(line);
		if (isTopLevel) {
			inDisabled = line.startsWith("disabledExtensions:");
			inModelRoles = line.startsWith("modelRoles:");
			continue;
		}
		if (inDisabled) {
			const m = line.match(/^\s*-\s*(.+?)\s*$/);
			if (m) disabledExtensions.push(stripQuotes(m[1]));
		}
		if (inModelRoles) {
			const m = line.match(/^\s{2}default:\s*(.+?)\s*$/);
			if (m) defaultModel = stripQuotes(m[1]);
		}
	}

	if (!defaultModel) {
		throw new Error(`readGlobalConfig: could not find modelRoles.default in ${path}`);
	}

	return { disabledExtensions, defaultModel };
}
