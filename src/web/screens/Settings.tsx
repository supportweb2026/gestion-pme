import { useEffect, useState, type FormEvent } from "react";
import { can, COMING_SOON, ROLE_LABELS, TAB_LABELS, text, useApp, useSettings, useSyncStatus, type Tab } from "../context.ts";
import { api, ApiError, getToken } from "../api.ts";
import { reconcileTeam } from "./team.ts";
import { formatDate, SubscriptionBadge } from "../subscription.tsx";
import { PLANS } from "../../shared/plans.ts";
import { DEFAULT_PAYMENT_DAYS } from "../../shared/invoice.ts";
import { CURRENCIES, rateFor } from "../../shared/currency.ts";
import { DEFAULT_REMINDER_STEPS, reminderSettings, stepLabel } from "../../shared/reminders.ts";
import { DEFAULT_VAT_RATES, fiscalSettings, type WithholdingPreset } from "../../shared/taxes.ts";
import { DOC_COLORS, docColor, softOf, tooLight } from "../../shared/branding.ts";
import qrcode from "qrcode-generator";

const COMPANY_FIELDS: { name: string; label: string; placeholder?: string; wide?: boolean }[] = [
  { name: "name", label: "Raison sociale" },
  { name: "legal_form", label: "Forme juridique", placeholder: "SARL, SA, SAS, EI…" },
  { name: "capital", label: "Capital", placeholder: "1 000 000 FCFA" },
  { name: "nif", label: "NIF" },
  { name: "rccm", label: "RCCM" },
  { name: "phone", label: "Téléphone" },
  { name: "email", label: "E-mail" },
  { name: "address", label: "Adresse" },
  { name: "city", label: "Ville", placeholder: "Libreville" },
  { name: "bank", label: "Coordonnées bancaires", placeholder: "Banque, IBAN / RIB", wide: true },
  { name: "mobile_money", label: "Mobile money", placeholder: "Airtel Money 0xx xx xx xx", wide: true },
  { name: "footer", label: "Mention de bas de page", placeholder: "Conditions de paiement, pénalités de retard…", wide: true },
];

