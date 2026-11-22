/**
 * Tableau de bord des gains : calculs purs sur les données locales (donc hors ligne).
 *
 * Tout est ramené en francs CFA au taux mémorisé sur chaque document.
 * - Chiffre d'affaires : lignes des factures validées datées dans la période,
 *   moins les lignes des avoirs validés datés dans la période.
 * - Marge brute : CA HT moins le coût d'achat des lignes (prix d'achat noté sur la ligne,
 *   sinon prix d'achat actuel de l'article). Les lignes sans prix d'achat sont exclues
 *   de la marge et signalées par le taux de couverture.
 * - Encaissé : encaissements datés dans la période, quelle que soit la date de la facture.
 */
import { computeTotals, lineNet, lineVat, PAYMENT_METHODS, roundAmount, type InvoiceLine } from "../shared/invoice.ts";
import { decimalsOf, toXaf } from "../shared/currency.ts";
import type { SyncRecord } from "../shared/sync.ts";
import { currencyOf, invoiceSituations, linesOf, quoteStatus, rateOf, type Situation } from "./ledger.ts";

export type DocStatusFilter = "paid" | "partial" | "unpaid" | "overdue";
export type LineKind = "product" | "service" | "free";

export interface ReportFilters {
  /** Bornes incluses, AAAA-MM-JJ. */
  from: string;
  to: string;
  clients: string[];
  articles: string[];
  kinds: LineKind[];
  statuses: DocStatusFilter[];
  methods: string[];
  sellers: string[];
  currencies: string[];
  vatRates: number[];
}

export const EMPTY_FILTERS: Omit<ReportFilters, "from" | "to"> = {
  clients: [], articles: [], kinds: [], statuses: [], methods: [], sellers: [], currencies: [], vatRates: [],
};

export interface ReportInput {
  invoices: SyncRecord[];
  credits: SyncRecord[];
  payments: SyncRecord[];
  quotes: SyncRecord[];
  articles: SyncRecord[];
  /** Date du jour, AAAA-MM-JJ (pour les retards et la balance âgée). */
  today: string;
}

/** Une ligne vendue (ou retirée par un avoir, signe négatif), en FCFA. */
export interface LineFact {
  docId: string;
  invoiceId: string;
  number: string;
  date: string;
  clientId: string;
  seller: string;
  currency: string;
  articleKey: string;
  label: string;
  kind: LineKind;
  vatRate: number;
  qty: number;
  net: number;
  vat: number;
  /** Coût d'achat HT, null si inconnu. */
  cost: number | null;
  sign: 1 | -1;
}

export interface Kpis {
  revenue: number;
  revenueGross: number;
  vat: number;
  credits: number;
  margin: number;
  /** Part du CA dont le prix d'achat est connu (0 à 1). */
  marginCoverage: number;
  /** Taux de marge sur le CA couvert (0 à 1), null si aucun coût connu. */
  marginRate: number | null;
  collected: number;
  due: number;
  overdue: number;
  invoiceCount: number;
  averageBasket: number;
  activeClients: number;
  newClients: number;
  /** Délai moyen entre la facture et son dernier encaissement, en jours (factures soldées). */
  paymentDelay: number | null;
  quotesSent: number;
  quotesSigned: number;
  quotesSignedAmount: number;
  /** Devis acceptés ou facturés / devis décidés ou expirés. */
  conversion: number | null;
}

export interface Breakdown {
  key: string;
  label: string;
  revenue: number;
  margin: number | null;
  qty: number;
  count: number;
  collected: number;
  due: number;
}

export interface SeriesPoint {
  key: string;
  label: string;
  revenue: number;
  collected: number;
  margin: number;
}

export interface Report {
  kpis: Kpis;
  series: SeriesPoint[];
  granularity: "day" | "week" | "month";
  byClient: Breakdown[];
  byArticle: Breakdown[];
  bySeller: Breakdown[];
  byMethod: Breakdown[];
  byVat: Breakdown[];
  aging: { key: string; label: string; amount: number; count: number }[];
  documents: {
    id: string; number: string; date: string; dueDate: string; clientId: string; seller: string; currency: string;
    revenue: number; gross: number; collected: number; due: number; status: Situation["status"];
  }[];
  lines: LineFact[];
}

const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const inRange = (d: string, f: { from: string; to: string }) => d >= f.from && d <= f.to;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** Vendeur d'un document : celui qui l'a créé. */
export const sellerOf = (r: SyncRecord | null | undefined) => s(r?.data.created_by) || "inconnu";

