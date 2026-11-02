import type { ChatMessage } from "../types.js";
import { estimateTokens, sleep } from "../util.js";
import { AnthropicProvider } from "./anthropic.js";
import { MockProvider } from "./mock.js";
import { OpenAIProvider } from "./openai.js";
import {
  ProviderError,
  classifyError,
  type ModelProfile,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ProviderConfig,
} from "./types.js";

export interface SecretResolver {
  /** Returns the secret value or undefined. Values never leave the server process. */
  get(name: string): Promise<string | undefined>;
}

export interface CallMeta {
  taskId?: string | null;
  rootId?: string | null;
  agentId?: string | null;
}

export interface UsageSink {
  (u: { provider: string; model: string; profile: string; inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number; ok: boolean; meta: CallMeta; error?: string }): Promise<void> | void;
}

/** Token bucket: `rpm` requests per minute per provider. */
class RateLimiter {
  private tokens: number;
  private last = Date.now();
  constructor(private rpm: number) {
    this.tokens = rpm;
  }
  async acquire(signal?: AbortSignal) {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.rpm, this.tokens + ((now - this.last) / 60_000) * this.rpm);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.rpm) * 60_000), signal);
    }
  }
}

export function costUsd(p: ModelProfile, inputTokens: number, outputTokens: number): number {
  return (inputTokens * p.inputCostPerMTok + outputTokens * p.outputCostPerMTok) / 1_000_000;
}

/**
 * Keep a conversation inside the context window: always keep the first user
 * message (the assignment) and as many recent turns as fit. Assistant tool calls
 * and their tool results are dropped together so pairs never break. If the
 * assignment alone is still too big, its middle is cut, keeping the start
 * (instructions) and the end (closing guidance).
 */
export function fitContext(system: string, messages: ChatMessage[], budgetTokens: number): ChatMessage[] {
  const cost = (m: ChatMessage) => estimateTokens(m.content + JSON.stringify(m.toolCalls ?? []));
  let total = estimateTokens(system) + messages.reduce((s, m) => s + cost(m), 0);
  if (total <= budgetTokens || !messages.length) return messages;
  const [first, ...rest] = messages;
  // Group into units that start at a non-tool message.
  const groups: ChatMessage[][] = [];
  for (const m of rest) {
    if (m.role === "tool" && groups.length) groups[groups.length - 1]!.push(m);
    else groups.push([m]);
  }
  let dropped = 0;
  while (groups.length > 1 && total > budgetTokens) {
    const g = groups.shift()!;
    total -= g.reduce((s, m) => s + cost(m), 0);
    dropped += g.length;
  }
  let head = first!.content + (dropped ? `\n\n[${dropped} earlier messages were trimmed to fit the context window]` : "");
  const over = total - budgetTokens;
  if (over > 0) {
    const keepChars = Math.max(800, (estimateTokens(head) - over) * 4);
    if (keepChars < head.length) {
      const half = Math.floor(keepChars / 2);
      head = `${head.slice(0, half)}\n\n[... ${head.length - keepChars} characters cut to fit the model's context window ...]\n\n${head.slice(-half)}`;
    }
  }
  // Groups always start with a non-tool message, so no tool result is orphaned.
  return [{ ...first!, content: head }, ...groups.flat()];
}

/** Servers phrase this differently: LM Studio, llama.cpp, OpenAI, Anthropic, Ollama. */
export const isContextOverflow = (msg: string) =>
  /context (size|length|window)[^.]{0,40}(exceed|too|limit)|exceed\w*[^.]{0,40}context|maximum context length|prompt is too long|too many tokens|n_ctx/i.test(msg);

export class ModelRouter {
  private providers = new Map<string, ModelProvider>();
  private limiters = new Map<string, RateLimiter>();
  private profiles = new Map<string, ModelProfile>();
  maxAttemptsPerProfile = 3;
  baseBackoffMs = 500;