/** Réduit le logo à 320 px de large pour qu'il reste léger à synchroniser. */
async function resizeLogo(file: File, maxW = 320, maxH = 160): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("image illisible"));
      i.src = url;
    });
    const scale = Math.min(1, maxW / img.width, maxH / img.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function Settings() {
  const { session } = useApp();
  return (
    <section>
      <div className="section-head"><h2>Réglages</h2></div>
      <MyAccount />
      <DeviceSecurity />
      {can.manageCompany(session.user.role) && <SubscriptionCard />}
      {can.manageCompany(session.user.role) && <CompanySettings />}
      {can.manageCompany(session.user.role) && <DocumentLookCard />}
      {can.manageCompany(session.user.role) && <FiscalSettingsCard />}
      {can.manageCompany(session.user.role) && <RemindersCard />}
      {can.manageCompany(session.user.role) && <TargetCard />}
      {can.manageCompany(session.user.role) && <CurrencySettings />}
      {can.manageUsers(session.user.role) && <Users />}
      {can.manageCompany(session.user.role) && <DataExport />}
    </section>
  );
}

const sentence = (m: string) => m.charAt(0).toUpperCase() + m.slice(1) + ".";

/** Changement de son propre mot de passe (tous les rôles). */
function MyAccount() {
  const { session } = useApp();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    if (f.next !== f.confirm) return setMsg({ ok: false, text: "Les deux mots de passe ne correspondent pas." });
    setBusy(true);
    try {
      await api("/api/me/password", { current: f.current, next: f.next });
      form.reset();
      setOpen(false);
      setMsg({ ok: true, text: "Mot de passe modifié." });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? sentence(err.message) : "Connexion internet nécessaire." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card section-card">
      <div className="section-head">
        <h3>Mon compte</h3>
        <button onClick={() => { setOpen((o) => !o); setMsg(null); }}>{open ? "Annuler" : "Changer mon mot de passe"}</button>
      </div>
      <p className="muted">{session.user.name} · {session.user.email} · {ROLE_LABELS[session.user.role] ?? session.user.role}</p>
      {open && (
        <form className="form-grid" onSubmit={submit}>
          <label>Mot de passe actuel<input name="current" type="password" required autoComplete="current-password" /></label>
          <label>Nouveau mot de passe<input name="next" type="password" required minLength={8} autoComplete="new-password" /></label>
          <label>Confirmer<input name="confirm" type="password" required minLength={8} autoComplete="new-password" /></label>
          <div className="form-actions"><button className="primary" disabled={busy}>Enregistrer</button></div>
        </form>
      )}
      {msg && <p className={msg.ok ? "success" : "error"} role="status">{msg.text}</p>}
      <TwoFactor />
    </div>
  );
}

/** QR code (SVG) d'un lien otpauth://, lu par l'application d'authentification. */
function QrCode({ value }: { value: string }) {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  const cells: string[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) cells.push(`M${c + 4} ${r + 4}h1v1h-1z`);
  return (
    <svg className="qr" viewBox={`0 0 ${n + 8} ${n + 8}`} role="img" aria-label="QR code à scanner avec l'application d'authentification" shapeRendering="crispEdges">
      <rect width={n + 8} height={n + 8} fill="#fff" />
      <path d={cells.join("")} fill="#101D36" />
    </svg>
  );
}

/**
 * Double authentification du compte : après le mot de passe, un code à 6 chiffres
 * de Google Authenticator, Microsoft Authenticator… Codes de secours montrés une fois.
 */
function TwoFactor() {
  const [state, setState] = useState<{ enabled: boolean; recoveryLeft: number } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<{ enabled: boolean; recoveryLeft: number }>("/api/me/2fa").then(setState).catch(() => setState(null));
  useEffect(() => { load(); }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) {
      setError(err instanceof ApiError ? sentence(err.message) : "Connexion internet nécessaire.");
    } finally { setBusy(false); }
  };

  if (!state) return null;
  return (
    <div className="two-factor" data-testid="two-factor">
      <div className="section-head">
        <div>
          <h4>Double authentification</h4>
          <p className="muted small">{state.enabled
            ? `Active : un code de l'application est demandé à chaque connexion. ${state.recoveryLeft} code${state.recoveryLeft > 1 ? "s" : ""} de secours restant${state.recoveryLeft > 1 ? "s" : ""}.`
            : "Protège votre compte même si votre mot de passe est découvert : un code à 6 chiffres de votre téléphone est demandé à la connexion."}</p>
        </div>
        {state.enabled ? (
          !disabling && <button className="ghost" onClick={() => { setDisabling(true); setCodes(null); }}>Désactiver</button>
        ) : !setup && (
          <button className="primary" disabled={busy} onClick={() => run(async () => setSetup(await api("/api/me/2fa/setup", {})))}>Activer</button>
        )}
      </div>

      {setup && !state.enabled && (
        <form className="two-factor-setup" onSubmit={(e) => {
          e.preventDefault();
          const code = String(new FormData(e.currentTarget).get("code") ?? "");
          run(async () => {
            const r = await api<{ recoveryCodes: string[] }>("/api/me/2fa/enable", { code });
            setCodes(r.recoveryCodes);
            setSetup(null);
            await load();
          });
        }}>
          <QrCode value={setup.uri} />
          <ol className="steps">
            <li>Installez une application d'authentification (Google Authenticator, Microsoft Authenticator…).</li>
            <li>Scannez ce QR code, ou saisissez la clé <code className="mono" data-testid="totp-secret">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>.</li>
            <li>Saisissez le code à 6 chiffres affiché.</li>
          </ol>
          <label>Code à 6 chiffres<input name="code" inputMode="numeric" autoComplete="one-time-code" required maxLength={7} /></label>
          <div className="form-actions">
            <button type="button" className="ghost" onClick={() => setSetup(null)}>Annuler</button>
            <button className="primary" disabled={busy}>Confirmer et activer</button>
          </div>
        </form>
      )}

      {codes && (
        <div className="recovery-codes" role="status">
          <p><b>Double authentification activée.</b> Gardez ces codes de secours en lieu sûr : chacun permet une connexion sans le téléphone. Ils ne seront plus affichés.</p>
          <ul className="mono" data-testid="recovery-codes">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
          <div className="form-actions">
            <button type="button" onClick={() => {
              const blob = new Blob([`Codes de secours Gestia\n\n${codes.join("\n")}\n`], { type: "text/plain" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = "gestia-codes-de-secours.txt";
              a.click();
              URL.revokeObjectURL(a.href);
            }}>Télécharger les codes</button>
            <button type="button" className="primary" onClick={() => setCodes(null)}>J'ai noté les codes</button>
          </div>
        </div>
      )}

      {disabling && state.enabled && (
        <form className="form-grid" onSubmit={(e) => {
          e.preventDefault();
          const password = String(new FormData(e.currentTarget).get("password") ?? "");
          run(async () => {
            await api("/api/me/2fa/disable", { password });
            setDisabling(false);
            await load();
          });
        }}>
          <label>Votre mot de passe<input name="password" type="password" required autoComplete="current-password" /></label>
          <div className="form-actions">
            <button type="button" className="ghost" onClick={() => setDisabling(false)}>Annuler</button>
            <button className="danger" disabled={busy}>Désactiver la double authentification</button>
          </div>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

/** Formule, échéance et contact pour s'abonner. */
function SubscriptionCard() {
  const { session } = useApp();
  const sync = useSyncStatus();
  const sub = sync.subscription ?? session.company.subscription;
  if (!sub) return null;
  return (
    <div className="card section-card">
      <div className="section-head"><h3>Abonnement</h3><SubscriptionBadge sub={sub} /></div>
      <p>
        Formule <strong>{sub.planLabel}</strong>
        {sub.endsAt && <> · {sub.plan === "trial" ? "essai jusqu'au" : "payé jusqu'au"} <strong>{formatDate(sub.endsAt)}</strong></>}
        {" "}· jusqu'à {sub.maxUsers >= 1000 ? "un nombre illimité d'" : `${sub.maxUsers} `}utilisateurs actifs
      </p>
      <ul className="muted small plan-list">
        {Object.entries(PLANS).filter(([k]) => k !== "trial").map(([k, p]) => (
          <li key={k}><strong>{p.label}</strong> : {p.description}</li>
        ))}
      </ul>
      {Object.keys(COMING_SOON).length > 0 && (
        <p className="muted small">Bientôt disponibles : {(Object.keys(COMING_SOON) as Tab[]).map((t) => TAB_LABELS[t].toLowerCase()).join(", ")}.</p>
      )}
      <p className="muted small">Pour vous abonner ou changer de formule, contactez l'équipe Gestia ; le paiement (virement, mobile money) est enregistré par elle et prend effet à la synchronisation suivante.</p>
    </div>
  );
}

/** Export complet des données : sauvegarde personnelle ou départ vers un autre outil. */
function DataExport() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function download() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/export", { headers: { authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `erreur ${res.status}`);
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "gestia-export.json";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (err) {
      setError(err instanceof ApiError ? sentence(err.message) : "Connexion internet nécessaire pour l'export.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card section-card">
      <div className="section-head">
        <h3>Sauvegarde des données</h3>
        <button onClick={download} disabled={busy}>{busy ? "Préparation…" : "Exporter toutes les données"}</button>
      </div>
      <p className="muted small">Fichier JSON contenant clients, articles, documents, paiements, dépenses, projets et réglages de l'entreprise (sans mots de passe ni justificatifs). Vos données vous appartiennent : conservez une copie régulièrement.</p>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function CompanySettings() {
  const { db } = useApp();
  const s = useSettings();
  const [saved, setSaved] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries([...new FormData(e.currentTarget)].map(([k, v]) => [k, String(v).trim()]));
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f)) {
      const value = k === "payment_days" ? Number(v) || DEFAULT_PAYMENT_DAYS : v;
      if ((s[k] ?? "") !== value) patch[k] = value;
    }
    if (Object.keys(patch).length) await db.write("settings", "company", patch);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  async function onLogo(file: File | undefined) {
    setLogoError(null);
    if (!file) return;
    try {
      await db.write("settings", "company", { logo: await resizeLogo(file) });
    } catch {
      setLogoError("Image illisible : utilisez un PNG ou un JPEG.");
    }
  }

  return (
    <form className="card section-card" onSubmit={save}>
      <h3>Entreprise</h3>
      <p className="muted small">Ces informations apparaissent sur vos devis, factures et avoirs.</p>
      <div className="logo-row">
        {typeof s.logo === "string" && s.logo ? <img src={s.logo} alt="Logo actuel" className="logo-preview" /> : <div className="logo-preview empty-logo">Logo</div>}
        <label className="button">
          Choisir un logo
          <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => onLogo(e.target.files?.[0])} />
        </label>
        {typeof s.logo === "string" && s.logo && <button type="button" className="ghost" onClick={() => db.write("settings", "company", { logo: "" })}>Retirer</button>}
        {logoError && <span className="error">{logoError}</span>}
      </div>
      <div className="form-grid">
        {COMPANY_FIELDS.map((f) => (
          <label key={f.name} className={f.wide ? "wide" : ""}>
            {f.label}
            <input name={f.name} defaultValue={text(s[f.name])} placeholder={f.placeholder} />
          </label>
        ))}
        <label>
          Délai de paiement (jours)
          <input name="payment_days" type="number" min="0" defaultValue={text(s.payment_days ?? DEFAULT_PAYMENT_DAYS)} />
        </label>
      </div>
      <div className="form-actions">
        {saved && <span className="ok-text">Enregistré</span>}
        <button className="primary">Enregistrer</button>
      </div>
    </form>
  );
}

/** Code PIN de l'appareil : chiffre la copie locale et verrouille après inactivité. */
function DeviceSecurity() {
  const { db } = useApp();
  const [protectedDevice, setProtected] = useState<boolean | null>(null);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [minutes, setMinutes] = useState(10);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    db.isProtected().then(setProtected);
    db.getMeta<number>("lock_minutes").then((m) => m !== undefined && setMinutes(m));
  }, [db]);

  async function enable(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    if (!/^\d{4,12}$/.test(pin)) return setMessage("Le code doit contenir 4 à 12 chiffres.");
    if (pin !== confirmPin) return setMessage("Les deux codes ne correspondent pas.");
    setBusy(true);
    try {
      await db.enablePin(pin);
      await db.setMeta("lock_minutes", minutes);
      setProtected(true);
      setPin("");
      setConfirmPin("");
      setMessage("Code PIN activé : les données de cet appareil sont chiffrées.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Activation impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!confirm("Retirer le code PIN ? Les données de cet appareil ne seront plus chiffrées.")) return;
    setBusy(true);
    await db.disablePin();
    setBusy(false);
    setProtected(false);
    setMessage("Code PIN retiré.");
  }

  return (
    <div className="card section-card">
      <h3>Sécurité de cet appareil</h3>
      <p className="muted small">
        Un code PIN chiffre toutes les données gardées sur cet appareil (factures, clients, justificatifs, session) et
        verrouille l'application après une période d'inactivité. Il fonctionne hors ligne et ne quitte jamais l'appareil.
        Recommandé sur les téléphones et les ordinateurs partagés.
      </p>
      {protectedDevice === null ? null : protectedDevice ? (
        <div className="form-actions">
          <label className="inline">
            Verrouiller après
            <select value={minutes} onChange={async (e) => { const m = Number(e.target.value); setMinutes(m); await db.setMeta("lock_minutes", m); }}>
              {[2, 5, 10, 30, 60].map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </label>
          <button className="ghost" onClick={() => location.reload()}>Verrouiller maintenant</button>
          <button className="ghost danger" onClick={disable} disabled={busy}>Retirer le code PIN</button>
        </div>
      ) : (
        <form className="form-grid" onSubmit={enable}>
          <label>Nouveau code PIN<input type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} maxLength={12} /></label>
          <label>Confirmer le code<input type="password" inputMode="numeric" autoComplete="new-password" value={confirmPin} onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ""))} maxLength={12} /></label>
          <label>
            Verrouiller après
            <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              {[2, 5, 10, 30, 60].map((m) => <option key={m} value={m}>{m} min d'inactivité</option>)}
            </select>
          </label>
          <div className="form-actions"><button className="primary" disabled={busy}>{busy ? "Chiffrement…" : "Activer le code PIN"}</button></div>
        </form>
      )}
      {message && <p className="muted small" role="status">{message}</p>}
    </div>
  );
}

/** Taux de change : 1 unité de devise = n francs CFA. L'euro et le XOF ont une parité fixe. */
function CurrencySettings() {
  const { db } = useApp();
  const s = useSettings();
  const rates = (s.rates as Record<string, number> | undefined) ?? {};
  const floating = Object.values(CURRENCIES).filter((c) => !c.fixedRate);
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const value = (code: string) => values[code] ?? String(rateFor(code, rates));

  async function save(next: Record<string, number>) {
    await db.write("settings", "company", { rates: { ...rates, ...next }, rates_updated_at: new Date().toISOString() });
    setValues({});
  }

  async function fetchRates() {
    setMessage(null);
    try {
      // Service public gratuit, sans clé. Taux exprimés pour 1 XAF.
      const res = await fetch("https://open.er-api.com/v6/latest/XAF");
      const data = (await res.json()) as { result?: string; rates?: Record<string, number> };
      if (data.result !== "success" || !data.rates) throw new Error();
      const next: Record<string, number> = {};
      for (const c of floating) {
        const perXaf = data.rates[c.code];
        if (perXaf > 0) next[c.code] = Math.round((1 / perXaf) * 100) / 100;
      }
      await save(next);
      setMessage("Taux mis à jour.");
    } catch {
      setMessage("Impossible de récupérer les taux (hors ligne ?) : saisissez-les à la main.");
    }
  }

  return (
    <div className="card section-card">
      <h3>Devises</h3>
      <p className="muted small">
        La comptabilité est tenue en francs CFA. Le taux est enregistré sur chaque document au moment de sa création.
        Parités fixes : 1 EUR = 655,957 FCFA ; 1 XOF = 1 FCFA.
        {s.rates_updated_at ? ` Dernière mise à jour : ${new Date(String(s.rates_updated_at)).toLocaleDateString("fr-FR")}.` : ""}
      </p>
      <div className="form-grid">
        {floating.map((c) => (
          <label key={c.code}>
            1 {c.code} ({c.label}) = … FCFA
            <input type="number" min="0" step="any" value={value(c.code)} onChange={(e) => setValues((v) => ({ ...v, [c.code]: e.target.value }))} />
          </label>
        ))}
      </div>
      <div className="form-actions">
        {message && <span className="muted small">{message}</span>}
        <button className="ghost" onClick={fetchRates}>Récupérer les taux du jour</button>
        <button className="primary" onClick={() => save(Object.fromEntries(floating.map((c) => [c.code, Number(value(c.code)) || rateFor(c.code, rates)])))}>
          Enregistrer les taux
        </button>
      </div>
    </div>
  );
}

interface User { id: string; email: string; name: string; role: string; active: number; must_change_password?: number }

/** Mot de passe provisoire lisible, sans caractères ambigus. */
function temporaryPassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function Users() {
  const { db, session } = useApp();
  const sync = useSyncStatus();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [temp, setTemp] = useState<{ name: string; password: string } | null>(null);

  const load = () =>
    api<{ users: User[] }>("/api/users")
      .then((r) => {
        setUsers(r.users);
        setError(null);
        // Annuaire d'équipe (Projets) : une fiche par compte, créée ici dès l'ajout d'un utilisateur.
        reconcileTeam(db, session).catch(() => {});
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Connexion internet nécessaire pour gérer les utilisateurs."));

  useEffect(() => { load(); }, [sync.state === "offline"]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api("/api/users", f);
      setAdding(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Connexion internet nécessaire.");
    }
  }

  async function update(id: string, patch: { role?: string; active?: boolean }) {
    if (patch.active === false && !confirm("Désactiver ce compte ? Ses appareils seront déconnectés et leurs données locales effacées.")) return;
    try {
      await api("/api/users/update", { id, ...patch });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Connexion internet nécessaire.");
    }
  }

  async function reset(u: User) {
    if (!confirm(`Donner un mot de passe provisoire à ${u.name} ? Ses appareils seront déconnectés ; il devra choisir un nouveau mot de passe à la connexion.`)) return;
    const password = temporaryPassword();
    try {
      await api("/api/users/password", { id: u.id, password });
      setTemp({ name: u.name, password });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Connexion internet nécessaire.");
    }
  }

  return (
    <div className="card section-card">
      <div className="section-head">
        <h3>Utilisateurs</h3>
        <button onClick={() => setAdding((a) => !a)}>{adding ? "Annuler" : "Ajouter un utilisateur"}</button>
      </div>
      {adding && (
        <form className="form-grid" onSubmit={create}>
          <label>Nom<input name="name" required /></label>
          <label>E-mail<input name="email" type="email" required /></label>
          <label>
            Rôle
            <select name="role" defaultValue="sales">
              {Object.entries(ROLE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label>Mot de passe provisoire<input name="password" type="password" minLength={8} required autoComplete="new-password" /></label>
          <div className="form-actions"><button className="primary">Créer le compte</button></div>
        </form>
      )}
      {error && <p className="error">{error}</p>}
      {temp && (
        <div className="notice" role="status">
          Mot de passe provisoire de <strong>{temp.name}</strong> : <code className="mono" data-testid="temp-password">{temp.password}</code>
          <p className="muted small">Communiquez-le à la personne (de vive voix ou par message). Il ne sera plus affiché.</p>
          <button className="ghost small" onClick={() => setTemp(null)}>J'ai noté</button>
        </div>
      )}
      {users && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nom</th><th>E-mail</th><th>Rôle</th><th>Statut</th><th /></tr></thead>
            <tbody>
              {users.map((u) => {
                const self = u.id === session.user.id;
                return (
                  <tr key={u.id}>
                    <td>{u.name}{self && <span className="muted"> (vous)</span>}</td>
                    <td>{u.email}</td>
                    <td>
                      {self ? ROLE_LABELS[u.role] : (
                        <select value={u.role} onChange={(e) => update(u.id, { role: e.target.value })} aria-label={`Rôle de ${u.name}`}>
                          {Object.entries(ROLE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${u.active ? "ok" : ""}`}>{u.active ? "Actif" : "Désactivé"}</span>
                      {u.active && u.must_change_password ? <span className="badge warn">Mot de passe provisoire</span> : null}
                    </td>
                    <td className="right">
                      {!self && (
                        <div className="actions right-actions">
                          {u.active ? <button className="ghost small" onClick={() => reset(u)}>Réinitialiser le mot de passe</button> : null}
                          <button className="ghost small" onClick={() => update(u.id, { active: !u.active })}>
                            {u.active ? "Désactiver" : "Réactiver"}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">Un changement de rôle prend effet à la prochaine synchronisation de la personne. Un nouveau compte se connecte avec le mot de passe provisoire choisi ici, puis le remplace.</p>
    </div>
  );
}

/**
 * Fiscalité (Gabon) : CSS, taux de TVA proposés, régime, retenues à la source, mentions.
 * Les taux sont paramétrables car la loi de finances les change ; chaque document fige
 * ceux en vigueur à son émission.
 */
function FiscalSettingsCard() {
  const { db } = useApp();
  const s = useSettings();
  const f = fiscalSettings(s);
  const [cssEnabled, setCssEnabled] = useState(f.cssEnabled);
  const [cssRate, setCssRate] = useState(String(f.cssRate));
  const [cssOnZero, setCssOnZero] = useState(f.cssOnZero);
  const [vatRates, setVatRates] = useState(f.vatRates.join(" ; "));
  const [debits, setDebits] = useState(f.vatOnDebits);
  const [exemption, setExemption] = useState(f.exemptionNote);
  const [withholdings, setWithholdings] = useState<{ label: string; rate: string }[]>(f.withholdings.map((w) => ({ label: w.label, rate: String(w.rate) })));
  const [requireNif, setRequireNif] = useState(f.requireClientNif);
  const [penalty, setPenalty] = useState(f.latePenalty);
  const [message, setMessage] = useState<string | null>(null);
  const toNum = (v: string) => Number(v.replace(",", "."));

  async function save(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    const rate = toNum(cssRate);
    if (!(rate >= 0 && rate <= 100)) return setMessage("Le taux de CSS doit être compris entre 0 et 100 %.");
    const rates = vatRates.split(/[;\s]+/).filter(Boolean).map(toNum);
    if (rates.length === 0 || rates.some((r) => !(r >= 0 && r <= 100))) return setMessage("Taux de TVA : des nombres entre 0 et 100, séparés par des points-virgules.");
    const wh: WithholdingPreset[] = withholdings.filter((w) => w.label.trim()).map((w) => ({ label: w.label.trim(), rate: toNum(w.rate) }));
    if (wh.some((w) => !(w.rate > 0 && w.rate <= 100))) return setMessage("Chaque retenue doit avoir un taux entre 0 et 100 %.");
    await db.write("settings", "company", {
      css_enabled: cssEnabled, css_rate: rate, css_on_zero: cssOnZero,
      vat_rates: [...new Set(rates)], vat_regime: debits ? "debits" : "encaissements",
      exemption_note: exemption.trim(), withholdings: wh, require_client_nif: requireNif, late_penalty: penalty.trim(),
    });
    setMessage("Enregistré");
    setTimeout(() => setMessage(null), 2500);
  }

  return (
    <form className="card section-card fiscal-card" onSubmit={save}>
      <h3>Fiscalité (Gabon)</h3>
      <p className="muted small">
        Appliquée aux nouveaux devis et factures ; un document émis garde les taux de sa date.
        Valeurs par défaut issues de la loi de finances 2026 : faites-les confirmer par votre comptable.
      </p>

      <fieldset>
        <legend>Contribution spéciale de solidarité (CSS)</legend>
        <label className="check-inline"><input type="checkbox" checked={cssEnabled} onChange={(e) => setCssEnabled(e.target.checked)} /> Facturer la CSS (entreprises au chiffre d'affaires d'au moins 30 M FCFA)</label>
        <div className="form-grid">
          <label>Taux de CSS (%)<input inputMode="decimal" value={cssRate} onChange={(e) => setCssRate(e.target.value)} disabled={!cssEnabled} /></label>
        </div>
        <label className="check-inline"><input type="checkbox" checked={cssOnZero} onChange={(e) => setCssOnZero(e.target.checked)} disabled={!cssEnabled} /> Appliquer aussi aux lignes à 0 % de TVA</label>
        <p className="hint">Calculée sur le montant HT, hors base de TVA, sur une ligne distincte de la facture.</p>
      </fieldset>

      <fieldset>
        <legend>TVA</legend>
        <div className="form-grid">
          <label>Taux proposés (%)<input value={vatRates} onChange={(e) => setVatRates(e.target.value)} placeholder={DEFAULT_VAT_RATES.join(" ; ")} /></label>
          <label>
            Exigibilité de la TVA
            <select value={debits ? "debits" : "encaissements"} onChange={(e) => setDebits(e.target.value === "debits")}>
              <option value="encaissements">Sur les encaissements (services, par défaut)</option>
              <option value="debits">Sur les débits (option, mentionnée sur la facture)</option>
            </select>
          </label>
          <label className="wide">Mention pour les lignes à 0 %<input value={exemption} onChange={(e) => setExemption(e.target.value)} placeholder="Exonération : article … du CGI" /></label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Retenues à la source proposées</legend>
        <p className="hint">Opérées par le client : la facture affiche la retenue et le net à payer.</p>
        <div className="withholding-rows">
          {withholdings.map((w, i) => (
            <div className="withholding-row" key={i}>
              <input aria-label="Nom de la retenue" value={w.label} onChange={(e) => setWithholdings((ws) => ws.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <input aria-label="Taux de la retenue" inputMode="decimal" value={w.rate} onChange={(e) => setWithholdings((ws) => ws.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} />
              <span className="muted">%</span>
              <button type="button" className="ghost" onClick={() => setWithholdings((ws) => ws.filter((_, j) => j !== i))}>Retirer</button>
            </div>
          ))}
        </div>
        <button type="button" className="ghost add-line" onClick={() => setWithholdings((ws) => [...ws, { label: "", rate: "" }])}>+ Ajouter une retenue</button>
      </fieldset>

      <fieldset>
        <legend>Factures</legend>
        <label className="check-inline"><input type="checkbox" checked={requireNif} onChange={(e) => setRequireNif(e.target.checked)} /> Rendre obligatoire le numéro fiscal des entreprises facturées</label>
        <div className="form-grid">
          <label className="wide">Pénalités de retard (mention)<input value={penalty} onChange={(e) => setPenalty(e.target.value)} placeholder="Pénalités de retard : 1,5 % par mois après l'échéance" /></label>
        </div>
        <p className="hint">Automatique : à partir de 500 000 FCFA, la facture précise que le règlement se fait par virement ou mobile money.</p>
      </fieldset>

      <div className="form-actions">
        {message && <span className={message === "Enregistré" ? "ok-text" : "error"}>{message}</span>}
        <button className="primary">Enregistrer la fiscalité</button>
      </div>
    </form>
  );
}

/** Calendrier de relance des factures impayées. */
function RemindersCard() {
  const { db } = useApp();
  const s = useSettings();
  const r = reminderSettings(s);
  const [enabled, setEnabled] = useState(r.enabled);
  const [steps, setSteps] = useState(r.steps.map(stepLabel).join(" ; "));
  const [message, setMessage] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    const parsed = steps.split(/[;,\s]+/).filter(Boolean).map((t) => {
      const m = /^J?\s*([+-]?\d+)$/i.exec(t.trim());
      return m ? Number(m[1]) : NaN;
    });
    if (parsed.length === 0 || parsed.some((n) => !Number.isInteger(n) || n < -60 || n > 365)) {
      return setMessage("Indiquez des étapes comme « J-3 ; J+1 ; J+7 » (de J-60 à J+365).");
    }
    await db.write("settings", "company", { reminders_enabled: enabled, reminder_steps: [...new Set(parsed)].sort((a, b) => a - b) });
    setSteps([...new Set(parsed)].sort((a, b) => a - b).map(stepLabel).join(" ; "));
    setMessage("Enregistré");
    setTimeout(() => setMessage(null), 2500);
  }

  return (
    <form className="card section-card reminders-card" onSubmit={save}>
      <h3>Relances des factures</h3>
      <p className="muted small">
        À chaque étape, la facture apparaît dans Factures &gt; « À relancer » avec un message adapté
        (rappel courtois avant l'échéance, puis relances de plus en plus fermes). L'envoi se fait en un clic par WhatsApp, e-mail ou PDF.
      </p>
      <label className="check-inline"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Proposer les relances selon ce calendrier</label>
      <div className="form-grid">
        <label className="wide">Étapes, par rapport à l'échéance<input value={steps} onChange={(e) => setSteps(e.target.value)} placeholder={DEFAULT_REMINDER_STEPS.map(stepLabel).join(" ; ")} disabled={!enabled} /></label>
      </div>
      <div className="form-actions">
        {message && <span className={message === "Enregistré" ? "ok-text" : "error"}>{message}</span>}
        <button className="primary">Enregistrer les relances</button>
      </div>
    </form>
  );
}

/**
 * Apparence des documents : couleur, cachet et signature, notes par défaut, conditions
 * générales. S'applique à l'aperçu et au PDF de tous les documents, y compris anciens
 * (la mise en page n'est pas une donnée figée du document, contrairement aux montants).
 */
function DocumentLookCard() {
  const { db } = useApp();
  const s = useSettings();
  const [color, setColor] = useState(docColor(s));
  const [stampError, setStampError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setColor(docColor(s)), [s.doc_color]);
  const stamp = typeof s.stamp === "string" ? s.stamp : "";

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const values: Record<string, unknown> = {
      doc_color: color,
      stamp_on: f.get("stamp_on") === "on",
      default_note_invoices: String(f.get("default_note_invoices") ?? "").trim(),
      default_note_quotes: String(f.get("default_note_quotes") ?? "").trim(),
      terms: String(f.get("terms") ?? "").trim(),
    };
    const patch = Object.fromEntries(Object.entries(values).filter(([k, v]) => (s[k] ?? (k === "stamp_on" ? true : "")) !== v));
    if (Object.keys(patch).length) await db.write("settings", "company", patch);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  async function onStamp(file: File | undefined) {
    setStampError(null);
    if (!file) return;
    try {
      await db.write("settings", "company", { stamp: await resizeLogo(file, 480, 220), stamp_on: true });
    } catch {
      setStampError("Image illisible : utilisez un PNG (idéalement sur fond transparent) ou un JPEG.");
    }
  }

  return (
    <form className="card section-card doc-look-card" onSubmit={save}>
      <h3>Apparence des documents</h3>
      <p className="muted small">Couleur, cachet et mentions de vos devis, factures et avoirs, à l'écran comme en PDF.</p>

      <div className="aside-label">Couleur</div>
      <div className="doc-colors" role="group" aria-label="Couleur des documents">
        {DOC_COLORS.map((c) => (
          <button key={c.hex} type="button" className="doc-color" style={{ background: c.hex }} aria-pressed={color === c.hex} aria-label={c.label} title={c.label} onClick={() => setColor(c.hex)} />
        ))}
        <label className="doc-color-custom">Autre<input type="color" value={color} onChange={(e) => setColor(e.target.value.toUpperCase())} aria-label="Couleur personnalisée" /></label>
      </div>
      <div className="doc-preview-strip" aria-hidden="true">
        <span className="t" style={{ color }}>Facture</span>
        <span className="bar" style={{ background: softOf(color) }} />
      </div>
      {tooLight(color) && <p className="error">Couleur trop claire : le titre sera peu lisible à l'impression.</p>}

      <div className="aside-label">Cachet et signature</div>
      <div className="logo-row">
        {stamp ? <img src={stamp} alt="Cachet actuel" className="stamp-preview" /> : <div className="logo-preview empty-logo">Cachet</div>}
        <label className="button">
          {stamp ? "Remplacer le cachet" : "Ajouter le cachet"}
          <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => onStamp(e.target.files?.[0])} />
        </label>
        {stamp && <button type="button" className="ghost" onClick={() => db.write("settings", "company", { stamp: "" })}>Retirer</button>}
        {stampError && <span className="error">{stampError}</span>}
      </div>
      {stamp && (
        <label className="check-inline">
          <input type="checkbox" name="stamp_on" defaultChecked={s.stamp_on !== false} />
          Imprimer le cachet sur les devis, factures et avoirs
        </label>
      )}
      <p className="hint">Photo ou scan du cachet signé, idéalement détouré (PNG transparent). Jamais imprimé sur un bon de livraison, que signe le client.</p>

      <div className="form-grid">
        <label className="wide">Note par défaut des nouvelles factures
          <textarea name="default_note_invoices" rows={2} defaultValue={text(s.default_note_invoices)} placeholder="Ex. Merci de rappeler le numéro de facture lors du paiement." />
        </label>
        <label className="wide">Note par défaut des nouveaux devis
          <textarea name="default_note_quotes" rows={2} defaultValue={text(s.default_note_quotes)} placeholder="Ex. Délai de réalisation : 15 jours à réception de l'acompte." />
        </label>
        <label className="wide">Conditions générales de vente
          <textarea name="terms" rows={4} defaultValue={text(s.terms)} placeholder="Imprimées en petit en bas des devis et des factures." />
        </label>
      </div>
      <div className="form-actions">
        {saved && <span className="ok-text">Enregistré</span>}
        <button className="primary">Enregistrer l'apparence</button>
      </div>
    </form>
  );
}

/** Objectif mensuel de chiffre d'affaires HT : suivi en haut du tableau de bord. */
function TargetCard() {
  const { db } = useApp();
  const s = useSettings();
  const [saved, setSaved] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = Math.max(0, Math.round(Number(new FormData(e.currentTarget).get("monthly_target")) || 0));
    await db.write("settings", "company", { monthly_target: v });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }
  return (
    <form className="card section-card" onSubmit={save} aria-label="Objectif mensuel">
      <h3>Objectif mensuel</h3>
      <p className="muted small">Chiffre d'affaires HT visé chaque mois. Sa progression s'affiche en haut du tableau de bord ; laissez vide pour ne rien afficher.</p>
      <div className="form-grid">
        <label>Objectif de chiffre d'affaires HT (FCFA)<input name="monthly_target" type="number" min="0" step="1000" defaultValue={Number(s.monthly_target) > 0 ? String(s.monthly_target) : ""} /></label>
      </div>
      <div className="form-actions">
        {saved && <span className="ok-text">Enregistré</span>}
        <button className="primary">Enregistrer</button>
      </div>
    </form>
  );
}
