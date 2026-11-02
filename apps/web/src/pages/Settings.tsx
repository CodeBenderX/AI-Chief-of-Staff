import { useEffect, useState } from "react";
import { api, LEVELS, useApi } from "../api";
import { useUser } from "../main";
import { ErrorNote, PageHead } from "../ui";

interface Provider { id: string; kind: string; baseUrl?: string; apiKeySecret?: string; requestsPerMinute?: number; enabled: boolean }
interface Profile { id: string; label: string; provider: string; model: string; inputCostPerMTok: number; outputCostPerMTok: number; contextWindow: number; maxOutputTokens: number; capabilities: string[]; fallbacks: string[] }
interface SettingsData {
  models: { providers: Provider[]; profiles: Profile[] };
  company: { name: string; mission: string; industry: string; timezone: string };
  policies: { defaultAutonomyCap: number; monthlyBudgetUsd: number; limits: Record<string, number> };
  activeProviders: string[];
  canStoreSecrets: boolean;
  email: EmailCfg;
  emailNotReady: string | null;
}
interface EmailCfg { enabled: boolean; host: string; port: number; security: "tls" | "starttls" | "none"; username: string; fromAddress: string; fromName: string; allowedDomains: string[]; dailyLimit: number; bccCeo: boolean }

const PRESETS: Record<string, Pick<EmailCfg, "host" | "port" | "security">> = {
  "Gmail / Google Workspace": { host: "smtp.gmail.com", port: 587, security: "starttls" },
  "Outlook / Microsoft 365": { host: "smtp.office365.com", port: 587, security: "starttls" },
  Fastmail: { host: "smtp.fastmail.com", port: 465, security: "tls" },
  "Zoho Mail": { host: "smtp.zoho.com", port: 465, security: "tls" },
};
interface Secret { name: string; source: string; hint: string | null }

const LIMIT_LABELS: Record<string, string> = {
  maxDepth: "Delegation depth", maxSubtasks: "Subtasks per objective", maxModelCalls: "Model calls per objective", maxToolCalls: "Tool calls per objective",
  maxStepsPerTask: "Steps per agent task", maxTokens: "Tokens per objective", maxCostUsd: "Spend per objective (USD)", maxWallMs: "Time per objective (ms)",
  maxRetries: "Retries before escalating", maxIdenticalToolCalls: "Identical repeat calls allowed", concurrency: "Parallel subtasks",
};

