import { useCallback, useEffect, useState } from "react";

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    credentials: "same-origin",
    headers: opts.body ? { "content-type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.details ?? data?.error ?? res.statusText, res.status);
  return data as T;
}

/** Fetch + reload on demand + refresh whenever the server pushes a live event. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    load();
    const onLive = () => load();
    window.addEventListener("aicos:live", onLive);
    return () => window.removeEventListener("aicos:live", onLive);
  }, [load]);
  return { data, error, reload: load, setData };
}

/** One SSE connection for the app; components listen to a window event (throttled). */
export function startLiveEvents() {
  let timer: number | undefined;
  const es = new EventSource("/api/events/stream");
  const bump = () => {
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      window.dispatchEvent(new Event("aicos:live"));
    }, 400);
  };
  es.addEventListener("task", bump);
  es.addEventListener("approval", bump);
  es.addEventListener("lead", bump);
  return () => es.close();
}

export const LEVELS = ["Read-only", "Drafts", "Internal changes", "External (approval)"];

export const fmtUsd = (n: number) => (n < 1 && n > 0 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
export const fmtTime = (s: string) => new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const fmtClock = (s: string) => new Date(s).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const statusLabel = (s: string) => s.replace(/_/g, " ");

export interface User { id: string; email: string; name: string; role: "ceo" | "admin" | "viewer" }
export interface Agent {
  id: string; name: string; department: string; role: string; systemPrompt: string; responsibilities: string[]; capabilities: string[];
  maxAutonomy: number; tools: string[]; memoryAccess: { read: string[]; write: string[] }; model: { profile: string; temperature?: number; maxOutputTokens?: number };
  status: string; canOrchestrate?: boolean;
  metrics?: { completed: number; failed: number; running: number; successRate: number | null; costUsd: number };
}
export interface Task {
  id: string; rootId: string; parentId: string | null; title: string; instructions: string; agentId: string; status: string; priority: string; depth: number;
  dependsOn: string[]; autonomyCap: number; attempts: number; result: string | null; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; steps: number;
}
export interface Approval {
  id: string; taskId: string; rootTaskId: string; agentId: string; toolId: string; tool?: string; input: unknown; actions: string[]; risk: string; riskSummary: string;
  estimatedCostUsd: number; justification: string; status: string; decidedBy: string | null; decisionNote: string | null; createdAt: string; decidedAt: string | null; expiresAt: string; taskTitle?: string;
}
export interface TaskEvent { id: string; taskId: string; rootId: string; type: string; agentId: string | null; data: Record<string, unknown>; at: string }
export interface MemoryItem { id: string; key: string; scope: string; title: string; content: string; tags: string[]; source: string; sourceType: string; verified: boolean; version: number; status: string; createdBy: string; createdAt: string }
