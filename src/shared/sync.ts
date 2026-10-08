import { isValidHlc, type Hlc } from "./hlc.ts";

/** Tables synchronisées entre appareils. */
export const SYNC_TABLES = [
  "clients", "articles", "quotes", "invoices", "credit_notes", "payments",
  "expenses", "settings", "journal_entries", "projects", "tasks",
] as const;
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

/**
 * Documents commerciaux numérotés. Une fois numérotés (facture ou avoir validé,
 * devis envoyé), leur contenu est figé : seuls certains champs de suivi bougent.
 */
export const NUMBERED_DOCS = {
  invoices: { numberedStatus: "validated", series: "FA", afterNumbering: ["sent_at", "paid_amount", "payment_status"] },
  credit_notes: { numberedStatus: "validated", series: "AV", afterNumbering: ["sent_at"] },
  quotes: { numberedStatus: "sent", series: "DV", afterNumbering: ["status", "invoice_id", "sent_at", "decided_at"] },
} as const;

export type DocTable = keyof typeof NUMBERED_DOCS;

export function isDocTable(tbl: string): tbl is DocTable {
  return tbl in NUMBERED_DOCS;
}

/** Vrai si le document a déjà reçu son numéro définitif. */
export function isNumbered(data: Fields | undefined): boolean {
  return typeof data?.number === "string" && data.number.length > 0;
}

/**
 * Règles métier vérifiées à la fois sur l'appareil et sur le serveur.
 * Retourne la raison du refus, ou null si la modification est acceptable.
 */
export function checkChange(existing: SyncRecord | null, change: Change): string | null {
  if (!(SYNC_TABLES as readonly string[]).includes(change.tbl)) return "table inconnue";
  if (!isValidHlc(change.hlc)) return "horodatage invalide";
  if (typeof change.row !== "string" || change.row.length < 3 || change.row.length > 64) return "identifiant de ligne invalide";
  if (!change.patch || typeof change.patch !== "object" || Array.isArray(change.patch)) return "contenu invalide";
  if (Object.keys(change.patch).length === 0) return "modification vide";

  if (isDocTable(change.tbl)) {
    const rule = NUMBERED_DOCS[change.tbl];
    const allowed = new Set<string>(rule.afterNumbering);
    if (isNumbered(existing?.data)) {
      const forbidden = Object.keys(change.patch).filter((f) => !allowed.has(f));
      if (forbidden.length > 0) {
        const fix = change.tbl === "invoices" ? " : passer par un avoir" : "";
        return `document numéroté non modifiable (${forbidden.join(", ")})${fix}`;
      }
    } else if (change.patch.status === rule.numberedStatus) {
      const n = change.patch.number;
      if (typeof n !== "string" || !n.startsWith(`${rule.series}-`)) {
        return "un document validé doit recevoir un numéro de sa série";
      }
    }
    if ("number" in change.patch && !(change.patch.status === rule.numberedStatus) && !isNumbered(existing?.data)) {
      return "le numéro n'est attribué qu'à la validation";
    }
  }
  return null;
}

/** Tables dont les lignes portent une date comptable, verrouillées après clôture. */
const DATED_TABLES = new Set(["invoices", "credit_notes", "payments", "expenses", "journal_entries"]);

/** Tables que chaque rôle peut modifier. */
const WRITABLE: Record<string, readonly string[] | "all"> = {
  admin: "all",
  director: "all",
  accountant: "all",
  sales: ["clients", "articles", "quotes", "invoices", "credit_notes", "payments", "expenses"],
  project_manager: ["clients", "quotes", "invoices", "payments", "expenses", "projects", "tasks"],
  employee: ["expenses"],
};

export interface Actor {
  userId: string;
  role: string;
}

/**
 * Droits et clôture, vérifiés par le serveur (et utilisables par l'appareil).
 * `closedUntil` : dernière date clôturée (AAAA-MM-JJ), ou vide.
 */
export function checkPermission(actor: Actor, existing: SyncRecord | null, change: Change, closedUntil = ""): string | null {
  const writable = WRITABLE[actor.role] ?? [];
  if (writable !== "all" && !writable.includes(change.tbl)) return "votre rôle ne permet pas cette modification";

  if (change.tbl === "journal_entries" && !["admin", "accountant"].includes(actor.role)) {
    return "écritures diverses réservées au comptable et à l'administrateur";
  }
  if (change.tbl === "settings") {
    if ("closed_until" in change.patch && !["admin", "accountant"].includes(actor.role)) return "clôture réservée au comptable et à l'administrateur";
    const other = Object.keys(change.patch).filter((k) => k !== "closed_until");
    if (other.length && !["admin", "director"].includes(actor.role)) return "réglages réservés à la direction";
  }
  if (change.tbl === "expenses") {
    const status = change.patch.status;
    const deciding = status === "approved" || status === "rejected";
    const approver = ["admin", "director", "accountant"].includes(actor.role);
    if (deciding && !approver) return "validation des dépenses réservée à la direction";
    if (actor.role === "employee" && existing && existing.data.created_by !== actor.userId) return "dépense d'un autre utilisateur";
  }

  if (closedUntil && DATED_TABLES.has(change.tbl)) {
    const onlyTracking = Object.keys(change.patch).every((k) => k === "sent_at");
    const before = typeof existing?.data.date === "string" ? existing.data.date : "";
    const after = typeof change.patch.date === "string" ? change.patch.date : before;
    if (!onlyTracking && ((before && before <= closedUntil) || (after && after <= closedUntil))) {
      return `période clôturée jusqu'au ${closedUntil.split("-").reverse().join("/")}`;
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