function useSaver() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, okText: string) => {
    try {
      await fn();
      setMsg({ ok: true, text: okText });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  const view = msg && <div className={msg.ok ? "note" : "err"} role="status" style={{ marginTop: 10 }}>{msg.text}</div>;
  return { run, view };
}

export function Settings() {
  const { data, error, reload } = useApi<SettingsData>("/settings");
  const isCeo = useUser().role === "ceo";
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;
  return (
    <div className="stack">
      <PageHead title="Settings" sub={isCeo ? "Models, keys and the rules every agent works under." : "Only the CEO can change settings."} />
      <Models data={data} onSaved={reload} readOnly={!isCeo} />
      <WebSearch readOnly={!isCeo} />
      <Outreach readOnly={!isCeo} />
      <Email data={data} onSaved={reload} readOnly={!isCeo} />
      <Keys canStore={data.canStoreSecrets} readOnly={!isCeo} />
      <Policies data={data} readOnly={!isCeo} />
      <Company data={data} readOnly={!isCeo} />
    </div>
  );
}

function Models({ data, onSaved, readOnly }: { data: SettingsData; onSaved: () => void; readOnly: boolean }) {
  const [m, setM] = useState(data.models);
  useEffect(() => setM(data.models), [data.models]);
  const s = useSaver();
  const setProv = (i: number, p: Partial<Provider>) => setM({ ...m, providers: m.providers.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const setProf = (i: number, p: Partial<Profile>) => setM({ ...m, profiles: m.profiles.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  return (
    <section className="panel">
      <h2>AI models</h2>
      <p className="small muted">Agents pick a model profile; each profile runs on a provider and falls back in order if it fails. Change these any time; running work picks up the new setup on its next call.</p>
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
        <h3>Providers</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Provider</th><th>Type</th><th>Address</th><th>Key name</th><th>Per min</th><th>On</th><th>Status</th></tr></thead>
            <tbody>
              {m.providers.map((p, i) => (
                <tr key={p.id}>
                  <td><b>{p.id}</b></td>
                  <td>{p.kind.replace("_", " ")}</td>
                  <td><input aria-label={`${p.id} address`} value={p.baseUrl ?? ""} placeholder={p.kind === "openai_compatible" ? "http://localhost:11434/v1" : "default"} onChange={(e) => setProv(i, { baseUrl: e.target.value || undefined })} /></td>
                  <td className="small">{p.apiKeySecret ?? "none"}</td>
                  <td style={{ width: 80 }}><input aria-label={`${p.id} requests per minute`} type="number" value={p.requestsPerMinute ?? 60} onChange={(e) => setProv(i, { requestsPerMinute: Number(e.target.value) })} /></td>
                  <td><input aria-label={`${p.id} enabled`} type="checkbox" style={{ width: "auto" }} checked={p.enabled} onChange={(e) => setProv(i, { enabled: e.target.checked })} /></td>
                  <td className="small">{data.activeProviders.includes(p.id) ? "ready" : <span className="muted">{p.enabled ? "needs key or address" : "off"}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3 style={{ marginTop: 16 }}>Model profiles</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Profile</th><th>Provider</th><th>Model</th><th>Context (tokens)</th><th>$ in / out per 1M tokens</th><th>Falls back to</th></tr></thead>
            <tbody>
              {m.profiles.map((p, i) => (
                <tr key={p.id}>
                  <td><b>{p.label}</b><div className="small muted">{p.id}</div></td>
                  <td><select aria-label={`${p.id} provider`} value={p.provider} onChange={(e) => setProf(i, { provider: e.target.value })}>{m.providers.map((x) => <option key={x.id}>{x.id}</option>)}</select></td>
                  <td><input aria-label={`${p.id} model`} value={p.model} onChange={(e) => setProf(i, { model: e.target.value })} /></td>
                  <td style={{ width: 110 }}><input aria-label={`${p.id} context window`} type="number" min={1000} step={1024} value={p.contextWindow || ""} onChange={(e) => setProf(i, { contextWindow: Number(e.target.value) })} /></td>
                  <td>
                    <div className="row" style={{ flexWrap: "nowrap", gap: 4 }}>
                      <input aria-label={`${p.id} input price`} type="number" step="0.01" style={{ width: 80 }} value={p.inputCostPerMTok} onChange={(e) => setProf(i, { inputCostPerMTok: Number(e.target.value) })} />
                      <input aria-label={`${p.id} output price`} type="number" step="0.01" style={{ width: 80 }} value={p.outputCostPerMTok} onChange={(e) => setProf(i, { outputCostPerMTok: Number(e.target.value) })} />
                    </div>
                  </td>
                  <td><input aria-label={`${p.id} fallbacks`} value={p.fallbacks.join(", ")} onChange={(e) => setProf(i, { fallbacks: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">Context must not be larger than what the model was loaded with. For LM Studio, use the Context Length from the model's Load settings. Prices are estimates for cost tracking; check them against your provider's current price list.</p>
        {!readOnly && <button className="primary" onClick={() => s.run(async () => { await api("/settings/models", { method: "PUT", body: m }); onSaved(); }, "Model settings saved and reloaded.")}>Save model settings</button>}
      </fieldset>
      {s.view}
    </section>
  );
}

function Keys({ canStore, readOnly }: { canStore: boolean; readOnly: boolean }) {
  const { data, reload } = useApi<Secret[]>("/secrets");
  const [values, setValues] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const s = useSaver();
  const save = (name: string) => s.run(async () => { await api(`/secrets/${name}`, { method: "PUT", body: { value: values[name] } }); setValues({ ...values, [name]: "" }); reload(); }, `${name} saved. It is encrypted and never shown again.`);
  return (
    <section className="panel">
      <h2>API keys</h2>
      <p className="small muted">Keys are encrypted at rest, used only by the server, and never shown to agents or returned by the API.</p>
      {!canStore && <p className="note">Storing keys here needs MASTER_KEY set on the server. Until then, set keys as environment variables.</p>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Key</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(data ?? []).map((k) => (
              <tr key={k.name}>
                <td><code>{k.name}</code></td>
                <td>{k.source === "unset" ? <span className="muted">not set</span> : `${k.hint} (${k.source === "stored" ? "stored" : "from environment"})`}</td>
                <td>
                  {!readOnly && canStore && (
                    <div className="row" style={{ flexWrap: "nowrap" }}>
                      <input aria-label={`New value for ${k.name}`} type="password" autoComplete="off" placeholder="Paste new key" value={values[k.name] ?? ""} onChange={(e) => setValues({ ...values, [k.name]: e.target.value })} />
                      <button disabled={(values[k.name] ?? "").length < 8} onClick={() => save(k.name)}>Save</button>
                      {k.source === "stored" && <button className="reject" onClick={() => s.run(async () => { await api(`/secrets/${k.name}`, { method: "DELETE" }); reload(); }, `${k.name} removed.`)}>Remove</button>}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && canStore && (
        <div className="row" style={{ marginTop: 10 }}>
          <input aria-label="New key name" placeholder="NEW_KEY_NAME" value={newName} onChange={(e) => setNewName(e.target.value.toUpperCase())} style={{ maxWidth: 260 }} />
          <input aria-label="New key value" type="password" autoComplete="off" placeholder="Value" value={values[newName] ?? ""} onChange={(e) => setValues({ ...values, [newName]: e.target.value })} style={{ maxWidth: 260 }} />
          <button disabled={!newName || (values[newName] ?? "").length < 8} onClick={() => save(newName)}>Add key</button>
        </div>
      )}
      {s.view}
    </section>
  );
}

function Policies({ data, readOnly }: { data: SettingsData; readOnly: boolean }) {
  const [p, setP] = useState(data.policies);
  const s = useSaver();
  return (
    <section className="panel">
      <h2>Operating policies</h2>
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="grid2">
          <div className="field">
            <label htmlFor="cap">Default autonomy for new work</label>
            <select id="cap" value={p.defaultAutonomyCap} onChange={(e) => setP({ ...p, defaultAutonomyCap: Number(e.target.value) })}>{LEVELS.map((l, i) => <option key={i} value={i}>L{i} {l}</option>)}</select>
            <span className="small muted">Level 3 actions always need your approval regardless of this setting.</span>
          </div>
          <div className="field">
            <label htmlFor="bud">Monthly AI budget (USD)</label>
            <input id="bud" type="number" min="0" value={p.monthlyBudgetUsd} onChange={(e) => setP({ ...p, monthlyBudgetUsd: Number(e.target.value) })} />
            <span className="small muted">New work is refused once this is reached.</span>
          </div>
        </div>
        <h3>Execution limits per objective</h3>
        <div className="grid2">
          {Object.entries(p.limits).map(([k, v]) => (
            <div className="field" key={k}>
              <label htmlFor={`l-${k}`}>{LIMIT_LABELS[k] ?? k}</label>
              <input id={`l-${k}`} type="number" step={k === "maxCostUsd" ? "0.5" : "1"} value={v} onChange={(e) => setP({ ...p, limits: { ...p.limits, [k]: Number(e.target.value) } })} />
            </div>
          ))}
        </div>
        {!readOnly && <button className="primary" onClick={() => s.run(() => api("/settings/policies", { method: "PUT", body: p }), "Policies saved. They apply to new work.")}>Save policies</button>}
      </fieldset>
      {s.view}
    </section>
  );
}

function Company({ data, readOnly }: { data: SettingsData; readOnly: boolean }) {
  const [c, setC] = useState(data.company);
  const s = useSaver();
  return (
    <section className="panel">
      <h2>Company profile</h2>
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="grid2">
          <div className="field"><label htmlFor="c-name">Name</label><input id="c-name" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="c-ind">Industry</label><input id="c-ind" value={c.industry} onChange={(e) => setC({ ...c, industry: e.target.value })} /></div>
        </div>
        <div className="field"><label htmlFor="c-mis">Mission</label><textarea id="c-mis" value={c.mission} onChange={(e) => setC({ ...c, mission: e.target.value })} /></div>
        <div className="field"><label htmlFor="c-tz">Time zone</label><input id="c-tz" value={c.timezone} onChange={(e) => setC({ ...c, timezone: e.target.value })} /></div>
        {!readOnly && <button className="primary" onClick={() => s.run(() => api("/settings/company", { method: "PUT", body: c }), "Company profile saved.")}>Save profile</button>}
      </fieldset>
      {s.view}
    </section>
  );
}

function Email({ data, onSaved, readOnly }: { data: SettingsData; onSaved: () => void; readOnly: boolean }) {
  const [e, setE] = useState<EmailCfg>(data.email);
  const [password, setPassword] = useState("");
  const [domains, setDomains] = useState(data.email.allowedDomains.join(", "));
  const s = useSaver();
  const set = <K extends keyof EmailCfg>(k: K, v: EmailCfg[K]) => setE({ ...e, [k]: v });
  const save = () =>
    s.run(async () => {
      if (password) await api("/secrets/SMTP_PASSWORD", { method: "PUT", body: { value: password } });
      await api("/settings/email", { method: "PUT", body: { ...e, allowedDomains: domains.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean) } });
      setPassword("");
      onSaved();
    }, "Email settings saved.");
  const test = () => s.run(async () => {
    const r = await api<{ to: string }>("/settings/email/test", { method: "POST" });
    return r;
  }, "Test email sent. Check your inbox (and spam folder).");
  const ready = !data.emailNotReady;
  return (
    <section className="panel">
      <h2>Email</h2>
      <p className="small muted">The account agents send from. Every email still needs your approval of the exact message first.</p>
      <p className="small">
        {ready ? <span className="pill completed">connected</span> : <span className="pill">not sending</span>}{" "}
        {ready ? `Approved emails are sent from ${data.email.fromAddress}.` : `Approved emails are kept in the Outbox: ${data.emailNotReady}.`}
      </p>
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="field">
          <label htmlFor="em-preset">Provider</label>
          <select id="em-preset" value="" onChange={(ev) => { const p = PRESETS[ev.target.value]; if (p) setE({ ...e, ...p }); }}>
            <option value="">Fill in server details for…</option>
            {Object.keys(PRESETS).map((k) => <option key={k}>{k}</option>)}
          </select>
        </div>
        <div className="grid2">
          <div className="field"><label htmlFor="em-host">SMTP server</label><input id="em-host" value={e.host} onChange={(ev) => set("host", ev.target.value.trim())} placeholder="smtp.example.com" /></div>
          <div className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
            <div className="field" style={{ width: 110 }}><label htmlFor="em-port">Port</label><input id="em-port" type="number" inputMode="numeric" value={e.port || ""} onChange={(ev) => set("port", Number(ev.target.value))} /></div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="em-sec">Encryption</label>
              <select id="em-sec" value={e.security} onChange={(ev) => set("security", ev.target.value as EmailCfg["security"])}>
                <option value="starttls">STARTTLS (usually port 587)</option><option value="tls">TLS (usually port 465)</option><option value="none">None (local test server only)</option>
              </select>
            </div>
          </div>
          <div className="field"><label htmlFor="em-user">Username</label><input id="em-user" autoComplete="off" value={e.username} onChange={(ev) => set("username", ev.target.value.trim())} placeholder="you@yourcompany.com" /></div>
          <div className="field">
            <label htmlFor="em-pass">Password</label>
            <input id="em-pass" type="password" autoComplete="new-password" value={password} onChange={(ev) => setPassword(ev.target.value)} placeholder="Leave blank to keep the saved one" />
            <span className="small muted">For Gmail, create an app password (Google Account → Security → App passwords). Stored encrypted.</span>
          </div>
          <div className="field"><label htmlFor="em-from">From address</label><input id="em-from" type="email" value={e.fromAddress} onChange={(ev) => set("fromAddress", ev.target.value.trim())} /></div>
          <div className="field"><label htmlFor="em-name">From name</label><input id="em-name" value={e.fromName} onChange={(ev) => set("fromName", ev.target.value)} placeholder="Acme Sales" /></div>
        </div>
        <h3>Safeguards</h3>
        <div className="grid2">
          <div className="field">
            <label htmlFor="em-dom">Only send to these domains</label>
            <input id="em-dom" value={domains} onChange={(ev) => setDomains(ev.target.value)} placeholder="Any domain" />
            <span className="small muted">Comma-separated, e.g. acme.com, partner.io. Subdomains are included.</span>
          </div>
          <div className="field">
            <label htmlFor="em-lim">Most emails per 24 hours</label>
            <input id="em-lim" type="number" min={1} value={e.dailyLimit || ""} onChange={(ev) => set("dailyLimit", Number(ev.target.value))} />
          </div>
        </div>
        <div className="checks" style={{ marginBottom: 14 }}>
          <label><input type="checkbox" checked={e.bccCeo} onChange={(ev) => set("bccCeo", ev.target.checked)} />Blind-copy me on every email agents send</label>
          <label><input type="checkbox" checked={e.enabled} onChange={(ev) => set("enabled", ev.target.checked)} />Send approved emails</label>
        </div>
        {!readOnly && (
          <div className="row">
            <button className="primary" onClick={save}>Save email settings</button>
            <button onClick={test} disabled={!ready}>Send me a test email</button>
          </div>
        )}
      </fieldset>
      {s.view}
    </section>
  );
}

interface SearchCfg { provider: "none" | "tavily" | "brave" | "searxng"; searxngUrl: string; country: string; monthlyLimit: number; status: { ready: boolean; reason: string | null; used: number; limit: number } }

function WebSearch({ readOnly }: { readOnly: boolean }) {
  const { data, reload } = useApi<SearchCfg>("/settings/search");
  const [c, setC] = useState<SearchCfg | null>(null);
  const [key, setKey] = useState("");
  const [results, setResults] = useState<{ title: string; url: string }[] | null>(null);
  const s = useSaver();
  useEffect(() => { if (data) setC(data); }, [data]);
  if (!c) return null;
  const secret = c.provider === "tavily" ? "TAVILY_API_KEY" : c.provider === "brave" ? "BRAVE_API_KEY" : null;
  const save = () => s.run(async () => {
    if (key && secret) await api(`/secrets/${secret}`, { method: "PUT", body: { value: key } });
    await api("/settings/search", { method: "PUT", body: { provider: c.provider, searxngUrl: c.searxngUrl, country: c.country, monthlyLimit: c.monthlyLimit } });
    setKey("");
    reload();
  }, "Web search settings saved.");
  const test = () => s.run(async () => {
    const r = await api<{ results: { title: string; url: string }[] }>("/settings/search/test", { body: { query: "web design services" } });
    setResults(r.results);
  }, "Search works.");
  return (
    <section className="panel">
      <h2>Web search</h2>
      <p className="small muted">Used to find leads and by research agents. Each search counts toward your monthly limit below.</p>
      <p className="small">
        {data!.status.ready ? <span className="pill completed">ready</span> : <span className="pill">not set up</span>}{" "}
        {data!.status.ready ? `${data!.status.used} of ${data!.status.limit} searches used this month.` : `Not searching: ${data!.status.reason}.`}
      </p>
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="field">
          <label htmlFor="ws-provider">Search service</label>
          <select id="ws-provider" value={c.provider} onChange={(e) => setC({ ...c, provider: e.target.value as SearchCfg["provider"] })}>
            <option value="none">None</option>
            <option value="tavily">Tavily (free plan: 1,000 searches a month, no credit card)</option>
            <option value="brave">Brave Search API</option>
            <option value="searxng">SearXNG (self-hosted, free)</option>
          </select>
        </div>
        {secret && (
          <div className="field">
            <label htmlFor="ws-key">API key</label>
            <input id="ws-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste to add or replace; leave blank to keep the saved one" />
            <span className="small muted">{c.provider === "tavily" ? "Sign up at tavily.com and copy your API key from the dashboard." : "Create a key in the Brave Search API dashboard. Check its current pricing first."} Stored encrypted.</span>
          </div>
        )}
        {c.provider === "searxng" && (
          <div className="field">
            <label htmlFor="ws-url">SearXNG address</label>
            <input id="ws-url" value={c.searxngUrl} onChange={(e) => setC({ ...c, searxngUrl: e.target.value.trim() })} placeholder="http://localhost:8080" />
            <span className="small muted">JSON output must be enabled in its settings.yml (search → formats → json).</span>
          </div>
        )}
        <div className="grid2">
          <div className="field">
            <label htmlFor="ws-limit">Most searches per month</label>
            <input id="ws-limit" type="number" min={1} value={c.monthlyLimit || ""} onChange={(e) => setC({ ...c, monthlyLimit: Number(e.target.value) })} />
            <span className="small muted">Keep this under your plan's free allowance so you're never charged.</span>
          </div>
          {c.provider === "brave" && (
            <div className="field"><label htmlFor="ws-country">Country (2 letters)</label><input id="ws-country" maxLength={2} value={c.country} onChange={(e) => setC({ ...c, country: e.target.value.toUpperCase() })} placeholder="CA" /></div>
          )}
        </div>
        {!readOnly && (
          <div className="row">
            <button className="primary" onClick={save}>Save web search</button>
            <button onClick={test} disabled={!data!.status.ready}>Run a test search</button>
          </div>
        )}
      </fieldset>
      {s.view}
      {results && <ul className="small" style={{ marginTop: 8 }}>{results.map((r) => <li key={r.url}>{r.title} <span className="muted">{r.url}</span></li>)}</ul>}
    </section>
  );
}

interface OutreachCfg { senderName: string; businessName: string; contactLine: string; optOutText: string; pitch: string; minScore: number; notReady: string | null }

function Outreach({ readOnly }: { readOnly: boolean }) {
  const { data, reload } = useApi<OutreachCfg>("/settings/outreach");
  const dnc = useApi<{ value: string; kind: string; reason: string | null; created_at: string }[]>("/do-not-contact");
  const [o, setO] = useState<OutreachCfg | null>(null);
  const [add, setAdd] = useState("");
  const s = useSaver();
  useEffect(() => { if (data) setO(data); }, [data]);
  if (!o) return null;
  const set = <K extends keyof OutreachCfg>(k: K, v: OutreachCfg[K]) => setO({ ...o, [k]: v });
  const footer = [o.senderName, o.businessName, o.contactLine].filter((x) => x.trim()).join("\n") + `\n\n${o.optOutText}`;
  return (
    <section className="panel">
      <h2>Outreach</h2>
      <p className="small muted">Used when agents draft emails to leads. Every outreach email ends with your details and a way to opt out; anti-spam laws such as Canada's CASL require both, and emails without them are refused.</p>
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="grid2">
          <div className="field"><label htmlFor="o-name">Your name</label><input id="o-name" value={o.senderName} onChange={(e) => set("senderName", e.target.value)} /></div>
          <div className="field"><label htmlFor="o-biz">Business name</label><input id="o-biz" value={o.businessName} onChange={(e) => set("businessName", e.target.value)} /></div>
        </div>
        <div className="field"><label htmlFor="o-contact">How to reach you</label><input id="o-contact" value={o.contactLine} onChange={(e) => set("contactLine", e.target.value)} placeholder="Website, phone and/or mailing address" /></div>
        <div className="field"><label htmlFor="o-pitch">What you offer</label><textarea id="o-pitch" value={o.pitch} onChange={(e) => set("pitch", e.target.value)} placeholder="e.g. I build fast, mobile-friendly websites for local service businesses, and keep them updated for a flat monthly fee." /></div>
        <div className="field"><label htmlFor="o-opt">Opt-out sentence</label><input id="o-opt" value={o.optOutText} onChange={(e) => set("optOutText", e.target.value)} /></div>
        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="o-score">Minimum website score to count as a lead</label>
          <input id="o-score" type="number" min={1} max={30} value={o.minScore || ""} onChange={(e) => set("minScore", Number(e.target.value))} />
          <span className="small muted">Higher means only sites with bigger problems. 4 is a good start.</span>
        </div>
        <label>Footer added to every outreach email</label>
        <pre style={{ fontFamily: "var(--font)", marginBottom: 12 }}>{footer}</pre>
        {!readOnly && <button className="primary" onClick={() => s.run(async () => { await api("/settings/outreach", { method: "PUT", body: { senderName: o.senderName, businessName: o.businessName, contactLine: o.contactLine, optOutText: o.optOutText, pitch: o.pitch, minScore: o.minScore } }); reload(); }, "Outreach settings saved.")}>Save outreach</button>}
      </fieldset>
      {s.view}

      <h3 style={{ marginTop: 20 }}>Do-not-contact list</h3>
      <p className="small muted">Nobody here is ever emailed, even if an email was already approved. Add anyone who asks not to be contacted.</p>
      <div className="row" style={{ marginBottom: 10 }}>
        <input aria-label="Email or domain to block" value={add} onChange={(e) => setAdd(e.target.value)} placeholder="name@business.com or business.com" style={{ maxWidth: 320 }} />
        <button disabled={add.trim().length < 3} onClick={() => s.run(async () => { await api("/do-not-contact", { body: { value: add.trim() } }); setAdd(""); dnc.reload(); }, "Added to do-not-contact list.")}>Add</button>
      </div>
      {dnc.data?.length ? (
        <table>
          <thead><tr><th>Email or domain</th><th>Reason</th><th>Added</th><th /></tr></thead>
          <tbody>
            {dnc.data.map((d) => (
              <tr key={d.value}>
                <td>{d.value}</td><td className="small">{d.reason}</td><td className="small muted">{new Date(d.created_at).toLocaleDateString()}</td>
                <td>{!readOnly && <button className="link" onClick={() => confirm(`Remove ${d.value} from the do-not-contact list?`) && s.run(async () => { await api(`/do-not-contact/${encodeURIComponent(d.value)}`, { method: "DELETE" }); dnc.reload(); }, "Removed.")}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="small muted">Empty.</p>}
    </section>
  );
}