  constructor(private usageSink?: UsageSink) {}

  /** (Re)load provider and profile configuration. Lets the CEO switch models without rebuilding. */
  async configure(providers: ProviderConfig[], profiles: ModelProfile[], secrets: SecretResolver, overrides: Record<string, ModelProvider> = {}) {
    this.providers.clear();
    this.limiters.clear();
    this.profiles.clear();
    for (const p of providers) {
      if (!p.enabled) continue;
      const key = p.apiKeySecret ? await secrets.get(p.apiKeySecret) : undefined;
      let impl: ModelProvider | undefined = overrides[p.id];
      if (!impl) {
        if (p.kind === "anthropic") {
          if (!key) continue; // not usable without a key; profiles fall back
          impl = new AnthropicProvider(p.id, key, p.baseUrl);
        } else if (p.kind === "openai") {
          if (!key) continue;
          impl = new OpenAIProvider(p.id, "openai", { apiKey: key, baseURL: p.baseUrl });
        } else if (p.kind === "openai_compatible") {
          if (!p.baseUrl) continue;
          impl = new OpenAIProvider(p.id, "openai_compatible", { apiKey: key, baseURL: p.baseUrl });
        } else {
          impl = new MockProvider(p.id);
        }
      }
      this.providers.set(p.id, impl);
      this.limiters.set(p.id, new RateLimiter(p.requestsPerMinute ?? 60));
    }
    for (const prof of profiles) this.profiles.set(prof.id, prof);
  }

  setProvider(p: ModelProvider, rpm = 600) {
    this.providers.set(p.id, p);
    this.limiters.set(p.id, new RateLimiter(rpm));
  }
  setProfile(p: ModelProfile) {
    this.profiles.set(p.id, p);
  }
  getProfile(id: string) {
    return this.profiles.get(id);
  }
  listProfiles() {
    return [...this.profiles.values()];
  }
  availableProviders() {
    return [...this.providers.keys()];
  }

