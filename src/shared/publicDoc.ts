/**
 * Document partagé avec le client par un lien : il le lit, le télécharge et le signe
 * en ligne, sans compte. Le lien porte un jeton secret propre au document ; le serveur
 * ne rend que les champs imprimés sur le document, jamais le reste de la fiche.
 */
import { isSlip } from "./documents.ts";
import { signatureOf } from "./signature.ts";

/** Champs de l'entreprise imprimés sur ses documents (en-tête, pied, cachet, conditions). */
export const COMPANY_PUBLIC_FIELDS = [
  "name", "legal_form", "capital", "address", "city", "phone", "email", "website", "nif", "rccm",
  "logo", "footer", "bank", "mobile_money", "doc_color", "stamp", "stamp_on", "terms",
] as const;
/** Champs du client imprimés dans l'encadré « Destinataire ». */
export const CLIENT_PUBLIC_FIELDS = ["name", "address", "city", "nif", "rccm"] as const;
/** Champs du document imprimés sur le devis. */
export const DOC_PUBLIC_FIELDS = [
  "number", "doc_type", "status", "date", "valid_until", "lines", "currency", "rate",
  "subject", "client_ref", "payment_terms", "notes", "imported", "import_v", "import_info",
  "css_rate", "css_on_zero", "withholding_rate", "withholding_label", "seller_name", "source_number", "decided_at",
] as const;

export interface PublicDoc {
  doc: Record<string, unknown>;
  client: Record<string, unknown>;
  company: Record<string, unknown>;
  /** Raison pour laquelle le document ne peut pas (ou plus) être signé, sinon chaîne vide. */
  locked: string;
}

const pick = (data: Record<string, unknown> | undefined, fields: readonly string[]) => {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (data && data[f] !== undefined) out[f] = data[f];
  return out;
};

/** Jeton d'un lien de signature : 24 octets aléatoires, en base64 pour URL. */
export function newSignToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const isSignToken = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{32}$/.test(v);

/** Comparaison en temps constant : ne révèle pas où deux jetons diffèrent. */
export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Chemin de la page de signature en ligne d'un document. */
export const signPath = (companyId: string, docId: string, token: string) => `/signer/${companyId}/${docId}/${token}`;
/** Lit un chemin « /signer/{entreprise}/{document}/{jeton} ». */
export function parseSignPath(path: string): { companyId: string; docId: string; token: string } | null {
  const m = /^\/signer\/([A-Za-z0-9-]{8,64})\/([A-Za-z0-9_-]{3,96})\/([A-Za-z0-9_-]{32})\/?$/.exec(path);
  return m ? { companyId: m[1], docId: m[2], token: m[3] } : null;
}

/** Pourquoi un document ne peut pas être signé en ligne aujourd'hui (chaîne vide : il peut l'être). */
export function signLock(data: Record<string, unknown>, today: string): string {
  if (signatureOf(data)) return "signed";
  if (data.status === "refused") return "refused";
  if (data.status !== "sent") return "closed";
  if (typeof data.valid_until === "string" && data.valid_until && data.valid_until < today) return "expired";
  return "";
}

/** Ce que le client voit d'un document partagé : uniquement ce qui est imprimé dessus. */
export function publicDoc(doc: Record<string, unknown>, client: Record<string, unknown> | undefined, company: Record<string, unknown> | undefined, today: string, extra: readonly string[] = []): PublicDoc {
  const sig = signatureOf(doc);
  return {
    doc: {
      ...pick(doc, [...DOC_PUBLIC_FIELDS, ...extra]),
      // La preuve technique (adresse, navigateur) reste chez l'entreprise.
      ...(sig ? { signature: { name: sig.name, at: sig.at, image: sig.image, via: sig.via } } : {}),
    },
    client: pick(client, CLIENT_PUBLIC_FIELDS),
    company: pick(company, COMPANY_PUBLIC_FIELDS),
    locked: signLock(doc, today),
  };
}

/** Un document se partage par lien s'il est finalisé et chiffré (pas un bon sans prix). */
export const shareable = (data: Record<string, unknown> | undefined) =>
  Boolean(data && typeof data.number === "string" && data.number && !data._deleted && !isSlip(data));
