/** Calculs de facture. Montants en unités entières de la devise (le FCFA n'a pas de centimes). */

export interface InvoiceLine {
  label: string;
  qty: number;
  unitPrice: number;
  /** Taux de TVA en pourcentage, 18 par défaut au Gabon. */
  vatRate: number;
  /** Unité facultative : u, h, jour, forfait… */
  unit?: string;
  /** Article du catalogue d'origine, s'il y en a un. */
  articleId?: string;
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

/** Montant sans devise pour les tableaux comptables : "1 250 000", vide pour zéro. */
export function formatAmount(amount: number, blankZero = true): string {
  if (blankZero && Math.round(amount) === 0) return "";
  return formatXaf(amount).replace(" FCFA", "");
}

/** Parité fixe euro / franc CFA. */
export const EUR_TO_XAF = 655.957;

/** Numéro de facture à partir d'une série et d'un rang : FA-2026-00001. */
export function formatInvoiceNumber(series: string, n: number): string {
  return `${series}-${String(n).padStart(5, "0")}`;
}

/** Délai de paiement par défaut, en jours. */
export const DEFAULT_PAYMENT_DAYS = 30;

/** Date ISO (AAAA-MM-JJ) décalée d'un nombre de jours. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Moyens de paiement courants au Gabon. */
export const PAYMENT_METHODS: Record<string, string> = {
  cash: "Espèces",
  transfer: "Virement",
  cheque: "Chèque",
  airtel: "Airtel Money",
  moov: "Moov Money",
  card: "Carte bancaire",
};

/**
 * Situation d'une facture : total, encaissé, avoirs imputés, reste dû.
 * Les encaissements sont des lignes distinctes : deux encaissements saisis
 * en même temps sur deux appareils s'additionnent au lieu de s'écraser.
 */
export function invoiceBalance(gross: number, payments: number[], credits: number[]) {
  const paid = payments.reduce((a, b) => a + b, 0);
  const credited = credits.reduce((a, b) => a + b, 0);
  const due = Math.max(0, gross - paid - credited);
  const status = due === 0 ? "paid" : paid + credited > 0 ? "partial" : "unpaid";
  return { gross, paid, credited, due, status } as const;
}

const UNITS = [
  "zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix",
  "onze", "douze", "treize", "quatorze", "quinze", "seize",
];
const TENS = ["", "dix", "vingt", "trente", "quarante", "cinquante", "soixante"];

function below100(n: number): string {
  if (n <= 16) return UNITS[n];
  if (n < 20) return `dix-${UNITS[n - 10]}`;
  if (n < 70) {
    const t = Math.floor(n / 10);
    const u = n % 10;
    if (u === 0) return TENS[t];
    if (u === 1) return `${TENS[t]} et un`;
    return `${TENS[t]}-${UNITS[u]}`;
  }
  if (n < 80) {
    const r = n - 60;
    return r === 11 ? "soixante et onze" : `soixante-${below100(r)}`;
  }
  const r = n - 80;
  if (r === 0) return "quatre-vingts";
  return `quatre-vingt-${below100(r)}`;
}

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  let s = "";
  if (h === 1) s = "cent";
  else if (h > 1) s = `${UNITS[h]} cent${r === 0 ? "s" : ""}`;
  if (r > 0) s = s ? `${s} ${below100(r)}` : below100(r);
  return s;
}

/** Montant en toutes lettres (orthographe traditionnelle), pour « Arrêtée la présente facture à… ». */
export function amountInWords(amount: number): string {
  let n = Math.round(Math.abs(amount));
  if (n === 0) return "zéro";
  const parts: string[] = [];
  const scales: [number, string][] = [[1_000_000_000, "milliard"], [1_000_000, "million"]];
  for (const [value, word] of scales) {
    const q = Math.floor(n / value);
    if (q > 0) {
      parts.push(`${below1000(q)} ${word}${q > 1 ? "s" : ""}`);
      n %= value;
    }
  }
  const thousands = Math.floor(n / 1000);
  if (thousands > 0) {
    // « mille » est invariable, et « cent » / « vingt » perdent leur s devant lui.
    const t = thousands === 1 ? "mille" : `${below1000(thousands).replace(/(cent|vingt)s$/, "$1")} mille`;
    parts.push(t);
    n %= 1000;
  }
  if (n > 0) parts.push(below1000(n));
  return parts.join(" ");
}
