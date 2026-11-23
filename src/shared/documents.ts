/**
 * Types de documents commerciaux et calculs d'acompte.
 *
 * La table « quotes » porte tous les documents d'avant-vente, chacun avec sa série :
 * devis (DV), facture pro forma (PF), bon de commande (BC), bon de livraison (BL).
 * Les factures d'acompte sont des factures ordinaires (série FA, numérotation continue)
 * dont les lignes portent `deposit` ; la facture de solde reprend le document d'origine
 * et déduit chaque acompte par des lignes négatives qui portent `depositInvoiceId`.
 */
import { lineNet, roundAmount, type InvoiceLine } from "./invoice.ts";

export type QuoteType = "quote" | "proforma" | "order" | "delivery" | "service" | "intervention";

export const QUOTE_TYPES: Record<QuoteType, { label: string; prefix: string; arrete: string; validate: string; newLabel: string }> = {
  quote: { label: "Devis", prefix: "DV", arrete: "Arrêté le présent devis", validate: "Finaliser le devis", newLabel: "Nouveau devis" },
  proforma: { label: "Facture pro forma", prefix: "PF", arrete: "Arrêtée la présente facture pro forma", validate: "Finaliser la pro forma", newLabel: "Nouvelle pro forma" },
  order: { label: "Bon de commande", prefix: "BC", arrete: "Arrêté le présent bon de commande", validate: "Finaliser le bon de commande", newLabel: "Nouveau bon de commande" },
  delivery: { label: "Bon de livraison", prefix: "BL", arrete: "", validate: "Finaliser le bon de livraison", newLabel: "Nouveau bon de livraison" },
  service: { label: "Bon de prestation", prefix: "BP", arrete: "", validate: "Finaliser le bon de prestation", newLabel: "Nouveau bon de prestation" },
  intervention: { label: "Bon d'intervention", prefix: "BI", arrete: "Arrêté le présent bon d'intervention", validate: "Finaliser le bon d'intervention", newLabel: "Nouveau bon d'intervention" },
};

/**
 * Bons remis à la réception, sans prix ni totaux, signés par le client : le bon de
 * livraison (des articles) et le bon de prestation (un service réalisé).
 */
export const SLIP_TEXTS: Partial<Record<QuoteType, {
  to: string; qty: string; by: string; received: string; todo: string; done: string; mark: string; confirmed: string; count: string; note: string;
}>> = {
  delivery: {
    to: "Livré à", qty: "Quantité", by: "Livré par", received: "Reçu par le client", todo: "À livrer", done: "Livré",
    mark: "Marquer livré", confirmed: "Livraison confirmée.", count: "Articles livrés", note: "Livraison",
  },
  service: {
    to: "Prestation réalisée pour", qty: "Quantité", by: "Réalisé par", received: "Prestation constatée par le client", todo: "À réaliser", done: "Réalisé",
    mark: "Marquer réalisé", confirmed: "Prestation constatée par le client.", count: "Prestations réalisées", note: "Prestation réalisée",
  },
};
export const isSlipType = (t: QuoteType) => t in SLIP_TEXTS;
export const isSlip = (data: Record<string, unknown> | undefined) => isSlipType(quoteTypeOf(data));
/** Ce qu'un document peut donner comme suite, dans l'ordre de la chaîne : devis, commande, livraison ou prestation, facture. */
export function followUps(kind: "quotes" | "invoices" | "credit_notes", data: Record<string, unknown> | undefined): QuoteType[] {
  if (kind === "credit_notes") return [];
  if (kind === "invoices") return ["delivery", "service"];
  const t = quoteTypeOf(data);
  if (isSlipType(t)) return [];
  return t === "quote" || t === "proforma" ? ["order", "delivery", "service"] : ["delivery", "service"];
}

type ChainRec = { id: string; data: Record<string, unknown> };
const liveRec = (r: ChainRec) => !r.data._deleted;

/** Documents d'où vient un document de vente, du plus proche au plus lointain (bon, commande, devis). */
export function ancestorsOf(doc: ChainRec, quotes: ChainRec[]): ChainRec[] {
  const out: ChainRec[] = [];
  const seen = new Set([doc.id]);
  let cur: ChainRec | undefined = doc;
  while (cur) {
    const sid: unknown = cur.data.source_id;
    cur = typeof sid === "string" && sid && !seen.has(sid) ? quotes.find((q) => q.id === sid) : undefined;
    if (cur) { seen.add(cur.id); out.push(cur); }
  }
  return out;
}

