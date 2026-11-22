/**
 * Fiscalité gabonaise paramétrable (Réglages > Fiscalité).
 *
 * Les taux sont des réglages de l'entreprise, jamais des constantes : la loi de finances
 * change chaque année. Ils sont figés sur chaque document à sa création (css_rate,
 * withholding_rate), pour qu'un document émis ne change pas quand les réglages changent.
 * Sources et points à confirmer : mémo conformite-gabon.md (22/11/2026).
 */

/** Taux de TVA proposés par défaut au Gabon (LF et LFR 2026) : normal, réduits, export. */
export const DEFAULT_VAT_RATES = [18, 10, 5, 3, 0];

/** Paiements d'au moins 500 000 FCFA : virement ou mobile money (art. P-917, LF 2026). */
export const CASH_LIMIT_XAF = 500_000;

export interface WithholdingPreset {
  label: string;
  rate: number;
}

/** Retenues à la source courantes ; taux modifiables dans les réglages. */
export const DEFAULT_WITHHOLDINGS: WithholdingPreset[] = [
  { label: "Précompte prestataire local", rate: 9.5 },
  { label: "Prestataire non-résident", rate: 25 },
  { label: "Retenue sur loyers", rate: 10 },
];

export interface FiscalSettings {
  cssEnabled: boolean;
  cssRate: number;
  cssOnZero: boolean;
  vatRates: number[];
  /** TVA exigible sur les débits (option) : mention obligatoire sur la facture. */
  vatOnDebits: boolean;
  exemptionNote: string;
  withholdings: WithholdingPreset[];
  requireClientNif: boolean;
  latePenalty: string;
}

const num = (v: unknown, d: number) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));

/** Réglages fiscaux de l'entreprise, avec les valeurs par défaut du Gabon. */
export function fiscalSettings(s: Record<string, unknown>): FiscalSettings {
  const rates = Array.isArray(s.vat_rates) ? (s.vat_rates as unknown[]).map(Number).filter((n) => n >= 0 && n <= 100) : [];
  const wh = Array.isArray(s.withholdings)
    ? (s.withholdings as WithholdingPreset[]).filter((w) => w && typeof w.label === "string" && Number(w.rate) > 0 && Number(w.rate) <= 100)
    : DEFAULT_WITHHOLDINGS;
  return {
    cssEnabled: Boolean(s.css_enabled),
    cssRate: num(s.css_rate, 1),
    cssOnZero: Boolean(s.css_on_zero),
    vatRates: rates.length ? rates : DEFAULT_VAT_RATES,
    vatOnDebits: s.vat_regime === "debits",
    exemptionNote: typeof s.exemption_note === "string" ? s.exemption_note : "TVA à 0 % : opération exonérée ou exportation.",
    withholdings: wh,
    requireClientNif: Boolean(s.require_client_nif),
    latePenalty: typeof s.late_penalty === "string" ? s.late_penalty : "",
  };
}

/** Champs fiscaux à figer sur un nouveau document, selon les réglages. */
export function newDocTaxFields(f: FiscalSettings): { css_rate: number; css_on_zero: boolean } {
  return { css_rate: f.cssEnabled ? f.cssRate : 0, css_on_zero: f.cssEnabled && f.cssOnZero };
}

/** "9,5 %" */
export const pct = (n: number) => `${n.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %`;

/**
 * Mentions fiscales imprimées sous les totaux d'une facture (ou d'un devis) :
 * TVA sur les débits, exonération, paiement hors espèces au-delà du seuil, pénalités, E-Fact.
 */
export function fiscalMentions(opts: {
  kind: "quotes" | "invoices" | "credit_notes";
  settings: Record<string, unknown>;
  data: Record<string, unknown>;
  hasZeroVat: boolean;
  payableXaf: number;
  delivery?: boolean;
}): string[] {
  if (opts.delivery) return [];
  const f = fiscalSettings(opts.settings);
  const out: string[] = [];
  if (opts.kind === "invoices" && f.vatOnDebits) out.push("TVA acquittée sur les débits.");
  if (opts.hasZeroVat && f.exemptionNote.trim()) out.push(f.exemptionNote.trim());
  if (opts.kind !== "credit_notes" && opts.payableXaf >= CASH_LIMIT_XAF) {
    out.push("Règlement par virement bancaire ou mobile money : espèces non acceptées à partir de 500 000 FCFA.");
  }
  if (opts.kind === "invoices" && f.latePenalty.trim()) out.push(f.latePenalty.trim());
  if (opts.kind === "invoices" && typeof opts.data.efact_number === "string" && opts.data.efact_number.trim()) {
    out.push(`Facture normalisée E-Fact (DGI) n° ${opts.data.efact_number.trim()}.`);
  }
  return out;
}
