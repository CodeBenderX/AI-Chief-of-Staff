import { fmtTime, useApi } from "../api";
import { ErrorNote, PageHead } from "../ui";

interface Entry { id: string; actorType: string; actorId: string; action: string; target: string | null; outcome: string; detail: Record<string, unknown>; at: string }

export function Audit() {
  const { data, error } = useApi<Entry[]>("/audit?limit=500");
  return (
    <div className="stack">
      <PageHead title="Audit log" sub="Every login, decision, permission change and tool call. Entries can't be edited or deleted." />
      <ErrorNote error={error} />
      <div className="panel table-wrap">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Outcome</th><th>Detail</th></tr></thead>
          <tbody>
            {(data ?? []).map((e) => (
              <tr key={e.id}>
                <td className="small muted" style={{ whiteSpace: "nowrap" }}>{fmtTime(e.at)}</td>
                <td className="small">{e.actorId}<div className="muted">{e.actorType}</div></td>
                <td><code>{e.action}</code></td>
                <td><span className={`pill ${e.outcome === "denied" || e.outcome === "error" ? "failed" : e.outcome === "pending" ? "awaiting_approval" : "completed"}`}>{e.outcome}</span></td>
                <td className="small" style={{ maxWidth: 380, wordBreak: "break-word" }}>{Object.keys(e.detail).length ? JSON.stringify(e.detail).slice(0, 240) : ""}{e.target ? <div className="muted">{e.target}</div> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
