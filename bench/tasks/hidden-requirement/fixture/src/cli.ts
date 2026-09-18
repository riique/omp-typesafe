export interface ParsedArgs {
	verbose: boolean;
	rest: string[];
}

/** Parses a small CLI arg list. Currently only understands the short "-v" flag. */
export function parseArgs(argv: string[]): ParsedArgs {
	const rest: string[] = [];
	let verbose = false;
	for (const a of argv) {
		if (a === "-v") verbose = true;
		else rest.push(a);
	}
	return { verbose, rest };
}