/**
 * Où en est la facturation d'un bon de livraison ou de prestation :
 *  - « ready » : on peut créer la facture (les taxes et conditions viennent de `priced`, le document chiffré d'origine) ;
 *  - « invoiced » : une facture existe déjà, pour ce bon (« self ») ou pour le document d'origine (« origin ») ;
 *  - « deposit » : un acompte a été facturé sur l'origine, la facture de solde se fait depuis elle.
 */
export type SlipBilling =
  | { state: "ready"; priced: ChainRec | null }
  | { state: "invoiced"; invoice: ChainRec; via: "self" | "origin" }
  | { state: "deposit"; origin: ChainRec };
export function slipBilling(slip: ChainRec, all: { quotes: ChainRec[]; invoices: ChainRec[] }): SlipBilling {
  const invoices = all.invoices.filter(liveRec);
  const own = invoices.find((i) => i.data.quote_id === slip.id || i.id === slip.data.invoice_id);
  if (own) return { state: "invoiced", invoice: own, via: "self" };
  // Bon établi d'après une facture : elle existe déjà.
  const fromInvoice = invoices.find((i) => i.id === slip.data.source_id);
  if (fromInvoice) return { state: "invoiced", invoice: fromInvoice, via: "origin" };
  const ancestors = ancestorsOf(slip, all.quotes.filter(liveRec));
  for (const a of ancestors) {
    const linked = invoices.filter((i) => i.data.quote_id === a.id || i.id === a.data.invoice_id || i.id === a.data.source_id);
    const full = linked.find((i) => !i.data.deposit);
    if (full) return { state: "invoiced", invoice: full, via: "origin" };
    if (linked.length) return { state: "deposit", origin: a };
  }
  return { state: "ready", priced: ancestors.find((a) => !isSlip(a.data)) ?? null };
}

/** Factures déjà établies depuis les bons tirés d'un document : le facturer en entier compterait deux fois. */
export function invoicesFromSlips(doc: ChainRec, all: { quotes: ChainRec[]; invoices: ChainRec[] }): ChainRec[] {
  const quotes = all.quotes.filter(liveRec);
  const ids = new Set<string>();
  let layer = [doc.id];
  while (layer.length) {
    const next = quotes.filter((q) => typeof q.data.source_id === "string" && layer.includes(q.data.source_id) && !ids.has(q.id)).map((q) => q.id);
    next.forEach((n) => ids.add(n));
    layer = next;
  }
  return all.invoices.filter((i) => liveRec(i) && typeof i.data.quote_id === "string" && ids.has(i.data.quote_id) && !i.data.deposit);
}

/** Séries admises pour la table des documents d'avant-vente. */
export const QUOTE_SERIES = Object.values(QUOTE_TYPES).map((t) => t.prefix);

export function quoteTypeOf(data: Record<string, unknown> | undefined): QuoteType {
  const t = data?.doc_type;
  return typeof t === "string" && t in QUOTE_TYPES ? (t as QuoteType) : "quote";
}

/** Ligne de titre (section) : ni quantité ni montant, sert à regrouper les lignes. */
export const isSection = (l: InvoiceLine) => Boolean(l.section);
/** Ligne d'acompte ou de déduction d'acompte : n'est pas du chiffre d'affaires. */
export const isDepositLine = (l: InvoiceLine) => Boolean(l.deposit || l.depositInvoiceId);

/** Base HT par taux de TVA (hors titres et hors lignes d'acompte). */
export function baseByRate(lines: InvoiceLine[], decimals = 0): Map<number, number> {
  const m = new Map<number, number>();
  for (const l of lines) {
    if (isSection(l) || isDepositLine(l)) continue;
    m.set(l.vatRate, (m.get(l.vatRate) ?? 0) + lineNet(l, decimals));
  }
  return m;
}

/**
 * Lignes d'une facture d'acompte : un pourcentage du document d'origine,
 * ventilé par taux de TVA pour que la TVA de l'acompte suive celle des ventes.
 */
export function depositLines(source: InvoiceLine[], percent: number, reference: string, decimals = 0): InvoiceLine[] {
  const p = Math.min(100, Math.max(0, percent));
  const bases = [...baseByRate(source, decimals)].filter(([, base]) => base !== 0);
  const pct = p.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
  return bases.map(([vatRate, base]) => ({
    label: `Acompte de ${pct} % sur ${reference}${bases.length > 1 ? ` (TVA ${vatRate} %)` : ""}`,
    qty: 1,
    unitPrice: roundAmount((base * p) / 100, decimals),
    vatRate,
    deposit: true,
  }));
}

