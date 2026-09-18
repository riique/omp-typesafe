import { cap, firstLine, isRecord, stringifyInput } from "./text";

/**
 * The single place omp branch-entry structure is interpreted.
 * Roles are camelCase (`user`, `assistant`, `toolResult`); tool calls are
 * `toolCall` content blocks inside assistant messages.
 */

export interface ToolCallView {
	name: string;
	inputPreview: string;
}

export interface MessageView {
	role: string;
	text: string;
	toolName: string | null;
	toolCallId: string | null;
	isError: boolean;
	toolCalls: ToolCallView[];
}

export interface EntryView {
	type: string;
	customType: string | null;
	content: string;
	message: MessageView | null;
}

function scanMessage(raw: Record<string, unknown>): MessageView {
	const role = typeof raw.role === "string" ? raw.role : "";
	let text = "";
	const toolCalls: ToolCallView[] = [];
	if (Array.isArray(raw.content)) {
		for (const block of raw.content) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
				text += (text ? "\n" : "") + block.text;
			} else if (block.type === "toolCall") {
				const name = typeof block.name === "string" ? block.name : typeof block.toolName === "string" ? block.toolName : "tool";
				toolCalls.push({ name, inputPreview: firstLine(stringifyInput(block.input ?? block.arguments ?? block.args, 400), 160) });
			}
		}
	}
	return {
		role,
		text,
		toolName: typeof raw.toolName === "string" ? raw.toolName : null,
		toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : null,
		isError: raw.isError === true,
		toolCalls,
	};
}

/** Validate and project raw branch entries into a stable view. */
export function scanBranch(branch: unknown): EntryView[] {
	if (!Array.isArray(branch)) return [];
	const out: EntryView[] = [];
	for (const raw of branch) {
		if (!isRecord(raw)) continue;
		const type = typeof raw.type === "string" ? raw.type : "";
		const view: EntryView = {
			type,
			customType: typeof raw.customType === "string" ? raw.customType : null,
			content: typeof raw.content === "string" ? raw.content : "",
			message: type === "message" && isRecord(raw.message) ? scanMessage(raw.message) : null,
		};
		out.push(view);
	}
	return out;
}

/** Most recent non-empty user message text (oldest-to-newest scan backwards). */
export function lastUserText(entries: EntryView[], max = 1200): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message?.role === "user" && e.message.text.trim().length > 0) {
			return cap(e.message.text, max);
		}
	}
	return "";
}

/** Most recent non-empty assistant message text — the claim under review. */
export function claimedIntent(entries: EntryView[], max = 800): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message?.role === "assistant" && e.message.text.trim().length > 0) {
			return cap(e.message.text, max);
		}
	}
	return "";
}

/** Last `count` tool results as "tool: first-line" summaries, oldest first. */
export function priorActions(entries: EntryView[], count: number): string[] {
	const out: string[] = [];
	for (let i = entries.length - 1; i >= 0 && out.length < count; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message?.role === "toolResult") {
			out.push(`${e.message.toolName ?? "tool"}: ${firstLine(e.message.text, 120)}`);
		}
	}
	return out.reverse();
}

/** Render a delta of branch entries for turn review, capped. */
export function renderDelta(entries: EntryView[], max = 6000): string {
	const lines: string[] = [];
	for (const e of entries) {
		if (e.type !== "message" || !e.message) continue;
		const m = e.message;
		if (m.role === "user" && m.text.trim().length > 0) {
			lines.push(`USER: ${cap(m.text, 800)}`);
		} else if (m.role === "assistant") {
			if (m.text.trim().length > 0) lines.push(`ASSISTANT: ${cap(m.text, 1500)}`);
			for (const tc of m.toolCalls) lines.push(`  call ${tc.name}: ${tc.inputPreview}`);
		} else if (m.role === "toolResult") {
			lines.push(`  result ${m.toolName ?? "tool"}${m.isError ? " (error)" : ""}: ${firstLine(m.text, 200)}`);
		}
	}
	return cap(lines.join("\n"), max);
}

/**
 * Substrings that mark a `custom`/`custom_message` entry as plan-mode context,
 * per the advisor doc's injected constraint context. Exported so callers and
 * tests can reference the exact marker set instead of duplicating it.
 */
export const PLAN_MODE_MARKERS = ["plan-mode-context", "plan-mode-reference"] as const;

/**
 * Plan-mode detection: a `custom` or `custom_message` entry whose customType
 * contains one of PLAN_MODE_MARKERS among recent entries.
 */
export function planModeActive(entries: EntryView[]): boolean {
	for (const e of entries.slice(-100)) {
		if (e.type !== "custom" && e.type !== "custom_message") continue;
		if (e.customType === null) continue;
		if (PLAN_MODE_MARKERS.some((marker) => e.customType!.includes(marker))) {
			return true;
		}
	}
	return false;
}
