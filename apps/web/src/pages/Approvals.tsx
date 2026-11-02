import { useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtTime, fmtUsd, statusLabel, useApi, type Approval } from "../api";
import { useUser } from "../main";
import { ErrorNote, Ladder, PageHead, Pill } from "../ui";

function Slip({ a, onDone }: { a: Approval; onDone: () => void }) {
  const user = useUser();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "approved" | "rejected" | "changes_requested") => {
    setBusy(true);
    try {
      await api(`/approvals/${a.id}/decision`, { body: { decision, note: note || undefined } });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pending = a.status === "pending";
  return (
    <article className={`slip ${pending ? "" : "decided"}`} aria-label={`Approval request: ${a.tool ?? a.toolId}`}>
      <header>
        <div>
          <h2 style={{ margin: 0 }}>{a.tool ?? a.toolId}</h2>
          <span className="small muted">Requested by {a.agentId} for <Link to={`/tasks/${a.rootTaskId}`}>{a.taskTitle || "a task"}</Link>, {fmtTime(a.createdAt)}</span>
        </div>
        <div className="row"><Ladder level={3} label={false} /><Pill s={a.status} /></div>
      </header>
      <dl>
        <dt>What it does</dt><dd>{a.actions.length ? a.actions.map(statusLabel).join(", ") : "External or production action"}</dd>
        <dt>Risk</dt><dd><span className={`risk-${a.risk}`}>{a.risk}</span>. {a.riskSummary}</dd>
        <dt>Cost estimate</dt><dd>{a.estimatedCostUsd ? fmtUsd(a.estimatedCostUsd) : "No direct cost"}</dd>
        <dt>Agent's reason</dt><dd>{a.justification || "None given"}</dd>
        {pending ? <><dt>Expires</dt><dd>{fmtTime(a.expiresAt)} (treated as rejected if you don't decide)</dd></> : <><dt>Decision</dt><dd>{statusLabel(a.status)}{a.decidedAt ? `, ${fmtTime(a.decidedAt)}` : ""}{a.decisionNote ? `: “${a.decisionNote}”` : ""}</dd></>}
      </dl>
      <label>Exactly what will run if approved</label>
      <Payload input={a.input} />
      {pending && user.role === "ceo" && (
        <div style={{ marginTop: 14 }}>
          <div className="field">
            <label htmlFor={`n-${a.id}`}>Note to the agent (required when requesting changes)</label>
            <input id={`n-${a.id}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Shorter, and copy me on it" />
          </div>
          <div className="row">
            <button className="approve" disabled={busy} onClick={() => decide("approved")}>Approve this action</button>
            <button disabled={busy || !note.trim()} onClick={() => decide("changes_requested")}>Request changes</button>
            <button className="reject" disabled={busy} onClick={() => decide("rejected")}>Reject</button>
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>Approval covers this exact input, once. Any change by the agent needs a new approval.</p>
        </div>
      )}
      {pending && user.role !== "ceo" && <p className="small muted">Only the CEO can decide this.</p>}
      <ErrorNote error={error} />
    </article>
  );
}

export function Approvals() {
  const [tab, setTab] = useState<"pending" | "">("pending");
  const { data, error, reload } = useApi<Approval[]>(`/approvals${tab ? "?status=pending" : ""}`, [tab]);
  return (
    <div className="stack">
      <PageHead title="Approvals" sub="External and production actions wait here. Nothing runs until you approve it.">
        <div className="row" role="tablist">
          <button role="tab" aria-selected={tab === "pending"} className={tab === "pending" ? "primary" : ""} onClick={() => setTab("pending")}>Waiting</button>
          <button role="tab" aria-selected={tab === ""} className={tab === "" ? "primary" : ""} onClick={() => setTab("")}>All decisions</button>
        </div>
      </PageHead>
      <ErrorNote error={error} />
      {data && data.length === 0 && <p className="muted">{tab ? "Nothing is waiting for you." : "No approval requests yet."}</p>}
      {(data ?? []).map((a) => <Slip key={a.id} a={a} onDone={reload} />)}
    </div>
  );
}

/** Show the exact input field by field, with text as the recipient would read it. */
function Payload({ input }: { input: unknown }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return <pre>{JSON.stringify(input, null, 2)}</pre>;
  return (
    <dl style={{ background: "var(--line-2)", padding: 12, borderRadius: 4, margin: 0 }}>
      {Object.entries(input as Record<string, unknown>).map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd style={{ whiteSpace: "pre-wrap" }}>{typeof v === "string" ? v : JSON.stringify(v, null, 2)}</dd>
        </div>
      ))}
    </dl>
  );
}
