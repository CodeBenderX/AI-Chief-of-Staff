import type { Store } from "./store.js";
import type { AuditEntry } from "./types.js";
import { newId, nowIso } from "./util.js";

const SECRET_KEYS = /(api[_-]?key|secret|password|token|authorization|credential)/i;

/** Remove anything that looks like a credential before it reaches logs. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return value
      .replace(/sk-[A-Za-z0-9_\-]{16,}/g, "[redacted-key]")
      .replace(/Bearer\s+[A-Za-z0-9._\-]{16,}/g, "Bearer [redacted]");
  }
  return value;
}

export class AuditLog {
  constructor(private store: Store) {}

  async write(entry: Omit<AuditEntry, "id" | "at">): Promise<void> {
    await this.store.appendAudit({
      ...entry,
      detail: redact(entry.detail) as Record<string, unknown>,
      id: newId("aud"),
      at: nowIso(),
    });
  }
}
