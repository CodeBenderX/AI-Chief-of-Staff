import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCompany, seedAgents } from "../company.js";
import { InMemoryStore } from "../store.js";

/**
 * A fake OpenAI-compatible server. Mode "lmstudio" rejects response_format
 * json_object with LM Studio's real error; mode "strict" rejects any
 * response_format. Requests are recorded for inspection.
 */
function fakeServer(mode: "lmstudio" | "strict") {
  const requests: Array<Record<string, any>> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const fmt = body.response_format?.type;
      const reject = (msg: string) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      };
      if (mode === "lmstudio" && fmt && fmt !== "json_schema" && fmt !== "text") return reject("'response_format.type' must be 'json_schema' or 'text'");
      if (mode === "strict" && fmt) return reject("response_format is not supported");
      const last = body.messages[body.messages.length - 1].content as string;
      const content = last.startsWith("PLAN_REQUEST")
        ? JSON.stringify({ summary: "plan", subtasks: [{ key: "a", agentId: "operations", title: "List questions", instructions: "List three launch questions." }] })
        : last.startsWith("SYNTHESIS_REQUEST")
          ? "Final report"
          : "Three questions: who, what, why.";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    });
  });
  return { server, requests };
}

async function companyAgainst(port: number) {
  const store = new InMemoryStore();
  await seedAgents(store);
  const c = createCompany({ store });
  await c.router.configure(
    [{ id: "lmstudio", kind: "openai_compatible", baseUrl: `http://127.0.0.1:${port}/v1`, enabled: true }],
    [
      { id: "default", label: "local", provider: "lmstudio", model: "qwen2.5-7b-instruct-1m", inputCostPerMTok: 0, outputCostPerMTok: 0, contextWindow: 32000, maxOutputTokens: 1024, capabilities: ["tools", "json"], fallbacks: [] },
      { id: "planner", label: "planner", provider: "lmstudio", model: "qwen2.5-7b-instruct-1m", inputCostPerMTok: 0, outputCostPerMTok: 0, contextWindow: 32000, maxOutputTokens: 1024, capabilities: ["tools", "json"], fallbacks: [] },
    ],
    { get: async () => undefined },
  );
  return c;
}

const servers: Server[] = [];
const listen = async (s: Server) => {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
};
afterAll(() => servers.forEach((s) => s.close()));

describe("OpenAI-compatible local servers", () => {
  let lm: ReturnType<typeof fakeServer>;
  let port: number;
  beforeAll(async () => {
    lm = fakeServer("lmstudio");
    port = await listen(lm.server);
  });

  it("plans with a JSON schema that LM Studio accepts", async () => {
    const c = await companyAgainst(port);
    const t = await c.orchestrator.submit("Prepare for a product launch", { createdBy: "ceo", wait: true });
    const done = (await c.store.getTask(t.id))!;
    expect(done.status).toBe("completed");
    expect(done.result).toBe("Final report");
    const planReq = lm.requests.find((r) => String(r.messages.at(-1).content).startsWith("PLAN_REQUEST"))!;
    expect(planReq.response_format.type).toBe("json_schema");
    expect(planReq.response_format.json_schema.name).toBe("plan");
    expect(planReq.response_format.json_schema.schema.properties.subtasks.type).toBe("array");
    expect(planReq.response_format.json_schema.schema.$schema).toBeUndefined();
    // optional-with-default fields are not required, so small models aren't forced to emit them
    expect(planReq.response_format.json_schema.schema.properties.subtasks.items.required).not.toContain("dependsOn");
    // tool-using agent calls don't send response_format at all
    expect(lm.requests.filter((r) => r.tools).every((r) => r.response_format === undefined)).toBe(true);
  });

  it("retries without response_format when a server rejects it", async () => {
    const strict = fakeServer("strict");
    const c = await companyAgainst(await listen(strict.server));
    const t = await c.orchestrator.submit("Prepare for a product launch", { createdBy: "ceo", wait: true });
    expect((await c.store.getTask(t.id))!.status).toBe("completed");
    const plans = strict.requests.filter((r) => String(r.messages.at(-1).content).startsWith("PLAN_REQUEST"));
    expect(plans.map((r) => r.response_format?.type ?? null)).toEqual(["json_schema", null]);
  });
});
