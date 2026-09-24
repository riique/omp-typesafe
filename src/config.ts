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

export interface AmbiguityGateSettings {
	enabled: boolean;
	threshold: number;
	weights: { goal: number; constraints: number; criteria: number; context: number };
	userCanAnswerFloor: number;
	maxAsksPerPlan: number;
	blockPropose: boolean;
	timeoutMs: number;
}

export type TypesafeRole = "adversarial" | "advisory";
export type TypesafePhase = "plan" | "execute";

export interface TypesafeConfig {
	role: TypesafeRole;
	phases: TypesafePhase[];
	adversary: AdversarySettings;
	stopGate: StopGateSettings;
	ambiguityGate: AmbiguityGateSettings;
}

export const DEFAULT_CONFIG: TypesafeConfig = {
	role: "adversarial",
	phases: ["plan", "execute"],
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
	ambiguityGate: {
		enabled: true,
		threshold: 0.2,
		weights: { goal: 0.35, constraints: 0.25, criteria: 0.25, context: 0.15 },
		userCanAnswerFloor: 0.5,
		maxAsksPerPlan: 3,
		blockPropose: true,
		timeoutMs: 2500,
	},
};

export function configPath(): string {
	return join(homedir(), ".omp", "agent", "typesafe.json");
}

/** Resolve the config file path, honoring TYPESAFE_CONFIG as a full replacement path. */
export function resolveConfigPath(env: Record<string, string | undefined> = process.env): string {
	const override = env.TYPESAFE_CONFIG?.trim();
	return override ? override : configPath();
}

/**
 * Apply TYPESAFE_ROLE / TYPESAFE_REVIEW_ENABLED on top of a merged config. Env wins over file.
 * Pure function so it is independently testable; TYPESAFE_CONFIG is handled separately in
 * loadConfig (it selects *which* file to read, before merging, not a post-merge override).
 */
export function applyEnvOverrides(cfg: TypesafeConfig, env: Record<string, string | undefined> = process.env): TypesafeConfig {
	let out = cfg;
	const role = env.TYPESAFE_ROLE;
	if (role === "advisory" || role === "adversarial") {
		out = { ...out, role };
	}
	const enabledRaw = env.TYPESAFE_REVIEW_ENABLED?.trim().toLowerCase();
	if (enabledRaw === "0" || enabledRaw === "false") {
		out = { ...out, adversary: { ...out.adversary, enabled: false } };
	} else if (enabledRaw === "1" || enabledRaw === "true") {
		out = { ...out, adversary: { ...out.adversary, enabled: true } };
	}
	const gateRaw = env.TYPESAFE_AMBIGUITY_GATE?.trim().toLowerCase();
	if (gateRaw === "0" || gateRaw === "false") {
		out = { ...out, ambiguityGate: { ...out.ambiguityGate, enabled: false } };
	} else if (gateRaw === "1" || gateRaw === "true") {
		out = { ...out, ambiguityGate: { ...out.ambiguityGate, enabled: true } };
	}
	const thresholdRaw = env.TYPESAFE_AMBIGUITY_THRESHOLD?.trim();
	if (thresholdRaw) {
		const parsed = Number.parseFloat(thresholdRaw);
		if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
			out = { ...out, ambiguityGate: { ...out.ambiguityGate, threshold: parsed } };
		}
	}
	return out;
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

function roleVal(v: unknown, fallback: TypesafeRole): TypesafeRole {
	return v === "adversarial" || v === "advisory" ? v : fallback;
}

function phasesArr(v: unknown, fallback: TypesafePhase[]): TypesafePhase[] {
	if (!Array.isArray(v)) return fallback;
	const out = [...new Set(v.filter((x): x is TypesafePhase => x === "plan" || x === "execute"))];
	return out.length > 0 ? out : fallback;
}

export function mergeConfig(base: TypesafeConfig, override: unknown): TypesafeConfig {
	const o = (typeof override === "object" && override !== null ? override : {}) as Record<string, unknown>;
	const adv = (typeof o.adversary === "object" && o.adversary !== null ? o.adversary : {}) as Record<string, unknown>;
	const gate = (typeof o.stopGate === "object" && o.stopGate !== null ? o.stopGate : {}) as Record<string, unknown>;
	const amb = (typeof o.ambiguityGate === "object" && o.ambiguityGate !== null ? o.ambiguityGate : {}) as Record<string, unknown>;
	const ambWeights = (typeof amb.weights === "object" && amb.weights !== null ? amb.weights : {}) as Record<string, unknown>;
	const a = base.adversary;
	const g = base.stopGate;
	const ag = base.ambiguityGate;
	return {
		role: roleVal(o.role, base.role),
		phases: phasesArr(o.phases, base.phases),
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
		ambiguityGate: {
			enabled: bool(amb.enabled, ag.enabled),
			threshold: num(amb.threshold, ag.threshold, 0, 1),
			weights: {
				goal: num(ambWeights.goal, ag.weights.goal, 0, 1),
				constraints: num(ambWeights.constraints, ag.weights.constraints, 0, 1),
				criteria: num(ambWeights.criteria, ag.weights.criteria, 0, 1),
				context: num(ambWeights.context, ag.weights.context, 0, 1),
			},
			userCanAnswerFloor: num(amb.userCanAnswerFloor, ag.userCanAnswerFloor, 0, 1),
			maxAsksPerPlan: Math.trunc(num(amb.maxAsksPerPlan, ag.maxAsksPerPlan, 0, 32)),
			blockPropose: bool(amb.blockPropose, ag.blockPropose),
			timeoutMs: Math.trunc(num(amb.timeoutMs, ag.timeoutMs, 250, 60_000)),
		},
	};
}

/** Load (or reload) the config file; returns the effective config. */
export async function loadConfig(logger?: { warn?: (...a: unknown[]) => void; info?: (...a: unknown[]) => void }): Promise<TypesafeConfig> {
	const path = resolveConfigPath();
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
	config = applyEnvOverrides(config);
	return config;
}
