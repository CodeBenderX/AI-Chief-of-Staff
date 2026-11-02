import type { ReactNode } from "react";
import { LEVELS, statusLabel } from "./api";

export function Ladder({ level, label = true }: { level: number; label?: boolean }) {
  return (
    <span title={`Autonomy level ${level}: ${LEVELS[level]}`} aria-label={`Autonomy level ${level}: ${LEVELS[level]}`}>
      <span className="ladder">
        {[0, 1, 2, 3].map((i) => (
          <i key={i} className={`${i <= level ? "on" : ""} ${i === 3 ? "ext" : ""}`} />
        ))}
      </span>
      {label && <span className="ladder-label">L{level} {LEVELS[level]}</span>}
    </span>
  );
}

export const Pill = ({ s }: { s: string }) => <span className={`pill ${s}`}>{statusLabel(s)}</span>;

export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted" style={{ margin: 0 }}>{sub}</p>}
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

export function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="link" onClick={onClose} autoFocus>Close</button>
        </div>
        {children}
      </aside>
    </>
  );
}

export const ErrorNote = ({ error }: { error: string | null }) => (error ? <div className="err" role="alert">{error}</div> : null);
