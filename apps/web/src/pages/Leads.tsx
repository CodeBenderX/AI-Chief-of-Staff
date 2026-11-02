import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtTime, useApi } from "../api";
import { useUser } from "../main";
import { Drawer, ErrorNote, PageHead } from "../ui";

interface Finding { id: string; severity: "high" | "medium" | "low"; title: string; detail: string }
interface Lead {
  id: string; domain: string; business_name: string; website: string; niche: string | null; area: string | null; status: string; score: number;
  audit: { findings: Finding[]; platform: string | null; https: boolean; checkedAt: string; contactPageUrl: string | null } | null;
  contact_email: string | null; contact_source: string | null; contact_found_at: string | null; notes: string; draft_task_id: string | null; contacted_at: string | null; created_at: string;
}
interface Run { id: string; niche: string; area: string; requested: number; status: string; searches: number; checked: number; qualified: number; message: string | null; created_at: string }

const STATUS: Record<string, { label: string; pill: string }> = {
  qualified: { label: "To contact", pill: "running" },
  drafting: { label: "Email in progress", pill: "awaiting_approval" },
  contacted: { label: "Contacted", pill: "completed" },
  replied: { label: "Replied", pill: "completed" },
  won: { label: "Won", pill: "completed" },
  lost: { label: "Lost", pill: "" },
  not_a_fit: { label: "Not a fit", pill: "" },
  do_not_contact: { label: "Do not contact", pill: "failed" },
};
const SEV_COLOR = { high: "var(--danger)", medium: "var(--authority)", low: "var(--ink-3)" };

