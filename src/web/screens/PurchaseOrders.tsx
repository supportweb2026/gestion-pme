/**
 * Commandes fournisseurs, intégrées au catalogue : on commande depuis Articles
 * (les produits en stock bas sont proposés avec la quantité à recommander), on envoie
 * la commande au fournisseur par WhatsApp ou e-mail, puis on la réceptionne :
 * la réception crée les entrées de stock et met à jour le coût moyen de chaque article.
 */
import { useMemo, useState, type FormEvent } from "react";
import { formatDate, text, today, useApp, useSettings, useTable } from "../context.ts";
import { formatXaf } from "../../shared/invoice.ts";
import type { SyncRecord } from "../../shared/sync.ts";
import {
  isTracked, orderMessage, orderTotal, qtyFr, suggestedQty, weightedCost, type PurchaseLine, type StockLevel,
} from "../../shared/stock.ts";

/** Référence lisible d'une commande : « CF-221126-1 » (date et rang du jour). */
function nextReference(orders: SyncRecord[], date: string): string {
  const stamp = date.slice(2).replaceAll("-", "").replace(/^(\d{2})(\d{2})(\d{2})$/, "$3$2$1");
  const sameDay = orders.filter((o) => text(o.data.reference).startsWith(`CF-${stamp}-`)).length;
  return `CF-${stamp}-${sameDay + 1}`;
}

