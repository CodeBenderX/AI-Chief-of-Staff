import { useState } from "react";
import { api, fmtTime, useApi, type MemoryItem } from "../api";
import { useUser } from "../main";
import { Drawer, ErrorNote, PageHead, Pill } from "../ui";

const SCOPES = ["company", "project", "decision", "organizational", "task", "agent", "conversation"];
interface Doc { id: string; version: number; title: string; kind: string; author: string; created_at: string; excerpt?: string; body?: string }

export function Knowledge() {
  const user = useUser();
  const [tab, setTab] = useState<"memory" | "docs">("memory");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("");
  const [status, setStatus] = useState("");
  const mem = useApi<MemoryItem[]>(tab === "memory" ? `/memory?${new URLSearchParams({ ...(query && { q: query }), ...(scope && { scope }), ...(status && { status }) })}` : null, [tab, query, scope, status]);
  const docs = useApi<Doc[]>(tab === "docs" ? `/documents${query ? `?q=${encodeURIComponent(query)}` : ""}` : null, [tab, query]);
  const [open, setOpen] = useState<MemoryItem | null>(null);
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <div className="stack">
      <PageHead title="Knowledge" sub="What the company knows, where each fact came from, and whether you've verified it.">
        {user.role !== "viewer" && <button className="primary" onClick={() => setAdding(true)}>Record knowledge</button>}
      </PageHead>
      <form className="row" onSubmit={(e) => { e.preventDefault(); setQuery(q); }}>
        <div role="tablist" className="row">
          <button type="button" role="tab" aria-selected={tab === "memory"} className={tab === "memory" ? "primary" : ""} onClick={() => setTab("memory")}>Memory</button>
          <button type="button" role="tab" aria-selected={tab === "docs"} className={tab === "docs" ? "primary" : ""} onClick={() => setTab("docs")}>Documents</button>
        </div>
        <input aria-label="Search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        {tab === "memory" && (
          <>
            <select aria-label="Scope" value={scope} onChange={(e) => setScope(e.target.value)} style={{ width: 160 }}><option value="">All scopes</option>{SCOPES.map((s) => <option key={s}>{s}</option>)}</select>
            <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 170 }}>
              <option value="">Current and disputed</option><option value="conflict">Disputed only</option><option value="archived">Archived</option><option value="all">Everything</option>
            </select>
          </>
        )}
        <button type="submit">Search</button>
      </form>

      {tab === "memory" && (
        <div className="panel table-wrap">
          <ErrorNote error={mem.error} />
          {mem.data?.length === 0 ? <p className="muted">Nothing stored{query ? " matches that search" : " yet"}.</p> : (
            <table>
              <thead><tr><th>Fact</th><th>Trust</th><th>Scope</th><th>Source</th><th>Recorded</th></tr></thead>
              <tbody>
                {(mem.data ?? []).map((m) => (
                  <tr key={m.id} className="click" onClick={() => setOpen(m)}>
                    <td><b>{m.title}</b><div className="small muted">{m.content.slice(0, 140)}</div></td>
                    <td>{m.status === "conflict" ? <Pill s="conflict" /> : m.verified ? <span className="pill verified">verified</span> : <span className="pill">unverified</span>}</td>
                    <td>{m.scope}</td>
                    <td className="small">{m.source}</td>
                    <td className="small muted">{fmtTime(m.createdAt)}<br />v{m.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "docs" && (
        <div className="panel table-wrap">
          <ErrorNote error={docs.error} />
          {docs.data?.length === 0 ? <p className="muted">No documents yet. Agents save drafts here as they work.</p> : (
            <table>
              <thead><tr><th>Document</th><th>Kind</th><th>Author</th><th>Version</th><th>Saved</th></tr></thead>
              <tbody>
                {(docs.data ?? []).map((d) => (
                  <tr key={d.id} className="click" onClick={() => setOpenDoc(d.id)}>
                    <td><b>{d.title}</b><div className="small muted">{d.excerpt}</div></td><td>{d.kind}</td><td>{d.author}</td><td>v{d.version}</td><td className="small muted">{fmtTime(d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {open && <MemoryDrawer m={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); mem.reload(); }} />}
      {openDoc && <DocDrawer id={openDoc} onClose={() => setOpenDoc(null)} />}
      {adding && <AddMemory onClose={() => setAdding(false)} onSaved={() => { setAdding(false); mem.reload(); }} />}
    </div>
  );
}

function MemoryDrawer({ m, onClose, onChanged }: { m: MemoryItem; onClose: () => void; onChanged: () => void }) {
  const user = useUser();
  const { data: history } = useApi<MemoryItem[]>(`/memory/history/${encodeURIComponent(m.key)}`);
  const [error, setError] = useState<string | null>(null);
  const setStatus = async (id: string, status: string) => {
    if (status === "deleted" && !confirm("Delete this entry? It stays in the audit trail but disappears from search.")) return;
    try {
      await api(`/memory/${id}/status`, { body: { status } });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Drawer onClose={onClose}>
      <h1>{m.title}</h1>
      <p className="small muted">{m.scope} memory, from {m.source} ({m.sourceType}), recorded by {m.createdBy} on {fmtTime(m.createdAt)}</p>
      {m.status === "conflict" && <p className="note" style={{ background: "var(--authority-soft)", color: "var(--authority)" }}>This contradicts an existing entry. Accept it to make it current, or archive it.</p>}
      <pre style={{ fontFamily: "var(--font)", fontSize: "0.95rem" }}>{m.content}</pre>
      {user.role === "ceo" && (
        <div className="row" style={{ marginTop: 12 }}>
          {m.status !== "current" && <button className="primary" onClick={() => setStatus(m.id, "current")}>Accept as current</button>}
          {m.status !== "archived" && <button onClick={() => setStatus(m.id, "archived")}>Archive</button>}
          <button className="reject" onClick={() => setStatus(m.id, "deleted")}>Delete</button>
        </div>
      )}
      <ErrorNote error={error} />
      <h2 style={{ marginTop: 22 }}>Version history</h2>
      <ul className="timeline">
        {(history ?? []).slice().reverse().map((v) => (
          <li key={v.id}><time>v{v.version}</time><span><Pill s={v.status} /> {v.verified ? "verified, " : ""}{v.source}, {fmtTime(v.createdAt)}<div className="small muted">{v.content.slice(0, 200)}</div></span></li>
        ))}
      </ul>
    </Drawer>
  );
}

function DocDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useApi<Doc[]>(`/documents/${id}`);
  const [v, setV] = useState(0);
  const doc = data?.[v];
  return (
    <Drawer onClose={onClose}>
      {doc && (
        <>
          <h1>{doc.title}</h1>
          <div className="row small muted" style={{ marginBottom: 12 }}>
            {doc.kind}, by {doc.author}
            <select aria-label="Version" value={v} onChange={(e) => setV(Number(e.target.value))} style={{ width: 180 }}>
              {data!.map((d, i) => <option key={d.version} value={i}>Version {d.version}, {fmtTime(d.created_at)}</option>)}
            </select>
          </div>
          <pre style={{ fontFamily: "var(--font)", fontSize: "0.95rem", maxHeight: "none" }}>{doc.body}</pre>
        </>
      )}
    </Drawer>
  );
}

function AddMemory({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ scope: "company", title: "", content: "", source: "" });
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await api("/memory", { body: f });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Drawer onClose={onClose}>
      <h1>Record knowledge</h1>
      <p className="muted">Entries you add as CEO are marked verified. Agents read them before related work.</p>
      <div className="field"><label htmlFor="m-scope">Scope</label><select id="m-scope" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}>{SCOPES.map((s) => <option key={s}>{s}</option>)}</select></div>
      <div className="field"><label htmlFor="m-title">Title</label><input id="m-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Ideal customer profile" /></div>
      <div className="field"><label htmlFor="m-content">Content</label><textarea id="m-content" style={{ minHeight: 160 }} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} /></div>
      <div className="field"><label htmlFor="m-source">Source</label><input id="m-source" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} placeholder="Board meeting, 2026-10-14" /></div>
      <ErrorNote error={error} />
      <button className="primary" onClick={save}>Save to memory</button>
    </Drawer>
  );
}
