import { newId, type DocumentStore, type Outbox } from "@aicos/core";
import type { Db } from "./db.js";

/**
 * Outbound actions land here after CEO approval. No delivery connector
 * (SMTP, CMS, CD pipeline) is wired yet, so items are recorded as
 * "queued_no_connector" — the platform never pretends something was sent.
 */
export class DbOutbox implements Outbox {
  constructor(private db: Db) {}
  async send(msg: { channel: string; to: string; subject?: string; body: string }) {
    const id = newId("out");
    const status = "queued_no_connector";
    await this.db.query(`INSERT INTO outbox (id, channel, recipient, subject, body, status) VALUES ($1,$2,$3,$4,$5,$6)`, [id, msg.channel, msg.to, msg.subject ?? null, msg.body, status]);
    return { id, status };
  }
  list(limit = 100) {
    return this.db.query(`SELECT * FROM outbox ORDER BY created_at DESC LIMIT $1`, [limit]);
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
