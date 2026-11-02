import { describe, expect, it } from "vitest";
import { ModelRouter, fitContext, isContextOverflow } from "../providers/router.js";
import { MockProvider } from "../providers/mock.js";
import { estimateTokens } from "../util.js";
import type { ModelRequest } from "../providers/types.js";
import { lastUser, setup } from "./helpers.js";

const LMSTUDIO_OVERFLOW = '400 "Engine protocol predict stream returned an error: {\\"code\\":500,\\"message\\":\\"Context size has been exceeded.\\",\\"type\\":\\"server_error\\"}"';
const promptTokens = (r: ModelRequest) => estimateTokens(r.system + r.messages.map((m) => m.content + JSON.stringify(m.toolCalls ?? [])).join(""));

describe("planning size", () => {
  it("answers simple objectives directly when the plan is empty", async () => {
    const c = await setup((req) => {
      if (lastUser(req).startsWith("PLAN_REQUEST")) {
        expect(lastUser(req)).toContain("FEWEST departments");
        return { text: JSON.stringify({ summary: "simple question, answering directly", subtasks: [] }) };
      }
      return { text: "1. Who is it for? 2. What problem does it solve? 3. How will we price it?" };
    });
    const t = await c.orchestrator.submit("List three questions we should answer before launching a new product.", { createdBy: "ceo", wait: true });
    const done = (await c.store.getTask(t.id))!;
    expect(done.status).toBe("completed");
    expect(done.result).toContain("Who is it for?");
    expect(await c.store.listTasks({ rootId: t.id })).toHaveLength(1); // no subtasks
    expect((await c.store.listEvents({ rootId: t.id })).map((e) => e.type)).toContain("plan.direct");
  });
});

describe("context limits on local servers", () => {
  it("recognises overflow errors from common servers", () => {
    for (const m of [
      LMSTUDIO_OVERFLOW,
      "This model's maximum context length is 8192 tokens",
      "prompt is too long: 250000 tokens > 200000 maximum",
      "the request exceeds the available context size, try increasing it",
      "input length exceeds the context length",
    ]) expect(isContextOverflow(m), m).toBe(true);
    expect(isContextOverflow("rate limit exceeded")).toBe(false);
  });

  it("shrinks the prompt and retries when the server's real context is smaller than configured", async () => {
    const SERVER_LIMIT = 3000; // what LM Studio actually loaded
    const seen: number[] = [];
    const r = new ModelRouter();
    r.setProvider(new MockProvider("lmstudio", (req) => {
      seen.push(promptTokens(req));
      if (promptTokens(req) > SERVER_LIMIT) throw Object.assign(new Error(LMSTUDIO_OVERFLOW), { status: 400 });
      return { text: "ok" };
    }));
    // Configured as 32k, like the default profile.
    r.setProfile({ id: "default", label: "local", provider: "lmstudio", model: "qwen", inputCostPerMTok: 0, outputCostPerMTok: 0, contextWindow: 32000, maxOutputTokens: 1024, capabilities: ["tools"], fallbacks: [] });
    const big = "Inputs from other departments: " + "market detail. ".repeat(2500); // ~9k tokens
    const res = await r.complete("default", {
      system: "You are an agent.",
      messages: [
        { role: "user", content: `Assignment: positioning\n${big}\nWhen finished, reply with your result.` },
        { role: "assistant", content: "", toolCalls: [{ id: "a", name: "memory__search", input: { query: "x" } }] },
        { role: "tool", content: "result ".repeat(400), toolCallId: "a" },
      ],
    });
    expect(res.text).toBe("ok");
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)!).toBeLessThanOrEqual(SERVER_LIMIT);
  });

  it("cuts the middle of an oversized assignment but keeps its start and end", () => {
    const content = `Assignment: X\nInstructions: do Y\n${"filler ".repeat(5000)}\nWhen finished, reply with your result.`;
    const [out] = fitContext("sys", [{ role: "user", content }], 1500);
    expect(estimateTokens(out!.content)).toBeLessThanOrEqual(1600);
    expect(out!.content.startsWith("Assignment: X")).toBe(true);
    expect(out!.content).toContain("When finished, reply with your result.");
    expect(out!.content).toContain("characters cut to fit");
  });
});