/** Clé d'article d'une ligne : l'article du catalogue, sinon la désignation libre. */
export const articleKeyOf = (l: InvoiceLine) => (l.articleId ? `a:${l.articleId}` : `l:${l.label.trim().toLowerCase()}`);

function lineKindOf(l: InvoiceLine, articles: Map<string, SyncRecord>): LineKind {
  if (!l.articleId) return "free";
  return articles.get(l.articleId)?.data.kind === "product" ? "product" : "service";
}

/** Coût d'achat unitaire HT en devise du document, ou null. */
function unitCostOf(l: InvoiceLine, articles: Map<string, SyncRecord>, rate: number): number | null {
  if (typeof l.cost === "number" && Number.isFinite(l.cost)) return l.cost;
  const a = l.articleId ? articles.get(l.articleId) : undefined;
  const c = a?.data.cost;
  if (c === undefined || c === null || c === "") return null;
  return Number(c) / (rate || 1);
}

/** Lignes vendues des factures et avoirs validés, toutes périodes confondues. */
export function lineFacts(input: ReportInput): LineFact[] {
  const articles = new Map(input.articles.map((a) => [a.id, a]));
  const invoices = new Map(input.invoices.map((i) => [i.id, i]));
  const out: LineFact[] = [];
  const push = (doc: SyncRecord, sign: 1 | -1, invoice: SyncRecord | undefined) => {
    const currency = currencyOf(doc);
    const rate = rateOf(doc);
    const d = decimalsOf(currency);
    for (const l of linesOf(doc)) {
      // Titres, acomptes et déductions d'acompte ne sont pas des ventes.
      if (l.section || l.deposit || l.depositInvoiceId) continue;
      const net = lineNet(l, d);
      const unitCost = unitCostOf(l, articles, rate);
      out.push({
        docId: doc.id,
        invoiceId: invoice?.id ?? "",
        number: s(doc.data.number),
        date: s(doc.data.date),
        clientId: s(doc.data.client_id),
        seller: sellerOf(invoice ?? doc),
        currency,
        articleKey: articleKeyOf(l),
        label: (l.articleId && s(articles.get(l.articleId)?.data.label)) || l.label.trim() || "(sans désignation)",
        kind: lineKindOf(l, articles),
        vatRate: Number(l.vatRate) || 0,
        qty: sign * (Number(l.qty) || 0),
        net: sign * toXaf(net, rate),
        vat: sign * toXaf(lineVat(l, d), rate),
        cost: unitCost === null ? null : sign * toXaf(roundAmount(unitCost * (Number(l.qty) || 0), d), rate),
        sign,
      });
    }
  };
  for (const inv of input.invoices) if (inv.data.status === "validated") push(inv, 1, inv);
  for (const c of input.credits) {
    if (c.data.status !== "validated") continue;
    push(c, -1, invoices.get(s(c.data.invoice_id)));
  }
  return out;
}

/** Granularité adaptée à la longueur de la période. */
export function granularityFor(from: string, to: string): Report["granularity"] {
  const n = daysBetween(from, to) + 1;
  return n <= 45 ? "day" : n <= 120 ? "week" : "month";
}

const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/** Lundi de la semaine d'une date. */
function mondayOf(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function bucketOf(date: string, g: Report["granularity"]): string {
  if (g === "month") return date.slice(0, 7);
  if (g === "week") return mondayOf(date);
  return date.slice(0, 10);
}

/** Toutes les cases de la période, dans l'ordre, avec leur libellé court. */
export function buckets(from: string, to: string, g: Report["granularity"]): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  if (g === "month") {
    const [fy, fm] = from.slice(0, 7).split("-").map(Number);
    const [ty, tm] = to.slice(0, 7).split("-").map(Number);
    for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); ) {
      out.push({ key: `${y}-${String(m).padStart(2, "0")}`, label: `${MONTHS[m - 1]} ${String(y).slice(2)}` });
      if (++m > 12) { m = 1; y++; }
    }
    return out;
  }
  const d = new Date(`${g === "week" ? mondayOf(from) : from}T12:00:00Z`);
  const end = Date.parse(`${to}T12:00:00Z`);
  while (d.getTime() <= end) {
    const key = d.toISOString().slice(0, 10);
    out.push({ key, label: `${Number(key.slice(8, 10))} ${MONTHS[Number(key.slice(5, 7)) - 1]}` });
    d.setUTCDate(d.getUTCDate() + (g === "week" ? 7 : 1));
  }
  return out;
}

