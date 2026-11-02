import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretResolver } from "@aicos/core";
import type { Db } from "./db.js";

/**
 * Encrypted secret storage (AES-256-GCM). The master key comes from the
 * environment and never touches the database. Secret values are only read
 * server-side (by the model router and connectors) and are never returned
 * by the API or shown to agents.
 */
export class SecretStore implements SecretResolver {
  private key: Buffer | null;
  constructor(private db: Db, masterKeyB64: string | undefined, private env: NodeJS.ProcessEnv = process.env) {
    const k = masterKeyB64 ? Buffer.from(masterKeyB64, "base64") : null;
    if (k && k.length !== 32) throw new Error("MASTER_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
    this.key = k;
  }

  get canStore() {
    return !!this.key;
  }

  encrypt(plain: string): string {
    if (!this.key) throw new Error("MASTER_KEY is not set; secrets cannot be stored. Use environment variables instead.");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
  }

  decrypt(blob: string): string {
    if (!this.key) throw new Error("MASTER_KEY is not set");
    const [iv, tag, ct] = blob.split(".").map((s) => Buffer.from(s, "base64"));
    const d = createDecipheriv("aes-256-gcm", this.key, iv!);
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(ct!), d.final()]).toString("utf8");
  }

  async set(name: string, value: string, by: string) {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new Error("secret names must be UPPER_SNAKE_CASE");
    await this.db.query(
      `INSERT INTO secrets (name, ciphertext, last4, updated_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (name) DO UPDATE SET ciphertext=EXCLUDED.ciphertext, last4=EXCLUDED.last4, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [name, this.encrypt(value), value.slice(-4), by],
    );
  }

  async delete(name: string) {
    await this.db.query(`DELETE FROM secrets WHERE name=$1`, [name]);
  }

  /** Stored value first, then environment variable. */
  async get(name: string): Promise<string | undefined> {
    const row = (await this.db.query<{ ciphertext: string }>(`SELECT ciphertext FROM secrets WHERE name=$1`, [name]))[0];
    if (row && this.key) return this.decrypt(row.ciphertext);
    return this.env[name] || undefined;
  }

  /** Metadata only — never values. */
  async list(names: string[]) {
    const rows = await this.db.query<{ name: string; last4: string; updated_at: string; updated_by: string }>(`SELECT name, last4, updated_at, updated_by FROM secrets`);
    const stored = new Map(rows.map((r) => [r.name, r]));
    const all = new Set([...names, ...stored.keys()]);
    return [...all].sort().map((name) => {
      const s = stored.get(name);
      return {
        name,
        source: s ? "stored" : this.env[name] ? "environment" : "unset",
        hint: s ? `••••${s.last4}` : this.env[name] ? `••••${this.env[name]!.slice(-4)}` : null,
        updatedAt: s?.updated_at ?? null,
        updatedBy: s?.updated_by ?? null,
      };
    });
  }
}
