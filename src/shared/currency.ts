/**
 * Devises. La comptabilité est tenue en francs CFA (XAF) ; un document peut
 * être établi dans une autre devise, avec le taux du jour mémorisé sur le
 * document lui-même (montant en devise × taux = montant en XAF).
 */
import { amountInWords } from "./invoice.ts";

export interface Currency {
  code: string;
  label: string;
  decimals: number;
  /** Nom en toutes lettres : singulier, pluriel, et sous-unité. */
  words: [string, string, string?];
  /** Parité fixe avec le franc CFA (non modifiable). */
  fixedRate?: number;
}

export const BASE_CURRENCY = "XAF";

export const CURRENCIES: Record<string, Currency> = {
  XAF: { code: "XAF", label: "Franc CFA (CEMAC)", decimals: 0, words: ["franc CFA", "francs CFA"], fixedRate: 1 },
  XOF: { code: "XOF", label: "Franc CFA (UEMOA)", decimals: 0, words: ["franc CFA", "francs CFA"], fixedRate: 1 },
  EUR: { code: "EUR", label: "Euro", decimals: 2, words: ["euro", "euros", "centimes"], fixedRate: 655.957 },
  USD: { code: "USD", label: "Dollar américain", decimals: 2, words: ["dollar", "dollars", "cents"] },
  CNY: { code: "CNY", label: "Yuan", decimals: 2, words: ["yuan", "yuans", "fens"] },
  GBP: { code: "GBP", label: "Livre sterling", decimals: 2, words: ["livre sterling", "livres sterling", "pence"] },
};

/** Taux par défaut (1 unité = n XAF), à mettre à jour dans les réglages. */
export const DEFAULT_RATES: Record<string, number> = { XAF: 1, XOF: 1, EUR: 655.957, USD: 600, CNY: 83, GBP: 770 };

export const decimalsOf = (code: string) => CURRENCIES[code]?.decimals ?? 2;

/** Arrondi à la précision de la devise : unité pour le FCFA, centime pour l'euro. */
export function roundTo(amount: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round((amount + Number.EPSILON) * f) / f;
}

/** Taux à appliquer : parité fixe si elle existe, sinon le taux saisi. */
export function rateFor(code: string, rates: Record<string, number> | undefined): number {
  const c = CURRENCIES[code];
  if (c?.fixedRate) return c.fixedRate;
  const r = Number(rates?.[code]);
  return r > 0 ? r : DEFAULT_RATES[code] ?? 1;
}

/** Conversion en francs CFA, arrondie à l'unité. */
export const toXaf = (amount: number, rate: number) => Math.round(amount * rate);

/** "1 250 000 FCFA", "1 250,50 €", "980,00 $". */
export function formatMoney(amount: number, code = BASE_CURRENCY): string {
  const d = decimalsOf(code);
  const sign = amount < 0 ? "-" : "";
  const fixed = Math.abs(roundTo(amount, d)).toFixed(d);
  const [int, dec] = fixed.split(".");
  const digits = int.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const n = dec ? `${digits},${dec}` : digits;
  const suffix: Record<string, string> = { XAF: "FCFA", XOF: "FCFA", EUR: "€", USD: "$", GBP: "£", CNY: "¥" };
  return `${sign}${n} ${suffix[code] ?? code}`;
}

/** Montant en lettres avec la devise : « mille deux cents euros et cinquante centimes ». */
export function amountInWordsWithCurrency(amount: number, code = BASE_CURRENCY): string {
  const c = CURRENCIES[code] ?? { words: [code, code] as [string, string], decimals: 2 };
  const abs = Math.abs(roundTo(amount, c.decimals));
  const units = Math.floor(abs);
  const cents = Math.round((abs - units) * 100);
  const unitWord = units > 1 ? c.words[1] : c.words[0];
  let out = `${amountInWords(units)} ${unitWord}`;
  if (c.decimals > 0 && cents > 0) out += ` et ${amountInWords(cents)} ${c.words[2] ?? "centimes"}`;
  return out;
}