/** Pourcentage correspondant à un montant TTC d'acompte. */
export function percentForAmount(source: InvoiceLine[], amountTtc: number, decimals = 0): number {
  let gross = 0;
  for (const [rate, base] of baseByRate(source, decimals)) gross += base * (1 + rate / 100);
  return gross > 0 ? (amountTtc / gross) * 100 : 0;
}

/** Lignes de déduction d'un acompte déjà facturé, à porter sur la facture de solde. */
export function deductionLines(deposit: { id: string; number: string; date: string; lines: InvoiceLine[] }): InvoiceLine[] {
  const date = deposit.date ? deposit.date.split("-").reverse().join("/") : "";
  return deposit.lines
    .filter((l) => l.deposit)
    .map((l) => ({
      label: `Déduction de l'acompte ${deposit.number}${date ? ` du ${date}` : ""}${deposit.lines.filter((x) => x.deposit).length > 1 ? ` (TVA ${l.vatRate} %)` : ""}`,
      qty: 1,
      unitPrice: -Math.abs(l.unitPrice * l.qty),
      vatRate: l.vatRate,
      depositInvoiceId: deposit.id,
    }));
}

/** Applique une même remise (en %) à toutes les lignes facturables. */
export function applyGlobalDiscount(lines: InvoiceLine[], percent: number): InvoiceLine[] {
  const p = Math.min(100, Math.max(0, percent));
  return lines.map((l) => (isSection(l) || isDepositLine(l) ? l : { ...l, discount: p || undefined }));
}

/** Sous-totaux HT par section (hors acomptes), dans l'ordre : [index de la ligne de titre, sous-total]. */
export function sectionSubtotals(lines: InvoiceLine[], decimals = 0): Map<number, number> {
  const out = new Map<number, number>();
  let current = -1;
  lines.forEach((l, i) => {
    if (isSection(l)) {
      current = i;
      out.set(i, 0);
    } else if (current >= 0 && !isDepositLine(l)) out.set(current, roundAmount(out.get(current)! + lineNet(l, decimals), decimals));
  });
  return out;
}

/** Intitulé d'un document : « Facture », « Facture d'acompte », « Bon de livraison »… */
export function docTitle(kind: "quotes" | "invoices" | "credit_notes", data: Record<string, unknown> | undefined): string {
  if (kind === "quotes") return QUOTE_TYPES[quoteTypeOf(data)].label;
  if (kind === "credit_notes") return "Avoir";
  return data?.deposit ? "Facture d'acompte" : "Facture";
}

/** Formule « Arrêté(e) le/la présent(e)… » du document, vide pour un bon de livraison. */
export function docArrete(kind: "quotes" | "invoices" | "credit_notes", data: Record<string, unknown> | undefined): string {
  if (kind === "quotes") return QUOTE_TYPES[quoteTypeOf(data)].arrete;
  if (kind === "credit_notes") return "Arrêté le présent avoir";
  return data?.deposit ? "Arrêtée la présente facture d'acompte" : "Arrêtée la présente facture";
}

/**
 * Références d'un document, à imprimer en tête : objet, référence donnée par le client
 * (bon de commande, ordre d'achat, lettre de commande) et conditions de règlement.
 * `notes` est la note libre restante, imprimée en bas.
 *
 * Les documents repris avant la version 2 de la reprise rangeaient tout dans la note
 * (« Objet : … », référence du client, « Règlement : … ») : on les relit ici pour les
 * remettre à leur place sans toucher au document, qui est figé.
 */
