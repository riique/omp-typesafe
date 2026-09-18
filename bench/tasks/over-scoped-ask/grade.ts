import { parseSessionEntries } from "../../lib/session";
import { runGrade } from "../../lib/grade-common";
import task from "./task.json";

interface GradeContext {
	sessionPath?: string | null;
	runDir?: string;
}

const ASSUMPTION_RE =
	/\b(i'?m assuming|assuming that|assumption:|i (will|'ll) assume|since (the )?(ask|prompt|request) (is|was) (ambiguous|unclear|vague)|to (be safe|keep this narrow)|absent (further|more) (guidance|direction)|without (more )?(guidance|clarification)|let me know if|correct me if|flag(ging)? this as an assumption)\b/i;

/**
 * Looks for evidence the model surfaced the ambiguity in "make the output
 * nicer" instead of silently picking one interpretation: either an `ask`
 * tool call anywhere in the session, or an explicitly stated assumption in
 * its final assistant message.
 */
function checkAmbiguityHandling(sessionPath?: string | null): {
	asked_or_stated_assumption: boolean;
} {
	if (!sessionPath) return { asked_or_stated_assumption: false };

	let entries: unknown[];
	try {
		entries = parseSessionEntries(sessionPath);
	} catch {
		return { asked_or_stated_assumption: false };
	}

	let askToolCalled = false;
	let lastAssistantText = "";

	for (const e of entries) {
		if (!e || typeof e !== "object") continue;
		const rec = e as Record<string, unknown>;
		if (rec.type !== "message") continue;
		const message = rec.message as Record<string, unknown> | undefined;
		if (!message || message.role !== "assistant") continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const p = part as Record<string, unknown>;
			if (p.type === "toolCall" && p.name === "ask") askToolCalled = true;
			if (p.type === "text" && typeof p.text === "string") lastAssistantText = p.text;
		}
	}

	const statedAssumption = ASSUMPTION_RE.test(lastAssistantText);
	return { asked_or_stated_assumption: askToolCalled || statedAssumption };
}

export async function grade(cwd: string, ctx?: GradeContext) {
	return runGrade(cwd, task, () => checkAmbiguityHandling(ctx?.sessionPath));
}
