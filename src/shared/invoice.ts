/** Calculs de facture. Montants en unités entières de la devise (le FCFA n'a pas de centimes). */

export interface InvoiceLine {
  label: string;
  qty: number;
  unitPrice: number;
  /** Taux de TVA en pourcentage, 18 par défaut au Gabon. */
  vatRate: number;
}

export interface InvoiceTotals {
  net: number;
  vat: number;
  gross: number;
}

export const DEFAULT_VAT_RATE = 18;

/** Arrondi commercial à l'unité, appliqué ligne par ligne. */
function round(n: number): number {
  return Math.round(n + Number.EPSILON);
}

export function computeTotals(lines: InvoiceLine[]): InvoiceTotals {
  let net = 0;
  let vat = 0;
  for (const l of lines) {
    const lineNet = round(l.qty * l.unitPrice);
    net += lineNet;
    vat += round((lineNet * l.vatRate) / 100);
  }
  return { net, vat, gross: net + vat };
}

/** "1 250 000 FCFA" : espace comme séparateur de milliers, sans décimales. */
export function formatXaf(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const digits = String(Math.abs(Math.round(amount))).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${digits} FCFA`;
}

/** Parité fixe euro / franc CFA. */
export const EUR_TO_XAF = 655.957;

/** Numéro de facture à partir d'une série et d'un rang : FA-2026-00001. */
export function formatInvoiceNumber(series: string, n: number): string {
  return `${series}-${String(n).padStart(5, "0")}`;
}
