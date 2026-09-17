import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Config lives at ~/.omp/agent/typesafe.json and is loaded on session_start.
 * Missing or malformed files fall back to these defaults.
 */

export interface AdversarySettings {
	enabled: boolean;
	reviewActions: boolean;
	reviewMessages: boolean;
	reviewTurns: boolean;
	tools: string[];
	inlineActionNotes: boolean;
	evidence: boolean;
	noul_floor: number;
	concern_severity: number;
	blocker_severity: number;
	emitNits: boolean;
	maxNotesPerUpdate: number;
	maxCallsPerTurn: number;
	immuneTurns: number;
	minMessageChars: number;
	timeoutMs: number;
}

export interface StopGateSettings {
	enabled: boolean;
	unfinished_threshold: number;
	verified_floor: number;
}

export interface TypesafeConfig {
	model: string;
	adversary: AdversarySettings;
	stopGate: StopGateSettings;
}

export const DEFAULT_CONFIG: TypesafeConfig = {
	model: "jev-latest",
	adversary: {
		enabled: true,
		reviewActions: true,
		reviewMessages: true,
		reviewTurns: true,
		tools: ["edit", "write", "apply_patch", "ast_edit", "bash", "eval", "notebook", "debug", "task"],
		inlineActionNotes: true,
		evidence: true,
		noul_floor: 0.45,
		concern_severity: 1.5,
		blocker_severity: 2.5,
		emitNits: false,
		maxNotesPerUpdate: 4,
		maxCallsPerTurn: 8,
		immuneTurns: 3,
		minMessageChars: 200,
		timeoutMs: 1500,
	},
	stopGate: { enabled: false, unfinished_threshold: 0.7, verified_floor: 0.25 },
};

export function configPath(): string {
	return join(homedir(), ".omp", "agent", "typesafe.json");
}

let config: TypesafeConfig = structuredClone(DEFAULT_CONFIG);

export function getConfig(): TypesafeConfig {
	return config;
}

function bool(v: unknown, fallback: boolean): boolean {
	return typeof v === "boolean" ? v : fallback;
}

function num(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return Math.min(max, Math.max(min, v));
}

function strArr(v: unknown, fallback: string[]): string[] {
	if (!Array.isArray(v)) return fallback;
	const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
	return out.length > 0 ? out : fallback;
}

function mergeConfig(base: TypesafeConfig, override: unknown): TypesafeConfig {
	const o = (typeof override === "object" && override !== null ? override : {}) as Record<string, unknown>;
	const adv = (typeof o.adversary === "object" && o.adversary !== null ? o.adversary : {}) as Record<string, unknown>;
	const gate = (typeof o.stopGate === "object" && o.stopGate !== null ? o.stopGate : {}) as Record<string, unknown>;
	const a = base.adversary;
	const g = base.stopGate;
	return {
		model: typeof o.model === "string" && o.model.trim() ? o.model.trim() : base.model,
		adversary: {
			enabled: bool(adv.enabled, a.enabled),
			reviewActions: bool(adv.reviewActions, a.reviewActions),
			reviewMessages: bool(adv.reviewMessages, a.reviewMessages),
			reviewTurns: bool(adv.reviewTurns, a.reviewTurns),
			tools: strArr(adv.tools, a.tools),
			inlineActionNotes: bool(adv.inlineActionNotes, a.inlineActionNotes),
			evidence: bool(adv.evidence, a.evidence),
			noul_floor: num(adv.noul_floor, a.noul_floor, 0, 1),
			concern_severity: num(adv.concern_severity, a.concern_severity, 0, 3),
			blocker_severity: num(adv.blocker_severity, a.blocker_severity, 0, 3),
			emitNits: bool(adv.emitNits, a.emitNits),
			maxNotesPerUpdate: Math.trunc(num(adv.maxNotesPerUpdate, a.maxNotesPerUpdate, 1, 32)),
			maxCallsPerTurn: Math.trunc(num(adv.maxCallsPerTurn, a.maxCallsPerTurn, 1, 128)),
			immuneTurns: Math.trunc(num(adv.immuneTurns, a.immuneTurns, 0, 32)),
			minMessageChars: Math.trunc(num(adv.minMessageChars, a.minMessageChars, 0, 100_000)),
			timeoutMs: Math.trunc(num(adv.timeoutMs, a.timeoutMs, 250, 60_000)),
		},
		stopGate: {
			enabled: bool(gate.enabled, g.enabled),
			unfinished_threshold: num(gate.unfinished_threshold, g.unfinished_threshold, 0, 1),
			verified_floor: num(gate.verified_floor, g.verified_floor, 0, 1),
		},
	};
}

/** Load (or reload) the config file; returns the effective config. */
export async function loadConfig(logger?: { warn?: (...a: unknown[]) => void; info?: (...a: unknown[]) => void }): Promise<TypesafeConfig> {
	const path = configPath();
	try {
		const raw = await Bun.file(path).json();
		config = mergeConfig(DEFAULT_CONFIG, raw);
		logger?.info?.(`[typesafe] config loaded from ${path}`);
	} catch (err) {
		config = structuredClone(DEFAULT_CONFIG);
		// Bun file errors carry an errno `code` property on the Error object.
		if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
			logger?.warn?.(`[typesafe] config at ${path} unreadable (${err}); using defaults`);
		}
	}
	return config;
}
