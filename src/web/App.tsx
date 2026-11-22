import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { preloadPdf } from "./pdfActions.ts";
import { LocalDb } from "./local/db.ts";
import { SyncEngine } from "./local/sync.ts";
import { api, ApiError, setToken } from "./api.ts";
import { COMING_SOON, Ctx, ROLE_LABELS, TAB_LABELS, TABS_BY_ROLE, text, useApp, useSettings, useSyncStatus, type Session, type Tab } from "./context.ts";
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
        <p className="auth-tagline">Le système de gestion de votre entreprise</p>
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
        <ul className="auth-points" aria-label="Points forts">
          <li>Devis, factures et relances en quelques clics</li>
          <li>Fonctionne même sans connexion</li>
          <li>Envoi par WhatsApp et e-mail</li>
        </ul>
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
  const allowed: Tab[] = [...(TABS_BY_ROLE[session.user.role] ?? ["expenses"]), ...(session.user.platformAdmin ? (["platform"] as Tab[]) : [])];
  // Modules finalisés d'abord, puis ceux qui arrivent (pastille « Bientôt »).
  const ready = allowed.filter((t) => !COMING_SOON[t]);
  const soon = allowed.filter((t) => COMING_SOON[t]);
  const tabs: Tab[] = [...ready, ...soon];
  const [tab, setTab] = useState<Tab>(() => {
    const saved = (() => { try { return localStorage.getItem("tab") as Tab | null; } catch { return null; } })();
    return saved && ready.includes(saved) ? saved : (ready[0] ?? tabs[0]);
  });
  const [open, setOpen] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // Menu latéral replié en icônes (ordinateur) : choix mémorisé sur l'appareil.
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem("gestia:menu-replie") === "1"; } catch { return false; } });
  const toggleMenu = () => setCollapsed((c) => {
    try { localStorage.setItem("gestia:menu-replie", c ? "0" : "1"); } catch { /* stockage indisponible */ }
    return !c;
  });
  const moreBtn = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const closeMore = () => { setMoreOpen(false); moreBtn.current?.focus(); };
  // Feuille « Plus » : le focus entre dans la feuille à l'ouverture.
  useEffect(() => {
    if (moreOpen) sheet.current?.querySelector<HTMLElement>(".nav-item")?.focus();
  }, [moreOpen]);
  const groups = navGroups(ready, soon);
  // Téléphone : quatre raccourcis en bas d'écran, le reste dans « Plus ».
  const mobileMain = MOBILE_MAIN.filter((t) => ready.includes(t)).slice(0, 4);
  const mobileMore = tabs.filter((t) => !mobileMain.includes(t));

  useEffect(() => {
    sync.start();
    // Générateur de PDF chargé en tâche de fond : disponible ensuite sans réseau.
    preloadPdf();
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
      <div className={`app${collapsed ? " side-collapsed" : ""}`}>
        <aside className="sidebar">
          <div className="side-brand">
            <GestiaLogo />
            <img src="/brand/gestia-icone.png" alt="Gestia" className="gestia-mark side-mark" width={298} height={309} />
            <CompanyName fallback={session.company.name} />
          </div>
          <nav className="side-nav" aria-label="Sections">
            {groups.map((g) => (
              <div className="nav-group" key={g.label}>
                {g.label && <div className="nav-group-label" id={`grp-${g.key}`}>{g.label}</div>}
                <ul aria-labelledby={g.label ? `grp-${g.key}` : undefined}>
                  {g.tabs.map((t) => (
                    <li key={t}><NavItem tab={t} active={tab === t} onClick={() => go(t)} tip={collapsed} /></li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <div className="side-foot">
            <button className="nav-item collapse-btn" onClick={toggleMenu} aria-expanded={!collapsed} title={collapsed ? "Agrandir le menu" : undefined}>
              <Icon name={collapsed ? "expand" : "collapse"} />
              <span className="nav-label">{collapsed ? "Agrandir le menu" : "Réduire le menu"}</span>
            </button>
            <InstallButton />
            <SyncPill onAuthLost={(revoked) => { sync.stop(); onLogout(revoked); }} />
            <div className="user-id">
              <span className="avatar" aria-hidden="true">{initials(session.user.name)}</span>
              <span className="user-text">
                <span className="user-name">{session.user.name}</span>
                <span className="user-role">{ROLE_LABELS[session.user.role] ?? session.user.role}</span>
              </span>
              <button className="icon" onClick={logout} title="Se déconnecter" aria-label="Se déconnecter">
                <Icon name="logout" />
              </button>
            </div>
          </div>
        </aside>

        <header className="mobile-head">
          <img src="/brand/gestia-icone.png" alt="Gestia" className="gestia-mark" width={298} height={309} />
          <CompanyName fallback={session.company.name} />
          <SyncDot />
        </header>
        <nav className="bottom-nav" aria-label="Sections">
          {mobileMain.map((t) => (
            <NavItem key={t} tab={t} active={tab === t && !moreOpen} onClick={() => { setMoreOpen(false); go(t); }} short />
          ))}
          {mobileMore.length > 0 && (
            <button ref={moreBtn} className={moreOpen || (mobileMore.includes(tab)) ? "nav-item active" : "nav-item"} aria-expanded={moreOpen} aria-controls="more-sheet" onClick={() => setMoreOpen((o) => !o)}>
              <Icon name="more" /><span className="nav-label">Plus</span>
            </button>
          )}
        </nav>
          {moreOpen && (
            <div className="more-sheet" id="more-sheet" role="dialog" aria-modal="true" aria-labelledby="more-title" ref={sheet}
              onKeyDown={(e) => { if (e.key === "Escape") closeMore(); }}>
              <div className="sheet-grip" aria-hidden="true" />
              <div className="sheet-head">
                <h2 id="more-title">Plus</h2>
                <button className="icon" onClick={closeMore} aria-label="Fermer"><Icon name="close" /></button>
              </div>
              <nav aria-label="Autres sections">
              {groups.map((g) => {
                const items = g.tabs.filter((t) => mobileMore.includes(t));
                if (items.length === 0) return null;
                return (
                  <div className="nav-group" key={g.label}>
                    {g.label && <div className="nav-group-label">{g.label}</div>}
                    {items.map((t) => <NavItem key={t} tab={t} active={tab === t} onClick={() => { setMoreOpen(false); go(t); }} />)}
                  </div>
                );
              })}
              </nav>
              <div className="user-id">
                <span className="avatar" aria-hidden="true">{initials(session.user.name)}</span>
                <span className="user-text">
                  <span className="user-name">{session.user.name}</span>
                  <span className="user-role">{ROLE_LABELS[session.user.role] ?? session.user.role}</span>
                </span>
                <button className="ghost small" onClick={logout}>Se déconnecter</button>
              </div>
            </div>
          )}
        {moreOpen && <div className="sheet-backdrop" onClick={closeMore} aria-hidden="true" />}

        <div className="main" inert={moreOpen || undefined}>
        <SubscriptionBanner />
        <main className="content">
          {/* L'ancien onglet « Gains » fait désormais partie du tableau de bord. */}
          {(tab === "dashboard" || tab === "gains") && <Dashboard />}
          {(tab === "quotes" || tab === "invoices" || tab === "credit_notes") && (
            <Documents key={tab} kind={tab} open={open} setOpen={setOpen} />
          )}
          {COMING_SOON[tab] && <ComingSoon tab={tab} onBack={() => go(ready[0] ?? "settings")} />}
          {tab === "expenses" && !COMING_SOON.expenses && <Expenses />}
          {tab === "clients" && <Clients />}
          {tab === "articles" && <Articles />}
          {tab === "projects" && !COMING_SOON.projects && <Projects />}
          {tab === "accounting" && !COMING_SOON.accounting && <Accounting />}
          {tab === "settings" && <Settings />}
          {tab === "platform" && session.user.platformAdmin && <Platform />}
        </main>
        </div>
        <RejectedNotice />
      </div>
    </Ctx.Provider>
  );
}

/** Initiales pour l'avatar : « Jimmy Rerambyha » → « JR ». */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

/** Page d'attente d'un module pas encore ouvert. */
function ComingSoon({ tab, onBack }: { tab: Tab; onBack: () => void }) {
  const info = COMING_SOON[tab]!;
  return (
    <section className="card coming-soon" data-testid="coming-soon">
      <div className="coming-soon-ico" aria-hidden="true"><Icon name={TAB_ICONS[tab]} /></div>
      <span className="soon-badge"><Icon name="clock" /> Bientôt disponible</span>
      <h2>{info.title}</h2>
      <p>Ce module est en cours de finalisation et arrivera dans une prochaine version de Gestia. Voici ce qu'il vous permettra de faire :</p>
      <ul>{info.points.map((p) => <li key={p}>{p}</li>)}</ul>
      <div><button className="primary" onClick={onBack}>Retour au tableau de bord</button></div>
    </section>
  );
}

/** Logo Gestia, en version claire ou sombre selon le thème de l'appareil. */
function GestiaLogo({ full = false }: { full?: boolean }) {
  // Logo sans slogan partout : le slogan devient illisible sous 300 px de large.
  // Hauteur fixe en CSS, largeur proportionnelle (700 × 172).
  return <img src="/brand/gestia-logo-sans-slogan.png" alt="Gestia" className={full ? "auth-logo" : "gestia-logo"} width={700} height={172} />;
}

/** Nom (ou logo) de l'entreprise cliente tel que défini dans les réglages. */
function CompanyName({ fallback }: { fallback: string }) {
  const s = useSettings();
  const logo = typeof s.logo === "string" && s.logo ? s.logo : null;
  const name = text(s.name) || fallback;
  return (
    <span className="company" title={name}>
      {logo ? <img src={logo} alt="" className="brand-logo" /> : <span className="company-mark" aria-hidden="true">{name.replace(/[^A-Za-zÀ-ÿ0-9]/g, "").slice(0, 2).toUpperCase()}</span>}
      <span>{name}</span>
    </span>
  );
}

/** Ordre des raccourcis en bas d'écran sur téléphone. */
const MOBILE_MAIN: Tab[] = ["dashboard", "invoices", "quotes", "clients", "projects", "expenses"];

type NavGroup = { key: string; label: string | null; tabs: Tab[] };

/** Menu groupé par usage : accueil, ventes, fichiers, modules à venir, puis administration. */
function navGroups(ready: Tab[], soon: Tab[]): NavGroup[] {
  const pick = (list: Tab[]) => list.filter((t) => ready.includes(t));
  const used = new Set<Tab>(["dashboard", "gains", "quotes", "invoices", "credit_notes", "clients", "articles", "settings", "platform"]);
  const groups: NavGroup[] = [
    { key: "home", label: null, tabs: pick(["dashboard"]) },
    { key: "sales", label: "Ventes", tabs: pick(["quotes", "invoices", "credit_notes"]) },
    { key: "files", label: "Répertoire", tabs: pick(["clients", "articles"]) },
    { key: "other", label: "Gestion", tabs: ready.filter((t) => !used.has(t)) },
    { key: "soon", label: "Bientôt disponible", tabs: soon },
    { key: "admin", label: "Administration", tabs: pick(["settings", "platform"]) },
  ];
  return groups.filter((g) => g.tabs.length > 0);
}

const TAB_ICONS: Record<Tab, IconName> = {
  dashboard: "home", gains: "chart", quotes: "quote", invoices: "invoice", credit_notes: "credit", expenses: "wallet",
  clients: "users", articles: "box", projects: "folder", accounting: "ledger", settings: "gear", platform: "shield",
};

/** Lien du menu. Un module pas encore ouvert est grisé et porte la mention « Bientôt ». */
function NavItem({ tab, active, onClick, short = false, tip = false }: { tab: Tab; active: boolean; onClick: () => void; short?: boolean; tip?: boolean }) {
  const soon = Boolean(COMING_SOON[tab]);
  const label = short && tab === "dashboard" ? "Accueil" : TAB_LABELS[tab];
  return (
    <button
      className={`nav-item${active ? " active" : ""}${soon ? " soon" : ""}`}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      title={tip ? `${TAB_LABELS[tab]}${soon ? " (bientôt disponible)" : ""}` : soon ? "Bientôt disponible" : undefined}
    >
      <Icon name={TAB_ICONS[tab]} />
      <span className="nav-label">{label}</span>
      {soon && <span className="soon-badge">Bientôt</span>}
    </button>
  );
}

type IconName = "home" | "quote" | "invoice" | "credit" | "wallet" | "users" | "box" | "folder" | "ledger" | "gear" | "shield" | "logout" | "more" | "close" | "clock" | "chart" | "collapse" | "expand";
const ICON_PATHS: Record<IconName, string[]> = {
  home: ["M3 10.5 12 3l9 7.5", "M5 9.5V20h14V9.5", "M10 20v-6h4v6"],
  quote: ["M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z", "M14 3v5h5", "M8.5 13h7", "M8.5 17h4"],
  invoice: ["M6 3h12v18l-3-2-3 2-3-2-3 2z", "M9 8h6", "M9 12h6", "M9 16h3"],
  credit: ["M6 3h12v18l-3-2-3 2-3-2-3 2z", "M9 12h6"],
  wallet: ["M4 7h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2h11", "M16 13.5h.01"],
  users: ["M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M2 21a7 7 0 0 1 14 0", "M16 3.5a4 4 0 0 1 0 7", "M19 14.5a7 7 0 0 1 3 6.5"],
  box: ["M21 8 12 3 3 8v8l9 5 9-5z", "M3 8l9 5 9-5", "M12 13v8"],
  folder: ["M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"],
  ledger: ["M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z", "M5 17a3 3 0 0 1 3-3h11", "M9 8h6"],
  gear: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"],
  shield: ["M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"],
  logout: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"],
  more: ["M4 6h16", "M4 12h16", "M4 18h16"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  collapse: ["M4 4h16v16H4z", "M9 4v16", "M16 10l-2 2 2 2"],
  expand: ["M4 4h16v16H4z", "M9 4v16", "M14 10l2 2-2 2"],
  chart: ["M4 20V10", "M10 20V4", "M16 20v-7", "M22 20H2"],
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

/** Version compacte de l'état de synchronisation, pour l'en-tête du téléphone. */
function SyncDot() {
  const { sync } = useApp();
  const s = useSyncStatus();
  const { label, tone } = syncLabel(s);
  return (
    <button className={`sync-dot ${tone}`} onClick={() => sync.syncNow()} title={label} aria-label={label}>
      <span className="dot" aria-hidden="true" />
      <span className="sync-text">{s.state === "offline" ? "Hors ligne" : s.state === "syncing" ? "Envoi…" : s.pending > 0 ? `${s.pending} à envoyer` : "À jour"}</span>
    </button>
  );
}

/** Libellé et couleur de l'état de synchronisation. Des envois en attente sont normaux : ton neutre, pas d'alerte. */
function syncLabel(s: ReturnType<typeof useSyncStatus>): { label: string; tone: string } {
  if (s.state === "syncing") return { label: "Synchronisation…", tone: "info" };
  if (s.state === "offline") return { label: s.pending > 0 ? `Hors ligne · ${s.pending} à envoyer` : "Hors ligne", tone: "muted" };
  if (s.state === "error") return { label: s.message ?? "Synchronisation impossible", tone: "warn" };
  if (s.pending > 0) return { label: `${s.pending} ${s.pending > 1 ? "modifications" : "modification"} à envoyer`, tone: "info" };
  return { label: "À jour", tone: "ok" };
}

function SyncPill({ onAuthLost }: { onAuthLost: (revoked: boolean) => void }) {
  const { sync } = useApp();
  const s = useSyncStatus();
  useEffect(() => {
    // Compte désactivé ou appareil révoqué : les données locales sont effacées.
    if (s.state === "auth") onAuthLost(/révoqué/.test(s.message ?? ""));
  }, [s.state]);
  const { label, tone } = syncLabel(s);
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
      {!sub.readOnly && <button className="icon" onClick={() => setClosed(true)} aria-label="Fermer le bandeau"><Icon name="close" /></button>}
    </div>
  );
}
