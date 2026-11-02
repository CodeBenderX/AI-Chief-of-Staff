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
            <thead><tr><th>Profile</th><th>Provider</th><th>Model</th><th>$ in / out per 1M tokens</th><th>Falls back to</th></tr></thead>
            <tbody>
              {m.profiles.map((p, i) => (
                <tr key={p.id}>
                  <td><b>{p.label}</b><div className="small muted">{p.id}</div></td>
                  <td><select aria-label={`${p.id} provider`} value={p.provider} onChange={(e) => setProf(i, { provider: e.target.value })}>{m.providers.map((x) => <option key={x.id}>{x.id}</option>)}</select></td>
                  <td><input aria-label={`${p.id} model`} value={p.model} onChange={(e) => setProf(i, { model: e.target.value })} /></td>
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
        <p className="small muted">Prices are estimates for cost tracking. Check them against your provider's current price list.</p>
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
