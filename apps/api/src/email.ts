import nodemailer from "nodemailer";
import type { Db } from "./db.js";
import type { SecretStore } from "./secrets.js";
import type { EmailSettings, Settings } from "./settings.js";

export const SMTP_PASSWORD_SECRET = "SMTP_PASSWORD";

export class EmailError extends Error {
  constructor(message: string, public readonly permanent: boolean) {
    super(message);
    this.name = "EmailError";
  }
}

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  bcc?: string;
}

/**
 * Delivers approved email over SMTP. Credentials are read from the encrypted
 * secret store at send time and never leave the server.
 *
 * This connector is only reached through the outbox, which is only reached by
 * the email.send tool after policy checks and an action-specific CEO approval
 * (or by the CEO directly: test email / resend).
 */
export class EmailConnector {
  constructor(private settings: Settings, private secrets: SecretStore, private db: Db) {}

  async config(): Promise<EmailSettings> {
    return this.settings.get("email");
  }

  /** Why email can't be sent right now, or null if it can. */
  async notReady(cfg?: EmailSettings): Promise<string | null> {
    const c = cfg ?? (await this.config());
    if (!c.enabled) return "email delivery is turned off in Settings";
    if (!c.host || !c.fromAddress) return "email settings are incomplete";
    if (c.username && !(await this.secrets.get(SMTP_PASSWORD_SECRET))) return `the ${SMTP_PASSWORD_SECRET} secret is not set`;
    return null;
  }

  /** Recipient policy: domain allowlist and rolling 24h cap. Throws a permanent EmailError if violated. */
  async checkPolicy(to: string, c: EmailSettings) {
    const domain = to.split("@").pop()!.toLowerCase();
    if (c.allowedDomains.length && !c.allowedDomains.some((d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`))) {
      throw new EmailError(`recipient domain ${domain} is not on the allowed list in Settings`, true);
    }
    const sent = Number((await this.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM outbox WHERE channel='email' AND status='sent' AND sent_at > now() - interval '24 hours'`))[0]!.n);
    if (sent >= c.dailyLimit) throw new EmailError(`daily email limit (${c.dailyLimit}) reached`, true);
  }

  private async transport(c: EmailSettings) {
    const pass = c.username ? await this.secrets.get(SMTP_PASSWORD_SECRET) : undefined;
    return nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.security === "tls",
      requireTLS: c.security === "starttls",
      ignoreTLS: c.security === "none",
      auth: c.username ? { user: c.username, pass } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      tls: { minVersion: "TLSv1.2" },
    });
  }

  /** Send one message. Returns the provider's message id. */
  async send(msg: EmailMessage, opts: { skipPolicy?: boolean } = {}): Promise<{ messageId: string; accepted: string[] }> {
    const c = await this.config();
    const reason = await this.notReady(c);
    if (reason) throw new EmailError(reason, true);
    if (!opts.skipPolicy) await this.checkPolicy(msg.to, c);
    const transport = await this.transport(c);
    try {
      const info = await transport.sendMail({
        from: c.fromName ? { name: c.fromName, address: c.fromAddress } : c.fromAddress,
        to: msg.to,
        bcc: msg.bcc,
        subject: msg.subject,
        text: msg.body,
        headers: { "X-Mailer": "AI Company OS" },
      });
      const accepted = (info.accepted ?? []).map(String);
      if (!accepted.some((a) => a.toLowerCase() === msg.to.toLowerCase())) {
        throw new EmailError(`server did not accept the recipient (${(info.rejected ?? []).map(String).join(", ") || "no reason given"})`, true);
      }
      return { messageId: String(info.messageId ?? ""), accepted };
    } catch (e) {
      if (e instanceof EmailError) throw e;
      const err = e as { code?: string; responseCode?: number; message?: string };
      // 5xx SMTP replies and auth failures won't fix themselves; network errors and 4xx might.
      const permanent = (err.responseCode ?? 0) >= 500 || err.code === "EAUTH";
      const hint = err.code === "EAUTH" ? " (check the username and SMTP_PASSWORD; Gmail needs an app password)" : "";
      throw new EmailError(`${err.message ?? String(e)}${hint}`.slice(0, 500), permanent);
    } finally {
      transport.close();
    }
  }
}
