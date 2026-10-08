import { useState, type FormEvent } from "react";
import { can, formatDate, text, today, useApp, useSettings, useTable } from "../context.ts";
import { formatXaf, PAYMENT_METHODS } from "../../shared/invoice.ts";
import type { SyncRecord } from "../../shared/sync.ts";
import { EXPENSE_CATEGORIES } from "../../shared/accounting.ts";

export { EXPENSE_CATEGORIES };

const STATUS: Record<string, { label: string; tone: string }> = {
  approved: { label: "Validée", tone: "ok" },
  pending: { label: "À valider", tone: "warn" },
  rejected: { label: "Refusée", tone: "danger" },
};

export function Expenses() {
  const { db, session } = useApp();
  const all = useTable("expenses");
  const projects = useTable("projects");
  const [month, setMonth] = useState(today().slice(0, 7));
  const [editing, setEditing] = useState<SyncRecord | "new" | null>(null);
  const approver = can.approveExpenses(session.user.role);
  const ownOnly = session.user.role === "employee";

  const visible = all.filter((e) => !ownOnly || e.data.created_by === session.user.id);
  const rows = visible
    .filter((e) => text(e.data.date).startsWith(month))
    .sort((a, b) => text(b.data.date).localeCompare(text(a.data.date)));
  const approved = rows.filter((e) => e.data.status !== "rejected");
  const total = approved.reduce((n, e) => n + Number(e.data.amount ?? 0), 0);
  const byCategory = new Map<string, number>();
  for (const e of approved) byCategory.set(text(e.data.category), (byCategory.get(text(e.data.category)) ?? 0) + Number(e.data.amount ?? 0));
  const pending = visible.filter((e) => e.data.status === "pending");

  const closedUntil = text(useSettings().closed_until);
  const [formError, setFormError] = useState<string | null>(null);

  async function save(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(ev.currentTarget)) as Record<string, string>;
    if (closedUntil && f.date <= closedUntil) {
      setFormError(`Période clôturée jusqu'au ${formatDate(closedUntil)} : choisissez une date ultérieure.`);
      return;
    }
    setFormError(null);
    const values: Record<string, unknown> = {
      date: f.date,
      amount: Math.round(Number(f.amount.replace(/\s/g, "")) || 0),
      vat_rate: Number(f.vat_rate) || 0,
      category: f.category,
      supplier: f.supplier.trim(),
      description: f.description.trim(),
      method: f.method,
      project_id: f.project_id ?? "",
    };
    if (editing === "new") {
      Object.assign(values, {
        status: approver || session.user.role === "accountant" ? "approved" : "pending",
        created_by: session.user.id,
        created_by_name: session.user.name,
      });
      await db.write("expenses", db.newId("dep"), values);
    } else if (editing) {
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values)) if (editing.data[k] !== v) patch[k] = v;
      if (Object.keys(patch).length) await db.write("expenses", editing.id, patch);
    }
    setEditing(null);
  }

  const decide = (e: SyncRecord, status: "approved" | "rejected") =>
    db.write("expenses", e.id, { status, decided_by: session.user.id, decided_at: new Date().toISOString() });

  const v = (k: string, fallback = "") => (editing && editing !== "new" ? text(editing.data[k]) : fallback);
  const canEdit = (e: SyncRecord) =>
    !(closedUntil && text(e.data.date) <= closedUntil) && (approver || (e.data.created_by === session.user.id && e.data.status !== "approved"));

  return (
    <section>
      <div className="section-head">
        <h2>Dépenses</h2>
        <button className="primary" onClick={() => setEditing("new")}>Nouvelle dépense</button>
      </div>

      {editing && (
        <form className="card form-grid" onSubmit={save} key={editing === "new" ? "new" : editing.id}>
          <label>Date<input name="date" type="date" required defaultValue={v("date", today())} /></label>
          <label>Montant TTC (FCFA)<input name="amount" inputMode="numeric" required defaultValue={v("amount")} /></label>
          <label>
            Catégorie
            <select name="category" defaultValue={v("category", "supplies")}>
              {Object.entries(EXPENSE_CATEGORIES).map(([k, c]) => <option key={k} value={k}>{c.label}</option>)}
            </select>
          </label>
          <label>Fournisseur<input name="supplier" defaultValue={v("supplier")} /></label>
          <label>Description<input name="description" defaultValue={v("description")} /></label>
          <label>
            Payé par
            <select name="method" defaultValue={v("method", "cash")}>
              {Object.entries(PAYMENT_METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          {projects.length > 0 && (
            <label>
              Projet
              <select name="project_id" defaultValue={v("project_id")}>
                <option value="">Aucun</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{text(p.data.name)}</option>)}
              </select>
            </label>
          )}
          <label>
            TVA récupérable
            <select name="vat_rate" defaultValue={v("vat_rate", "0")}>
              <option value="0">Aucune</option>
              <option value="18">18 %</option>
              <option value="10">10 %</option>
            </select>
          </label>
          {formError && <p className="error wide" role="alert">{formError}</p>}
          <div className="form-actions">
            {editing !== "new" && (
              <button type="button" className="ghost danger" onClick={async () => {
                if (confirm("Supprimer cette dépense ?")) {
                  await db.remove("expenses", editing.id);
                  setEditing(null);
                }
              }}>Supprimer</button>
            )}
            <button type="button" className="ghost" onClick={() => setEditing(null)}>Annuler</button>
            <button className="primary">Enregistrer</button>
          </div>
        </form>
      )}

      {approver && pending.length > 0 && (
        <div className="card section-card">
          <h3>{pending.length} dépense(s) à valider</h3>
          <table>
            <tbody>
              {pending.map((e) => (
                <tr key={e.id}>
                  <td>{formatDate(e.data.date)}</td>
                  <td>{text(e.data.created_by_name)}</td>
                  <td>{EXPENSE_CATEGORIES[text(e.data.category)]?.label}</td>
                  <td>{text(e.data.description) || text(e.data.supplier)}</td>
                  <td className="right mono">{formatXaf(Number(e.data.amount))}</td>
                  <td className="right nowrap">
                    <button className="ghost small" onClick={() => decide(e, "rejected")}>Refuser</button>{" "}
                    <button className="small primary" onClick={() => decide(e, "approved")}>Valider</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="toolbar">
        <label className="inline">Mois <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
        <span className="muted">Total du mois : <strong className="mono">{formatXaf(total)}</strong></span>
      </div>

      {byCategory.size > 0 && (
        <div className="chips">
          {[...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => (
            <span key={k} className="chip">{EXPENSE_CATEGORIES[k]?.label ?? k} · <span className="mono">{formatXaf(n)}</span></span>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="empty">Aucune dépense ce mois-ci.</p>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Catégorie</th><th>Fournisseur / description</th><th>Saisie par</th><th>Statut</th><th className="right">Montant TTC</th><th /></tr></thead>
            <tbody>
              {rows.map((e) => {
                const st = STATUS[text(e.data.status)] ?? STATUS.approved;
                return (
                  <tr key={e.id}>
                    <td>{formatDate(e.data.date)}</td>
                    <td>{EXPENSE_CATEGORIES[text(e.data.category)]?.label ?? text(e.data.category)}</td>
                    <td>{[text(e.data.supplier), text(e.data.description)].filter(Boolean).join(" · ")}</td>
                    <td className="muted">{text(e.data.created_by_name)}</td>
                    <td><span className={`badge ${st.tone}`}>{st.label}</span></td>
                    <td className="right mono">{formatXaf(Number(e.data.amount))}</td>
                    <td className="right">{canEdit(e) && <button className="ghost small" onClick={() => setEditing(e)}>Modifier</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
