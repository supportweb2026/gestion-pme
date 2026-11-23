import { isValidHlc, type Hlc } from "./hlc.ts";
import type { SubscriptionInfo } from "./plans.ts";
import { QUOTE_SERIES } from "./documents.ts";
import { checkSignature } from "./signature.ts";
import { checkProjectChange, checkProjectPermission, COMPANY_COST_ID, type ProjectContext } from "./projectRules.ts";

/** Tables synchronisées entre appareils. */
export const SYNC_TABLES = [
  "clients", "articles", "quotes", "invoices", "credit_notes", "payments",
  "expenses", "settings", "journal_entries", "projects", "tasks", "time_entries",
  // Module Projets, lot 1 : annuaire, coûts horaires (protégés), données financières (protégées), équipe du projet.
  "team_members", "cost_rates", "project_finance", "project_members",
  // Stock (lot 7 facturation) : entrées, inventaires, retours ; les sorties se déduisent des ventes.
  "stock_moves", "purchase_orders",
  // Projets, lot 2 : étapes.
  "project_stages",
  // Projets, lot 3 : journal des décisions (validations, réserves, pause, arrêt, réouverture), en ajout seul.
  "project_decisions",
  // Projets, lot 4 : budget prévu par poste (grille étape × poste), protégé comme project_finance.
  "budget_lines",
  // Projets, lot 5 : catégories de tâche, discussion, pièces jointes et liens, historique (en ajout seul).
  "task_categories", "task_comments", "attachments", "task_events",
  // Projets, lot 6 : points de vigilance (sans montant, lus par tous, signalés par tous).
  "watch_points",
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
  invoices: { numberedStatus: "validated", series: "FA", afterNumbering: ["sent_at", "paid_amount", "payment_status", "reminded_at", "reminders", "efact_number", "efact_status", "recurrence", "recurrence_next"] },
  credit_notes: { numberedStatus: "validated", series: "AV", afterNumbering: ["sent_at"] },
  // `project_id` : rattachement analytique d'un devis envoyé au projet qu'il lance (RG3.2) ;
  // ni imprimé ni comptable, il ne passe que de vide à une valeur (voir projectRules.ts).
  quotes: { numberedStatus: "sent", series: "DV", afterNumbering: ["status", "invoice_id", "sent_at", "decided_at", "project_id", "signature", "sign_token"] },
} as const;

/** Références qu'une nouvelle reprise d'historique peut ajouter à un document déjà repris (jamais remplacer). */
export const IMPORT_COMPLEMENT_FIELDS = ["client_ref", "payment_terms", "import_info", "seller_name"] as const;

export type DocTable = keyof typeof NUMBERED_DOCS;

export function isDocTable(tbl: string): tbl is DocTable {
  return tbl in NUMBERED_DOCS;
}

/**
 * Document repris d'un autre logiciel (champ `imported`, ex. "vosfactures") : créé en une
 * seule écriture, déjà numéroté. Réservé à la direction (voir checkPermission).
 */
