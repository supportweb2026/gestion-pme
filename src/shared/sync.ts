import { isValidHlc, type Hlc } from "./hlc.ts";

/** Tables synchronisées entre appareils. */
export const SYNC_TABLES = ["clients", "articles", "invoices", "expenses", "projects", "tasks"] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

export type Fields = Record<string, unknown>;

/** Une modification élémentaire : quelques champs d'une ligne, à un instant HLC. */
export interface Change {
  /** Identifiant unique de la modification (UUID) : garantit l'idempotence. */
  id: string;
  tbl: SyncTable;
  /** Identifiant de la ligne modifiée (UUID généré sur l'appareil). */
  row: string;
  patch: Fields;
  hlc: Hlc;
  device: string;
}

/** État d'une ligne : ses valeurs et, pour chaque champ, l'horodatage de sa dernière écriture. */
export interface SyncRecord {
  tbl: SyncTable;
  id: string;
  data: Fields;
  clocks: Record<string, Hlc>;
}

/** Champ réservé : une suppression est un marquage, jamais un effacement. */
export const DELETED = "_deleted";

/**
 * Fusion champ par champ, « la dernière écriture gagne » :
 * un champ n'est remplacé que si la modification est plus récente que la
 * dernière écriture connue de ce champ. Appliquer la même modification deux
 * fois, ou des modifications dans un ordre différent, donne le même résultat.
 */
export function applyChange(record: SyncRecord | null, change: Change): { record: SyncRecord; applied: string[] } {
  const base: SyncRecord = record
    ? { tbl: record.tbl, id: record.id, data: { ...record.data }, clocks: { ...record.clocks } }
    : { tbl: change.tbl, id: change.row, data: {}, clocks: {} };
  const applied: string[] = [];
  for (const [field, value] of Object.entries(change.patch)) {
    const known = base.clocks[field];
    if (known === undefined || change.hlc > known) {
      base.data[field] = value;
      base.clocks[field] = change.hlc;
      applied.push(field);
    }
  }
  return { record: base, applied };
}

export function isDeleted(record: SyncRecord | null | undefined): boolean {
  return Boolean(record?.data[DELETED]);
}

/** Champs encore modifiables sur une facture validée (le reste est figé). */
const INVOICE_FIELDS_AFTER_VALIDATION = new Set(["paid_amount", "payment_status", "sent_at"]);

/**
 * Règles métier vérifiées à la fois sur l'appareil et sur le serveur.
 * Retourne la raison du refus, ou null si la modification est acceptable.
 */
export function checkChange(existing: SyncRecord | null, change: Change): string | null {
  if (!(SYNC_TABLES as readonly string[]).includes(change.tbl)) return "table inconnue";
  if (!isValidHlc(change.hlc)) return "horodatage invalide";
  if (typeof change.row !== "string" || change.row.length < 8 || change.row.length > 64) return "identifiant de ligne invalide";
  if (!change.patch || typeof change.patch !== "object" || Array.isArray(change.patch)) return "contenu invalide";
  if (Object.keys(change.patch).length === 0) return "modification vide";

  if (change.tbl === "invoices") {
    const validated = existing?.data.status === "validated";
    if (validated) {
      const forbidden = Object.keys(change.patch).filter((f) => !INVOICE_FIELDS_AFTER_VALIDATION.has(f));
      if (forbidden.length > 0) {
        return `facture validée non modifiable (${forbidden.join(", ")}) : passer par un avoir`;
      }
    }
    if (change.patch.status === "validated" && !validated) {
      if (typeof change.patch.number !== "string" || change.patch.number.length === 0) {
        return "une facture validée doit recevoir un numéro";
      }
    }
  }
  return null;
}

/** Requête et réponse de l'unique point d'échange /api/sync. */
export interface SyncRequest {
  /** Modifications locales en attente d'envoi. */
  changes: Change[];
  /** Curseur : dernier numéro de séquence serveur déjà reçu. */
  since: number;
}

export interface SyncResponse {
  accepted: string[];
  rejected: { id: string; reason: string; record: SyncRecord | null }[];
  /** Modifications des autres appareils depuis le curseur. */
  changes: Change[];
  cursor: number;
  /** Vrai s'il reste des modifications à récupérer. */
  more: boolean;
}

export const MAX_PUSH = 200;
export const MAX_PULL = 500;
