/**
 * Signature du client sur un devis, une commande ou un bon : son nom, la date, et le tracé
 * fait au doigt ou à la souris. Elle vaut accord (ou réception) et ne se modifie plus.
 */
export interface Signature {
  /** Nom du signataire, tel qu'il l'a saisi. */
  name: string;
  /** Date et heure de la signature (ISO). */
  at: string;
  /** Tracé de la signature : image PNG en data URL. */
  image: string;
  /** « screen » : signée sur l'appareil de l'entreprise ; « link » : signée en ligne par le client. */
  via: "screen" | "link";
  /** Signature en ligne : adresse et navigateur du signataire, gardés comme preuve. */
  ip?: string;
  agent?: string;
}

/** Taille maximale du tracé (caractères de la data URL) : un trait fin sur fond transparent pèse quelques Ko. */
export const SIGNATURE_MAX = 120_000;
const KEYS = new Set(["name", "at", "image", "via", "ip", "agent"]);

/** Raison du refus d'une signature mal formée, ou null si elle est acceptable. */
export function checkSignature(v: unknown): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "signature invalide";
  const s = v as Record<string, unknown>;
  if (Object.keys(s).some((k) => !KEYS.has(k))) return "signature invalide";
  if (typeof s.name !== "string" || s.name.trim().length < 2 || s.name.length > 120) return "le nom du signataire est requis";
  if (typeof s.at !== "string" || Number.isNaN(Date.parse(s.at))) return "date de signature invalide";
  if (typeof s.image !== "string" || !s.image.startsWith("data:image/png;base64,") || s.image.length > SIGNATURE_MAX) return "tracé de signature invalide";
  if (s.via !== "screen" && s.via !== "link") return "signature invalide";
  if (s.ip !== undefined && (typeof s.ip !== "string" || s.ip.length > 64)) return "signature invalide";
  if (s.agent !== undefined && (typeof s.agent !== "string" || s.agent.length > 300)) return "signature invalide";
  return null;
}

/** Signature portée par un document, si elle est bien formée. */
export function signatureOf(data: Record<string, unknown> | undefined): Signature | null {
  return data && checkSignature(data.signature) === null ? (data.signature as Signature) : null;
}

/** « Signé par Awa Ndong le 23/11/2026 à 14:05 ». */
export function signatureLine(s: Signature, formatDate: (iso: string) => string): string {
  const d = new Date(s.at);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `Signé par ${s.name} le ${formatDate(s.at.slice(0, 10))} à ${time}`;
}
