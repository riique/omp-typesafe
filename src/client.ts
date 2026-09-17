import {
	APIConnectionError,
	APIError,
	APIUserAbortError,
	APITimeoutError,
	RateLimitError,
	TypeSafeClient,
	TypeSafeError,
	choice,
	noul,
	score,
} from "@typesafe-ai/sdk";
import type { EntryType, Questions } from "@typesafe-ai/sdk";

/**
 * SDK wrapper. All TypeSafe traffic goes through here so usage tracking,
 * model resolution and error classification stay in one place.
 */

let client: TypeSafeClient | null = null;

export interface SessionUsage {
	inputTokens: number;
	outputTokens: number;
	requests: number;
}

const usage: SessionUsage = { inputTokens: 0, outputTokens: 0, requests: 0 };
let lastResolvedModel: string | null = null;

/** Per-request pricing: $0.042 per Mtok input, output free. */
const INPUT_USD_PER_MTOK = 0.042;

export function apiKeyPresent(): boolean {
	return !!process.env.TYPESAFE_API_KEY?.trim();
}

export function getClient(model?: string): TypeSafeClient {
	if (!client) {
		client = new TypeSafeClient(model ? { defaultModel: model } : {});
	}
	return client;
}

export function resetClient(): void {
	client = null;
	lastResolvedModel = null;
}

export function getSessionUsage(): SessionUsage {
	return { ...usage };
}

export function resetUsage(): void {
	usage.inputTokens = 0;
	usage.outputTokens = 0;
	usage.requests = 0;
}

export function estimateCostUsd(): number {
	return (usage.inputTokens * INPUT_USD_PER_MTOK) / 1_000_000;
}

export function getLastResolvedModel(): string | null {
	return lastResolvedModel;
}

export interface AskOptions {
	/** Per-attempt timeout in ms. SDK default is 10000. */
	timeoutMs?: number;
	maxRetries?: number;
	/** Model override; usually omitted so the client default applies. */
	model?: string;
}

export interface WireAnswer {
	type: string;
	[key: string]: unknown;
}

export interface AskResult {
	result: {
		model: string;
		answers: Record<string, WireAnswer>;
		usage: { input_tokens: number; output_tokens: number };
	};
	requestId: string | undefined;
}

/**
 * One systemOne call. `state` may be a string, object, or array.
 * Timeouts are per attempt; `signal` is a belt-and-braces total budget.
 */
export async function ask(
	state: EntryType,
	questions: Questions,
	opts: AskOptions = {},
): Promise<AskResult> {
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const maxRetries = opts.maxRetries ?? 0;
	const c = getClient(opts.model);
	const promise = c.systemOne(
		{ state, questions, ...(opts.model ? { model: opts.model } : {}) },
		{
			timeout: timeoutMs,
			retry: { maxRetries },
			signal: AbortSignal.timeout(timeoutMs + 300),
		},
	);
	const wrapped = await promise.withResponse();
	const data = wrapped.data;
	usage.inputTokens += data.usage?.input_tokens ?? 0;
	usage.outputTokens += data.usage?.output_tokens ?? 0;
	usage.requests += 1;
	lastResolvedModel = data.model ?? null;
	const answers: Record<string, WireAnswer> = {};
	for (const [name, answer] of Object.entries(data.answers)) {
		// Spread into a fresh object literal so the answer fits the index signature.
		answers[name] = { ...answer };
	}
	return {
		result: {
			model: data.model,
			answers,
			usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 },
		},
		requestId: wrapped.requestId,
	};
}

/** Human-readable classification of an SDK failure. */
export function describeError(err: unknown): string {
	if (err instanceof APITimeoutError) return "timeout";
	if (err instanceof RateLimitError) {
		return err.retryAfterMs !== undefined ? `rate_limited retryAfter=${err.retryAfterMs}ms` : "rate_limited";
	}
	if (err instanceof APIUserAbortError) return "aborted";
	if (err instanceof APIConnectionError) return "connection_error";
	if (err instanceof APIError) {
		const reqId = err.requestId !== undefined ? ` request=${err.requestId}` : "";
		return `api_error status=${err.status}${reqId}: ${err.message}`;
	}
	if (err instanceof TypeSafeError) return `typesafe_error: ${err.message}`;
	return err instanceof Error ? err.message : String(err);
}

export { choice, noul, score };
