import { describe, expect, it } from "vitest";
import { toModelName } from "../tools/registry.js";
import type { ModelRequest } from "../providers/types.js";
import { lastUser, setup } from "./helpers.js";

const plan = (subtasks: unknown[]) => ({ text: JSON.stringify({ summary: "plan", subtasks }) });
const isPlan = (r: ModelRequest) => lastUser(r).startsWith("PLAN_REQUEST");
const isSynth = (r: ModelRequest) => lastUser(r).startsWith("SYNTHESIS_REQUEST");
const agentOf = (r: ModelRequest) => /You are the (.+?) of/.exec(r.system)?.[1];

describe("Orchestrator", () => {
  it("plans, runs dependencies in order, aggregates and records history", async () => {
    const order: string[] = [];
    const c = await setup((req) => {
      if (isPlan(req))
        return plan([
          { key: "r", agentId: "market-research", title: "Research competitors", instructions: "List competitors with sources", dependsOn: [] },
          { key: "f", agentId: "finance", title: "Price model", instructions: "Build a price model", dependsOn: [] },
          { key: "s", agentId: "product-strategy", title: "Positioning", instructions: "Recommend positioning", dependsOn: ["r", "f"] },
        ]);
      if (isSynth(req)) return { text: "Executive report: positioning recommended." };
      order.push(agentOf(req)!);
      if (agentOf(req) === "Product Strategy Director") expect(lastUser(req)).toContain("Inputs from other departments");
      return { text: `${agentOf(req)} done` };
    });
    const root = await c.orchestrator.submit("Evaluate entering the SMB invoicing market", { createdBy: "ceo", wait: true });
    const done = (await c.store.getTask(root.id))!;
    expect(done.status).toBe("completed");
    expect(done.result).toContain("Executive report");
    expect(order[order.length - 1]).toBe("Product Strategy Director");
    const tree = await c.store.listTasks({ rootId: root.id });
    expect(tree).toHaveLength(4);
    expect(tree.every((t) => t.status === "completed")).toBe(true);
    const types = (await c.store.listEvents({ rootId: root.id })).map((e) => e.type);
    expect(types).toContain("plan.created");
    expect(types).toContain("model.called");
    // outcome stored to task memory with provenance
    const mem = await c.memory.search({ type: "ceo", id: "ceo" }, { text: "Outcome SMB invoicing" });
    expect(mem[0]?.source).toBe(`task:${root.id}`);
    expect(mem[0]?.verified).toBe(false);
    // usage tracked with cost
    expect((await c.store.listUsage({ rootId: root.id })).every((u) => u.costUsd > 0)).toBe(true);
  });

  it("rejects cyclic or invalid plans and falls back to the Chief of Staff", async () => {
    const c = await setup((req) => {
      if (isPlan(req))
        return plan([
          { key: "a", agentId: "finance", title: "A task", instructions: "do task a", dependsOn: ["b"] },
          { key: "b", agentId: "finance", title: "B task", instructions: "do task b", dependsOn: ["a"] },
        ]);
      return { text: "handled directly" };
    });
    const root = await c.orchestrator.submit("Do something", { createdBy: "ceo", wait: true });
    const done = (await c.store.getTask(root.id))!;
    expect(done.status).toBe("completed");
    expect(done.result).toBe("handled directly");
    const ev = (await c.store.listEvents({ rootId: root.id })).filter((e) => e.type === "plan.invalid");
    expect(ev).toHaveLength(2);
    expect(String(ev[0]!.data.error)).toMatch(/cycle/);
  });

  it("pauses for CEO approval and executes only after approval", async () => {
    let sentCall = false;
    const c = await setup((req) => {
      if (isPlan(req)) return plan([{ key: "o", agentId: "sales", title: "Email the lead", instructions: "Send intro email to lead@acme.test", dependsOn: [] }]);
      if (isSynth(req)) return { text: "report" };
      if (!sentCall) {
        sentCall = true;
        return { toolCalls: [{ id: "c1", name: toModelName("email.send"), input: { to: "lead@acme.test", subject: "Intro", body: "Hello" } }] };
      }
      return { text: `done: ${lastUser(req).slice(0, 80)}` };
    });
    const root = await c.orchestrator.submit("Reach out to Acme", { createdBy: "ceo", wait: true });
    expect((await c.store.getTask(root.id))!.status).toBe("awaiting_approval");
    expect(c.outbox.sent).toHaveLength(0);
    const [approval] = await c.store.listApprovals({ status: "pending" });
    expect(approval).toMatchObject({ toolId: "email.send", agentId: "sales", actions: ["external_communication"] });

    await c.approvals.decide(approval!.id, "approved", "ceo");
    await c.orchestrator.resume(approval!.taskId, { wait: true });
    expect(c.outbox.sent).toEqual([expect.objectContaining({ to: "lead@acme.test" })]);
    expect((await c.store.getTask(root.id))!.status).toBe("completed");
  });

  it("does not execute a rejected action and tells the agent", async () => {
    let n = 0;
    const c = await setup((req) => {
      n++;
      if (n === 1) return { toolCalls: [{ id: "c1", name: toModelName("email.send"), input: { to: "x@y.test", subject: "s", body: "b" } }] };
      return { text: lastUser(req) };
    });
    const t = await c.orchestrator.submit("Email x", { createdBy: "ceo", agentId: "sales", wait: true });
    const [a] = await c.store.listApprovals({ status: "pending" });
    await c.approvals.decide(a!.id, "rejected", "ceo", "not this week");
    await c.orchestrator.resume(t.id, { wait: true });
    const done = (await c.store.getTask(t.id))!;
    expect(c.outbox.sent).toHaveLength(0);
    expect(done.status).toBe("completed");
    expect(done.result).toContain("REJECTED");
    expect(done.result).toContain("not this week");
  });

  it("cannot bypass approval by delegating, and refuses recursive delegation", async () => {
    const c = await setup((req) => {
      const who = agentOf(req);
      const turn = req.messages.filter((m) => m.role === "assistant").length;
      if (who === "Marketing Director" && turn === 0)
        return { toolCalls: [{ id: "d1", name: toModelName("task.delegate"), input: { agentId: "sales", title: "Send the email", instructions: "Email the press list at press@news.test now." } }] };
      if (who === "Sales Director" && turn === 0)
        return {
          toolCalls: [
            { id: "d2", name: toModelName("task.delegate"), input: { agentId: "marketing", title: "Loop back", instructions: "Delegating back to marketing on purpose." } },
            { id: "e1", name: toModelName("email.send"), input: { to: "press@news.test", subject: "News", body: "Big news" } },
          ],
        };
      return { text: `${who}: ${lastUser(req).slice(0, 300)}` };
    });
    // Both may delegate in this test.
    for (const id of ["marketing", "sales"]) {
      const a = (await c.store.getAgent(id))!;
      await c.store.upsertAgent({ ...a, tools: [...a.tools, "task.delegate"] });
    }

    const t = await c.orchestrator.submit("Announce", { createdBy: "ceo", agentId: "marketing", wait: true });
    const tree = await c.store.listTasks({ rootId: t.id });
    const child = tree.find((x) => x.agentId === "sales")!;
    // The delegated email still needs its own CEO approval; delegation cannot skip it.
    expect(c.outbox.sent).toHaveLength(0);
    const childTools = child.state!.messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(childTools[0]).toMatch(/recursive delegation refused/);
    expect(child.status).toBe("awaiting_approval");
    expect(await c.store.listApprovals({ status: "pending" })).toEqual([expect.objectContaining({ agentId: "sales", toolId: "email.send" })]);
    const parentTools = (await c.store.getTask(t.id))!.state!.messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(parentTools[0]).toMatch(/PAUSED/);
  });

  it("enforces loop guards and hard limits, escalating to the CEO", async () => {
    const c = await setup(() => ({ toolCalls: [{ id: "x", name: toModelName("memory.search"), input: { query: "same thing" } }] }));
    const t = await c.orchestrator.submit("Loop forever", { createdBy: "ceo", agentId: "market-research", wait: true, limits: { maxStepsPerTask: 5 } });
    const done = (await c.store.getTask(t.id))!;
    expect(done.status).toBe("escalated");
    expect(done.error).toMatch(/step limit/);
    const ev = (await c.store.listEvents({ rootId: t.id })).map((e) => e.type);
    expect(ev).toContain("guard.loop");
    expect(ev).toContain("task.escalated");
    expect(c.mock.calls.length).toBe(5); // hard limits are not retried
  });

  it("stops at the model-call budget for the whole tree", async () => {
    const c = await setup((req) => {
      if (isPlan(req)) return plan(Array.from({ length: 4 }, (_, i) => ({ key: `k${i}`, agentId: "operations", title: `Job ${i}`, instructions: `job ${i}`, dependsOn: [] })));
      return { text: "ok" };
    });
    const t = await c.orchestrator.submit("Many jobs", { createdBy: "ceo", wait: true, limits: { maxModelCalls: 3, concurrency: 1 } });
    expect(c.mock.calls.length).toBe(3);
    const tree = await c.store.listTasks({ rootId: t.id });
    expect(tree.filter((x) => x.status === "escalated").length).toBeGreaterThan(0);
    expect((await c.store.getTask(t.id))!.status).toBe("escalated");
  });

  it("retries transient failures, then escalates", async () => {
    let calls = 0;
    const c = await setup(() => {
      calls++;
      throw Object.assign(new Error("bad request"), { status: 400 });
    });
    const t = await c.orchestrator.submit("Fail", { createdBy: "ceo", agentId: "operations", wait: true, limits: { maxRetries: 1 } });
    expect((await c.store.getTask(t.id))!.status).toBe("escalated");
    expect(calls).toBe(2); // one attempt + one retry, non-retryable at provider level
  });

  it("cancels a running tree", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const c = await setup(async (req) => {
      if (isPlan(req)) return plan([{ key: "a", agentId: "operations", title: "Slow job", instructions: "slow", dependsOn: [] }]);
      await gate;
      return { text: "late" };
    });
    const t = await c.orchestrator.submit("Slow", { createdBy: "ceo" });
    await new Promise((r) => setTimeout(r, 30));
    await c.orchestrator.cancel(t.id, "ceo");
    release();
    await c.orchestrator.waitForIdle(t.id);
    const tree = await c.store.listTasks({ rootId: t.id });
    expect(tree.every((x) => x.status === "cancelled")).toBe(true);
  });
});
