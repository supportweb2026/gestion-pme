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
  /** Remise commerciale en pourcentage du montant de la ligne (0 à 100), facultative. */
  discount?: number;
  /** Prix d'achat unitaire HT (devise du document), noté pour le calcul de la marge ; jamais imprimé. */
  cost?: number;
  /** Ligne de titre (section) : sans quantité ni prix, regroupe les lignes qui suivent. */
  section?: boolean;
  /** Ligne d'une facture d'acompte (comptée en avances reçues, pas en chiffre d'affaires). */
  deposit?: boolean;
  /** Déduction, sur la facture de solde, de la facture d'acompte indiquée (montant négatif). */
  depositInvoiceId?: string;
  /** Détail imprimé sous la désignation (documents repris d'un autre logiciel). */
  description?: string;
  /**
   * Montants figés d'un document repris d'un autre logiciel : HT et TVA de la ligne tels qu'ils
   * figuraient sur le document d'origine. Présents, ils remplacent le calcul quantité × prix.
   */
  net?: number;
  vat?: number;
}

export interface InvoiceTotals {
  /** Total des remises accordées. */
  discount: number;
  net: number;
  vat: number;
  /** Contribution spéciale de solidarité (Gabon), sur la base HT, hors base de TVA. */
  css: number;
  /** Total TTC : HT + TVA + CSS. */
  gross: number;
  /** Retenue à la source opérée par le client, sur la base HT. */
  withholding: number;
  /** Net à payer : TTC moins la retenue à la source. */
  payable: number;
}

/** Taxes figées sur un document (taux en %). Absentes : pas de CSS, pas de retenue. */
export interface DocTaxes {
  cssRate?: number;
  /** La CSS s'applique aussi aux lignes à 0 % de TVA. */
  cssOnZero?: boolean;
  withholdingRate?: number;
  /** Retenue figée (document repris d'un autre logiciel) : remplace le calcul par le taux. */
  withholdingAmount?: number;
}

/** Taxes figées sur un document, lues depuis ses champs css_rate, css_on_zero, withholding_rate. */
export function docTaxes(data: Record<string, unknown> | undefined): DocTaxes {
  const n = (v: unknown) => Math.min(100, Math.max(0, Number(v) || 0));
  const frozen = typeof data?.withholding_amount === "number" && Number.isFinite(data.withholding_amount) ? { withholdingAmount: data.withholding_amount } : {};
  return { cssRate: n(data?.css_rate), cssOnZero: Boolean(data?.css_on_zero), withholdingRate: n(data?.withholding_rate), ...frozen };
}

export const DEFAULT_VAT_RATE = 18;

/** Arrondi commercial ligne par ligne, à l'unité (FCFA) ou au centime (euro, dollar). */
export function roundAmount(n: number, decimals = 0): number {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** Remise de la ligne, bornée entre 0 et 100 %. */
export const lineDiscount = (l: InvoiceLine) => Math.min(100, Math.max(0, Number(l.discount) || 0));

/** Montant HT d'une ligne, remise déduite, arrondi à la précision de la devise. */
export const lineNet = (l: InvoiceLine, decimals = 0) =>
  typeof l.net === "number" ? l.net : roundAmount((l.qty * l.unitPrice * (100 - lineDiscount(l))) / 100, decimals);

/** Ligne sans montants figés : elle se recalcule à nouveau d'après quantité, prix et taux. */
export function unfreezeLine(l: InvoiceLine): InvoiceLine {
  const { net: _net, vat: _vat, ...rest } = l;
  return rest;
}

/** Montant de la remise d'une ligne (avant TVA). */
export const lineDiscountAmount = (l: InvoiceLine, decimals = 0) =>
  typeof l.net === "number" ? 0 : roundAmount(l.qty * l.unitPrice, decimals) - lineNet(l, decimals);
export const lineVat = (l: InvoiceLine, decimals = 0) =>
  typeof l.vat === "number" ? l.vat : roundAmount((lineNet(l, decimals) * l.vatRate) / 100, decimals);

export function computeTotals(lines: InvoiceLine[], decimals = 0, taxes: DocTaxes = {}): InvoiceTotals {
  let net = 0;
  let vat = 0;
  let discount = 0;
  let cssBase = 0;
  for (const l of lines) {
    const n = lineNet(l, decimals);
    net += n;
    vat += lineVat(l, decimals);
    discount += lineDiscountAmount(l, decimals);
    if (taxes.cssOnZero || l.vatRate > 0) cssBase += n;
  }
  const css = taxes.cssRate ? roundAmount((cssBase * taxes.cssRate) / 100, decimals) : 0;
  const withholding = typeof taxes.withholdingAmount === "number"
    ? taxes.withholdingAmount
    : taxes.withholdingRate ? roundAmount((net * taxes.withholdingRate) / 100, decimals) : 0;
  const gross = roundAmount(net + vat + css, decimals);
  return {
    discount: roundAmount(discount, decimals),
    net: roundAmount(net, decimals),
    vat: roundAmount(vat, decimals),
    css,
    gross,
    withholding,
    payable: roundAmount(gross - withholding, decimals),
  };
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
