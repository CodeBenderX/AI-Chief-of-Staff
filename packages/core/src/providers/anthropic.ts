import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage } from "../types.js";
import { classifyError, type ModelProvider, type ModelRequest, type ModelResponse } from "./types.js";

type Block = Anthropic.ContentBlockParam;

/** Anthropic Claude via the official SDK. */
export class AnthropicProvider implements ModelProvider {
  readonly kind = "anthropic" as const;
  private client: Anthropic;
  constructor(readonly id: string, apiKey: string, baseURL?: string) {
    this.client = new Anthropic({ apiKey, baseURL, maxRetries: 0 });
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    try {
      const res = await this.client.messages.create(
        {
          model: req.model,
          max_tokens: req.maxOutputTokens,
          system: req.system,
          messages: toAnthropicMessages(req.messages),
          tools: req.tools?.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema })),
        },
        { signal: req.signal },
      );
      let text = "";
      const toolCalls = [];
      for (const b of res.content) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, input: b.input });
      }
      return {
        text,
        toolCalls,
        usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
        stopReason: res.stop_reason ?? "unknown",
      };
    } catch (e) {
      throw classifyError(e);
    }
  }
}

export function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const block: Block = { type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content };
      const last = out[out.length - 1];
      // Consecutive tool results are merged into one user turn, as the API requires.
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
        (last.content as Block[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    } else if (m.role === "assistant") {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input as Record<string, unknown> });
      out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "(no content)" }] });
    } else {
      out.push({ role: "user", content: m.content });
    }
  }
  return out;
}
