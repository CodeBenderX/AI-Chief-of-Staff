import { createCompany, seedAgents } from "../company.js";
import { MockProvider, type MockHandler } from "../providers/mock.js";
import { InMemoryStore } from "../store.js";
import type { Outbox } from "../tools/types.js";

export class TestOutbox implements Outbox {
  sent: Array<{ channel: string; to: string; subject?: string; body: string }> = [];
  async send(msg: { channel: string; to: string; subject?: string; body: string }) {
    this.sent.push(msg);
    return { id: `out_${this.sent.length}`, status: "sent" };
  }
}

export async function setup(handler: MockHandler) {
  const store = new InMemoryStore();
  await seedAgents(store);
  // Point every agent at the mock profile.
  for (const a of await store.listAgents()) await store.upsertAgent({ ...a, model: { profile: "test" } });
  const outbox = new TestOutbox();
  const docs: Array<{ title: string }> = [];
  const company = createCompany({
    store,
    services: {
      outbox,
      documents: { create: async (d) => (docs.push(d), { id: `doc_${docs.length}`, version: 1 }) },
    },
  });
  const mock = new MockProvider("mock", handler);
  company.router.setProvider(mock);
  company.router.setProfile({ id: "test", label: "test", provider: "mock", model: "mock-1", inputCostPerMTok: 1, outputCostPerMTok: 2, contextWindow: 100_000, maxOutputTokens: 1000, capabilities: ["tools", "json"], fallbacks: [] });
  company.router.baseBackoffMs = 1;
  return { ...company, mock, outbox, docs };
}

export const lastUser = (req: { messages: { role: string; content: string }[] }) =>
  [...req.messages].reverse().find((m) => m.role !== "assistant")?.content ?? "";
