/**
 * Apparence des documents : couleur d'accent, cachet et signature, mentions par défaut.
 * Tout est réglé une fois dans Réglages et s'applique à l'aperçu comme au PDF.
 */

/** Couleurs proposées (contraste suffisant sur fond blanc pour le titre). */
export const DOC_COLORS: { hex: string; label: string }[] = [
  { hex: "#0255C6", label: "Bleu" },
  { hex: "#101D36", label: "Nuit" },
  { hex: "#0F7A4D", label: "Vert" },
  { hex: "#B4231F", label: "Rouge" },
  { hex: "#B35C00", label: "Ocre" },
  { hex: "#5B3FA8", label: "Violet" },
];

export const DEFAULT_DOC_COLOR = DOC_COLORS[0].hex;

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Couleur d'accent des documents (valeur sûre si le réglage est absent ou invalide). */
export function docColor(settings: Record<string, unknown> | undefined): string {
  const c = settings?.doc_color;
  return typeof c === "string" && HEX.test(c) ? c.toUpperCase() : DEFAULT_DOC_COLOR;
}

/** Composantes 0-1 d'une couleur #RRGGBB. */
export function rgb01(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Teinte claire dérivée (fonds d'en-tête de tableau, ligne de total) : 9 % de la couleur sur du blanc. */
export function softOf(hex: string, amount = 0.09): string {
  const [r, g, b] = rgb01(hex).map((v) => Math.round((1 - amount + amount * v) * 255));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** Luminance relative (WCAG) pour vérifier que le titre reste lisible. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb01(hex).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Couleur trop claire pour un titre sur fond blanc (contraste < 3:1). */
export const tooLight = (hex: string) => (1.05 / (luminance(hex) + 0.05)) < 3;

/** Cachet imprimé sur ce type de document ? (pas sur un bon de livraison : c'est le client qui signe). */
export function stampFor(settings: Record<string, unknown>, kind: "quotes" | "invoices" | "credit_notes", delivery: boolean): string {
  const stamp = typeof settings.stamp === "string" && settings.stamp.startsWith("data:image/") ? settings.stamp : "";
  if (!stamp || delivery || settings.stamp_on === false) return "";
  return stamp;
}

/** Mention par défaut d'un nouveau document (note imprimée), selon son type. */
export function defaultNote(settings: Record<string, unknown>, kind: "quotes" | "invoices" | "credit_notes"): string {
  const v = kind === "quotes" ? settings.default_note_quotes : kind === "invoices" ? settings.default_note_invoices : "";
  return typeof v === "string" ? v : "";
}

/** Conditions générales imprimées en bas des devis et factures. */
export function termsFor(settings: Record<string, unknown>, kind: "quotes" | "invoices" | "credit_notes", delivery: boolean): string {
  if (kind === "credit_notes" || delivery) return "";
  return typeof settings.terms === "string" ? settings.terms.trim() : "";
}
