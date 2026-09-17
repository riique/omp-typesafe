/** Shared text helpers and runtime narrowing guards used across the extension. */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cap(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max);
}

export function firstLine(text: string, max: number): string {
	const line = text.split("\n", 1)[0] ?? "";
	return cap(line.trim(), max);
}

/** Concatenate `text` blocks out of a content array (or pass through a bare string). */
export function textFromContent(content: unknown, max: number): string {
	if (!Array.isArray(content)) {
		return typeof content === "string" ? cap(content, max) : "";
	}
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
			parts.push(block.text);
		}
	}
	return cap(parts.join("\n"), max);
}

/** Stable one-line JSON of an arbitrary tool input, capped. */
export function stringifyInput(input: unknown, max: number): string {
	if (input === undefined || input === null) return "";
	let text: string;
	if (typeof input === "string") {
		text = input;
	} else {
		try {
			text = JSON.stringify(input) ?? "";
		} catch {
			text = String(input);
		}
	}
	return cap(text, max);
}

/** Escape a value for inclusion in a double-quoted XML-style attribute. */
export function escapeAttr(value: string): string {
	return value.replace(/"/g, "'").replace(/\s+/g, " ").trim();
}

export function fmt2(value: number): string {
	return value.toFixed(2);
}
