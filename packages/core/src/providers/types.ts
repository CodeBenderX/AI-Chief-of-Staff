import type { ChatMessage, ToolCall } from "../types.js";

export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools?: ModelToolSpec[];
  maxOutputTokens: number;
  temperature?: number;
  /** Ask for a JSON object reply (providers that support it). */
  json?: boolean;
  signal?: AbortSignal;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
}

export interface ModelProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export type ProviderKind = "anthropic" | "openai" | "openai_compatible" | "mock";

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  /** For openai_compatible (Ollama, LM Studio, vLLM, OpenRouter ...). */
  baseUrl?: string;
  /** Name of the secret holding the API key. The key itself is never stored in config. */
  apiKeySecret?: string;
  requestsPerMinute?: number;
  enabled: boolean;
}

export interface ModelProfile {
  id: string;
  label: string;
  provider: string;
  model: string;
  /** USD per million tokens. 0 for local models. */
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: Array<"tools" | "json" | "vision" | "long_context" | "reasoning">;
  /** Profile ids to try, in order, if this one fails. */
  fallbacks: string[];
}

/** Errors worth retrying (rate limit, overload, transient network). */
export class ProviderError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

export function classifyError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const err = e as { status?: number; message?: string; name?: string; code?: string };
  const status = typeof err?.status === "number" ? err.status : undefined;
  const msg = err?.message ?? String(e);
  if (err?.name === "AbortError" || msg === "aborted") return new ProviderError("aborted", false);
  if (status !== undefined) return new ProviderError(msg, status === 408 || status === 409 || status === 429 || status >= 500, status);
  // network-level failure (ECONNRESET, fetch failed ...)
  return new ProviderError(msg, /ECONN|ETIMEDOUT|fetch failed|socket|network|timed out/i.test(msg + (err?.code ?? "")));
}
