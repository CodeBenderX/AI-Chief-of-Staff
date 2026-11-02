import OpenAI from "openai";
import type { ChatMessage } from "../types.js";
import { classifyError, type ModelProvider, type ModelRequest, type ModelResponse, type ProviderKind } from "./types.js";

/**
 * OpenAI via the official SDK. With `baseURL` the same adapter serves any
 * OpenAI-compatible server: Ollama (http://localhost:11434/v1), LM Studio
 * (http://localhost:1234/v1), vLLM, OpenRouter, etc.
 */
export class OpenAIProvider implements ModelProvider {
  private client: OpenAI;
  constructor(readonly id: string, readonly kind: ProviderKind, opts: { apiKey?: string; baseURL?: string }) {
    this.client = new OpenAI({
      apiKey: opts.apiKey || (kind === "openai_compatible" ? "local-no-key" : undefined),
      baseURL: opts.baseURL,
      maxRetries: 0,
    });
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    try {
      const res = await this.client.chat.completions.create(
        {
          model: req.model,
          max_tokens: req.maxOutputTokens,
          temperature: req.temperature,
          messages: toOpenAIMessages(req.system, req.messages),
          tools: req.tools?.length
            ? req.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
            : undefined,
          response_format: req.json && !req.tools?.length ? { type: "json_object" } : undefined,
        },
        { signal: req.signal },
      );
      const choice = res.choices[0];
      const msg = choice?.message;
      const toolCalls = (msg?.tool_calls ?? [])
        .filter((c) => c.type === "function")
        .map((c) => ({ id: c.id, name: c.function.name, input: safeJson(c.function.arguments) }));
      return {
        text: msg?.content ?? "",
        toolCalls,
        usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
        stopReason: choice?.finish_reason ?? "unknown",
      };
    } catch (e) {
      throw classifyError(e);
    }
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { _unparseable: s };
  }
}

export function toOpenAIMessages(system: string, messages: ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content });
    else if (m.role === "assistant")
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls?.length
          ? m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }))
          : undefined,
      });
    else out.push({ role: "user", content: m.content });
  }
  return out;
}