/** Période précédente de même durée, ou même période un an plus tôt. */
export function comparePeriod(from: string, to: string, mode: "previous" | "year"): { from: string; to: string } {
  const shift = (iso: string, days: number) => {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  if (mode === "year") {
    const y = (iso: string) => {
      const d = new Date(`${iso}T12:00:00Z`);
      const month = d.getUTCMonth();
      d.setUTCFullYear(d.getUTCFullYear() - 1);
      if (d.getUTCMonth() !== month) d.setUTCDate(0); // 29 février
      return d.toISOString().slice(0, 10);
    };
    return { from: y(from), to: y(to) };
  }
  // Mois entiers (mois, trimestre, année) : on recule d'autant de mois calendaires.
  const lastDay = (iso: string) => shift(`${iso.slice(0, 7)}-01`, 32).slice(0, 7) + "-01";
  if (from.endsWith("-01") && shift(to, 1) === lastDay(to)) {
    const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
    const start = new Date(`${from}T12:00:00Z`);
    start.setUTCMonth(start.getUTCMonth() - months);
    const f = start.toISOString().slice(0, 10);
    return { from: f, to: shift(from, -1) };
  }
  const len = daysBetween(from, to) + 1;
  return { from: shift(from, -len), to: shift(to, -len) };
}

/** Calcule le tableau de bord pour une période et des filtres. */
export function buildReport(input: ReportInput, f: ReportFilters): Report {
  const sit = invoiceSituations(input.invoices, input.payments, input.credits);
  const invoices = new Map(input.invoices.map((i) => [i.id, i]));
  const g = granularityFor(f.from, f.to);

  // Encaissements par facture (en FCFA), avec moyen et date.
  const paysByInvoice = new Map<string, SyncRecord[]>();
  for (const p of input.payments) {
    const id = s(p.data.invoice_id);
    paysByInvoice.set(id, [...(paysByInvoice.get(id) ?? []), p]);
  }
  const payXaf = (p: SyncRecord) => Math.round(Number(p.data.amount ?? 0) * (Number(p.data.rate) || rateOf(invoices.get(s(p.data.invoice_id))) || 1));

  const lineFilter = f.articles.length > 0 || f.kinds.length > 0 || f.vatRates.length > 0;
  const lineOk = (l: LineFact) =>
    (f.articles.length === 0 || f.articles.includes(l.articleKey)) &&
    (f.kinds.length === 0 || f.kinds.includes(l.kind)) &&
    (f.vatRates.length === 0 || f.vatRates.includes(l.vatRate));

  /** Filtres portant sur la facture (client, vendeur, devise, statut, moyen de paiement). */
  const invoiceOk = (inv: SyncRecord | undefined, clientId: string, seller: string, currency: string) => {
    if (f.clients.length && !f.clients.includes(clientId)) return false;
    if (f.sellers.length && !f.sellers.includes(seller)) return false;
    if (f.currencies.length && !f.currencies.includes(currency)) return false;
    if (f.statuses.length || f.methods.length) {
      if (!inv) return false;
      const st = sit.get(inv.id)?.status;
      if (f.statuses.length && !(st && f.statuses.includes(st as DocStatusFilter))) return false;
      if (f.methods.length && !(paysByInvoice.get(inv.id) ?? []).some((p) => f.methods.includes(s(p.data.method)))) return false;
    }
    return true;
  };

  const all = lineFacts(input);
  const lines = all.filter((l) => inRange(l.date, f) && lineOk(l) && invoiceOk(invoices.get(l.invoiceId), l.clientId, l.seller, l.currency));

  // Factures retenues : validées, datées dans la période, passant les filtres
  // (et contenant au moins une ligne retenue si un filtre de ligne est actif).
  const withMatchingLine = new Set(lines.filter((l) => l.sign === 1).map((l) => l.docId));
  const docs = input.invoices.filter((inv) =>
    inv.data.status === "validated" && inRange(s(inv.data.date), f) &&
    invoiceOk(inv, s(inv.data.client_id), sellerOf(inv), currencyOf(inv)) &&
    (!lineFilter || withMatchingLine.has(inv.id)));

  // Encaissements de la période : facture passant les filtres, moyen choisi.
  const articleMap = new Map(input.articles.map((a) => [a.id, a]));
  const invoiceHasLine = (inv: SyncRecord) =>
    linesOf(inv).some((l) => lineOk({ articleKey: articleKeyOf(l), kind: lineKindOf(l, articleMap), vatRate: Number(l.vatRate) || 0 } as LineFact));
  const payments = input.payments.filter((p) => {
    if (!inRange(s(p.data.date), f)) return false;
    if (f.methods.length && !f.methods.includes(s(p.data.method))) return false;
    const inv = invoices.get(s(p.data.invoice_id));
    if (!inv) return false;
    if (!invoiceOk(inv, s(inv.data.client_id), sellerOf(inv), currencyOf(inv))) return false;
    if (lineFilter && !invoiceHasLine(inv)) return false;
    return true;
  });

  const revenue = lines.reduce((n, l) => n + l.net, 0);
  const vat = lines.reduce((n, l) => n + l.vat, 0);
  const creditsAmount = -lines.filter((l) => l.sign === -1).reduce((n, l) => n + l.net, 0);
  const costed = lines.filter((l) => l.cost !== null);
  const costedRevenue = costed.reduce((n, l) => n + l.net, 0);
  const margin = costed.reduce((n, l) => n + l.net - (l.cost ?? 0), 0);
  const positive = lines.filter((l) => l.sign === 1).reduce((n, l) => n + l.net, 0);
  const positiveCosted = costed.filter((l) => l.sign === 1).reduce((n, l) => n + l.net, 0);

  const collected = payments.reduce((n, p) => n + payXaf(p), 0);
  let due = 0;
  let overdue = 0;
  let delaySum = 0;
  let delayN = 0;
  for (const inv of docs) {
    const st = sit.get(inv.id)!;
    const d = Math.round(st.due * st.rate);
    due += d;
    if (st.status === "overdue") overdue += d;
    if (st.status === "paid") {
      const last = (paysByInvoice.get(inv.id) ?? []).map((p) => s(p.data.date)).sort().pop();
      if (last) {
        delaySum += Math.max(0, daysBetween(s(inv.data.date), last));
        delayN++;
      }
    }
  }

  // Clients actifs et nouveaux (première facture validée de leur histoire dans la période).
  const firstInvoice = new Map<string, string>();
  for (const inv of input.invoices) {
    if (inv.data.status !== "validated") continue;
    const c = s(inv.data.client_id);
    const d = s(inv.data.date);
    if (!firstInvoice.has(c) || d < firstInvoice.get(c)!) firstInvoice.set(c, d);
  }
  const active = new Set(docs.map((d) => s(d.data.client_id)));
  const newClients = [...active].filter((c) => inRange(firstInvoice.get(c) ?? "", f)).length;

  // Devis de la période (client, vendeur, devise).
  const quotes = input.quotes.filter((q) =>
    s(q.data.number) && inRange(s(q.data.date), f) &&
    (!f.clients.length || f.clients.includes(s(q.data.client_id))) &&
    (!f.sellers.length || f.sellers.includes(sellerOf(q))) &&
    (!f.currencies.length || f.currencies.includes(currencyOf(q))));
  const signed = quotes.filter((q) => ["accepted", "invoiced"].includes(quoteStatus(q)));
  const decided = quotes.filter((q) => ["accepted", "invoiced", "refused", "expired"].includes(quoteStatus(q)));
  const quoteNet = (q: SyncRecord) => toXaf(computeTotals(linesOf(q), decimalsOf(currencyOf(q))).net, rateOf(q));

  const kpis: Kpis = {
    revenue,
    revenueGross: revenue + vat,
    vat,
    credits: creditsAmount,
    margin,
    marginCoverage: positive > 0 ? positiveCosted / positive : 0,
    marginRate: costedRevenue > 0 ? margin / costedRevenue : null,
    collected,
    due,
    overdue,
    invoiceCount: docs.length,
    averageBasket: withMatchingLine.size ? Math.round(positive / docs.filter((d) => withMatchingLine.has(d.id)).length || 0) : 0,
    activeClients: active.size,
    newClients,
    paymentDelay: delayN ? Math.round(delaySum / delayN) : null,
    quotesSent: quotes.length,
    quotesSigned: signed.length,
    quotesSignedAmount: signed.reduce((n, q) => n + quoteNet(q), 0),
    conversion: decided.length ? signed.length / decided.length : null,
  };

  // Évolution dans le temps.
  const series = buckets(f.from, f.to, g).map((b) => ({ ...b, revenue: 0, collected: 0, margin: 0 }));
  const at = new Map(series.map((p) => [p.key, p]));
  for (const l of lines) {
    const p = at.get(bucketOf(l.date, g));
    if (!p) continue;
    p.revenue += l.net;
    if (l.cost !== null) p.margin += l.net - l.cost;
  }
  for (const p of payments) {
    const pt = at.get(bucketOf(s(p.data.date), g));
    if (pt) pt.collected += payXaf(p);
  }

  // Répartitions.
  const group = (keyOf: (l: LineFact) => string, labelOf: (l: LineFact) => string) => {
    const m = new Map<string, Breakdown & { costed: boolean; docs: Set<string> }>();
    for (const l of lines) {
      const k = keyOf(l);
      const b = m.get(k) ?? { key: k, label: labelOf(l), revenue: 0, margin: 0, qty: 0, count: 0, collected: 0, due: 0, costed: false, docs: new Set<string>() };
      b.revenue += l.net;
      b.qty += l.qty;
      if (l.cost !== null) { b.margin = (b.margin ?? 0) + l.net - l.cost; b.costed = true; }
      if (l.sign === 1) b.docs.add(l.docId);
      m.set(k, b);
    }
    return [...m.values()]
      .map(({ costed, docs: d, ...b }) => ({ ...b, margin: costed ? b.margin : null, count: d.size }))
      .sort((a, b) => b.revenue - a.revenue);
  };
  const byClient = group((l) => l.clientId, (l) => l.clientId);
  const bySeller = group((l) => l.seller, (l) => l.seller);
  // Encaissé et reste dû par client et par vendeur.
  const addMoney = (rows: Breakdown[], keyOf: (inv: SyncRecord) => string) => {
    const idx = new Map(rows.map((r) => [r.key, r]));
    for (const p of payments) {
      const inv = invoices.get(s(p.data.invoice_id))!;
      const r = idx.get(keyOf(inv));
      if (r) r.collected += payXaf(p);
    }
    for (const inv of docs) {
      const st = sit.get(inv.id)!;
      const r = idx.get(keyOf(inv));
      if (r) r.due += Math.round(st.due * st.rate);
    }
  };
  addMoney(byClient, (inv) => s(inv.data.client_id));
  addMoney(bySeller, sellerOf);

  const byArticle = group((l) => l.articleKey, (l) => l.label);
  const byVat = group((l) => String(l.vatRate), (l) => `${l.vatRate} %`);

  const methods = new Map<string, Breakdown>();
  for (const p of payments) {
    const k = s(p.data.method) || "autre";
    const b = methods.get(k) ?? { key: k, label: PAYMENT_METHODS[k] ?? "Autre", revenue: 0, margin: null, qty: 0, count: 0, collected: 0, due: 0 };
    b.collected += payXaf(p);
    b.count++;
    methods.set(k, b);
  }
  const byMethod = [...methods.values()].sort((a, b) => b.collected - a.collected);

  // Balance âgée à la date du jour, sur les factures passant les filtres (datées jusqu'à la fin de période).
  const ages = [
    { key: "current", label: "Pas encore échu", min: -Infinity, max: 0 },
    { key: "30", label: "1 à 30 jours", min: 1, max: 30 },
    { key: "60", label: "31 à 60 jours", min: 31, max: 60 },
    { key: "90", label: "61 à 90 jours", min: 61, max: 90 },
    { key: "more", label: "Plus de 90 jours", min: 91, max: Infinity },
  ].map((a) => ({ ...a, amount: 0, count: 0 }));
  for (const inv of input.invoices) {
    if (inv.data.status !== "validated" || s(inv.data.date) > f.to) continue;
    if (!invoiceOk(inv, s(inv.data.client_id), sellerOf(inv), currencyOf(inv))) continue;
    if (lineFilter && !invoiceHasLine(inv)) continue;
    const st = sit.get(inv.id)!;
    if (st.due <= 0) continue;
    const late = s(inv.data.due_date) ? daysBetween(s(inv.data.due_date), input.today) : 0;
    const a = ages.find((x) => late >= x.min && late <= x.max)!;
    a.amount += Math.round(st.due * st.rate);
    a.count++;
  }

  const documents = docs
    .map((inv) => {
      const st = sit.get(inv.id)!;
      const own = lines.filter((l) => l.docId === inv.id);
      return {
        id: inv.id,
        number: s(inv.data.number),
        date: s(inv.data.date),
        dueDate: s(inv.data.due_date),
        clientId: s(inv.data.client_id),
        seller: sellerOf(inv),
        currency: st.currency,
        revenue: own.reduce((n, l) => n + l.net, 0),
        gross: Math.round(st.gross * st.rate),
        collected: Math.round(st.paid * st.rate),
        due: Math.round(st.due * st.rate),
        status: st.status,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));

  return {
    kpis, series, granularity: g, byClient, byArticle, bySeller, byMethod, byVat,
    aging: ages.map(({ key, label, amount, count }) => ({ key, label, amount, count })),
    documents, lines,
  };
}

/** Évolution relative entre deux valeurs, null si la base est nulle. */
export function delta(current: number, previous: number): number | null {
  if (!previous) return null;
  return (current - previous) / Math.abs(previous);
}
