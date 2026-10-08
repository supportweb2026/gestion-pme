/**
 * Console de l'équipe Gestia : entreprises clientes, abonnements, paiements,
 * erreurs remontées par les appareils. Réservée aux administrateurs de l'éditeur.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError } from "../api.ts";
import { useApp } from "../context.ts";
import { PLANS, type SubscriptionInfo } from "../../shared/plans.ts";
import { formatXaf, PAYMENT_METHODS } from "../../shared/invoice.ts";
import { formatDate, STATE_LABELS, SubscriptionBadge } from "../subscription.tsx";

interface CompanyRow {
  id: string;
  name: string;
  plan: string;
  status: string;
  trial_ends_at: string | null;
  paid_until: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  note: string | null;
  created_at: string;
  users: number;
  last_seen: string | null;
  admin_email: string | null;
  subscription: SubscriptionInfo;
}

interface PaymentRow {
  id: string;
  company_id: string;
  company_name: string;
  plan: string;
  months: number;
  amount: number;
  method: string;
  reference: string | null;
  period_from: string;
  period_to: string;
  created_at: string;
}

interface ErrorRow { id: number; at: string; message: string; detail: string | null; url: string | null; agent: string | null; company_name: string | null }

const sentence = (m: string) => m.charAt(0).toUpperCase() + m.slice(1) + ".";
const ago = (iso: string | null) => {
  if (!iso) return "jamais";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 864e5);
  return days <= 0 ? "aujourd'hui" : days === 1 ? "hier" : `il y a ${days} j`;
};

function temporaryPassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => chars[b % chars.length]).join("");
}

export function Platform() {
  const [view, setView] = useState<"companies" | "payments" | "errors">("companies");
  const [companies, setCompanies] = useState<CompanyRow[] | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [errors, setErrors] = useState<ErrorRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = async () => {
    try {
      const [c, p, e] = await Promise.all([
        api<{ companies: CompanyRow[] }>("/api/platform/companies"),
        api<{ payments: PaymentRow[] }>("/api/platform/payments"),
        api<{ errors: ErrorRow[] }>("/api/platform/errors"),
      ]);
      setCompanies(c.companies);
      setPayments(p.payments);
      setErrors(e.errors);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? sentence(err.message) : "Connexion internet nécessaire pour la console.");
    }
  };
  useEffect(() => { load(); }, []);

  return (
    <section>
      <div className="section-head">
        <h2>Plateforme Gestia</h2>
        <div className="actions">
          {(["companies", "payments", "errors"] as const).map((v) => (
            <button key={v} className={view === v ? "primary" : ""} onClick={() => setView(v)}>
              {v === "companies" ? "Entreprises" : v === "payments" ? "Paiements" : `Erreurs${errors.length ? ` (${errors.length})` : ""}`}
            </button>
          ))}
          <button className="ghost" onClick={load}>Actualiser</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {companies && <Kpis companies={companies} payments={payments} />}
      {companies && view === "companies" && (
        <Companies companies={companies} selected={selected} setSelected={setSelected} reload={load} />
      )}
      {view === "payments" && <Payments payments={payments} />}
      {view === "errors" && <Errors errors={errors} />}
    </section>
  );
}

function Kpis({ companies, payments }: { companies: CompanyRow[]; payments: PaymentRow[] }) {
  const year = String(new Date().getFullYear());
  const count = (f: (c: CompanyRow) => boolean) => companies.filter(f).length;
  const soon = count((c) => (c.subscription.state === "trial" || c.subscription.state === "active") && c.subscription.daysLeft !== null && c.subscription.daysLeft <= 7);
  const late = count((c) => ["grace", "expired"].includes(c.subscription.state));
  const revenue = payments.filter((p) => p.created_at.startsWith(year)).reduce((s, p) => s + p.amount, 0);
  const active7 = count((c) => !!c.last_seen && Date.now() - Date.parse(c.last_seen) < 7 * 864e5);
  return (
    <div className="kpis">
      <div className="card kpi"><div className="kpi-label">Entreprises</div><div className="kpi-value">{companies.length}</div><div className="muted small">{active7} actives cette semaine</div></div>
      <div className="card kpi"><div className="kpi-label">En essai</div><div className="kpi-value">{count((c) => c.subscription.state === "trial")}</div></div>
      <div className="card kpi"><div className="kpi-label">Abonnées</div><div className="kpi-value">{count((c) => c.subscription.state === "active")}</div></div>
      <div className={`card kpi ${late ? "danger" : ""}`}><div className="kpi-label">À relancer</div><div className="kpi-value">{soon + late}</div><div className="muted small">{soon} échéance ≤ 7 j · {late} en retard</div></div>
      <div className="card kpi"><div className="kpi-label">Encaissé {year}</div><div className="kpi-value">{formatXaf(revenue)}</div></div>
      <div className="card kpi"><div className="kpi-label">Utilisateurs actifs</div><div className="kpi-value">{companies.reduce((s, c) => s + Number(c.users), 0)}</div></div>
    </div>
  );
}

function Companies({ companies, selected, setSelected, reload }: {
  companies: CompanyRow[]; selected: string | null; setSelected: (id: string | null) => void; reload: () => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [state, setState] = useState("");
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return companies.filter((c) =>
      (!state || c.subscription.state === state) &&
      (!needle || [c.name, c.admin_email, c.contact_email, c.contact_phone].some((v) => v?.toLowerCase().includes(needle))));
  }, [companies, q, state]);
  const current = companies.find((c) => c.id === selected);

  return (
    <>
      <div className="platform-filters">
        <input type="search" placeholder="Rechercher (nom, e-mail, téléphone)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher une entreprise" />
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="Filtrer par état">
          <option value="">Tous les états</option>
          {Object.entries(STATE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Entreprise</th><th>Formule</th><th>État</th><th>Échéance</th><th className="num">Utilisateurs</th><th>Activité</th><th>Inscrite le</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className={c.id === selected ? "selected clickable" : "clickable"} onClick={() => setSelected(c.id === selected ? null : c.id)}>
                <td><strong>{c.name}</strong><div className="muted small">{c.admin_email ?? c.contact_email ?? ""}</div></td>
                <td>{c.subscription.planLabel}</td>
                <td><SubscriptionBadge sub={c.subscription} /></td>
                <td>{formatDate(c.subscription.endsAt)}{c.subscription.daysLeft !== null && <div className="muted small">{c.subscription.daysLeft >= 0 ? `J-${c.subscription.daysLeft}` : `dépassée de ${-c.subscription.daysLeft} j`}</div>}</td>
                <td className="num">{c.users} / {c.subscription.maxUsers >= 1000 ? "∞" : c.subscription.maxUsers}</td>
                <td>{ago(c.last_seen)}</td>
                <td>{formatDate(c.created_at)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="muted">Aucune entreprise.</td></tr>}
          </tbody>
        </table>
      </div>
      {current && <CompanyPanel key={current.id} c={current} reload={reload} />}
    </>
  );
}

function CompanyPanel({ c, reload }: { c: CompanyRow; reload: () => Promise<void> }) {
  const { session } = useApp();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [temp, setTemp] = useState<string | null>(null);
  const isEditor = c.id === session.company.id;

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      await reload();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? sentence(err.message) : "Connexion internet nécessaire." });
    }
  }

  const form = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
  };

  return (
    <div className="card section-card company-panel" data-testid="company-panel">
      <div className="section-head">
        <h3>{c.name}</h3>
        <SubscriptionBadge sub={c.subscription} />
      </div>
      <p className="muted">
        Administrateur : {c.admin_email ?? "—"}
        {c.contact_phone && <> · Tél. <a href={`tel:${c.contact_phone.replace(/\s/g, "")}`}>{c.contact_phone}</a></>}
        {" "}· Inscrite le {formatDate(c.created_at)} · Dernière activité : {ago(c.last_seen)}
      </p>
      {msg && <p className={msg.ok ? "success" : "error"} role="status">{msg.text}</p>}

      <h4>Enregistrer un paiement</h4>
      <form className="form-grid" onSubmit={(e) => {
        const f = form(e);
        run(() => api("/api/platform/payment", { company_id: c.id, plan: f.plan, months: Number(f.months), amount: Number(f.amount), method: f.method, reference: f.reference }), "Paiement enregistré, abonnement prolongé.");
      }}>
        <label>Formule
          <select name="plan" defaultValue={c.plan === "trial" ? "pro" : c.plan}>
            {Object.entries(PLANS).filter(([k]) => k !== "trial").map(([k, p]) => <option key={k} value={k}>{p.label} ({p.maxUsers >= 1000 ? "illimité" : `${p.maxUsers} util.`})</option>)}
          </select>
        </label>
        <label>Durée (mois)<input name="months" type="number" min={1} max={36} defaultValue={12} required /></label>
        <label>Montant (FCFA)<input name="amount" type="number" min={0} step={1} required /></label>
        <label>Moyen
          <select name="method" defaultValue="transfer">
            {Object.entries(PAYMENT_METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="wide">Référence<input name="reference" placeholder="N° de virement, de transaction…" maxLength={120} /></label>
        <div className="form-actions"><button className="primary">Enregistrer le paiement</button></div>
      </form>

      <h4>Ajuster l'abonnement</h4>
      <form className="form-grid" key={`${c.plan}|${c.trial_ends_at}|${c.paid_until}`} onSubmit={(e) => {
        const f = form(e);
        run(() => api("/api/platform/company", { id: c.id, plan: f.plan, trial_ends_at: f.trial_ends_at, paid_until: f.paid_until }), "Abonnement modifié.");
      }}>
        <label>Formule
          <select name="plan" defaultValue={c.plan}>
            {Object.entries(PLANS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
          </select>
        </label>
        <label>Fin d'essai<input name="trial_ends_at" type="date" defaultValue={c.trial_ends_at ?? ""} /></label>
        <label>Payé jusqu'au<input name="paid_until" type="date" defaultValue={c.paid_until ?? ""} /></label>
        <div className="form-actions"><button>Enregistrer</button></div>
      </form>

      <h4>Note interne</h4>
      <form className="form-grid" onSubmit={(e) => {
        const f = form(e);
        run(() => api("/api/platform/company", { id: c.id, note: f.note }), "Note enregistrée.");
      }}>
        <label className="wide"><span className="sr-only">Note</span><textarea name="note" rows={2} defaultValue={c.note ?? ""} maxLength={1000} placeholder="Relances, conditions particulières…" /></label>
        <div className="form-actions"><button>Enregistrer la note</button></div>
      </form>

      <h4>Accès</h4>
      <div className="actions">
        {!isEditor && (c.status === "suspended" ? (
          <button onClick={() => run(() => api("/api/platform/company", { id: c.id, status: "active" }), "Compte réactivé.")}>Réactiver le compte</button>
        ) : (
          <button className="danger" onClick={() => confirm(`Suspendre ${c.name} ? Plus personne ne pourra s'y connecter ; les données sont conservées.`) &&
            run(() => api("/api/platform/company", { id: c.id, status: "suspended" }), "Compte suspendu.")}>Suspendre le compte</button>
        ))}
        {c.admin_email && (
          <button className="ghost" onClick={() => {
            if (!confirm(`Donner un mot de passe provisoire à ${c.admin_email} ?`)) return;
            const password = temporaryPassword();
            run(async () => { await api("/api/platform/reset-password", { email: c.admin_email, password }); setTemp(password); }, "Mot de passe provisoire créé.");
          }}>Réinitialiser le mot de passe de l'administrateur</button>
        )}
      </div>
      {temp && (
        <div className="notice" role="status">
          Mot de passe provisoire de {c.admin_email} : <code className="mono">{temp}</code>
          <p className="muted small">À communiquer au client ; il devra le changer à la connexion.</p>
        </div>
      )}
    </div>
  );
}

function Payments({ payments }: { payments: PaymentRow[] }) {
  return (
    <div className="card table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Entreprise</th><th>Formule</th><th>Période</th><th>Moyen</th><th>Référence</th><th className="num">Montant</th></tr></thead>
        <tbody>
          {payments.map((p) => (
            <tr key={p.id}>
              <td>{formatDate(p.created_at)}</td>
              <td>{p.company_name}</td>
              <td>{PLANS[p.plan]?.label ?? p.plan} · {p.months} mois</td>
              <td>{formatDate(p.period_from)} → {formatDate(p.period_to)}</td>
              <td>{PAYMENT_METHODS[p.method as keyof typeof PAYMENT_METHODS] ?? p.method}</td>
              <td>{p.reference ?? ""}</td>
              <td className="num">{formatXaf(p.amount)}</td>
            </tr>
          ))}
          {payments.length === 0 && <tr><td colSpan={7} className="muted">Aucun paiement enregistré.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Errors({ errors }: { errors: ErrorRow[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="card table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Entreprise</th><th>Erreur</th><th>Page</th></tr></thead>
        <tbody>
          {errors.map((e) => (
            <tr key={e.id} className="clickable" onClick={() => setOpen(open === e.id ? null : e.id)}>
              <td>{new Date(e.at).toLocaleString("fr-FR")}</td>
              <td>{e.company_name ?? "—"}</td>
              <td>
                {e.message}
                {open === e.id && <pre className="err-detail">{[e.detail, e.agent].filter(Boolean).join("\n\n")}</pre>}
              </td>
              <td>{e.url ?? ""}</td>
            </tr>
          ))}
          {errors.length === 0 && <tr><td colSpan={4} className="muted">Aucune erreur remontée.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
