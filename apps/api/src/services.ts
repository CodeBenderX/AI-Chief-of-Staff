import { newId, type DocumentStore, type Outbox } from "@aicos/core";
import type { Db } from "./db.js";
import type { EmailConnector, EmailError } from "./email.js";

export interface OutboxRow {
  id: string;
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
  status: "sending" | "sent" | "failed" | "queued_no_connector";
  detail: string | null;
  attempts: number;
  provider_message_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  created_at: string;
  sent_at: string | null;
}

/**
 * Outbound actions land here after CEO approval. Email is delivered through
 * the SMTP connector when one is configured; other channels (publishing,
 * deploys) have no connector yet and are recorded as "queued_no_connector".
 * The status returned is always the real outcome — never an optimistic one.
 */
export class DbOutbox implements Outbox {
  constructor(
    private db: Db,
    private email?: EmailConnector,
    private hooks: { isSuppressed?: (to: string) => Promise<boolean>; onSent?: (to: string) => Promise<void> } = {},
  ) {}

  async send(msg: { channel: string; to: string; subject?: string; body: string }, meta: { taskId?: string; agentId?: string } = {}) {
    const id = newId("out");
    await this.db.query(
      `INSERT INTO outbox (id, channel, recipient, subject, body, status, task_id, agent_id) VALUES ($1,$2,$3,$4,$5,'sending',$6,$7)`,
      [id, msg.channel, msg.to, msg.subject ?? null, msg.body, meta.taskId ?? null, meta.agentId ?? null],
    );
    return this.deliver(id);
  }

  /** Attempt delivery of one row that is in "sending" state. */
  private async deliver(id: string): Promise<{ id: string; status: string; detail?: string }> {
    const row = (await this.db.query<OutboxRow>(`SELECT * FROM outbox WHERE id=$1`, [id]))[0]!;
    if (row.channel !== "email" || !this.email) return this.mark(id, "queued_no_connector", `no delivery connector for ${row.channel}`);
    // Checked again at send time: someone may have opted out since the email was approved.
    if (await this.hooks.isSuppressed?.(row.recipient)) return this.mark(id, "failed", "not sent: recipient is on the do-not-contact list");
    const notReady = await this.email.notReady();
    if (notReady) return this.mark(id, "queued_no_connector", `not sent: ${notReady}`);
    try {
      const cfg = await this.email.config();
      const bcc = cfg.bccCeo ? (await this.db.query<{ email: string }>(`SELECT email FROM users WHERE role='ceo' AND active ORDER BY created_at LIMIT 1`))[0]?.email : undefined;
      const r = await this.email.send({ to: row.recipient, subject: row.subject ?? "", body: row.body, bcc });
      await this.db.query(`UPDATE outbox SET status='sent', detail=NULL, provider_message_id=$2, sent_at=now(), attempts=attempts+1 WHERE id=$1`, [id, r.messageId]);
      await this.hooks.onSent?.(row.recipient).catch(() => {});
      return { id, status: "sent", detail: `delivered to the mail server for ${row.recipient}` };
    } catch (e) {
      const err = e as EmailError;
      await this.db.query(`UPDATE outbox SET attempts=attempts+1 WHERE id=$1`, [id]);
      return this.mark(id, "failed", `${err.permanent === false ? "temporary failure, the CEO can retry from the Outbox" : "delivery failed"}: ${err.message}`);
    }
  }

  private async mark(id: string, status: OutboxRow["status"], detail: string) {
    await this.db.query(`UPDATE outbox SET status=$2, detail=$3 WHERE id=$1`, [id, status, detail]);
    return { id, status, detail };
  }

  /**
   * CEO-initiated retry of an item that already passed approval but failed or
   * was queued while no connector was set up. Atomic, so it can't double-send.
   */
  async retry(id: string) {
    const claimed = await this.db.query(`UPDATE outbox SET status='sending' WHERE id=$1 AND status IN ('failed','queued_no_connector') RETURNING id`, [id]);
    if (!claimed.length) throw Object.assign(new Error("only failed or queued items can be retried"), { statusCode: 409 });
    return this.deliver(id);
  }

  list(limit = 100) {
    return this.db.query<OutboxRow>(`SELECT * FROM outbox ORDER BY created_at DESC LIMIT $1`, [limit]);
  }
}

/** Versioned documents. Every save is a new version; nothing is overwritten. */
export class DbDocuments implements DocumentStore {
  constructor(private db: Db) {}
  async create(doc: { title: string; kind: string; body: string; author: string; id?: string }) {
    const id = doc.id ?? newId("doc");
    const v = (await this.db.query<{ v: number | null }>(`SELECT max(version) AS v FROM documents WHERE id=$1`, [id]))[0]?.v ?? 0;
    const version = Number(v) + 1;
    await this.db.query(`INSERT INTO documents (id, version, title, kind, body, author) VALUES ($1,$2,$3,$4,$5,$6)`, [id, version, doc.title, doc.kind, doc.body, doc.author]);
    return { id, version };
  }
  list(q?: string) {
    return this.db.query(
      `SELECT DISTINCT ON (id) id, version, title, kind, author, created_at, left(body, 280) AS excerpt FROM documents
       WHERE ($1::text IS NULL OR title ILIKE '%' || $1 || '%' OR body ILIKE '%' || $1 || '%')
       ORDER BY id, version DESC`,
      [q || null],
    );
  }
  versions(id: string) {
    return this.db.query(`SELECT id, version, title, kind, body, author, created_at FROM documents WHERE id=$1 ORDER BY version DESC`, [id]);
  }
}
