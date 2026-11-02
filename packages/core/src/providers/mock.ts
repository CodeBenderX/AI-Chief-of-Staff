import type { ModelProvider, ModelRequest, ModelResponse } from "./types.js";
import { estimateTokens } from "../util.js";

export type MockHandler = (req: ModelRequest, callIndex: number) => Partial<ModelResponse> | Promise<Partial<ModelResponse>>;

/**
 * Deterministic provider for tests and offline demos. A handler decides each
 * reply; the default handler plans with the Chief of Staff and answers plainly.
 */
export class MockProvider implements ModelProvider {
  readonly kind = "mock" as const;
  calls: ModelRequest[] = [];
  constructor(readonly id = "mock", private handler: MockHandler = defaultMockHandler) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    const r = await this.handler(req, this.calls.length - 1);
    const text = r.text ?? "";
    return {
      text,
      toolCalls: r.toolCalls ?? [],
      usage: r.usage ?? {
        inputTokens: estimateTokens(req.system + req.messages.map((m) => m.content).join("\n")),
        outputTokens: estimateTokens(text) + 1,
      },
      stopReason: r.stopReason ?? (r.toolCalls?.length ? "tool_use" : "end_turn"),
    };
  }
}

/** Offline behaviour so the whole product is usable without any model configured. */
export const defaultMockHandler: MockHandler = (req) => {
  const last = req.messages[req.messages.length - 1]?.content ?? "";
  if (req.json && /PLAN_REQUEST/.test(last)) {
    const objective = /<objective>([\s\S]*?)<\/objective>/.exec(last)?.[1]?.trim() ?? "objective";
    return {
      text: JSON.stringify({
        summary: `Offline mock plan for: ${objective.slice(0, 120)}`,
        subtasks: [
          { key: "research", agentId: "market-research", title: "Gather context", instructions: `Collect what is already known about: ${objective}`, dependsOn: [], priority: "normal" },
          { key: "plan", agentId: "product-strategy", title: "Recommend next steps", instructions: `Using the research, recommend next steps for: ${objective}`, dependsOn: ["research"], priority: "normal" },
        ],
      }),
    };
  }
  if (/SYNTHESIS_REQUEST/.test(last)) {
    return { text: "[mock model] Summary of department results. Configure a real provider in Settings for genuine analysis." };
  }
  return { text: `[mock model] Completed: ${last.replace(/\s+/g, " ").slice(0, 160)}` };
};
