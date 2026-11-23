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

export type QuoteType = "quote" | "proforma" | "order" | "delivery" | "intervention";

export const QUOTE_TYPES: Record<QuoteType, { label: string; prefix: string; arrete: string; validate: string; newLabel: string }> = {
  quote: { label: "Devis", prefix: "DV", arrete: "Arrêté le présent devis", validate: "Finaliser le devis", newLabel: "Nouveau devis" },
  proforma: { label: "Facture pro forma", prefix: "PF", arrete: "Arrêtée la présente facture pro forma", validate: "Finaliser la pro forma", newLabel: "Nouvelle pro forma" },
  order: { label: "Bon de commande", prefix: "BC", arrete: "Arrêté le présent bon de commande", validate: "Finaliser le bon de commande", newLabel: "Nouveau bon de commande" },
  delivery: { label: "Bon de livraison", prefix: "BL", arrete: "", validate: "Finaliser le bon de livraison", newLabel: "Nouveau bon de livraison" },
  intervention: { label: "Bon d'intervention", prefix: "BI", arrete: "Arrêté le présent bon d'intervention", validate: "Finaliser le bon d'intervention", newLabel: "Nouveau bon d'intervention" },
};

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