  /** Resolve the chain of profiles to try: the requested one, then its fallbacks (deduplicated). */
  chain(profileId: string): ModelProfile[] {
    const seen = new Set<string>();
    const out: ModelProfile[] = [];
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const p = this.profiles.get(id);
      if (!p) return;
      out.push(p);
      p.fallbacks.forEach(visit);
    };
    visit(profileId);
    if (!out.length && this.profiles.has("default")) visit("default");
    return out;
  }

  async complete(
    profileId: string,
    req: Omit<ModelRequest, "model" | "maxOutputTokens"> & { maxOutputTokens?: number },
    meta: CallMeta = {},
  ): Promise<ModelResponse & { profile: ModelProfile; costUsd: number }> {
    const chain = this.chain(profileId).filter((p) => this.providers.has(p.provider));
    if (!chain.length) throw new ProviderError(`no usable provider for model profile "${profileId}" — configure one in Settings`, false);
    let lastErr: ProviderError | undefined;
    for (const profile of chain) {
      const provider = this.providers.get(profile.provider)!;
      const maxOut = Math.min(req.maxOutputTokens ?? profile.maxOutputTokens, profile.maxOutputTokens);
      const tools = profile.capabilities.includes("tools") ? req.tools : undefined;
      // Room for the reply and the tool definitions; the rest is the prompt budget.
      const toolTokens = estimateTokens(JSON.stringify(tools ?? []));
      let budget = Math.max(1000, profile.contextWindow - maxOut - toolTokens - 512);
      let messages = fitContext(req.system, req.messages, budget);
      let shrinks = 0;
      for (let attempt = 1; attempt <= this.maxAttemptsPerProfile; attempt++) {
        await this.limiters.get(profile.provider)!.acquire(req.signal);
        const started = Date.now();
        try {
          const res = await provider.complete({ ...req, tools, messages, model: profile.model, maxOutputTokens: maxOut });
          const c = costUsd(profile, res.usage.inputTokens, res.usage.outputTokens);
          await this.usageSink?.({ provider: profile.provider, model: profile.model, profile: profile.id, ...res.usage, costUsd: c, latencyMs: Date.now() - started, ok: true, meta });
          return { ...res, profile, costUsd: c };
        } catch (e) {
          lastErr = classifyError(e);
          await this.usageSink?.({ provider: profile.provider, model: profile.model, profile: profile.id, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: Date.now() - started, ok: false, meta, error: lastErr.message });
          if (lastErr.message === "aborted") throw lastErr;
          // The server's real context is smaller than configured (e.g. LM Studio loaded
          // the model with a short context): shrink the prompt and try again.
          if (isContextOverflow(lastErr.message) && shrinks < 3) {
            const used = estimateTokens(req.system) + messages.reduce((n, m) => n + estimateTokens(m.content + JSON.stringify(m.toolCalls ?? [])), 0);
            budget = Math.max(1000, Math.floor(Math.min(budget, used) * 0.6));
            messages = fitContext(req.system, req.messages, budget);
            shrinks++;
            attempt--; // a shrink isn't a failed attempt
            continue;
          }
          if (!lastErr.retryable) break; // try the next profile
          if (attempt < this.maxAttemptsPerProfile) await sleep(this.baseBackoffMs * 2 ** (attempt - 1) + Math.random() * 100, req.signal);
        }
      }
    }
    throw lastErr ?? new ProviderError("all model profiles failed", false);
  }
}

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: "mock", kind: "mock", enabled: true, requestsPerMinute: 600 },
  { id: "ollama", kind: "openai_compatible", baseUrl: "http://localhost:11434/v1", enabled: true, requestsPerMinute: 60 },
  { id: "lmstudio", kind: "openai_compatible", baseUrl: "http://localhost:1234/v1", enabled: false, requestsPerMinute: 60 },
  { id: "anthropic", kind: "anthropic", apiKeySecret: "ANTHROPIC_API_KEY", enabled: true, requestsPerMinute: 50 },
  { id: "openai", kind: "openai", apiKeySecret: "OPENAI_API_KEY", enabled: true, requestsPerMinute: 50 },
];

/**
 * Starter profiles. Prices are placeholders the CEO should confirm in Settings
 * against the provider's current price list; local models are free.
 */
export const DEFAULT_PROFILES: ModelProfile[] = [
  { id: "default", label: "Local (Ollama)", provider: "ollama", model: "llama3.1:8b", inputCostPerMTok: 0, outputCostPerMTok: 0, contextWindow: 32_000, maxOutputTokens: 2048, capabilities: ["tools", "json"], fallbacks: ["offline"] },
  { id: "planner", label: "Planner (local)", provider: "ollama", model: "llama3.1:8b", inputCostPerMTok: 0, outputCostPerMTok: 0, contextWindow: 32_000, maxOutputTokens: 2048, capabilities: ["tools", "json"], fallbacks: ["offline"] },
  { id: "claude", label: "Claude (Anthropic)", provider: "anthropic", model: "claude-sonnet-5-5", inputCostPerMTok: 3, outputCostPerMTok: 15, contextWindow: 200_000, maxOutputTokens: 4096, capabilities: ["tools", "json", "long_context"], fallbacks: ["default"] },
  { id: "gpt", label: "OpenAI", provider: "openai", model: "gpt-4.1", inputCostPerMTok: 2, outputCostPerMTok: 8, contextWindow: 128_000, maxOutputTokens: 4096, capabilities: ["tools", "json", "long_context"], fallbacks: ["default"] },
  { id: "offline", label: "Offline mock", provider: "mock", model: "mock-1", inputCostPerMTok: 0, outputCostPerMTok: 0, contextWindow: 100_000, maxOutputTokens: 2048, capabilities: ["tools", "json"], fallbacks: [] },
];
