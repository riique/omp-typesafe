import { homedir } from "node:os";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Questions } from "@typesafe-ai/sdk";
import {
	apiKeyPresent,
	ask,
	choice,
	describeError,
	estimateCostUsd,
	getLastResolvedModel,
	getSessionUsage,
	noul,
	resetClient,
	resetUsage,
	score,
} from "./client";
import type { WireAnswer } from "./client";
import { getConfig, loadConfig } from "./config";
import type { TypesafeRole } from "./config";
import { loadPriorities } from "./priorities";
import { collectEvidence, recordAction, repoOutline, resetEvidenceTurn } from "./evidence";
import type { Evidence } from "./evidence";
import { claimedIntent, lastUserText, planModeActive, priorActions, renderDelta, scanBranch } from "./branch";
import type { EntryView } from "./branch";
import {
	beginTurn,
	canReviewMessage,
	endTurn,
	getLastReviewRecord,
	getReviewHistory,
	getReviewStats,
	recordMessageReviewed,
	resetReviewerSession,
	review,
	shouldEmit,
	isSteerImmune,
} from "./reviewer";
import {
	asksObserved,
	buildBlockReason,
	buildGateNote,
	GATE_CUSTOM_TYPE,
	getAmbiguityTelemetry,
	getAsks,
	getLastAmbiguityScore,
	isProposeWrite,
	proposeDecision,
	recordAsk,
	recordScore,
	resetAmbiguitySession,
	scoreAmbiguity,
} from "./ambiguity";
import type { AmbiguityResult, GateDecision, GateTrigger } from "./ambiguity";
import { cap, fmt2, isRecord, stringifyInput, textFromContent } from "./text";

/**
 * TypeSafe Adversary — advisor-pattern adversarial reviewer for omp, powered by
 * TypeSafe AI's System One model (Jev). Watches actions, responses, and turn
 * deltas; raises nit/concern/blocker notes; exposes the typesafe_ask tool.
 */

// omp host API types ship with the host package, which is not a dependency of
// this plugin; the host injects a Zod-compatible schema builder and a logger.
interface ZodSchemaLike {
	optional(): ZodSchemaLike;
}

interface ZodBuilder {
	object(shape: Record<string, ZodSchemaLike>): ZodSchemaLike;
	string(): ZodSchemaLike;
	enum(...values: string[]): ZodSchemaLike;
	array(item: ZodSchemaLike): ZodSchemaLike;
	record(key: ZodSchemaLike, value: ZodSchemaLike): ZodSchemaLike;
}

interface LoggerLike {
	debug?(...args: unknown[]): void;
	info?(...args: unknown[]): void;
	warn?(...args: unknown[]): void;
	error?(...args: unknown[]): void;
}

interface NotifyCtx {
	hasUI?: boolean;
	ui?: { notify(message: string, level?: string): unknown };
}

let priorities = "";
let turnCursor = 0;
const reviewedCallIds = new Set<string>();
let sessionOverride: boolean | null = null;
let sessionRoleOverride: TypesafeRole | null = null;
let stopGateUses = 0;
let planStartScored = false;
let planPrompt = "";

function reviewEnabled(): boolean {
	return sessionOverride ?? getConfig().adversary.enabled;
}

function resolvedRole(): TypesafeRole {
	return sessionRoleOverride ?? getConfig().role;
}

function roleLabel(role: TypesafeRole): string {
	return role === "advisory" ? "TypeSafe Advisor" : "TypeSafe Adversary";
}

/** Gate a trigger on config.phases: plan-mode entries need "plan", everything else needs "execute". */
function phaseAllowed(entries: EntryView[]): boolean {
	const phases = getConfig().phases;
	return planModeActive(entries) ? phases.includes("plan") : phases.includes("execute");
}

function notifyVia(ctx: NotifyCtx | undefined, logger: LoggerLike | undefined, message: string, level = "info"): void {
	if (ctx?.hasUI === true && ctx.ui) ctx.ui.notify(message, level);
	else logger?.info?.(`[typesafe] ${message}`);
}