export function isHistoryImport(patch: Fields): boolean {
  return typeof patch.imported === "string" && patch.imported !== "";
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
  if (typeof change.row !== "string" || change.row.length < 3 || change.row.length > 96) return "identifiant de ligne invalide";
  if (!change.patch || typeof change.patch !== "object" || Array.isArray(change.patch)) return "contenu invalide";
  if (Object.keys(change.patch).length === 0) return "modification vide";

  // Jeton de l'espace client en ligne : forme imposée, pour qu'il ne soit jamais devinable.
  if (change.tbl === "clients" && "portal_token" in change.patch && change.patch.portal_token !== "" && !/^[A-Za-z0-9_-]{32}$/.test(String(change.patch.portal_token))) {
    return "lien de l'espace client invalide";
  }

  if (isDocTable(change.tbl)) {
    const rule = NUMBERED_DOCS[change.tbl];
    const allowed = new Set<string>(rule.afterNumbering);
    if (isNumbered(existing?.data)) {
      // Document repris : une nouvelle reprise peut compléter ses références restées vides, jamais les changer.
      const complement = (f: string) => Boolean(existing?.data.imported) && (IMPORT_COMPLEMENT_FIELDS as readonly string[]).includes(f)
        && (existing?.data[f] === undefined || existing?.data[f] === "") && typeof change.patch[f] === "string" && (change.patch[f] as string).length <= 4000;
      const forbidden = Object.keys(change.patch).filter((f) => !allowed.has(f) && !complement(f));
      if (forbidden.length > 0) {
        const fix = change.tbl === "invoices" ? " : passer par un avoir" : "";
        return `document numéroté non modifiable (${forbidden.join(", ")})${fix}`;
      }
    } else if (isHistoryImport(change.patch)) {
      // Reprise d'historique : le document garde son numéro d'origine, hors des séries de Gestia.
      const n = change.patch.number;
      if (typeof n !== "string" || n.trim() === "" || n.length > 60) return "un document repris doit garder son numéro d'origine";
      return checkProjectChange(existing, change);
    } else if (change.patch.status === rule.numberedStatus) {
      const n = change.patch.number;
      // Les documents d'avant-vente ont chacun leur série (DV, PF, BC, BL).
      const series = change.tbl === "quotes" ? QUOTE_SERIES : [rule.series];
      if (typeof n !== "string" || !series.some((s) => n.startsWith(`${s}-`))) {
        return "un document validé doit recevoir un numéro de sa série";
      }
    }
    // Jeton du lien de signature en ligne : forme imposée, pour qu'il ne soit jamais devinable.
    if ("sign_token" in change.patch && change.patch.sign_token !== "" && !/^[A-Za-z0-9_-]{32}$/.test(String(change.patch.sign_token))) return "lien de signature invalide";
    // Signature du client : sur un document finalisé seulement, bien formée, et posée une seule fois.
    if ("signature" in change.patch) {
      if (change.tbl !== "quotes" || !isNumbered(existing?.data)) return "seul un document finalisé peut être signé";
      if (existing?.data.signature) return "document déjà signé";
      const bad = checkSignature(change.patch.signature);
      if (bad) return bad;
    }
    if ("number" in change.patch && !(change.patch.status === rule.numberedStatus) && !isNumbered(existing?.data)) {
      return "le numéro n'est attribué qu'à la validation";
    }
  }
  return checkProjectChange(existing, change);
}

/** Tables dont les lignes portent une date comptable, verrouillées après clôture. */
const DATED_TABLES = new Set(["invoices", "credit_notes", "payments", "expenses", "journal_entries", "time_entries", "stock_moves"]);

/** Tables que chaque rôle peut modifier. */
const WRITABLE: Record<string, readonly string[] | "all"> = {
  admin: "all",
  director: "all",
  accountant: "all",
  sales: ["clients", "articles", "quotes", "invoices", "credit_notes", "payments", "expenses", "projects", "tasks", "time_entries",
    "project_finance", "project_members", "stock_moves", "purchase_orders", "project_stages",
    "project_decisions", "budget_lines", "task_comments", "attachments", "task_events", "watch_points"],
  project_manager: ["clients", "quotes", "invoices", "payments", "expenses", "projects", "tasks", "time_entries",
    "project_finance", "project_members", "project_stages",
    "project_decisions", "budget_lines", "task_comments", "attachments", "task_events", "watch_points"],
  // `project_stages` : seulement « Demander la validation » d'une étape dont il est responsable (projectRules.ts).
  // Lot 5 : il commente, joint des fichiers et laisse l'historique de ses gestes sur les tâches.
  // Lot 6 : il signale un point de vigilance et suit ceux dont il est responsable (projectRules.ts).
  employee: ["expenses", "tasks", "time_entries", "project_stages", "task_comments", "attachments", "task_events", "watch_points"],
};

export interface Actor {
  userId: string;
  role: string;
}

/**
 * Droits et clôture, vérifiés par le serveur (et utilisables par l'appareil).
 * `closedUntil` : dernière date clôturée (AAAA-MM-JJ), ou vide.
 */
