import { useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtTime, useApi } from "../api";
import { useUser } from "../main";
import { Drawer, ErrorNote, PageHead } from "../ui";

interface Item {
  id: string; channel: string; recipient: string; subject: string | null; body: string; status: string; detail: string | null;
  attempts: number; provider_message_id: string | null; task_id: string | null; agent_id: string | null; created_at: string; sent_at: string | null;
}

const LABEL: Record<string, string> = { sent: "sent", failed: "failed", queued_no_connector: "not sent", sending: "sending" };
const PILL: Record<string, string> = { sent: "completed", failed: "failed", queued_no_connector: "awaiting_approval", sending: "running" };

export function Outbox() {
  const { data, error, reload } = useApi<Item[]>("/outbox");
  const [open, setOpen] = useState<Item | null>(null);
  return (
    <div className="stack">
      <PageHead title="Outbox" sub="Everything you approved to leave the company, and whether it actually went out." />
      <ErrorNote error={error} />
      <div className="panel table-wrap">
        {data?.length === 0 ? <p className="muted">Nothing has been approved for sending yet.</p> : (
          <table>
            <thead><tr><th>Message</th><th>To</th><th>Status</th><th>From agent</th><th>Approved</th></tr></thead>
            <tbody>
              {(data ?? []).map((o) => (
                <tr key={o.id} className="click" onClick={() => setOpen(o)}>
                  <td><b>{o.subject || "(no subject)"}</b><div className="small muted">{o.channel === "email" ? "Email" : o.channel}</div></td>
                  <td>{o.recipient}</td>
                  <td><span className={`pill ${PILL[o.status] ?? ""}`}>{LABEL[o.status] ?? o.status}</span>{o.status !== "sent" && o.detail && <div className="small muted" style={{ maxWidth: 280 }}>{o.detail}</div>}</td>
                  <td>{o.agent_id ?? "you"}</td>
                  <td className="small muted">{fmtTime(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && <ItemDrawer item={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); reload(); }} />}
    </div>
  );
}

function ItemDrawer({ item, onClose, onChanged }: { item: Item; onClose: () => void; onChanged: () => void }) {
  const isCeo = useUser().role === "ceo";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canSend = isCeo && item.channel === "email" && (item.status === "failed" || item.status === "queued_no_connector");
  const send = async () => {
    setBusy(true);
    try {
      const r = await api<{ status: string; detail?: string }>(`/outbox/${item.id}/retry`, { method: "POST" });
      if (r.status !== "sent") setError(r.detail ?? `Not sent (${r.status})`);
      else onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer onClose={onClose}>
      <h1>{item.subject || "(no subject)"}</h1>
      <dl className="slip" style={{ border: 0, padding: 0, display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px", fontSize: "0.9rem" }}>
        <dt className="muted">To</dt><dd style={{ margin: 0 }}>{item.recipient}</dd>
        <dt className="muted">Status</dt><dd style={{ margin: 0 }}>{LABEL[item.status] ?? item.status}{item.sent_at ? `, ${fmtTime(item.sent_at)}` : ""}</dd>
        {item.detail && <><dt className="muted">Details</dt><dd style={{ margin: 0 }}>{item.detail}</dd></>}
        <dt className="muted">Attempts</dt><dd style={{ margin: 0 }}>{item.attempts}</dd>
        {item.provider_message_id && <><dt className="muted">Message ID</dt><dd style={{ margin: 0, wordBreak: "break-all" }}>{item.provider_message_id}</dd></>}
        {item.task_id && <><dt className="muted">Task</dt><dd style={{ margin: 0 }}><Link to={`/tasks/${item.task_id}`} onClick={onClose}>View the task</Link></dd></>}
      </dl>
      <pre style={{ fontFamily: "var(--font)", fontSize: "0.95rem", marginTop: 14, maxHeight: "none" }}>{item.body}</pre>
      {canSend && (
        <div style={{ marginTop: 14 }}>
          <button className="primary" disabled={busy} onClick={send}>{item.status === "failed" ? "Try sending again" : "Send now"}</button>
          <p className="small muted" style={{ marginTop: 6 }}>Sends this exact message, which you already approved.</p>
        </div>
      )}
      <ErrorNote error={error} />
    </Drawer>
  );
}