function answerNumber(answer: WireAnswer | undefined, key: string): number | null {
	if (!answer) return null;
	const value = answer[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Format probabilities map ("0": 0.62, ...) as "0=0.62 1=0.30". */
function formatProbabilities(probabilities: unknown): string {
	if (!isRecord(probabilities)) return "";
	const parts: string[] = [];
	for (const [key, value] of Object.entries(probabilities)) {
		if (typeof value === "number") parts.push(`${key}=${value.toFixed(2)}`);
	}
	return parts.join(" ");
}

function summarizeAnswers(answers: Record<string, WireAnswer>): string {
	const lines: string[] = [];
	for (const [id, a] of Object.entries(answers)) {
		if (a.type === "noul") {
			lines.push(`${id}.noul = ${typeof a.noul === "number" ? a.noul.toFixed(3) : String(a.noul)}`);
		} else if (a.type === "choice") {
			const conf = typeof a.confidence === "number" ? a.confidence.toFixed(3) : "?";
			const probs = formatProbabilities(a.probabilities);
			lines.push(`${id}.choice = ${String(a.choice)} (confidence ${conf}${probs ? `; probabilities ${probs}` : ""})`);
		} else if (a.type === "score") {
			const conf = typeof a.confidence === "number" ? a.confidence.toFixed(3) : "?";
			const probs = formatProbabilities(a.probabilities);
			const legend = isRecord(a.legend)
				? Object.entries(a.legend)
						.map(([k, v]) => `${k}=${String(v)}`)
						.join(" ")
				: "";
			lines.push(`${id}.score = ${typeof a.score === "number" ? a.score.toFixed(3) : String(a.score)} (confidence ${conf}${legend ? `; legend ${legend}` : ""}${probs ? `; probabilities ${probs}` : ""})`);
		}
	}
	return lines.join("\n");
}

function normalizeOptions(options: unknown): Record<string, string> | undefined {
	if (Array.isArray(options)) {
		const map: Record<string, string> = {};
		for (const entry of options) {
			if (isRecord(entry) && typeof entry.name === "string" && entry.name.length > 0) {
				map[entry.name] = typeof entry.description === "string" ? entry.description : "";
			}
		}
		return Object.keys(map).length > 0 ? map : undefined;
	}
	if (isRecord(options)) {
		const map: Record<string, string> = {};
		for (const [key, value] of Object.entries(options)) {
			if (typeof value === "string") map[key] = value;
		}
		return Object.keys(map).length > 0 ? map : undefined;
	}
	return undefined;
}

function buildWireQuestions(items: unknown): { questions?: Questions; error?: string } {
	if (!Array.isArray(items) || items.length === 0) return { error: "questions must be a non-empty array" };
	const questions: Questions = {};
	for (const raw of items) {
		if (!isRecord(raw)) return { error: "each question must be an object" };
		const id = typeof raw.id === "string" ? raw.id : "";
		if (!id) return { error: "question.id is required" };
		const type = raw.type;
		const instructions = typeof raw.instructions === "string" ? raw.instructions : "";
		if (type === "noul") {
			const whenTrue = typeof raw.whenTrue === "string" ? raw.whenTrue : undefined;
			const whenFalse = typeof raw.whenFalse === "string" ? raw.whenFalse : undefined;
			questions[id] = noul(instructions, whenTrue !== undefined || whenFalse !== undefined ? { true: whenTrue, false: whenFalse } : undefined);
		} else if (type === "choice") {
			const criteria = normalizeOptions(raw.options);
			if (!criteria || Object.keys(criteria).length < 2) return { error: `question ${id}: choice requires options with at least 2 entries` };
			questions[id] = choice(instructions, criteria);
		} else if (type === "score") {
			const levels = Array.isArray(raw.levels) ? raw.levels.filter((l): l is string => typeof l === "string") : [];
			if (levels.length < 2 || levels.length > 10) return { error: `question ${id}: score requires 2-10 levels` };
			questions[id] = score(instructions, levels);
		} else {
			return { error: `question ${id}: type must be noul, choice, or score` };
		}
	}
	return { questions };
}

/**
 * Ambiguity gate helpers. Everything here is defensive: any failure yields a
 * "none" decision and the plan-mode flow continues untouched.
 */

interface GateCtxLike {
	cwd?: string;
	hasUI?: boolean;
	sessionManager: { getBranch(): unknown[] };
}

/** Assistant text seen so far this plan, plus any plan file content written. */
function planSoFar(entries: EntryView[], max = 6000): string {
	const lines: string[] = [];
	for (const e of entries) {
		if (e.type !== "message" || !e.message) continue;
		if (e.message.role === "assistant" && e.message.text.trim().length > 0) lines.push(e.message.text);
	}
	return cap(lines.join("\n"), max);
}

export default function typesafeExtension(pi: ExtensionAPI) {
	pi.setLabel("TypeSafe Adversary");
	const logger = pi.logger as LoggerLike | undefined;
	const z = pi.zod as ZodBuilder;

	pi.on("session_start", async (_event, ctx) => {
		await loadConfig(logger);
		sessionOverride = null;
		sessionRoleOverride = null;
		priorities = await loadPriorities(ctx.cwd, resolvedRole());
		resetUsage();
		resetClient();
		resetReviewerSession();
		resetEvidenceTurn();
		reviewedCallIds.clear();
		stopGateUses = 0;
		resetAmbiguitySession();
		planStartScored = false;
		planPrompt = "";
		turnCursor = ctx.sessionManager.getBranch().length;
		pi.setLabel(roleLabel(resolvedRole()));
		if (!apiKeyPresent()) {
			logger?.warn?.("[typesafe] TYPESAFE_API_KEY is not set; adversary and typesafe_ask stay inactive");
			notifyVia(ctx, logger, "TypeSafe adversary inactive: TYPESAFE_API_KEY not set", "warn");
		}
	});

	const resetCursor = async (_event: unknown, ctx: { sessionManager: { getBranch(): unknown[] } }) => {
		turnCursor = Math.max(0, ctx.sessionManager.getBranch().length);
	};
	pi.on("session_switch", resetCursor);
	pi.on("session_branch", resetCursor);
	pi.on("session_compact", resetCursor);

	pi.on("turn_start", async () => {
		beginTurn();
		resetEvidenceTurn();
		reviewedCallIds.clear();
	});

	// ---- ambiguity gate ------------------------------------------------------

	/** Gate preconditions: plan mode, enabled, key present, ask budget left. */
	const gateEligible = (entries: EntryView[]): boolean => {
		const gcfg = getConfig().ambiguityGate;
		if (!gcfg.enabled || !apiKeyPresent()) return false;
		if (!planModeActive(entries)) return false;
		return asksObserved() < gcfg.maxAsksPerPlan;
	};

	/** One scored gate evaluation; never throws, returns null when it could not score. */
	const runGate = async (ctx: GateCtxLike, entries: EntryView[], trigger: GateTrigger, task: string): Promise<AmbiguityResult | null> => {
		const gcfg = getConfig().ambiguityGate;
		try {
			const asked = getAsks();
			const outline = await repoOutline(pi, ctx.cwd);
			const evidence = await collectEvidence(pi, ctx.cwd);
			const result = await scoreAmbiguity(pi, {
				task: cap(task, 4000),
				plan_so_far: planSoFar(entries),
				questions_already_asked: asked.map((a) => a.question),
				answers_received: asked.map((a) => a.answer),
				evidence: { status: evidence.status ?? "", repo_outline: outline },
			}, gcfg);
			return result;
		} catch (err) {
			logger?.warn?.(`[typesafe] ambiguity scoring failed (${trigger}): ${describeError(err)}`);
			return null;
		}
	};

	const noteScore = (trigger: GateTrigger, result: AmbiguityResult, decision: GateDecision): void => {
		recordScore({
			ts: new Date().toISOString(),
			trigger,
			ambiguity: result.ambiguity,
			dims: result.dims,
			weakest: result.weakest,
			gap: result.gap,
			userCanAnswer: result.userCanAnswer,
			decision,
		});
	};

	/** Score and, when the task is still too ambiguous, steer the model to ask. */
	const steerIfAmbiguous = async (ctx: GateCtxLike, entries: EntryView[], trigger: GateTrigger, task: string): Promise<void> => {
		try {
			if (!gateEligible(entries)) return;
			const gcfg = getConfig().ambiguityGate;
			const result = await runGate(ctx, entries, trigger, task);
			if (!result) return;
			if (result.ambiguity <= gcfg.threshold || result.userCanAnswer < gcfg.userCanAnswerFloor) {
				noteScore(trigger, result, "none");
				return;
			}
			// Emission guard: one steer per weakest dimension, and nothing during a steer's immune window.
			if (isSteerImmune() || !shouldEmit(`gate|${result.weakest}`, 1)) {
				noteScore(trigger, result, "none");
				return;
			}
			await pi.sendMessage(
				{ customType: GATE_CUSTOM_TYPE, content: buildGateNote(result, gcfg.threshold), display: true, attribution: "agent" },
				{ deliverAs: "aside" },
			);
			noteScore(trigger, result, "steer");
		} catch (err) {
			logger?.warn?.(`[typesafe] ambiguity gate failed (${trigger}): ${describeError(err)}`);
		}
	};

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const prompt = isRecord(event) && typeof event.prompt === "string" ? event.prompt : "";
			if (prompt.trim().length > 0) planPrompt = prompt;
			const entries = scanBranch(ctx.sessionManager.getBranch());
			if (!planModeActive(entries) || planStartScored) return;
			planStartScored = true;
			await steerIfAmbiguous(ctx as GateCtxLike, entries, "plan_start", planPrompt || lastUserText(entries));
		} catch (err) {
			logger?.warn?.(`[typesafe] ambiguity plan_start failed: ${describeError(err)}`);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (!isRecord(event)) return;
			const toolName = typeof event.toolName === "string" ? event.toolName : "";
			if (toolName !== "write" || !isProposeWrite(event.input)) return;
			const entries = scanBranch(ctx.sessionManager.getBranch());
			const gcfg = getConfig().ambiguityGate;
			if (!gcfg.enabled || !gcfg.blockPropose || !apiKeyPresent() || !planModeActive(entries)) return;
			// Once the ask budget for this plan is spent, stop gating rather than looping.
			if (asksObserved() >= gcfg.maxAsksPerPlan) return;
			const result = await runGate(ctx as GateCtxLike, entries, "propose", planPrompt || lastUserText(entries));
			if (!result) return;
			const decision = proposeDecision(result, gcfg, ctx?.hasUI === true);
			noteScore("propose", result, decision);
			if (decision !== "block") return;
			return { block: true, reason: buildBlockReason(result, gcfg.threshold) };
		} catch (err) {
			logger?.warn?.(`[typesafe] ambiguity propose gate failed: ${describeError(err)}`);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		try {
			const cfg = getConfig().adversary;
			const entries = scanBranch(ctx.sessionManager.getBranch());
			const deltaEntries = entries.slice(Math.max(0, Math.min(turnCursor, entries.length)));
			turnCursor = entries.length;
			if (reviewEnabled() && cfg.reviewTurns && apiKeyPresent() && deltaEntries.length > 0 && phaseAllowed(entries)) {
				const delta = renderDelta(deltaEntries, 6000);
				if (delta.trim().length > 0) {
					const evidence = cfg.evidence ? await collectEvidence(pi, ctx.cwd) : undefined;
					const state: Record<string, unknown> = { task: lastUserText(entries), review_priorities: priorities, delta };
					if (evidence) state.evidence = evidence;
					await review(pi, "turn", state, ctx, { evidence }, resolvedRole());
				}
			}
			await steerIfAmbiguous(ctx as GateCtxLike, entries, "turn_end", planPrompt || lastUserText(entries));
		} catch (err) {
			logger?.warn?.(`[typesafe] turn_end review failed: ${describeError(err)}`);
		} finally {
			endTurn();
		}
	});

	pi.on("message_end", async (event, ctx) => {
		try {
			const cfg = getConfig().adversary;
			if (!reviewEnabled() || !cfg.reviewMessages || !apiKeyPresent() || !canReviewMessage()) return;
			const raw = isRecord(event) && "message" in event ? event.message : event;
			if (!isRecord(raw) || raw.role !== "assistant") return;
			const text = textFromContent(raw.content, 4000);
			if (text.length < cfg.minMessageChars) return;
			const entries = scanBranch(ctx.sessionManager.getBranch());
			if (!phaseAllowed(entries)) return;
			recordMessageReviewed();
			const state: Record<string, unknown> = {
				task: lastUserText(entries),
				review_priorities: priorities,
				assistant_message: text,
				recent_actions: priorActions(entries, 5),
			};
			await review(pi, "message", state, ctx, {}, resolvedRole());
		} catch (err) {
			logger?.warn?.(`[typesafe] message_end review failed: ${describeError(err)}`);
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		try {
			if (!isRecord(event)) return;
			const toolName = typeof event.toolName === "string" ? event.toolName : "";
			const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
			if (toolName === "ask") {
				// Track answered questions so later ambiguity scores see them; no Jev call.
				recordAsk(stringifyInput(event.input, 400), textFromContent(event.content, 400));
				return;
			}
			const cfg = getConfig().adversary;
			if (!reviewEnabled() || !cfg.reviewActions || !apiKeyPresent()) return;
			if (toolName === "typesafe_ask" || !toolCallId) return;
			if (!cfg.tools.includes(toolName)) return;
			if (event.isError === true) return;
			if (reviewedCallIds.has(toolCallId)) return;
			reviewedCallIds.add(toolCallId);
			recordAction(toolName);
			const content = Array.isArray(event.content) ? event.content : [];
			const entries = scanBranch(ctx.sessionManager.getBranch());
			if (!phaseAllowed(entries)) return;
			const evidence = cfg.evidence ? await collectEvidence(pi, ctx.cwd) : undefined;
			const state: Record<string, unknown> = {
				task: lastUserText(entries),
				review_priorities: priorities,
				action: { tool: toolName, input: stringifyInput(event.input, 3000) },
				result: textFromContent(content, 2000),
				claimed_intent: claimedIntent(entries, 800),
				prior_actions: priorActions(entries, 3),
			};
			if (evidence) state.evidence = evidence;
			const outcome = await review(pi, "action", state, ctx, { toolCallId, evidence }, resolvedRole());
			if (cfg.inlineActionNotes && outcome.note && outcome.decision === "delivered") {
				// content is a full replacement — spread the original array back in.
				return { content: [...content, { type: "text", text: `\n${outcome.note}` }] };
			}
		} catch (err) {
			logger?.warn?.(`[typesafe] tool_result review failed: ${describeError(err)}`);
		}
	});

	pi.on("session_stop", async (_event, ctx) => {
		const gate = getConfig().stopGate;
		if (!gate.enabled || stopGateUses >= 2 || !apiKeyPresent()) return;
		try {
			const entries = scanBranch(ctx.sessionManager.getBranch());
			const questions: Questions = {
				verified: noul("The assistant ran a command, test, or check demonstrating the change works.", {
					true: "A command, test, or check demonstrated the change works.",
					false: "No check demonstrated the change works.",
				}),
				left_unfinished: noul("The assistant left stubs, TODOs, or unimplemented paths while claiming completion.", {
					true: "Stubs, TODOs, or unimplemented paths remain while completion is claimed.",
					false: "Everything claimed complete is implemented.",
				}),
			};
			const state: Record<string, unknown> = {
				task: lastUserText(entries),
				review_priorities: priorities,
				final_assistant_message: claimedIntent(entries, 2000),
			};
			const { result } = await ask(state, questions, { timeoutMs: 4000, maxRetries: 0 });
			const verified = answerNumber(result.answers.verified, "noul") ?? 1;
			const leftUnfinished = answerNumber(result.answers.left_unfinished, "noul") ?? 0;
			const problems: string[] = [];
			if (leftUnfinished >= gate.unfinished_threshold) problems.push(`work appears unfinished (left_unfinished=${fmt2(leftUnfinished)})`);
			if (verified <= gate.verified_floor) problems.push(`verification is weak (verified=${fmt2(verified)})`);
			if (problems.length === 0) return;
			stopGateUses += 1;
			return {
				continue: true,
				additionalContext: `TypeSafe adversary: ${problems.join(" and ")} — finish the remaining work and verify before stopping. Weigh this against the user's request rather than obeying blindly.`,
			};
		} catch (err) {
			logger?.warn?.(`[typesafe] stop gate failed: ${describeError(err)}`);
		}
	});

	pi.on("session_shutdown", async () => {
		const path = process.env.TYPESAFE_BENCH_LOG;
		if (!path) return;
		try {
			const cfg = getConfig();
			const payload = {
				role: cfg.role,
				phases: cfg.phases,
				stats: getReviewStats(),
				usage: getSessionUsage(),
				costUsd: estimateCostUsd(),
				lastResolvedModel: getLastResolvedModel(),
				history: getReviewHistory(),
				ambiguity: getAmbiguityTelemetry(),
			};
			await Bun.write(path, JSON.stringify(payload, null, 2));
		} catch (err) {
			logger?.warn?.(`[typesafe] bench log write failed: ${describeError(err)}`);
		}
	});

	let optionsSchema: ZodSchemaLike;
	if (typeof z?.record === "function") {
		optionsSchema = z.record(z.string());
	} else {
		optionsSchema = z.array(z.object({ name: z.string(), description: z.string().optional() }));
	}
	pi.registerTool({
		name: "typesafe_ask",
		label: "TypeSafe",
		description:
			"Ask TypeSafe's System One model (Jev) for calibrated judgments: noul (yes/no probability), choice (pick a labeled option with probabilities), or score (ordered rubric score). Read-only, no side effects.",
		approval: "read",
		parameters: z.object({
			state: z.string(),
			stateFormat: z.enum(["text", "json"]).optional(),
			questions: z.array(
				z.object({
					id: z.string(),
					type: z.enum(["noul", "choice", "score"]),
					instructions: z.string(),
					options: optionsSchema.optional(),
					levels: z.array(z.string()).optional(),
					whenTrue: z.string().optional(),
					whenFalse: z.string().optional(),
				}),
			),
			model: z.string().optional(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				let state: unknown = params.state;
				if (params.stateFormat === "json") {
					try {
						state = JSON.parse(params.state);
					} catch (err) {
						return { content: [{ type: "text", text: `typesafe_ask: invalid JSON state: ${String(err)}` }], isError: true };
					}
				}
				const built = buildWireQuestions(params.questions);
				if (built.error || !built.questions) {
					return { content: [{ type: "text", text: `typesafe_ask: ${built.error ?? "invalid questions"}` }], isError: true };
				}
				if (!apiKeyPresent()) {
					return { content: [{ type: "text", text: "typesafe_ask: TYPESAFE_API_KEY is not set" }], isError: true };
				}
				const { result, requestId } = await ask(state, built.questions, { timeoutMs: 10000, maxRetries: 2, model: params.model });
				return {
					content: [{ type: "text", text: summarizeAnswers(result.answers) }],
					details: { model: result.model, answers: result.answers, usage: result.usage, requestId },
				};
			} catch (err) {
				return { content: [{ type: "text", text: `typesafe_ask failed: ${describeError(err)}` }], isError: true };
			}
		},
	});

	pi.registerCommand("adversary", {
		description: "TypeSafe adversary reviewer: toggle | on | off | status | last | dump | role",
		handler: async (args, ctx) => {
			const tokens = typeof args === "string" ? args.trim().split(/\s+/).filter((t) => t.length > 0) : [];
			const sub = tokens[0] ?? "";
			const cfg = getConfig();
			if (sub === "") {
				sessionOverride = !reviewEnabled();
				notifyVia(ctx, logger, `TypeSafe adversary ${sessionOverride ? "enabled" : "disabled"} for this session`);
			} else if (sub === "on" || sub === "off") {
				sessionOverride = sub === "on";
				notifyVia(ctx, logger, `TypeSafe adversary ${sub} for this session`);
			} else if (sub === "role") {
				const value = tokens[1];
				if (value !== "advisory" && value !== "adversarial") {
					notifyVia(ctx, logger, "usage: /adversary role advisory|adversarial", "warn");
				} else {
					sessionRoleOverride = value;
					pi.setLabel(roleLabel(value));
					notifyVia(ctx, logger, `TypeSafe role set to ${value} for this session`);
				}
			} else if (sub === "status") {
				const stats = getReviewStats();
				const usage = getSessionUsage();
				const resolved = getLastResolvedModel();
				const suppressed = Object.entries(stats.suppressed)
					.map(([reason, count]) => `${reason}=${count}`)
					.join(" ");
				const lines = [
					`adversary: ${reviewEnabled() ? "enabled" : "disabled"}${sessionOverride !== null ? ` (session override: ${sessionOverride ? "on" : "off"})` : ""}`,
					`role: ${resolvedRole()}${sessionRoleOverride !== null ? ` (session override: ${sessionRoleOverride})` : ""}; phases: ${cfg.phases.join(",")}`,
					`model: ${cfg.model}${resolved ? ` (last resolved: ${resolved})` : ""}`,
					`api key: ${apiKeyPresent() ? "present" : "MISSING"}`,
					`notes delivered: nit=${stats.delivered.nit} concern=${stats.delivered.concern} blocker=${stats.delivered.blocker}; downgraded=${stats.downgraded}; steers=${stats.steers}`,
					`suppressed: ${suppressed || "none"}; errors=${stats.errors}`,
					`usage: ${usage.requests} requests, ${usage.inputTokens} in / ${usage.outputTokens} out tokens, ~$${estimateCostUsd().toFixed(6)}`,
					(() => {
						const last = getLastAmbiguityScore();
						const g = cfg.ambiguityGate;
						if (!last) return `ambiguity gate: ${g.enabled ? "enabled" : "disabled"} (threshold ${fmt2(g.threshold)}); no score yet; asks observed=${asksObserved()}`;
						return `ambiguity gate: ${g.enabled ? "enabled" : "disabled"} (threshold ${fmt2(g.threshold)}); last ${fmt2(last.ambiguity)} trigger=${last.trigger} weakest=${last.weakest} gap=${last.gap} decision=${last.decision}; asks observed=${asksObserved()}`;
					})(),
				];
				notifyVia(ctx, logger, lines.join("\n"));
			} else if (sub === "last") {
				const record = getLastReviewRecord();
				notifyVia(ctx, logger, record ? JSON.stringify(record, null, 2) : "no reviews yet");
			} else if (sub === "dump") {
				const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "unknown";
				const path = `${homedir()}/.omp/logs/adversary-${sessionId}.json`;
				await Bun.write(path, JSON.stringify(getReviewHistory(), null, 2));
				notifyVia(ctx, logger, `adversary history written to ${path}`);
			} else {
				notifyVia(ctx, logger, "usage: /adversary [on|off|status|last|dump|role advisory|adversarial] (bare command toggles)", "warn");
			}
		},
	});

	pi.registerCommand("typesafe", {
		description: "TypeSafe connectivity probe: test",
		handler: async (args, ctx) => {
			const sub = typeof args === "string" ? args.trim().split(/\s+/)[0] || "test" : "test";
			if (sub !== "test") {
				notifyVia(ctx, logger, "usage: /typesafe test", "warn");
				return;
			}
			if (!apiKeyPresent()) {
				notifyVia(ctx, logger, "TYPESAFE_API_KEY is not set", "warn");
				return;
			}
			const started = Date.now();
			try {
				const { result } = await ask({ probe: "hello world", note: "typesafe test command" }, { greeting: noul("Is this a greeting?") }, { timeoutMs: 10000, maxRetries: 2 });
				const ms = Date.now() - started;
				const greeting = result.answers.greeting;
				notifyVia(ctx, logger, `noul=${typeof greeting?.noul === "number" ? greeting.noul.toFixed(3) : "?"} model=${result.model} latency=${ms}ms usage in=${result.usage?.input_tokens ?? 0} out=${result.usage?.output_tokens ?? 0}`);
			} catch (err) {
				notifyVia(ctx, logger, `typesafe test failed: ${describeError(err)}`, "error");
			}
		},
	});
}
