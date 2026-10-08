import { useState, type FormEvent } from "react";
import { normalize, text, useApp, useTable } from "../context.ts";
import { DEFAULT_VAT_RATE, formatXaf } from "../../shared/invoice.ts";
import type { SyncRecord } from "../../shared/sync.ts";
import { savePatch } from "./Clients.tsx";

const UNITS = ["", "u", "h", "jour", "mois", "forfait", "kg", "m", "m²", "l"];

/** Catalogue : un article choisi dans une facture remplit son prix et sa TVA. */
export function Articles() {
  const { db } = useApp();
  const articles = useTable("articles");
  const [editing, setEditing] = useState<SyncRecord | "new" | null>(null);
  const [query, setQuery] = useState("");

  const q = normalize(query.trim());
  const rows = articles
    .filter((a) => !q || normalize(`${text(a.data.ref)} ${text(a.data.label)}`).includes(q))
    .sort((a, b) => text(a.data.label).localeCompare(text(b.data.label), "fr"));

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const values = {
      ref: f.ref.trim(),
      label: f.label.trim(),
      kind: f.kind,
      unit: f.unit,
      price: Math.round(Number(f.price) || 0),
      vat_rate: Number(f.vat_rate) || 0,
    };
    const isNew = editing === "new";
    await savePatch(db, "articles", isNew ? db.newId("art") : (editing as SyncRecord).id, isNew ? {} : (editing as SyncRecord).data, values);
    setEditing(null);
  }

  const v = (k: string, fallback = "") => (editing && editing !== "new" ? text(editing.data[k]) : fallback);

  return (
    <section>
      <div className="section-head">
        <h2>Articles et services</h2>
        <button className="primary" onClick={() => setEditing("new")}>Nouvel article</button>
      </div>

      {editing && (
        <form className="card form-grid" onSubmit={save} key={editing === "new" ? "new" : editing.id}>
          <label>Désignation<input name="label" required defaultValue={v("label")} /></label>
          <label>Référence<input name="ref" defaultValue={v("ref")} /></label>
          <label>
            Type
            <select name="kind" defaultValue={v("kind", "service")}>
              <option value="service">Service</option>
              <option value="product">Produit</option>
            </select>
          </label>
          <label>
            Unité
            <select name="unit" defaultValue={v("unit")}>
              {UNITS.map((u) => <option key={u} value={u}>{u || "—"}</option>)}
            </select>
          </label>
          <label>Prix unitaire HT (FCFA)<input name="price" type="number" min="0" step="1" required defaultValue={v("price", "0")} /></label>
          <label>TVA %<input name="vat_rate" type="number" min="0" step="any" defaultValue={v("vat_rate", String(DEFAULT_VAT_RATE))} /></label>
          <div className="form-actions">
            {editing !== "new" && (
              <button type="button" className="ghost danger" onClick={async () => {
                if (confirm("Supprimer cet article du catalogue ?")) {
                  await db.remove("articles", editing.id);
                  setEditing(null);
                }
              }}>Supprimer</button>
            )}
            <button type="button" className="ghost" onClick={() => setEditing(null)}>Annuler</button>
            <button className="primary">Enregistrer</button>
          </div>
        </form>
      )}

      <div className="toolbar">
        <input type="search" placeholder="Rechercher un article" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Rechercher un article" />
      </div>

      {rows.length === 0 ? (
        <p className="empty">{articles.length === 0 ? "Catalogue vide. Ajoutez vos produits et services pour les retrouver dans les factures." : "Aucun résultat."}</p>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Référence</th><th>Désignation</th><th>Type</th><th className="right">Prix HT</th><th className="right">TVA</th><th /></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{text(a.data.ref)}</td>
                  <td>{text(a.data.label)}{a.data.unit ? <span className="muted"> / {text(a.data.unit)}</span> : null}</td>
                  <td>{a.data.kind === "product" ? "Produit" : "Service"}</td>
                  <td className="right mono">{formatXaf(Number(a.data.price ?? 0))}</td>
                  <td className="right">{text(a.data.vat_rate)} %</td>
                  <td className="right"><button className="ghost small" onClick={() => setEditing(a)}>Modifier</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
