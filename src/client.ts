import { TypeSafeJudge } from "@oh-my-pi/pi-ai/judgment";
import type { ChoiceQuestion, JudgmentState, NoulQuestion, Questions, ScoreQuestion } from "@oh-my-pi/pi-ai/judgment";
import type { ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/** Shared extension host surface needed to resolve the native judge role. */
type JudgeHostContext = ExtensionContext | ExtensionCommandContext;

export type JudgeContext = Pick<JudgeHostContext, "models" | "modelRegistry" | "sessionManager">;

export interface SessionUsage {
	inputTokens: number;
	outputTokens: number;
	requests: number;
	costUsd: number;
}

const usage: SessionUsage = { inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 };
let lastResolvedModel: string | null = null;
let lastApi: string | null = null;

export interface AskOptions {
	timeoutMs?: number;
	model?: string;
	signal?: AbortSignal;
}

export interface WireAnswer {
	type: string;
	[key: string]: unknown;
}

export interface AskResult {
	result: {
		model: string;
		api: string;
		provider: string;
		answers: Record<string, WireAnswer>;
		usage: { input_tokens: number; output_tokens: number; cost: number };
	};
	requestId: undefined;
}

export function resetClient(): void {
	lastResolvedModel = null;
	lastApi = null;
}

export function resetUsage(): void {
	usage.inputTokens = 0;
	usage.outputTokens = 0;
	usage.requests = 0;
	usage.costUsd = 0;
}

export function getSessionUsage(): SessionUsage {
	return { ...usage };
}

export function estimateCostUsd(): number {
	return usage.costUsd;
}

export function getLastResolvedModel(): string | null {
	return lastResolvedModel;
}

export function getLastApi(): string | null {
	return lastApi;
}

export function resolveJudgeModel(ctx: JudgeContext, modelOverride?: string) {
	return ctx.models.resolve(modelOverride ?? "@judge");
}

export function judgeAvailable(ctx: JudgeContext, modelOverride?: string): boolean {
	const model = resolveJudgeModel(ctx, modelOverride);
	return model !== undefined && model.api === "openrouter-decisions";
}

export async function ask(ctx: JudgeContext, state: JudgmentState, questions: Questions, opts: AskOptions = {}): Promise<AskResult> {
	const model = resolveJudgeModel(ctx, opts.model);
	if (!model) throw new Error(opts.model ? `judge model not found: ${opts.model}` : "no model resolves for @judge");
	if (model.api !== "openrouter-decisions" && model.api !== "typesafe") {
		throw new Error(`judge model ${model.provider}/${model.id} does not support native judgments (api=${model.api})`);
	}
	const apiKey = ctx.modelRegistry.resolver(model, ctx.sessionManager.getSessionId());
	const headers = await ctx.modelRegistry.resolveModelHeaders(model, opts.signal);
	const judge = new TypeSafeJudge({
		apiKey,
		api: model.api,
		provider: model.provider,
		model: model.id,
		baseUrl: model.baseUrl,
		headers,
		timeoutMs: opts.timeoutMs,
	});
	const result = await judge.judge({ state, questions }, { signal: opts.signal });
	usage.inputTokens += result.usage.input;
	usage.outputTokens += result.usage.output;
	usage.requests += 1;
	usage.costUsd += result.usage.cost.total;
	lastResolvedModel = `${result.provider}/${result.model}`;
	lastApi = result.api;
	const answers: Record<string, WireAnswer> = {};
	for (const [name, answer] of Object.entries(result.answers)) answers[name] = { ...answer };
	return {
		result: {
			model: result.model,
			api: result.api,
			provider: result.provider,
			answers,
			usage: {
				input_tokens: result.usage.input,
				output_tokens: result.usage.output,
				cost: result.usage.cost.total,
			},
		},
		requestId: undefined,
	};
}

export function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function noul(instructions: string, criteria?: { true?: string; false?: string }): NoulQuestion {
	return { type: "noul", instructions, criteria };
}

export function choice(instructions: string, criteria: Record<string, string>): ChoiceQuestion {
	return {
		type: "choice",
		instructions,
		criteria: Object.fromEntries(Object.entries(criteria).map(([key, value]) => [key, value])),
	};
}

export function score(instructions: string, levels: readonly string[]): ScoreQuestion {
	if (levels.length < 2) throw new Error("score requires at least two levels");
	return { type: "score", instructions, criteria: levels as [string, string, ...string[]] };
}