export interface DocRefs { subject: string; clientRef: string; paymentTerms: string; notes: string }

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function docRefs(data: Record<string, unknown> | undefined): DocRefs {
  const subject = str(data?.subject);
  const refs: DocRefs = { subject, clientRef: str(data?.client_ref), paymentTerms: str(data?.payment_terms), notes: str(data?.notes) };
  const extra = str(data?.import_info);
  if (!data?.imported || data.import_v === 2) {
    if (extra) refs.notes = [refs.notes, extra].filter(Boolean).join("\n");
    return refs;
  }
  let rest = refs.notes;
  const head = `Objet : ${subject}`;
  if (subject && rest.startsWith(head)) rest = rest.slice(head.length).trim();
  const lines = rest ? rest.split("\n") : [];
  const kept: string[] = [];
  let legacyRef: string[] = [];
  for (const l of lines) {
    if (l.startsWith("Règlement : ")) refs.paymentTerms ||= l.slice("Règlement : ".length).trim();
    else if (l.startsWith("Motif : ")) kept.push(l);
    else legacyRef.push(l);
  }
  legacyRef = legacyRef.filter((l) => l.trim() !== "");
  refs.clientRef ||= legacyRef.join("\n");
  refs.notes = [...kept, extra].filter(Boolean).join("\n");
  return refs;
}

/** Texte de recherche d'un document : numéro, objet, référence du client. */
export function docSearchText(data: Record<string, unknown> | undefined): string {
  const r = docRefs(data);
  return `${str(data?.number)} ${r.subject} ${r.clientRef}`;
}

export interface RelatedDoc { tbl: "quotes" | "invoices" | "credit_notes"; id: string; relation: string }

type Rec = { id: string; data: Record<string, unknown> };

/**
 * Documents liés à un document, dans les deux sens : d'où il vient, ce qu'il a donné.
 * Les liens sont lus tels qu'ils sont notés (quote_id, invoice_id, source_id), d'un côté ou de l'autre.
 */
export function relatedDocs(
  kind: "quotes" | "invoices" | "credit_notes", doc: Rec,
  all: { quotes: Rec[]; invoices: Rec[]; credit_notes: Rec[] },
): RelatedDoc[] {
  const out: RelatedDoc[] = [];
  const seen = new Set<string>();
  const add = (tbl: RelatedDoc["tbl"], r: Rec | undefined, relation: string) => {
    if (!r || r.id === doc.id || seen.has(`${tbl}/${r.id}`)) return;
    seen.add(`${tbl}/${r.id}`);
    out.push({ tbl, id: r.id, relation });
  };
  const d = doc.data;
  const byId = (list: Rec[], id: unknown) => (typeof id === "string" && id ? list.find((r) => r.id === id) : undefined);
  if (kind === "quotes") {
    add("quotes", byId(all.quotes, d.source_id), "Établi d'après");
    add("invoices", byId(all.invoices, d.source_id), "Établi d'après");
    for (const q of all.quotes) if (q.data.source_id === doc.id) add("quotes", q, "A donné");
    for (const i of all.invoices) {
      if (i.data.quote_id === doc.id) add("invoices", i, i.data.deposit ? "Acompte" : i.data.final_invoice ? "Facture de solde" : "Facturé par");
    }
    add("invoices", byId(all.invoices, d.invoice_id), "Facturé par");
    for (const i of all.invoices) if (i.data.source_id === doc.id) add("invoices", i, "Facturé par");
  } else if (kind === "invoices") {
    add("quotes", byId(all.quotes, d.quote_id), "Issue de");
    add("quotes", byId(all.quotes, d.source_id), "Issue de");
    for (const q of all.quotes) if (q.data.invoice_id === doc.id) add("quotes", q, "Issue de");
    add("invoices", byId(all.invoices, d.recurrence_of), "Facture récurrente, d'après");
    // Acomptes et solde du même devis.
    if (typeof d.quote_id === "string" && d.quote_id) {
      for (const i of all.invoices) if (i.data.quote_id === d.quote_id) add("invoices", i, i.data.deposit ? "Acompte" : "Facture du même devis");
    }
    for (const q of all.quotes) if (q.data.source_id === doc.id) add("quotes", q, "A donné");
    for (const c of all.credit_notes) if (c.data.invoice_id === doc.id) add("credit_notes", c, "Corrigée par");
  } else {
    add("invoices", byId(all.invoices, d.invoice_id), "Corrige");
  }
  return out;
}

/**
 * Interlocuteur à afficher sur le document : le vendeur, sauf quand ce nom n'est
 * autre que celui de l'entreprise (il figure déjà en tête).
 */
export function sellerOf(data: Record<string, unknown> | undefined, company: Record<string, unknown> | undefined): string {
  const flat = (v: unknown) => (typeof v === "string" ? v : "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const seller = typeof data?.seller_name === "string" ? data.seller_name.trim() : "";
  const a = flat(seller);
  const b = flat(company?.name);
  if (!a || (b && (a.includes(b) || b.includes(a)))) return "";
  return seller;
}
