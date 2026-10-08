import { useEffect, useState, type FormEvent } from "react";
import { can, ROLE_LABELS, text, useApp, useSettings, useSyncStatus } from "../context.ts";
import { api, ApiError, getToken } from "../api.ts";
import { formatDate, SubscriptionBadge } from "../subscription.tsx";
import { PLANS } from "../../shared/plans.ts";
import { DEFAULT_PAYMENT_DAYS } from "../../shared/invoice.ts";
import { CURRENCIES, rateFor } from "../../shared/currency.ts";

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
async function resizeLogo(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("image illisible"));
      i.src = url;
    });
    const scale = Math.min(1, 320 / img.width, 160 / img.height);
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
  const { session } = useApp();
  const sync = useSyncStatus();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [temp, setTemp] = useState<{ name: string; password: string } | null>(null);

  const load = () =>
    api<{ users: User[] }>("/api/users")
      .then((r) => { setUsers(r.users); setError(null); })
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
