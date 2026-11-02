import { createHash, randomUUID } from "node:crypto";

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

export const nowIso = (): string => new Date().toISOString();

/** Deterministic JSON: object keys sorted recursively. Used for action hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function actionHash(toolId: string, input: unknown): string {
  return sha256(`${toolId}\n${canonicalJson(input)}`);
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });

export class LimitExceededError extends Error {
  constructor(public readonly limit: string, message: string) {
    super(message);
    this.name = "LimitExceededError";
  }
}

export class PolicyDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyDeniedError";
  }
}

/** Rough token estimate (~4 chars/token) for budgeting before a call is made. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
