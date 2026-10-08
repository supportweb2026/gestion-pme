import { useEffect, useMemo, useState, type FormEvent } from "react";
import { LocalDb } from "./local/db.ts";
import { SyncEngine } from "./local/sync.ts";
import { api, ApiError, setToken } from "./api.ts";
import { Ctx, ROLE_LABELS, TAB_LABELS, TABS_BY_ROLE, text, useApp, useSettings, useSyncStatus, type Session, type Tab } from "./context.ts";
import { Dashboard } from "./screens/Dashboard.tsx";
import { Documents } from "./screens/Documents.tsx";
import { Clients } from "./screens/Clients.tsx";
import { Articles } from "./screens/Articles.tsx";
import { Expenses } from "./screens/Expenses.tsx";
import { Settings } from "./screens/Settings.tsx";
import { Accounting } from "./screens/Accounting.tsx";
import { Projects } from "./screens/Projects.tsx";
import { Platform } from "./screens/Platform.tsx";
import { useInstall } from "./device.ts";
import { formatDate } from "./subscription.tsx";
import { GRACE_DAYS } from "../shared/plans.ts";

type Boot =
  | { kind: "loading" }
  | { kind: "locked"; db: LocalDb }
  | { kind: "auth"; db: LocalDb }
  | { kind: "ready"; db: LocalDb; session: Session };

