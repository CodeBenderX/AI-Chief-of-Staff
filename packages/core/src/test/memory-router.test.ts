import { describe, expect, it } from "vitest";
import { MemoryAccessError } from "../memory.js";
import { ModelRouter, fitContext } from "../providers/router.js";
import { MockProvider } from "../providers/mock.js";
import type { ModelProfile } from "../providers/types.js";
import type { ChatMessage } from "../types.js";
import { setup } from "./helpers.js";

describe("MemoryService", () => {
  it("enforces scope access, versions writes and flags conflicts", async () => {
    const c = await setup(() => ({ text: "" }));
    const ceo = { type: "ceo" as const, id: "ceo" };
    const research = { type: "agent" as const, id: "market-research", access: { read: ["company" as const], write: ["company" as const] } };
    const support = { type: "agent" as const, id: "customer-support", access: { read: ["project" as const], write: [] } };

    const v1 = await c.memory.write(ceo, { scope: "company", title: "Target market", content: "SMBs in Canada", source: "CEO", sourceType: "ceo" });
    expect(v1.verified).toBe(true);

    // Agent contradicting a verified fact creates a conflict, not an overwrite.
    const v2 = await c.memory.write(research, { key: v1.key, scope: "company", title: "Target market", content: "Enterprises in the US", source: "https://example.com/report", sourceType: "agent" });
    expect(v2).toMatchObject({ status: "conflict", verified: false, version: 2 });
    expect((await c.store.getMemory(v1.id))!.status).toBe("current");

    // CEO resolves the conflict by accepting v2.
    await c.memory.setStatus(ceo, v2.id, "current");
    expect((await c.store.getMemory(v1.id))!.status).toBe("superseded");
    expect((await c.memory.history(ceo, v1.key)).map((v) => v.version)).toEqual([1, 2]);

    // Unauthorized read/write.
    expect(await c.memory.search(support, { text: "target market" })).toEqual([]);
    await expect(c.memory.write(support, { scope: "company", title: "x", content: "y", source: "s", sourceType: "agent" })).rejects.toThrow(MemoryAccessError);
    await expect(c.memory.setStatus(research, v1.id, "deleted")).rejects.toThrow(MemoryAccessError);
  });
});

const profile = (id: string, provider: string, fallbacks: string[] = []): ModelProfile => ({
  id, label: id, provider, model: `${provider}-model`, inputCostPerMTok: 3, outputCostPerMTok: 15, contextWindow: 10_000, maxOutputTokens: 500, capabilities: ["tools"], fallbacks,
});

describe("ModelRouter", () => {
  it("retries retryable errors, falls back across providers, and prices usage", async () => {
    const usage: number[] = [];
    const r = new ModelRouter((u) => void usage.push(u.costUsd));
    r.baseBackoffMs = 1;
    let primaryCalls = 0;
    r.setProvider(new MockProvider("primary", () => {
      primaryCalls++;
      throw Object.assign(new Error("overloaded"), { status: 529 });
    }));
    r.setProvider(new MockProvider("backup", () => ({ text: "from backup", usage: { inputTokens: 1_000_000, outputTokens: 0 } })));
    r.setProfile(profile("main", "primary", ["spare"]));
    r.setProfile(profile("spare", "backup"));
    const res = await r.complete("main", { system: "s", messages: [{ role: "user", content: "hi" }] });
    expect(primaryCalls).toBe(3);
    expect(res.text).toBe("from backup");
    expect(res.costUsd).toBeCloseTo(3);
    expect(usage.filter((u) => u === 0)).toHaveLength(3); // failed attempts are logged too
  });

  it("explains when no provider is configured", async () => {
    const r = new ModelRouter();
    r.setProfile(profile("main", "nowhere"));
    await expect(r.complete("main", { system: "", messages: [] })).rejects.toThrow(/configure one in Settings/);
  });

  it("trims context without orphaning tool results", () => {
    const big = "x".repeat(4000);
    const msgs: ChatMessage[] = [{ role: "user", content: "assignment" }];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: "assistant", content: big, toolCalls: [{ id: `c${i}`, name: "t", input: {} }] });
      msgs.push({ role: "tool", content: big, toolCallId: `c${i}` });
    }
    const out = fitContext("sys", msgs, 5000);
    expect(out[0]!.content).toContain("assignment");
    expect(out[0]!.content).toContain("trimmed");
    expect(out[1]!.role).toBe("assistant");
    expect(out.length).toBeLessThan(msgs.length);
  });
});
