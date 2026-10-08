import { useEffect, useState, type FormEvent } from "react";
import { can, ROLE_LABELS, text, useApp, useSettings, useSyncStatus } from "../context.ts";
import { api, ApiError } from "../api.ts";
import { DEFAULT_PAYMENT_DAYS } from "../../shared/invoice.ts";

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
      {can.manageCompany(session.user.role) && <CompanySettings />}
      {can.manageUsers(session.user.role) && <Users />}
    </section>
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

interface User { id: string; email: string; name: string; role: string; active: number }

function Users() {
  const { session } = useApp();
  const sync = useSyncStatus();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

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
                    <td><span className={`badge ${u.active ? "ok" : ""}`}>{u.active ? "Actif" : "Désactivé"}</span></td>
                    <td className="right">
                      {!self && (
                        <button className="ghost small" onClick={() => update(u.id, { active: !u.active })}>
                          {u.active ? "Désactiver" : "Réactiver"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">Un changement de rôle prend effet à la prochaine connexion de la personne.</p>
    </div>
  );
}
