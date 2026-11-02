import { z } from "zod";
import { AutonomyLevel, DEFAULT_LIMITS, DEFAULT_PROFILES, DEFAULT_PROVIDERS, type ModelProfile, type ProviderConfig } from "@aicos/core";
import type { Db } from "./db.js";

export const ProviderSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  kind: z.enum(["anthropic", "openai", "openai_compatible", "mock"]),
  baseUrl: z.url().optional(),
  apiKeySecret: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
  requestsPerMinute: z.number().int().min(1).max(10_000).optional(),
  enabled: z.boolean(),
});

export const ProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  label: z.string().min(1).max(80),
  provider: z.string(),
  model: z.string().min(1).max(200),
  inputCostPerMTok: z.number().min(0).max(1000),
  outputCostPerMTok: z.number().min(0).max(1000),
  contextWindow: z.number().int().min(1000).max(10_000_000),
  maxOutputTokens: z.number().int().min(16).max(200_000),
  capabilities: z.array(z.enum(["tools", "json", "vision", "long_context", "reasoning"])),
  fallbacks: z.array(z.string()).max(5),
});

export const ModelsSchema = z
  .object({ providers: z.array(ProviderSchema).max(30), profiles: z.array(ProfileSchema).max(50) })
  .superRefine((v, ctx) => {
    const providerIds = new Set(v.providers.map((p) => p.id));
    const profileIds = new Set(v.profiles.map((p) => p.id));
    for (const p of v.profiles) {
      if (!providerIds.has(p.provider)) ctx.addIssue({ code: "custom", message: `profile ${p.id}: unknown provider ${p.provider}` });
      for (const f of p.fallbacks) if (!profileIds.has(f)) ctx.addIssue({ code: "custom", message: `profile ${p.id}: unknown fallback ${f}` });
    }
    if (!profileIds.has("default")) ctx.addIssue({ code: "custom", message: 'a profile with id "default" is required' });
  });

export const CompanySchema = z.object({
  name: z.string().min(1).max(120),
  mission: z.string().max(2000),
  industry: z.string().max(200),
  timezone: z.string().max(60),
});

export const PoliciesSchema = z.object({
  /** Highest autonomy level any new task may run at unless the CEO raises it per task. */
  defaultAutonomyCap: z.nativeEnum(AutonomyLevel),
  limits: z.object({
    maxDepth: z.number().int().min(0).max(5),
    maxSubtasks: z.number().int().min(1).max(50),
    maxModelCalls: z.number().int().min(1).max(1000),
    maxToolCalls: z.number().int().min(0).max(2000),
    maxStepsPerTask: z.number().int().min(1).max(50),
    maxTokens: z.number().int().min(1000).max(20_000_000),
    maxCostUsd: z.number().min(0).max(10_000),
    maxWallMs: z.number().int().min(10_000).max(24 * 3600_000),
    maxRetries: z.number().int().min(0).max(5),
    maxIdenticalToolCalls: z.number().int().min(1).max(10),
    concurrency: z.number().int().min(1).max(10),
  }),
  /** Monthly AI spend ceiling; new tasks are refused once reached. */
  monthlyBudgetUsd: z.number().min(0).max(1_000_000),
});

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** SMTP account used to deliver approved emails. The password lives in the encrypted secret SMTP_PASSWORD. */
export const EmailSchema = z
  .object({
    enabled: z.boolean(),
    host: z.string().max(253),
    port: z.number().int().min(1).max(65535),
    /** tls = implicit TLS (465), starttls = upgrade (587). "none" is allowed only for a server on this machine. */
    security: z.enum(["tls", "starttls", "none"]),
    username: z.string().max(320),
    fromAddress: z.union([z.email().max(320), z.literal("")]),
    fromName: z.string().max(120),
    /** Optional: only these recipient domains may receive email. Empty = any domain. */
    allowedDomains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i).max(253)).max(100),
    /** Hard cap on emails sent per rolling 24 hours. */
    dailyLimit: z.number().int().min(1).max(10_000),
    /** Send the CEO a blind copy of every email agents send. */
    bccCeo: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (!v.enabled) return;
    if (!v.host) ctx.addIssue({ code: "custom", message: "SMTP host is required" });
    if (!v.fromAddress) ctx.addIssue({ code: "custom", message: "From address is required" });
    if (v.security === "none" && !LOCAL_HOSTS.has(v.host)) ctx.addIssue({ code: "custom", message: "Unencrypted SMTP is only allowed for a server on this machine; use TLS or STARTTLS" });
  });
export type EmailSettings = z.infer<typeof EmailSchema>;

export type Models = { providers: ProviderConfig[]; profiles: ModelProfile[] };
export type CompanyProfile = z.infer<typeof CompanySchema>;
export type Policies = z.infer<typeof PoliciesSchema>;

const DEFAULTS = {
  models: { providers: DEFAULT_PROVIDERS, profiles: DEFAULT_PROFILES } as Models,
  company: { name: "My AI Company", mission: "", industry: "", timezone: "America/Vancouver" } as CompanyProfile,
  policies: { defaultAutonomyCap: AutonomyLevel.External, limits: DEFAULT_LIMITS, monthlyBudgetUsd: 100 } as Policies,
  email: { enabled: false, host: "", port: 587, security: "starttls", username: "", fromAddress: "", fromName: "", allowedDomains: [], dailyLimit: 50, bccCeo: false } as EmailSettings,
};
type Key = keyof typeof DEFAULTS;

export class Settings {
  constructor(private db: Db) {}
  async get<K extends Key>(key: K): Promise<(typeof DEFAULTS)[K]> {
    const row = (await this.db.query<{ value: (typeof DEFAULTS)[K] }>(`SELECT value FROM settings WHERE key=$1`, [key]))[0];
    return row?.value ?? structuredClone(DEFAULTS[key]);
  }
  async set<K extends Key>(key: K, value: (typeof DEFAULTS)[K]) {
    await this.db.query(`INSERT INTO settings (key, value) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [key, JSON.stringify(value)]);
  }
}
