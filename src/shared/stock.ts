/**
 * Stock des produits suivis.
 *
 * Les entrées et corrections sont des mouvements saisis (table `stock_moves`) :
 * stock initial, réception fournisseur, inventaire. Les sorties ne se saisissent pas :
 * elles se déduisent des ventes, pour qu'un même article ne sorte jamais deux fois.
 *  - Un bon de livraison finalisé fait sortir ses articles.
 *  - Une facture validée fait sortir ses articles, sauf si un bon de livraison finalisé
 *    couvre déjà la vente (établi d'après cette facture ou d'après le même devis).
 * Un avoir ne remet rien en stock : un retour de marchandise se saisit (mouvement « Retour client »).
 * La valeur du stock suit le coût moyen unitaire pondéré (CMUP), recalculé à chaque réception.
 */

export type StockMoveKind = "initial" | "purchase" | "inventory" | "return" | "loss";

export const STOCK_MOVE_LABELS: Record<StockMoveKind, string> = {
  initial: "Stock initial",
  purchase: "Réception fournisseur",
  inventory: "Inventaire",
  return: "Retour client",
  loss: "Perte ou casse",
};

interface Rec {
  id: string;
  data: Record<string, unknown>;
}
interface Line {
  articleId?: string;
  qty: number;
  deposit?: boolean;
  depositInvoiceId?: string;
  section?: boolean;
}

export interface StockMove {
  articleId: string;
  date: string;
  /** Positif = entrée, négatif = sortie. */
  qty: number;
  kind: StockMoveKind | "sale" | "delivery";
  label: string;
  /** Document ou mouvement d'origine. */
  sourceId: string;
  table: "stock_moves" | "invoices" | "quotes";
  /** Horodatage de saisie, pour ordonner les mouvements d'un même jour. */
  at?: string;
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const linesOf = (r: Rec) => ((r.data.lines as Line[]) ?? []).filter((l) => l.articleId && !l.section && !l.deposit && !l.depositInvoiceId);

/** Vrai si l'article est un produit dont on suit le stock. */
export const isTracked = (a: Rec | undefined | null) => Boolean(a && a.data.kind === "product" && a.data.track_stock);

/** Bons de livraison finalisés. */
const deliveries = (quotes: Rec[]) => quotes.filter((q) => q.data.doc_type === "delivery" && str(q.data.number) !== "");

/** Mouvements déduits des ventes (bons de livraison et factures). */
export function salesMoves(invoices: Rec[], quotes: Rec[]): StockMove[] {
  const out: StockMove[] = [];
  const bls = deliveries(quotes);
  const covered = new Set(bls.map((b) => str(b.data.source_id)).filter(Boolean));
  for (const b of bls) {
    for (const l of linesOf(b)) {
      out.push({ articleId: l.articleId!, date: str(b.data.date), qty: -Math.abs(Number(l.qty) || 0), kind: "delivery", label: `Livraison ${str(b.data.number)}`, sourceId: b.id, table: "quotes" });
    }
  }
  for (const inv of invoices) {
    if (inv.data.status !== "validated" || inv.data.deposit) continue;
    if (covered.has(inv.id) || (inv.data.quote_id && covered.has(str(inv.data.quote_id)))) continue;
    for (const l of linesOf(inv)) {
      out.push({ articleId: l.articleId!, date: str(inv.data.date), qty: -Math.abs(Number(l.qty) || 0), kind: "sale", label: `Facture ${str(inv.data.number)}`, sourceId: inv.id, table: "invoices" });
    }
  }
  return out;
}

/** Mouvements saisis (entrées, inventaires, retours, pertes). */
export function manualMoves(moves: Rec[]): StockMove[] {
  return moves.map((m) => {
    const kind = (str(m.data.kind) || "inventory") as StockMoveKind;
    const who = str(m.data.supplier);
    return {
      articleId: str(m.data.article_id),
      date: str(m.data.date),
      qty: Number(m.data.qty) || 0,
      kind,
      label: `${STOCK_MOVE_LABELS[kind] ?? "Mouvement"}${who ? ` · ${who}` : ""}${m.data.reference ? ` · ${str(m.data.reference)}` : ""}`,
      sourceId: m.id,
      table: "stock_moves" as const,
      at: str(m.data.created_at),
    };
  });
}

export interface StockLevel {
  qty: number;
  /** Coût moyen unitaire (CMUP), ou null s'il est inconnu. */
  unitCost: number | null;
  value: number;
  alert: number;
  low: boolean;
}

/** Quantité en stock par article suivi. */
export function stockLevels(articles: Rec[], moves: StockMove[]): Map<string, StockLevel> {
  const qty = new Map<string, number>();
  for (const m of moves) qty.set(m.articleId, (qty.get(m.articleId) ?? 0) + m.qty);
  const out = new Map<string, StockLevel>();
  for (const a of articles) {
    if (!isTracked(a)) continue;
    const q = Math.round((qty.get(a.id) ?? 0) * 1000) / 1000;
    const c = a.data.cost === undefined || a.data.cost === null || a.data.cost === "" ? null : Number(a.data.cost);
    const alert = Number(a.data.stock_alert) || 0;
    out.set(a.id, { qty: q, unitCost: c, value: c === null ? 0 : Math.round(Math.max(0, q) * c), alert, low: q <= alert });
  }
  return out;
}

/** Nouveau coût moyen pondéré après une réception. */
export function weightedCost(stockQty: number, stockCost: number | null, inQty: number, inCost: number): number {
  const before = Math.max(0, stockQty);
  if (before === 0 || stockCost === null) return Math.round(inCost);
  return Math.round((before * stockCost + inQty * inCost) / (before + inQty));
}

/** Quantité au format français (« 12 », « 2,5 »). */
export const qtyFr = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 3 });