export function App() {
  const [boot, setBoot] = useState<Boot>({ kind: "loading" });

  useEffect(() => {
    LocalDb.open().then(async (db) => {
      if (await db.isProtected()) setBoot({ kind: "locked", db });
      else await afterUnlock(db);
    });
  }, []);

  async function afterUnlock(db: LocalDb) {
    const session = await db.getMeta<Session>("session");
    if (session) {
      setToken(session.token);
      setBoot({ kind: "ready", db, session });
    } else {
      setBoot({ kind: "auth", db });
    }
  }

  if (boot.kind === "loading") return <div className="center muted">Ouverture…</div>;
  if (boot.kind === "locked") {
    return (
      <PinScreen
        onPin={async (pin) => {
          if (!(await boot.db.unlock(pin))) return false;
          await afterUnlock(boot.db);
          return true;
        }}
        onForgot={async () => {
          await boot.db.wipe();
          setBoot({ kind: "auth", db: boot.db });
        }}
      />
    );
  }
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
  if (boot.session.user.mustChangePassword) {
    const { db, session } = boot;
    return (
      <ForcePasswordScreen
        session={session}
        onDone={async () => {
          const next = { ...session, user: { ...session.user, mustChangePassword: false } };
          await db.setMeta("session", next);
          setBoot({ kind: "ready", db, session: next });
        }}
        onLogout={async () => {
          await db.setMeta("session", undefined);
          setToken(null);
          setBoot({ kind: "auth", db });
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

/** Écran de déverrouillage : le code PIN déchiffre la copie locale, sans réseau. */
function PinScreen({ onPin, onForgot }: { onPin: (pin: string) => Promise<boolean>; onForgot: () => Promise<void> }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempts, setAttempts] = useState(0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // Délai croissant après plusieurs erreurs, contre les essais en série.
    if (attempts >= 3) await new Promise((r) => setTimeout(r, Math.min(30, 2 ** (attempts - 2)) * 1000));
    const ok = await onPin(pin);
    setBusy(false);
    if (!ok) {
      setAttempts((a) => a + 1);
      setPin("");
      setError("Code incorrect.");
    }
  }

  async function forgot() {
    if (!confirm("Effacer les données de cet appareil et vous reconnecter ? Vos données sur le serveur sont conservées ; seules les modifications pas encore synchronisées seraient perdues.")) return;
    await onForgot();
  }

  return (
    <div className="auth">
      <form className="card auth-card" onSubmit={submit}>
        <GestiaLogo full />
        <h1>Appareil verrouillé</h1>
        <p className="muted">Saisissez votre code PIN pour ouvrir l'application.</p>
        <label>
          Code PIN
          <input type="password" inputMode="numeric" autoComplete="off" autoFocus required minLength={4} maxLength={12}
            value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy || pin.length < 4}>{busy ? "Vérification…" : "Déverrouiller"}</button>
        <button type="button" className="link small" onClick={forgot}>Code oublié ?</button>
      </form>
    </div>
  );
}

interface Support { name?: string; email?: string; phone?: string }

/** Coordonnées de l'équipe Gestia, mémorisées pour être affichées hors ligne. */
function useSupport(): Support {
  const [support, setSupport] = useState<Support>(() => {
    try { return JSON.parse(localStorage.getItem("support") ?? "{}"); } catch { return {}; }
  });
  useEffect(() => {
    api<{ support?: Support }>("/api/status")
      .then((r) => {
        setSupport(r.support ?? {});
        try { localStorage.setItem("support", JSON.stringify(r.support ?? {})); } catch { /* stockage indisponible */ }
      })
      .catch(() => {});
  }, []);
  return support;
}

function SupportLine({ support, prefix }: { support: Support; prefix: string }) {
  if (!support.email && !support.phone) return null;
  return (
    <p className="muted small">
      {prefix}{" "}
      {support.phone && <a href={`tel:${support.phone.replace(/\s/g, "")}`}>{support.phone}</a>}
      {support.phone && support.email && " · "}
      {support.email && <a href={`mailto:${support.email}`}>{support.email}</a>}
    </p>
  );
}

function AuthScreen({ db, onSession }: { db: LocalDb; onSession: (s: Session) => Promise<void> }) {
  const [mode, setMode] = useState<"login" | "signup">(() => (location.hash === "#inscription" ? "signup" : "login"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const support = useSupport();

  function switchTo(m: "login" | "signup") {
    setMode(m);
    setError(null);
    history.replaceState(null, "", m === "signup" ? "#inscription" : location.pathname);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    if (mode === "signup" && f.password !== f.confirm) {
      setError("Les deux mots de passe ne correspondent pas.");
      return;
    }
    delete f.confirm;
    setBusy(true);
    setError(null);
    try {
      const session = await api<Session>(mode === "signup" ? "/api/signup" : "/api/login", { ...f, deviceId: db.deviceId });
      history.replaceState(null, "", location.pathname);
      await onSession(session);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message.charAt(0).toUpperCase() + err.message.slice(1) + ".");
      else setError("Serveur injoignable : la première connexion sur cet appareil demande internet.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="card auth-card" onSubmit={submit} key={mode}>
        <GestiaLogo full />
        <h1>{mode === "signup" ? "Créer mon entreprise" : "Connexion"}</h1>
        {mode === "signup" ? (
          <>
            <p className="muted">30 jours d'essai gratuit, toutes les fonctions. Vous serez l'administrateur de votre espace.</p>
            <label>Nom de l'entreprise<input name="company" required autoComplete="organization" maxLength={120} /></label>
            <label>Votre nom<input name="name" required autoComplete="name" maxLength={120} /></label>
            <label>Téléphone<input name="phone" type="tel" autoComplete="tel" placeholder="+241 …" maxLength={40} /></label>
          </>
        ) : null}
        <label>E-mail<input name="email" type="email" required autoComplete="email" /></label>
        <label>
          Mot de passe
          <input name="password" type="password" required minLength={8} autoComplete={mode === "signup" ? "new-password" : "current-password"} />
        </label>
        {mode === "signup" && (
          <label>Confirmer le mot de passe<input name="confirm" type="password" required minLength={8} autoComplete="new-password" /></label>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? "Patientez…" : mode === "signup" ? "Démarrer l'essai gratuit" : "Se connecter"}</button>
        {mode === "login" ? (
          <>
            <p className="auth-switch">Nouvelle entreprise ? <button type="button" className="link" onClick={() => switchTo("signup")}>Créer mon entreprise</button></p>
            <details className="small muted">
              <summary>Mot de passe oublié ?</summary>
              <p>Demandez à l'administrateur de votre entreprise de vous donner un mot de passe provisoire (Réglages › Utilisateurs). Si vous êtes l'administrateur, contactez l'équipe Gestia.</p>
              <SupportLine support={support} prefix="Équipe Gestia :" />
            </details>
          </>
        ) : (
          <p className="auth-switch">Déjà un compte ? <button type="button" className="link" onClick={() => switchTo("login")}>Se connecter</button></p>
        )}
      </form>
    </div>
  );
}

/** Mot de passe provisoire : il doit être remplacé avant d'utiliser l'application. */
function ForcePasswordScreen({ session, onDone, onLogout }: { session: Session; onDone: () => Promise<void>; onLogout: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    if (f.next !== f.confirm) return setError("Les deux mots de passe ne correspondent pas.");
    setBusy(true);
    setError(null);
    try {
      setToken(session.token);
      await api("/api/me/password", { current: f.current, next: f.next });
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message.charAt(0).toUpperCase() + err.message.slice(1) + "." : "Connexion internet nécessaire.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="card auth-card" onSubmit={submit}>
        <GestiaLogo full />
        <h1>Choisissez votre mot de passe</h1>
        <p className="muted">Bonjour {session.user.name}, vous vous êtes connecté avec un mot de passe provisoire. Remplacez-le par un mot de passe personnel.</p>
        <label>Mot de passe provisoire<input name="current" type="password" required autoComplete="current-password" /></label>
        <label>Nouveau mot de passe<input name="next" type="password" required minLength={8} autoComplete="new-password" /></label>
        <label>Confirmer<input name="confirm" type="password" required minLength={8} autoComplete="new-password" /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? "Patientez…" : "Enregistrer"}</button>
        <button type="button" className="link small" onClick={onLogout}>Se déconnecter</button>
      </form>
    </div>
  );
}

function Shell({ db, session, onLogout }: { db: LocalDb; session: Session; onLogout: (wipe: boolean) => Promise<void> }) {
  const sync = useMemo(() => new SyncEngine(db), [db]);
  const tabs: Tab[] = [...(TABS_BY_ROLE[session.user.role] ?? ["expenses"]), ...(session.user.platformAdmin ? (["platform"] as Tab[]) : [])];
  const [tab, setTab] = useState<Tab>(() => {
    const saved = (() => { try { return localStorage.getItem("tab") as Tab | null; } catch { return null; } })();
    return saved && tabs.includes(saved) ? saved : tabs[0];
  });
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    sync.start();
    return () => sync.stop();
  }, [sync]);

  // Avec un code PIN : verrouillage après une période sans activité.
  useEffect(() => {
    let last = Date.now();
    let minutes = 0;
    let alive = true;
    (async () => {
      if (!(await db.isProtected())) return;
      minutes = Number((await db.getMeta<number>("lock_minutes")) ?? 10);
    })();
    const touch = () => { last = Date.now(); };
    const events = ["pointerdown", "keydown", "scroll"];
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const timer = setInterval(() => {
      if (alive && minutes > 0 && Date.now() - last > minutes * 60_000) location.reload();
    }, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
      events.forEach((e) => window.removeEventListener(e, touch));
    };
  }, [db]);

  const go = (t: Tab, id?: string) => {
    setTab(t);
    setOpen(id ?? null);
    try { localStorage.setItem("tab", t); } catch { /* stockage indisponible */ }
    window.scrollTo(0, 0);
  };

  const logout = async () => {
    const pending = await db.pendingCount();
    if (pending > 0 && !confirm(`${pending} modification(s) pas encore envoyée(s). Se déconnecter quand même ? Elles resteront sur cet appareil.`)) return;
    sync.stop();
    await onLogout(false);
  };

  return (
    <Ctx.Provider value={{ db, sync, session, logout, go }}>
      <div className="app">
        <header className="topbar">
          <CompanyBrand fallback={session.company.name} />
          <SyncPill onAuthLost={(revoked) => { sync.stop(); onLogout(revoked); }} />
          <div className="user">
            <span className="user-name">{session.user.name}</span>
            <span className="muted small">{ROLE_LABELS[session.user.role] ?? session.user.role}</span>
            <InstallButton />
            <button className="ghost small" onClick={logout}>Déconnexion</button>
          </div>
        </header>
        <nav className="tabs" aria-label="Sections">
          {tabs.map((t) => (
            <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => go(t)} aria-current={tab === t}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
        <SubscriptionBanner />
        <main className="content">
          {tab === "dashboard" && <Dashboard />}
          {(tab === "quotes" || tab === "invoices" || tab === "credit_notes") && (
            <Documents key={tab} kind={tab} open={open} setOpen={setOpen} />
          )}
          {tab === "expenses" && <Expenses />}
          {tab === "clients" && <Clients />}
          {tab === "articles" && <Articles />}
          {tab === "projects" && <Projects />}
          {tab === "accounting" && <Accounting />}
          {tab === "settings" && <Settings />}
          {tab === "platform" && session.user.platformAdmin && <Platform />}
        </main>
        <RejectedNotice />
      </div>
    </Ctx.Provider>
  );
}

/** Logo Gestia, en version claire ou sombre selon le thème de l'appareil. */
function GestiaLogo({ full = false }: { full?: boolean }) {
  const base = full ? "gestia-logo" : "gestia-logo-sans-slogan";
  const cls = full ? "auth-logo" : "gestia-logo";
  return (
    <>
      <img src={`/brand/${base}.png`} alt="Gestia" className={`${cls} light`} />
      <img src={`/brand/${base}-blanc.png`} alt="Gestia" className={`${cls} dark`} />
    </>
  );
}

/** Gestia, puis le nom (ou le logo) de l'entreprise cliente tels que définis dans les réglages. */
function CompanyBrand({ fallback }: { fallback: string }) {
  const s = useSettings();
  const logo = typeof s.logo === "string" && s.logo ? s.logo : null;
  return (
    <div className="brand">
      <GestiaLogo />
      <span className="brand-sep" aria-hidden="true" />
      <span className="company">
        {logo && <img src={logo} alt="" className="brand-logo" />}
        <span>{text(s.name) || fallback}</span>
      </span>
    </div>
  );
}

function SyncPill({ onAuthLost }: { onAuthLost: (revoked: boolean) => void }) {
  const { sync } = useApp();
  const s = useSyncStatus();
  useEffect(() => {
    // Compte désactivé ou appareil révoqué : les données locales sont effacées.
    if (s.state === "auth") onAuthLost(/révoqué/.test(s.message ?? ""));
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

/** Installer Gestia sur l'écran d'accueil (téléphone ou ordinateur). */
function InstallButton() {
  const { available, install, iosHint } = useInstall();
  const [hint, setHint] = useState(false);
  if (!available) return null;
  return (
    <>
      <button className="ghost small" onClick={() => (iosHint ? setHint((h) => !h) : install())}>Installer</button>
      {hint && (
        <div className="toast" role="status">
          <strong>Installer Gestia sur l'iPhone</strong>
          <p className="muted">Dans Safari, touchez le bouton Partager puis « Sur l'écran d'accueil ».</p>
          <button className="ghost small" onClick={() => setHint(false)}>Fermer</button>
        </div>
      )}
    </>
  );
}

/** Bandeau d'abonnement : fin d'essai proche, retard de paiement, consultation seule. */
function SubscriptionBanner() {
  const { session } = useApp();
  const s = useSyncStatus();
  const support = useSupport();
  const sub = s.subscription ?? session.company.subscription;
  const [closed, setClosed] = useState(false);
  if (!sub || closed) return null;
  let tone = "info";
  let msg: string | null = null;
  const days = sub.daysLeft ?? 0;
  if (sub.state === "suspended") {
    tone = "danger";
    msg = "Le compte de votre entreprise est suspendu. Vos données sont conservées : contactez l'équipe Gestia pour le rétablir.";
  } else if (sub.state === "expired") {
    tone = "danger";
    msg = `Votre abonnement a pris fin le ${formatDate(sub.endsAt)}. Gestia est en consultation seule : vos nouvelles saisies restent sur cet appareil et seront envoyées dès le renouvellement.`;
  } else if (sub.state === "grace") {
    tone = "warn";
    msg = `Votre ${sub.plan === "trial" ? "essai" : "abonnement"} a pris fin le ${formatDate(sub.endsAt)}. Il vous reste ${GRACE_DAYS + days} jour(s) avant le passage en consultation seule.`;
  } else if (sub.state === "trial" && sub.daysLeft !== null && days <= 7) {
    tone = "info";
    msg = days === 0 ? "Votre essai gratuit se termine aujourd'hui." : `Votre essai gratuit se termine dans ${days} jour(s) (le ${formatDate(sub.endsAt)}).`;
  } else if (sub.state === "active" && sub.daysLeft !== null && days <= 7) {
    tone = "info";
    msg = `Votre abonnement ${sub.planLabel} arrive à échéance le ${formatDate(sub.endsAt)}.`;
  }
  if (!msg) return null;
  return (
    <div className={`banner ${tone}`} role="status" data-testid="subscription-banner">
      <div>
        <p>{msg}</p>
        <SupportLine support={support} prefix={sub.state === "trial" || sub.state === "active" ? "Pour vous abonner :" : "Contact :"} />
      </div>
      {!sub.readOnly && <button className="ghost small" onClick={() => setClosed(true)} aria-label="Fermer">×</button>}
    </div>
  );
}
