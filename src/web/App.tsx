import { useEffect, useMemo, useState, type FormEvent } from "react";
import { LocalDb } from "./local/db.ts";
import { SyncEngine } from "./local/sync.ts";
import { api, ApiError, setToken } from "./api.ts";
import { Ctx, ROLE_LABELS, useApp, useSyncStatus, type Session } from "./context.ts";
import { Dashboard } from "./screens/Dashboard.tsx";
import { Invoices } from "./screens/Invoices.tsx";
import { Clients } from "./screens/Clients.tsx";

type Boot =
  | { kind: "loading" }
  | { kind: "auth"; db: LocalDb }
  | { kind: "ready"; db: LocalDb; session: Session };

export function App() {
  const [boot, setBoot] = useState<Boot>({ kind: "loading" });

  useEffect(() => {
    LocalDb.open().then(async (db) => {
      const session = await db.getMeta<Session>("session");
      if (session) {
        setToken(session.token);
        setBoot({ kind: "ready", db, session });
      } else {
        setBoot({ kind: "auth", db });
      }
    });
  }, []);

  if (boot.kind === "loading") return <div className="center muted">Ouverture…</div>;
  if (boot.kind === "auth") {
    return (
      <AuthScreen
        db={boot.db}
        onSession={async (session) => {
          await boot.db.setMeta("session", session);
          setToken(session.token);
          setBoot({ kind: "ready", db: boot.db, session });
        }}
      />
    );
  }
  return (
    <Shell
      db={boot.db}
      session={boot.session}
      onLogout={async (wipe) => {
        if (wipe) await boot.db.wipe();
        else await boot.db.setMeta("session", undefined);
        setToken(null);
        setBoot({ kind: "auth", db: boot.db });
      }}
    />
  );
}

function AuthScreen({ db, onSession }: { db: LocalDb; onSession: (s: Session) => Promise<void> }) {
  const [mode, setMode] = useState<"login" | "setup" | "checking">("checking");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ initialized: boolean }>("/api/status")
      .then((s) => setMode(s.initialized ? "login" : "setup"))
      .catch(() => {
        setMode("login");
        setError("Pas de connexion : la toute première ouverture sur cet appareil demande internet.");
      });
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError(null);
    try {
      const path = mode === "setup" ? "/api/setup" : "/api/login";
      const session = await api<Session>(path, { ...f, deviceId: db.deviceId });
      await onSession(session);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Serveur injoignable : vérifiez votre connexion.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark">G</span>
          <span>Gestion PME</span>
        </div>
        {mode === "checking" ? (
          <p className="muted">Vérification…</p>
        ) : (
          <>
            <h1>{mode === "setup" ? "Créer votre entreprise" : "Connexion"}</h1>
            {mode === "setup" && (
              <>
                <p className="muted">Première installation : vous serez l'administrateur.</p>
                <label>Nom de l'entreprise<input name="company" required autoComplete="organization" /></label>
                <label>Votre nom<input name="name" required autoComplete="name" /></label>
              </>
            )}
            <label>E-mail<input name="email" type="email" required autoComplete="email" /></label>
            <label>
              Mot de passe
              <input name="password" type="password" required minLength={8} autoComplete={mode === "setup" ? "new-password" : "current-password"} />
            </label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="primary" disabled={busy}>{busy ? "Patientez…" : mode === "setup" ? "Créer" : "Se connecter"}</button>
          </>
        )}
      </form>
    </div>
  );
}

type Tab = "dashboard" | "invoices" | "clients";
const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Tableau de bord" },
  { id: "invoices", label: "Factures" },
  { id: "clients", label: "Clients" },
];

function Shell({ db, session, onLogout }: { db: LocalDb; session: Session; onLogout: (wipe: boolean) => Promise<void> }) {
  const sync = useMemo(() => new SyncEngine(db), [db]);
  const [tab, setTab] = useState<Tab>("dashboard");

  useEffect(() => {
    sync.start();
    return () => sync.stop();
  }, [sync]);

  const logout = async () => {
    const pending = await db.pendingCount();
    if (pending > 0 && !confirm(`${pending} modification(s) pas encore envoyée(s). Se déconnecter quand même ? Elles resteront sur cet appareil.`)) return;
    sync.stop();
    await onLogout(false);
  };

  return (
    <Ctx.Provider value={{ db, sync, session, logout }}>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark">G</span>
            <span>{session.company.name}</span>
          </div>
          <SyncPill onAuthLost={() => { sync.stop(); onLogout(false); }} />
          <div className="user">
            <span className="user-name">{session.user.name}</span>
            <span className="muted small">{ROLE_LABELS[session.user.role] ?? session.user.role}</span>
            <button className="ghost small" onClick={logout}>Déconnexion</button>
          </div>
        </header>
        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "tab active" : "tab"} onClick={() => setTab(t.id)} aria-current={tab === t.id}>
              {t.label}
            </button>
          ))}
        </nav>
        <main className="content">
          {tab === "dashboard" && <Dashboard />}
          {tab === "invoices" && <Invoices />}
          {tab === "clients" && <Clients />}
        </main>
        <RejectedNotice />
      </div>
    </Ctx.Provider>
  );
}

function SyncPill({ onAuthLost }: { onAuthLost: () => void }) {
  const { sync } = useApp();
  const s = useSyncStatus();
  useEffect(() => {
    if (s.state === "auth") onAuthLost();
  }, [s.state]);
  let label: string;
  let tone: string;
  if (s.state === "syncing") {
    label = "Synchronisation…";
    tone = "info";
  } else if (s.state === "offline") {
    label = s.pending > 0 ? `Hors ligne · ${s.pending} en attente` : "Hors ligne";
    tone = "muted";
  } else if (s.state === "error") {
    label = s.message ?? "Erreur de synchronisation";
    tone = "warn";
  } else if (s.pending > 0) {
    label = `${s.pending} en attente`;
    tone = "warn";
  } else {
    label = "À jour";
    tone = "ok";
  }
  return (
    <button className={`pill ${tone}`} onClick={() => sync.syncNow()} title="Synchroniser maintenant" data-testid="sync-pill">
      <span className="dot" />
      {label}
    </button>
  );
}

function RejectedNotice() {
  const s = useSyncStatus();
  const [hidden, setHidden] = useState<string | undefined>();
  if (s.rejected.length === 0 || hidden === s.lastSync) return null;
  return (
    <div className="toast" role="status">
      <strong>{s.rejected.length} modification(s) refusée(s) par le serveur</strong>
      <ul>{s.rejected.slice(0, 3).map((r, i) => <li key={i}>{r.reason}</li>)}</ul>
      <button className="ghost small" onClick={() => setHidden(s.lastSync)}>Fermer</button>
    </div>
  );
}