export function Leads() {
  const user = useUser();
  const [filter, setFilter] = useState("");
  const [q, setQ] = useState("");
  const leads = useApi<Lead[]>(`/leads?${new URLSearchParams({ ...(filter && { status: filter }), ...(q && { q }) })}`, [filter, q]);
  const runs = useApi<Run[]>("/lead-runs");
  const search = useApi<{ status: { ready: boolean; reason: string | null; used: number; limit: number } }>("/settings/search");
  const outreach = useApi<{ notReady: string | null }>("/settings/outreach");
  const [open, setOpen] = useState<Lead | null>(null);
  const latest = runs.data?.[0];
  const running = latest?.status === "running";

  return (
    <div className="stack">
      <PageHead title="Leads" sub="Businesses whose websites need work, found and checked for you. Nothing is sent without your approval." />

      {search.data && !search.data.status.ready && (
        <div className="note" style={{ background: "var(--authority-soft)", color: "var(--authority)" }}>
          To find leads, choose a web search service first ({search.data.status.reason}). <Link to="/settings">Open Settings → Web search</Link>
        </div>
      )}
      {outreach.data?.notReady && (
        <div className="note">Before drafting emails, {outreach.data.notReady}. <Link to="/settings">Open Settings</Link></div>
      )}

      {user.role !== "viewer" && <FindLeads disabled={!search.data?.status.ready || running} onStarted={runs.reload} />}

      {latest && (
        <p className="small" role="status">
          {running ? (
            <>Searching for {latest.niche} in {latest.area}: {latest.searches} searches, {latest.checked} websites checked, {latest.qualified} leads so far…</>
          ) : (
            <>Last search ({latest.niche} in {latest.area}, {fmtTime(latest.created_at)}): {latest.status === "failed" ? <span style={{ color: "var(--danger)" }}>failed: {latest.message}</span> : latest.message}</>
          )}
          {search.data && <span className="muted"> {search.data.status.used} of {search.data.status.limit} searches used this month.</span>}
        </p>
      )}

      <div className="row">
        <select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }}>
          <option value="">Active leads</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          <option value="all">Everything</option>
        </select>
        <input aria-label="Search leads" placeholder="Search by name, niche or area" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
      </div>

      <div className="panel table-wrap">
        <ErrorNote error={leads.error} />
        {leads.data?.length === 0 ? (
          <p className="muted">{filter || q ? "No leads match." : "No leads yet. Pick a type of business and an area above, then click Find leads."}</p>
        ) : (
          <table>
            <thead><tr><th>Business</th><th>What we found</th><th>Contact</th><th>Status</th><th>Found</th></tr></thead>
            <tbody>
              {(leads.data ?? []).map((l) => (
                <tr key={l.id} className="click" onClick={() => setOpen(l)}>
                  <td><b>{l.business_name}</b><div className="small muted">{l.domain}</div></td>
                  <td className="small">{(l.audit?.findings ?? []).slice(0, 2).map((f) => f.title).join("; ") || <span className="muted">nothing major</span>}{(l.audit?.findings.length ?? 0) > 2 && <span className="muted"> +{l.audit!.findings.length - 2} more</span>}</td>
                  <td className="small">{l.contact_email ?? <span className="muted">none found</span>}</td>
                  <td><span className={`pill ${STATUS[l.status]?.pill ?? ""}`}>{STATUS[l.status]?.label ?? l.status}</span></td>
                  <td className="small muted">{fmtTime(l.created_at).split(",")[0]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && <LeadDrawer id={open.id} outreachNotReady={outreach.data?.notReady ?? null} onClose={() => setOpen(null)} onChanged={leads.reload} />}
    </div>
  );
}

function FindLeads({ disabled, onStarted }: { disabled: boolean; onStarted: () => void }) {
  const [niche, setNiche] = useState("");
  const [area, setArea] = useState("");
  const [count, setCount] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api("/lead-runs", { body: { niche, area, count } });
      onStarted();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className="panel" onSubmit={start}>
      <h2>Find new leads</h2>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div style={{ flex: 1, minWidth: 180 }}><label htmlFor="niche">Type of business</label><input id="niche" required minLength={2} value={niche} onChange={(e) => setNiche(e.target.value)} placeholder="e.g. plumbers, dental clinics, cafes" /></div>
        <div style={{ flex: 1, minWidth: 180 }}><label htmlFor="area">Area</label><input id="area" required minLength={2} value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Burnaby, BC" /></div>
        <div>
          <label htmlFor="count">How many</label>
          <select id="count" value={count} onChange={(e) => setCount(Number(e.target.value))}>{[5, 10, 15, 20].map((n) => <option key={n}>{n}</option>)}</select>
        </div>
        <button className="primary" disabled={disabled}>Find leads</button>
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>Searches the web, skips directories like Yelp and Facebook, checks each business website, and keeps the ones with problems you could fix. Uses about 2 to 5 searches.</p>
      <ErrorNote error={error} />
    </form>
  );
}

function LeadDrawer({ id, outreachNotReady, onClose, onChanged }: { id: string; outreachNotReady: string | null; onClose: () => void; onChanged: () => void }) {
  const user = useUser();
  const { data: lead, reload } = useApi<Lead>(`/leads/${id}`);
  const [notes, setNotes] = useState("");
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string; taskId?: string } | null>(null);
  useEffect(() => {
    if (lead) {
      setNotes(lead.notes);
      setEmail(lead.contact_email ?? "");
    }
  }, [lead?.id]);
  if (!lead) return <Drawer onClose={onClose}>{null}</Drawer>;
  const canEdit = user.role !== "viewer";
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      const r = (await fn()) as { taskId?: string } | undefined;
      setMsg({ ok: true, text: ok, taskId: r?.taskId });
      reload();
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  const save = () => run(() => api(`/leads/${lead.id}`, { method: "PATCH", body: { notes, contactEmail: email.trim() || null } }), "Saved.");
  const setStatus = (status: string) => run(() => api(`/leads/${lead.id}`, { method: "PATCH", body: { status } }), "Status updated.");
  const draft = () => run(() => api(`/leads/${lead.id}/draft`, { method: "POST" }), "The Sales agent is writing the email. It will appear in Approvals for you to review.");
  const dnc = () => confirm(`Never contact ${lead.business_name} again? Their email and website are added to your do-not-contact list.`) && run(() => api(`/leads/${lead.id}/do-not-contact`, { method: "POST" }), "Added to your do-not-contact list.");
  const findings = lead.audit?.findings ?? [];
  const blocked = lead.status === "do_not_contact";

  return (
    <Drawer onClose={onClose}>
      <h1>{lead.business_name}</h1>
      <p className="small"><a href={lead.website} target="_blank" rel="noreferrer noopener">{lead.website}</a>{lead.niche && <span className="muted"> {lead.niche}, {lead.area}</span>}</p>

      <h2 style={{ marginTop: 18 }}>Website check</h2>
      <p className="small muted">Checked {lead.audit ? fmtTime(lead.audit.checkedAt) : "—"}{lead.audit?.platform ? `. Built with ${lead.audit.platform}` : ""}. Score {lead.score} (higher means more to fix).</p>
      {findings.length === 0 ? <p className="muted">No problems found.</p> : (
        <ul style={{ paddingLeft: 18, margin: 0 }}>
          {findings.map((f) => (
            <li key={f.id} style={{ marginBottom: 6 }}>
              <b style={{ color: SEV_COLOR[f.severity] }}>{f.title}</b>
              <div className="small muted">{f.detail}</div>
            </li>
          ))}
        </ul>
      )}

      <h2 style={{ marginTop: 18 }}>Contact</h2>
      <fieldset disabled={!canEdit || blocked} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="field">
          <label htmlFor="lead-email">Email</label>
          <input id="lead-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="No email found on their site" />
          {lead.contact_email && lead.contact_source && (
            <span className="small muted">
              {lead.contact_source.startsWith("http") ? <>Published on <a href={lead.contact_source} target="_blank" rel="noreferrer noopener">{new URL(lead.contact_source).pathname}</a></> : lead.contact_source}
              {lead.contact_found_at ? `, found ${fmtTime(lead.contact_found_at)}` : ""}
            </span>
          )}
          {!lead.contact_email && lead.audit?.contactPageUrl && <span className="small muted">Try their <a href={lead.audit.contactPageUrl} target="_blank" rel="noreferrer noopener">contact page</a>.</span>}
        </div>
        <div className="field"><label htmlFor="lead-notes">Notes</label><textarea id="lead-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Spoke on the phone, call back in March" /></div>
        <div className="row">
          <button onClick={save}>Save</button>
          <select aria-label="Status" value={lead.status} onChange={(e) => setStatus(e.target.value)} style={{ width: 200 }}>
            {Object.entries(STATUS).filter(([k]) => k !== "do_not_contact").map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
      </fieldset>

      {canEdit && !blocked && (
        <>
          <h2 style={{ marginTop: 18 }}>Reach out</h2>
          {outreachNotReady && <p className="small note">Before drafting, {outreachNotReady}.</p>}
          <div className="row">
            <button className="primary" disabled={!lead.contact_email || !!outreachNotReady || lead.status === "drafting"} onClick={draft}>
              {lead.status === "drafting" ? "Email waiting in Approvals" : "Draft outreach email"}
            </button>
            <button className="reject" onClick={dnc}>Do not contact</button>
          </div>
          <p className="small muted" style={{ marginTop: 6 }}>The Sales agent writes a short email based on the problems above. You review the exact message in Approvals before it's sent.</p>
        </>
      )}
      {blocked && <p className="note">This business is on your do-not-contact list.</p>}
      {lead.draft_task_id && <p className="small"><Link to={`/tasks/${lead.draft_task_id}`} onClick={onClose}>View the outreach task</Link></p>}
      {msg && <div className={msg.ok ? "note" : "err"} role="status" style={{ marginTop: 10 }}>{msg.text}{msg.taskId && <> <Link to="/approvals" onClick={onClose}>Go to Approvals</Link></>}</div>}
    </Drawer>
  );
}