export function checkPermission(actor: Actor, existing: SyncRecord | null, change: Change, closedUntil = "", ctx?: ProjectContext): string | null {
  const writable = WRITABLE[actor.role] ?? [];
  if (writable !== "all" && !writable.includes(change.tbl)) return "votre rôle ne permet pas cette modification";

  if (isDocTable(change.tbl) && isHistoryImport(change.patch) && !["admin", "director"].includes(actor.role)) {
    return "reprise d'historique réservée à la direction";
  }
  if (isDocTable(change.tbl) && isNumbered(existing?.data) && Object.keys(change.patch).some((k) => (IMPORT_COMPLEMENT_FIELDS as readonly string[]).includes(k))
    && !["admin", "director"].includes(actor.role)) {
    return "reprise d'historique réservée à la direction";
  }
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

  if (change.tbl === "time_entries" && actor.role === "employee") {
    const owner = existing ? existing.data.user_id : change.patch.user_id;
    if (owner !== actor.userId) return "un employé ne saisit que ses propres temps";
  }

  if (closedUntil && DATED_TABLES.has(change.tbl)) {
    const onlyTracking = Object.keys(change.patch).every((k) => k === "sent_at" || (IMPORT_COMPLEMENT_FIELDS as readonly string[]).includes(k));
    const before = typeof existing?.data.date === "string" ? existing.data.date : "";
    const after = typeof change.patch.date === "string" ? change.patch.date : before;
    if (!onlyTracking && ((before && before <= closedUntil) || (after && after <= closedUntil))) {
      return `période clôturée jusqu'au ${closedUntil.split("-").reverse().join("/")}`;
    }
  }
  return checkProjectPermission(actor, existing, change, ctx);
}

/** Requête et réponse de l'unique point d'échange /api/sync. */
export interface SyncRequest {
  /** Modifications locales en attente d'envoi. */
  changes: Change[];
  /** Curseur : dernier numéro de séquence serveur déjà reçu. */
  since: number;
}

/**
 * Lecture : ce que le serveur envoie à un appareil selon le rôle de son utilisateur.
 * `owner` = auteur de la ligne (created_by), pour les dépenses personnelles.
 */
const READABLE: Record<string, readonly string[] | "all"> = {
  admin: "all",
  director: "all",
  accountant: "all",
  project_manager: SYNC_TABLES.filter((t) => t !== "journal_entries"),
  sales: SYNC_TABLES.filter((t) => t !== "journal_entries"),
  // Aucune table de montants (project_finance, cost_rates, budget_lines) ; les anciens champs
  // de montant de `projects` sont retirés à l'envoi (redactPatch).
  employee: ["settings", "projects", "tasks", "time_entries", "expenses", "team_members", "project_members", "project_stages", "project_decisions",
    "task_categories", "task_comments", "attachments", "task_events", "watch_points"],
};
const OWN_ONLY: Record<string, readonly string[]> = {
  sales: ["expenses"],
  employee: ["expenses"],
};

/**
 * Coût horaire par personne : direction et comptable seulement. Le chef de projet
 * et le commercial ne lisent que le coût moyen de l'entreprise (arbitrage 2).
 */
const COST_RATES_ALL = ["admin", "director", "accountant"];

export function canRead(actor: Actor, tbl: string, owner: unknown, rowId?: string): boolean {
  const readable = READABLE[actor.role] ?? [];
  if (readable !== "all" && !readable.includes(tbl)) return false;
  if (tbl === "cost_rates" && !COST_RATES_ALL.includes(actor.role)) return rowId === COMPANY_COST_ID;
  if ((OWN_ONLY[actor.role] ?? []).includes(tbl)) return owner === actor.userId;
  return true;
}

/**
 * Version des règles de lecture. Quand elle change, l'appareil d'un employé
 * repart de zéro pour effacer les montants reçus avant le filtrage (lot 1).
 */
export const DATA_EPOCH = 1;

export interface SyncResponse {
  /** Rôle pris en compte : s'il change, l'appareil repart de zéro. */
  role: string;
  /** Version des règles de lecture (voir DATA_EPOCH). */
  dataEpoch?: number;
  /** État de l'abonnement de l'entreprise (lecture seule si expiré ou suspendu). */
  subscription?: SubscriptionInfo;
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
