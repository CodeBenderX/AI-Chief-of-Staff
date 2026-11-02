import { StrictMode, createContext, useContext, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { api, startLiveEvents, useApi, type User } from "./api";
import { Overview } from "./pages/Overview";
import { Workforce } from "./pages/Workforce";
import { Tasks, TaskDetail } from "./pages/Tasks";
import { Approvals } from "./pages/Approvals";
import { Knowledge } from "./pages/Knowledge";
import { Settings } from "./pages/Settings";
import { Audit } from "./pages/Audit";
import { Outbox } from "./pages/Outbox";
import "./styles.css";

const UserCtx = createContext<User | null>(null);
export const useUser = () => useContext(UserCtx)!;

function AuthGate() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [needsSetup, setNeedsSetup] = useState(false);
  useEffect(() => {
    api<{ user: User }>("/auth/me")
      .then((r) => setUser(r.user))
      .catch(async () => {
        setNeedsSetup((await api<{ needsSetup: boolean }>("/auth/status")).needsSetup);
        setUser(null);
      });
  }, []);
  if (user === undefined) return null;
  if (!user) return <SignIn setup={needsSetup} onDone={setUser} />;
  return (
    <UserCtx.Provider value={user}>
      <Shell onSignOut={() => setUser(null)} />
    </UserCtx.Provider>
  );
}

function SignIn({ setup, onDone }: { setup: boolean; onDone: (u: User) => void }) {
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api<{ user: User }>(setup ? "/auth/setup" : "/auth/login", { body: form });
      onDone(r.user);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="auth-page">
      <form className="panel" onSubmit={submit}>
        <h1>{setup ? "Create the CEO account" : "Sign in"}</h1>
        <p className="muted">{setup ? "This first account holds final authority: approvals, permissions, keys and policies." : "Company console"}</p>
        {setup && (
          <div className="field"><label htmlFor="n">Your name</label><input id="n" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        )}
        <div className="field"><label htmlFor="e">Email</label><input id="e" type="email" required autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        <div className="field">
          <label htmlFor="p">Password</label>
          <input id="p" type="password" required minLength={setup ? 12 : 1} autoComplete={setup ? "new-password" : "current-password"} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          {setup && <span className="small muted">At least 12 characters.</span>}
        </div>
        {error && <div className="err" style={{ marginBottom: 12 }}>{error}</div>}
        <button className="primary" type="submit">{setup ? "Create account" : "Sign in"}</button>
      </form>
    </div>
  );
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const user = useUser();
  useEffect(() => startLiveEvents(), []);
  const { data: pending } = useApi<unknown[]>("/approvals?status=pending");
  const signOut = async () => {
    await api("/auth/logout", { method: "POST" });
    onSignOut();
  };
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand">Company Console<small>AI workforce, human authority</small></div>
        <NavLink to="/" end>Overview</NavLink>
        <NavLink to="/approvals">Approvals {pending && pending.length > 0 && <span className="count">{pending.length}</span>}</NavLink>
        <NavLink to="/tasks">Tasks</NavLink>
        <NavLink to="/outbox">Outbox</NavLink>
        <NavLink to="/workforce">Workforce</NavLink>
        <NavLink to="/knowledge">Knowledge</NavLink>
        <NavLink to="/audit">Audit log</NavLink>
        <NavLink to="/settings">Settings</NavLink>
        <div className="spacer" />
        <div className="who">
          <div style={{ color: "#fff" }}>{user.name}</div>
          <div>{user.role === "ceo" ? "CEO" : user.role === "admin" ? "Administrator" : "Viewer"}</div>
          <button className="link" onClick={signOut}>Sign out</button>
        </div>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/workforce" element={<Workforce />} />
          <Route path="/knowledge" element={<Knowledge />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/outbox" element={<Outbox />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthGate />
    </BrowserRouter>
  </StrictMode>,
);
