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
      return await this.request(req, responseFormat(req));
    } catch (e) {
      // Some OpenAI-compatible servers accept only certain response_format types
      // (LM Studio: json_schema or text). Retry once without it rather than fail.
      const err = e as { status?: number; message?: string };
      if (err?.status === 400 && /response_format/i.test(err.message ?? "") && responseFormat(req)) {
        try {
          return await this.request(req, undefined);
        } catch (e2) {
          throw classifyError(e2);
        }
      }
      throw classifyError(e);
    }
  }

  private async request(req: ModelRequest, response_format: OpenAI.ChatCompletionCreateParams["response_format"]): Promise<ModelResponse> {
    const res = await this.client.chat.completions.create(
      {
        model: req.model,
        max_tokens: req.maxOutputTokens,
        temperature: req.temperature,
        messages: toOpenAIMessages(req.system, req.messages),
        tools: req.tools?.length
          ? req.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
          : undefined,
        response_format,
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
  }
}

/** Prefer a schema (widely supported); bare JSON mode only when no schema is given. */
export function responseFormat(req: ModelRequest): OpenAI.ChatCompletionCreateParams["response_format"] {
  if (req.tools?.length) return undefined;
  if (req.jsonSchema) {
    const { $schema: _drop, ...schema } = req.jsonSchema.schema;
    return { type: "json_schema", json_schema: { name: req.jsonSchema.name, schema, strict: false } };
  }
  if (req.json) return { type: "json_object" };
  return undefined;
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