export function PurchaseOrderForm({ articles, levels, preset, onClose }: {
  articles: SyncRecord[]; levels: Map<string, StockLevel>; preset: string[]; onClose: () => void;
}) {
  const { db, session } = useApp();
  const orders = useTable("purchase_orders");
  const tracked = articles.filter(isTracked).sort((a, b) => text(a.data.label).localeCompare(text(b.data.label), "fr"));
  const lineFor = (a: SyncRecord): PurchaseLine => ({
    articleId: a.id,
    label: text(a.data.label),
    qty: levels.get(a.id) ? suggestedQty(levels.get(a.id)!) : 1,
    unitCost: Number(levels.get(a.id)?.unitCost ?? a.data.cost ?? 0) || 0,
  });
  const [lines, setLines] = useState<PurchaseLine[]>(() => {
    const start = tracked.filter((a) => preset.includes(a.id)).map(lineFor);
    return start.length ? start : tracked.slice(0, 1).map(lineFor);
  });
  const [error, setError] = useState<string | null>(null);
  const suppliers = useMemo(() => [...new Set(orders.map((o) => text(o.data.supplier)).filter(Boolean))], [orders]);
  const update = (i: number, patch: Partial<PurchaseLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const clean = lines.filter((l) => l.articleId && l.qty > 0);
    if (!f.supplier.trim()) return setError("Indiquez le fournisseur.");
    if (clean.length === 0) return setError("Ajoutez au moins un article avec une quantité.");
    const date = f.date || today();
    await db.write("purchase_orders", db.newId("cf"), {
      reference: nextReference(orders, date), supplier: f.supplier.trim(), supplier_phone: f.supplier_phone.trim(), date,
      expected_at: f.expected_at, lines: clean, status: "ordered", notes: f.notes.trim(),
      created_by: session.user.id, created_by_name: session.user.name, created_at: new Date().toISOString(),
    });
    onClose();
  }

  return (
    <form className="card purchase-form" onSubmit={save} aria-label="Nouvelle commande fournisseur">
      <div className="section-head"><h3>Commande fournisseur</h3></div>
      <div className="form-grid">
        <label>Fournisseur<input name="supplier" list="suppliers-list" required autoFocus /></label>
        <datalist id="suppliers-list">{suppliers.map((s) => <option key={s} value={s} />)}</datalist>
        <label>WhatsApp du fournisseur<input name="supplier_phone" type="tel" placeholder="+241 …" /></label>
        <label>Commandé le<input name="date" type="date" defaultValue={today()} /></label>
        <label>Livraison prévue le<input name="expected_at" type="date" /></label>
      </div>
      <div className="lines-wrap">
        <table className="lines purchase-lines">
          <thead><tr><th>Article</th><th className="num right">En stock</th><th className="num right">À commander</th><th className="num right">Coût unitaire HT</th><th className="right">Montant HT</th><th><span className="sr-only">Retirer</span></th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select aria-label="Article commandé" value={l.articleId} onChange={(e) => {
                    const a = tracked.find((x) => x.id === e.target.value);
                    if (a) update(i, lineFor(a));
                  }}>
                    {tracked.map((a) => <option key={a.id} value={a.id}>{text(a.data.label)}</option>)}
                  </select>
                </td>
                <td className="num right mono muted">{levels.get(l.articleId) ? qtyFr(levels.get(l.articleId)!.qty) : "—"}</td>
                <td className="num"><input aria-label="Quantité à commander" type="number" min="0" step="any" value={l.qty} onChange={(e) => update(i, { qty: Number(e.target.value) })} /></td>
                <td className="num"><input aria-label="Coût unitaire HT" type="number" min="0" step="1" value={l.unitCost} onChange={(e) => update(i, { unitCost: Number(e.target.value) })} /></td>
                <td className="right mono">{formatXaf(Math.round(l.qty * l.unitCost))}</td>
                <td className="del">
                  <button type="button" className="ghost icon" aria-label={`Retirer la ligne ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12" /><path d="M18 6 6 18" /></svg>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="line-tools">
        <button type="button" className="ghost add-line" disabled={tracked.length === 0} onClick={() => {
          const next = tracked.find((a) => !lines.some((l) => l.articleId === a.id)) ?? tracked[0];
          if (next) setLines((ls) => [...ls, lineFor(next)]);
        }}>+ Ajouter un article</button>
        <span className="purchase-total">Total HT <b className="mono" data-testid="order-total">{formatXaf(orderTotal(lines))}</b></span>
      </div>
      <label>Note pour le fournisseur<input name="notes" placeholder="Facultatif" /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="ghost" onClick={onClose}>Annuler</button>
        <button className="primary">Enregistrer la commande</button>
      </div>
    </form>
  );
}

/** Commandes en cours : envoi au fournisseur, réception (entrée en stock), annulation. */
export function OpenOrders({ articles, levels }: { articles: SyncRecord[]; levels: Map<string, StockLevel> }) {
  const { db, session } = useApp();
  const settings = useSettings();
  const orders = useTable("purchase_orders");
  const open = orders.filter((o) => o.data.status === "ordered").sort((a, b) => text(a.data.date).localeCompare(text(b.data.date)));
  const [busy, setBusy] = useState<string | null>(null);
  if (open.length === 0) return null;
  const units = new Map(articles.map((a) => [a.id, text(a.data.unit)]));

  async function receive(o: SyncRecord) {
    if (!confirm(`Réceptionner la commande ${text(o.data.reference)} ? Les quantités entrent en stock.`)) return;
    setBusy(o.id);
    try {
      const lines = (o.data.lines as PurchaseLine[]) ?? [];
      // Coût moyen pondéré recalculé ligne par ligne (un même article peut figurer deux fois).
      const running = new Map<string, { qty: number; cost: number | null }>();
      for (const l of lines) {
        const lv = running.get(l.articleId) ?? { qty: levels.get(l.articleId)?.qty ?? 0, cost: levels.get(l.articleId)?.unitCost ?? null };
        await db.write("stock_moves", db.newId("stk"), {
          article_id: l.articleId, kind: "purchase", qty: l.qty, unit_cost: l.unitCost, supplier: text(o.data.supplier), reference: text(o.data.reference),
          order_id: o.id, date: today(), created_at: new Date().toISOString(), created_by: session.user.id, created_by_name: session.user.name,
        });
        const cost = l.unitCost > 0 ? weightedCost(lv.qty, lv.cost, l.qty, l.unitCost) : lv.cost;
        running.set(l.articleId, { qty: lv.qty + l.qty, cost });
      }
      for (const [id, v] of running) if (v.cost !== null) await db.write("articles", id, { cost: v.cost });
      await db.write("purchase_orders", o.id, { status: "received", received_at: new Date().toISOString(), received_by: session.user.id });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card open-orders" role="region" aria-label="Commandes fournisseurs en cours">
      <h3>Commandes fournisseurs en cours</h3>
      <ul>
        {open.map((o) => {
          const lines = (o.data.lines as PurchaseLine[]) ?? [];
          const msg = orderMessage({ company: text(settings.name), supplier: text(o.data.supplier), reference: text(o.data.reference), lines, units });
          const phone = text(o.data.supplier_phone).replace(/[^\d]/g, "");
          const late = text(o.data.expected_at) && text(o.data.expected_at) < today();
          return (
            <li key={o.id} className="open-order">
              <div className="open-order-main">
                <div><b className="mono">{text(o.data.reference)}</b> · {text(o.data.supplier)}</div>
                <div className="muted small">
                  {lines.map((l) => `${qtyFr(l.qty)} × ${l.label}`).join(", ")} · {formatXaf(orderTotal(lines))} HT
                </div>
                <div className={`small ${late ? "danger-text" : "muted"}`}>
                  Commandée le {formatDate(o.data.date)}{o.data.expected_at ? ` · livraison ${late ? "attendue depuis" : "prévue"} le ${formatDate(o.data.expected_at)}` : ""}
                </div>
              </div>
              <div className="actions">
                <a className="button" href={`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`} target="_blank" rel="noopener noreferrer">Envoyer par WhatsApp</a>
                <button className="primary" disabled={busy === o.id} onClick={() => receive(o)}>Réceptionner</button>
                <button className="ghost" onClick={async () => { if (confirm("Annuler cette commande ?")) await db.write("purchase_orders", o.id, { status: "cancelled" }); }}>Annuler la commande</button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
