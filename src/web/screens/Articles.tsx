import { ImportCsv } from "../ImportCsv.tsx";
import { useState, type FormEvent } from "react";
import { formatDate, normalize, text, today, useApp, useTable } from "../context.ts";
import { usePaged } from "../Pager.tsx";
import { DEFAULT_VAT_RATE, formatXaf } from "../../shared/invoice.ts";
import type { SyncRecord } from "../../shared/sync.ts";
import { savePatch } from "./Clients.tsx";
import { useStock } from "../stock.ts";
import { OpenOrders, PurchaseOrderForm } from "./PurchaseOrders.tsx";
import { isTracked, onOrder, qtyFr, STOCK_MOVE_LABELS, weightedCost, type StockLevel, type StockMoveKind } from "../../shared/stock.ts";

const UNITS = ["", "u", "h", "jour", "mois", "forfait", "kg", "m", "m²", "l"];

/** Catalogue : un article choisi dans une facture remplit son prix et sa TVA. */
export function Articles() {
  const { db, session } = useApp();
  const articles = useTable("articles");
  const [editing, setEditing] = useState<SyncRecord | "new" | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("service");
  const [lowOnly, setLowOnly] = useState(false);
  const [stockOf, setStockOf] = useState<string | null>(null);
  const { levels } = useStock();
  const purchaseOrders = useTable("purchase_orders");
  const ordered = onOrder(purchaseOrders);
  const [ordering, setOrdering] = useState<string[] | null>(null);
  const lowCount = [...levels.values()].filter((l) => l.low).length;
  const stockValue = [...levels.values()].reduce((n, l) => n + l.value, 0);
  const openForm = (target: SyncRecord | "new") => {
    setKind(target === "new" ? "service" : text(target.data.kind) || "service");
    setStockOf(null);
    setOrdering(null);
    setEditing(target);
  };

  const q = normalize(query.trim());
  const rows = articles
    .filter((a) => !q || normalize(`${text(a.data.ref)} ${text(a.data.label)}`).includes(q))
    .filter((a) => !lowOnly || levels.get(a.id)?.low)
    .sort((a, b) => text(a.data.label).localeCompare(text(b.data.label), "fr"));
  const { shown, pager } = usePaged(rows, `${q}|${lowOnly}`);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const values = {
      ref: f.ref.trim(),
      label: f.label.trim(),
      kind: f.kind,
      unit: f.unit,
      price: Math.round(Number(f.price) || 0),
      // Prix d'achat facultatif : vide = inconnu (la marge n'est pas calculée).
      cost: String(f.cost ?? "").trim() === "" ? null : Math.round(Number(f.cost) || 0),
      vat_rate: Number(f.vat_rate) || 0,
      // Stock suivi : produits seulement ; le seuil d'alerte déclenche « Stock bas ».
      track_stock: f.kind === "product" && f.track_stock === "on",
      stock_alert: f.kind === "product" && f.track_stock === "on" ? Math.max(0, Number(f.stock_alert) || 0) : 0,
    };
    const isNew = editing === "new";
    const id = isNew ? db.newId("art") : (editing as SyncRecord).id;
    await savePatch(db, "articles", id, isNew ? {} : (editing as SyncRecord).data, values);
    const initial = Number(f.initial_qty) || 0;
    if (isNew && values.track_stock && initial > 0) {
      await db.write("stock_moves", db.newId("stk"), {
        article_id: id, kind: "initial", created_at: new Date().toISOString(), qty: initial, date: today(), unit_cost: values.cost, created_by: session.user.id, created_by_name: session.user.name,
      });
    }
    setEditing(null);
  }

  const v = (k: string, fallback = "") => (editing && editing !== "new" ? text(editing.data[k]) : fallback);

  return (
    <section>
      <div className="page-head">
        <div>
          <h2>Articles et services</h2>
          <p className="muted small">{articles.length === 0 ? "Votre catalogue de produits et services" : `${articles.length} article${articles.length > 1 ? "s" : ""}`}{levels.size > 0 ? ` · stock valorisé ${formatXaf(stockValue)}` : ""}</p>
        </div>
        <div className="actions">
          <ImportCsv kind="articles" />
          {levels.size > 0 && (
            <button onClick={() => { setEditing(null); setStockOf(null); setOrdering([...levels].filter(([, l]) => l.low).map(([id]) => id)); }}>
              Commander{lowCount > 0 ? ` (${lowCount} en stock bas)` : ""}
            </button>
          )}
          <button className="primary" onClick={() => openForm("new")}>Nouvel article</button>
        </div>
      </div>

      {editing && (
        <form className="card form-grid" onSubmit={save} key={editing === "new" ? "new" : editing.id}>
          <label>Désignation<input name="label" required defaultValue={v("label")} /></label>
          <label>Référence<input name="ref" defaultValue={v("ref")} /></label>
          <label>
            Type
            <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
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
          <label>Prix d'achat HT (FCFA)<input name="cost" type="number" min="0" step="1" placeholder="Facultatif, pour la marge" defaultValue={v("cost")} /></label>
          <label>TVA %<input name="vat_rate" type="number" min="0" step="any" defaultValue={v("vat_rate", String(DEFAULT_VAT_RATE))} /></label>
          {kind === "product" && <StockFields editing={editing} />}
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

      {ordering && <PurchaseOrderForm articles={articles} levels={levels} preset={ordering} onClose={() => setOrdering(null)} />}
      <OpenOrders articles={articles} levels={levels} />

      {stockOf && articles.some((a) => a.id === stockOf) && (
        <StockPanel key={stockOf} article={articles.find((a) => a.id === stockOf)!} level={levels.get(stockOf)} onClose={() => setStockOf(null)} />
      )}

      <div className="toolbar">
        <input type="search" placeholder="Rechercher un article" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Rechercher un article" />
        {levels.size > 0 && (
          <div className="segmented" role="group" aria-label="Filtrer les articles">
            <button className={!lowOnly ? "active" : ""} aria-pressed={!lowOnly} onClick={() => setLowOnly(false)}>Tous</button>
            <button className={lowOnly ? "active" : ""} aria-pressed={lowOnly} onClick={() => setLowOnly(true)}>
              Stock bas{lowCount > 0 && <span className="seg-count">{lowCount}</span>}
            </button>
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="empty">{articles.length === 0 ? "Catalogue vide. Ajoutez vos produits et services pour les retrouver dans les factures." : "Aucun résultat."}</p>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Référence</th><th>Désignation</th><th>Type</th><th className="right">Prix HT</th><th className="right">Marge</th>{levels.size > 0 && <th className="right">Stock</th>}<th className="right">TVA</th><th className="col-action"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{text(a.data.ref)}</td>
                  <td>{text(a.data.label)}{a.data.unit ? <span className="muted"> / {text(a.data.unit)}</span> : null}</td>
                  <td>{a.data.kind === "product" ? "Produit" : "Service"}</td>
                  <td className="right mono">{formatXaf(Number(a.data.price ?? 0))}</td>
                  <td className="right mono">{marginLabel(a)}</td>
                  {levels.size > 0 && <td className="right c-stock">{(() => {
                    const l = levels.get(a.id);
                    if (!l) return <span className="muted">—</span>;
                    return (
                      <button className="link stock-link mono" onClick={() => { setEditing(null); setStockOf(a.id); }} aria-label={`Stock de ${text(a.data.label)} : ${qtyFr(l.qty)}`}>
                        {qtyFr(l.qty)}{l.low && <span className="badge danger stock-low">Stock bas</span>}
                        {ordered.get(a.id) ? <span className="on-order" title="Commandé, pas encore reçu">+{qtyFr(ordered.get(a.id)!)} en commande</span> : null}
                      </button>
                    );
                  })()}</td>}
                  <td className="right">{text(a.data.vat_rate)} %</td>
                  <td className="right col-action"><button className="ghost small" onClick={() => openForm(a)}>Modifier</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {pager}
        </div>
      )}
    </section>
  );
}

/** Marge unitaire en pourcentage du prix de vente, si le prix d'achat est connu. */
function marginLabel(a: SyncRecord): string {
  const c = a.data.cost;
  const p = Number(a.data.price ?? 0);
  if (c === undefined || c === null || c === "" || p <= 0) return "—";
  return `${Math.round(((p - Number(c)) / p) * 100)} %`;
}

/** Champs de stock d'un produit : suivi, seuil d'alerte, stock de départ. */
function StockFields({ editing }: { editing: SyncRecord | "new" }) {
  const existing = editing === "new" ? null : editing;
  const [tracked, setTracked] = useState(existing ? Boolean(existing.data.track_stock) : false);
  return (
    <fieldset className="stock-fields">
      <label className="check-inline">
        <input type="checkbox" name="track_stock" checked={tracked} onChange={(e) => setTracked(e.target.checked)} />
        Suivre le stock de ce produit
      </label>
      {tracked && (
        <>
          <label>Seuil d'alerte<input name="stock_alert" type="number" min="0" step="any" defaultValue={existing ? text(existing.data.stock_alert) || "0" : "0"} /></label>
          {!existing && <label>Stock de départ<input name="initial_qty" type="number" min="0" step="any" defaultValue="0" /></label>}
          <p className="hint">Les ventes font sortir le stock automatiquement : au bon de livraison, sinon à la facture validée. Les entrées se saisissent depuis la colonne Stock.</p>
        </>
      )}
    </fieldset>
  );
}

type StockAction = "purchase" | "adjust" | null;

/** Fiche de stock d'un produit : niveau, valeur, réceptions, corrections et historique. */
function StockPanel({ article, level, onClose }: { article: SyncRecord; level: StockLevel | undefined; onClose: () => void }) {
  const { db, session, go } = useApp();
  const { moves } = useStock();
  const [action, setAction] = useState<StockAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<StockMoveKind>("inventory");
  const unit = text(article.data.unit);
  const history = moves.filter((m) => m.articleId === article.id).slice(0, 15);
  const q = level?.qty ?? 0;

  async function receive(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const qty = Number(f.qty);
    const cost = Math.round(Number(f.unit_cost) || 0);
    if (!(qty > 0)) return setError("Indiquez la quantité reçue.");
    await db.write("stock_moves", db.newId("stk"), {
      article_id: article.id, kind: "purchase", created_at: new Date().toISOString(), qty, unit_cost: cost, supplier: f.supplier.trim(), reference: f.reference.trim(),
      date: f.date || today(), created_by: session.user.id, created_by_name: session.user.name,
    });
    // Le prix d'achat de l'article devient le coût moyen pondéré : marge et valeur du stock suivent.
    if (cost > 0) await db.write("articles", article.id, { cost: weightedCost(q, level?.unitCost ?? null, qty, cost) });
    setAction(null);
  }

  async function adjust(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const n = Number(f.qty);
    if (f.qty === "" || !(n >= 0)) return setError("Indiquez une quantité positive.");
    const delta = reason === "inventory" ? n - q : reason === "return" ? n : -n;
    if (delta === 0) return setError(reason === "inventory" ? "Le stock compté est déjà celui affiché." : "Indiquez une quantité.");
    await db.write("stock_moves", db.newId("stk"), {
      article_id: article.id, kind: reason, created_at: new Date().toISOString(), qty: delta, note: f.note.trim(), date: f.date || today(),
      created_by: session.user.id, created_by_name: session.user.name,
    });
    setAction(null);
  }

  return (
    <div className="card stock-panel" aria-label={`Stock de ${text(article.data.label)}`} role="region">
      <div className="stock-head">
        <div>
          <div className="aside-label">Stock · {text(article.data.label)}</div>
          <div className={`aside-amount mono${level?.low ? " danger-text" : ""}`} data-testid="stock-qty">{qtyFr(q)}{unit ? ` ${unit}` : ""}</div>
          <p className="aside-sub">
            {level?.unitCost !== null && level?.unitCost !== undefined ? `Coût moyen ${formatXaf(level.unitCost)} · valeur ${formatXaf(level.value)}` : "Coût d'achat inconnu : renseignez-le à la réception."}
            {level && level.alert > 0 ? ` · alerte à ${qtyFr(level.alert)}` : ""}
          </p>
        </div>
        <div className="actions">
          <button className={action === "purchase" ? "primary" : ""} onClick={() => { setError(null); setAction(action === "purchase" ? null : "purchase"); }}>Réception fournisseur</button>
          <button className={action === "adjust" ? "primary" : ""} onClick={() => { setError(null); setAction(action === "adjust" ? null : "adjust"); }}>Corriger le stock</button>
          <button className="ghost" onClick={onClose}>Fermer</button>
        </div>
      </div>

      {action === "purchase" && (
        <form className="form-grid stock-form" onSubmit={receive}>
          <label>Quantité reçue<input name="qty" type="number" min="0" step="any" required autoFocus /></label>
          <label>Coût d'achat unitaire HT (FCFA)<input name="unit_cost" type="number" min="0" step="1" defaultValue={level?.unitCost ?? ""} /></label>
          <label>Fournisseur<input name="supplier" /></label>
          <label>N° du bon ou de la facture fournisseur<input name="reference" /></label>
          <label>Reçu le<input name="date" type="date" defaultValue={today()} /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="form-actions"><button className="primary">Enregistrer la réception</button></div>
        </form>
      )}
      {action === "adjust" && (
        <form className="form-grid stock-form" onSubmit={adjust}>
          <label>Motif
            <select value={reason} onChange={(e) => setReason(e.target.value as StockMoveKind)}>
              {(["inventory", "return", "loss"] as StockMoveKind[]).map((k) => <option key={k} value={k}>{STOCK_MOVE_LABELS[k]}</option>)}
            </select>
          </label>
          <label>{reason === "inventory" ? "Quantité comptée" : reason === "return" ? "Quantité retournée" : "Quantité perdue"}<input name="qty" type="number" min="0" step="any" required autoFocus /></label>
          <label>Commentaire<input name="note" placeholder="Facultatif" /></label>
          <label>Le<input name="date" type="date" defaultValue={today()} /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="form-actions"><button className="primary">Enregistrer la correction</button></div>
        </form>
      )}

      <h3 className="stock-history-title">Mouvements</h3>
      {history.length === 0 ? <p className="muted small">Aucun mouvement pour l'instant.</p> : (
        <ul className="stock-history">
          {history.map((m, i) => (
            <li key={`${m.sourceId}-${i}`}>
              <span className="muted">{formatDate(m.date)}</span>
              {m.table === "stock_moves" ? <span>{m.label}</span>
                : <button className="link" onClick={() => go(m.table === "invoices" ? "invoices" : "quotes", m.sourceId)}>{m.label}</button>}
              <span className={`mono ${m.qty < 0 ? "" : "ok-text"}`}>{m.qty > 0 ? "+" : ""}{qtyFr(m.qty)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
