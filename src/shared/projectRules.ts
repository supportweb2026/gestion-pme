/**
 * Module Projets : règles d'intégrité et de confidentialité (lot 1).
 *
 * Appelées en une ligne depuis `checkChange`, `checkPermission` et la boucle
 * de réception du serveur (voir sync.ts). Les mêmes fonctions tournent sur
 * l'appareil (src/web/local/guard.ts) pour refuser une action tout de suite,
 * même hors ligne.
 *
 * Références : 02-modele-de-donnees.md, §2.3 (tables), §4.3 (R5, R6, R9, R12,
 * R13, R14) et §4.4 (redactPatch).
 */
import { decodeHlc } from "./hlc.ts";
import type { Actor, Change, Fields, SyncRecord } from "./sync.ts";

const DELETED = "_deleted";

/** Statuts de tâche (inchangés). */
export const TASK_STATUSES = ["todo", "doing", "review", "done"] as const;
/** Motifs de blocage (RG12.3). */
export const BLOCK_REASONS = ["material", "client", "info", "other"] as const;
/** Rôles dans un projet. */
export const MEMBER_ROLES = ["sponsor", "manager", "member"] as const;

/** Identifiants déterministes (R6). */
export const teamMemberIdOf = (userId: string) => `tm-${userId}`;
export const costRateIdOf = (teamMemberId: string) => `cr-${teamMemberId}`;
export const COMPANY_COST_ID = "cr-company";
export const financeIdOf = (projectId: string) => `fin-${projectId}`;
export const memberIdOf = (projectId: string, teamMemberId: string) => `pm-${projectId}-${teamMemberId}`;

/** Rôles Gestia qui dirigent l'entreprise : tous les droits sur tous les projets. */
const DIRECTION = ["admin", "director"];

/**
 * Ce que le serveur (ou l'appareil) sait des projets touchés par un envoi.
 * Sans contexte, les règles qui en dépendent ne s'appliquent pas.
 */
export interface ProjectContext {
  /** Rôles de l'utilisateur dans le projet (équipe du projet). */
  rolesIn(projectId: string, userId: string): string[];
  /** Ligne du projet, ou null si inconnue. */
  project(projectId: string): SyncRecord | null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const isInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
const has = (patch: Fields, k: string) => Object.prototype.hasOwnProperty.call(patch, k);

/** Champ non modifiable une fois posé (R5). */
function frozen(existing: SyncRecord | null, patch: Fields, field: string): boolean {
  if (!existing || !has(patch, field)) return false;
  const before = str(existing.data[field]);
  return before !== "" && str(patch[field]) !== before;
}

/**
 * Contenu (R5, R6, R13) : identifiants déterministes, champs figés, bornes et
 * énumérations. Retourne la raison du refus, ou null.
 */
export function checkProjectChange(existing: SyncRecord | null, change: Change): string | null {
  const p = change.patch;
  const row = change.row;
  const value = (k: string) => (has(p, k) ? p[k] : existing?.data[k]);

  switch (change.tbl) {
    case "team_members": {
      if (!row.startsWith("tm-")) return "identifiant invalide";
      if (frozen(existing, p, "user_id")) return "compte lié non modifiable";
      const userId = str(value("user_id"));
      if (userId && row !== teamMemberIdOf(userId)) return "identifiant invalide";
      if (!existing && !str(p.name).trim()) return "nom obligatoire";
      if (has(p, "name") && !str(p.name).trim()) return "nom obligatoire";
      return null;
    }
    case "cost_rates": {
      if (frozen(existing, p, "team_member_id")) return "identifiant invalide";
      if (row !== COMPANY_COST_ID && row !== costRateIdOf(str(value("team_member_id")))) return "identifiant invalide";
      if (has(p, "hourly_cost") && !isInt(p.hourly_cost)) return "coût horaire invalide (entier positif)";
      return null;
    }
    case "project_finance": {
      if (frozen(existing, p, "project_id")) return "une ligne ne change pas de projet";
      if (row !== financeIdOf(str(value("project_id")))) return "identifiant invalide";
      for (const k of ["sold_manual", "hourly_rate", "cost_rate", "legacy_budget"]) {
        if (has(p, k) && !isInt(p[k])) return "montant invalide (entier positif)";
      }
      return null;
    }
    case "project_members": {
      if (frozen(existing, p, "project_id")) return "une ligne ne change pas de projet";
      if (frozen(existing, p, "team_member_id")) return "identifiant invalide";
      if (row !== memberIdOf(str(value("project_id")), str(value("team_member_id")))) return "identifiant invalide";
      if (has(p, "role") && !(MEMBER_ROLES as readonly string[]).includes(str(p.role))) return "rôle de projet inconnu";
      return null;
    }
    case "tasks": {
      if (has(p, "status") && !(TASK_STATUSES as readonly string[]).includes(str(p.status))) return "statut de tâche inconnu";
      if (has(p, "blocked_reason") && p.blocked_reason !== "" && !(BLOCK_REASONS as readonly string[]).includes(str(p.blocked_reason))) return "motif de blocage inconnu";
      if (has(p, "assignee_id") && p.assignee_id !== "" && !str(p.assignee_id).startsWith("tm-")) return "responsable inconnu";
      return null;
    }
    case "time_entries": {
      if (has(p, "hours")) {
        const h = p.hours;
        if (typeof h !== "number" || !Number.isFinite(h) || h <= 0 || h > 24) return "Pas plus de 24 h par jour";
      }
      return null;
    }
    default:
      return null;
  }
}

/** Champs qu'un employé peut modifier sur une tâche existante (R9). */
const EMPLOYEE_TASK_FIELDS = new Set(["status", "blocked", "blocked_reason", "blocked_note", "blocked_at", "blocked_by", "description", "rank", "assignee_id"]);

/** Vrai si l'acteur dirige ce projet : direction, ou commanditaire / chef de projet dans l'équipe. */
export function leadsProject(actor: Actor, projectId: string, ctx?: ProjectContext): boolean {
  if (DIRECTION.includes(actor.role)) return true;
  if (!ctx || !projectId) return false;
  return ctx.rolesIn(projectId, actor.userId).some((r) => r === "manager" || r === "sponsor");
}

/** Vrai si l'acteur peut passer une tâche à Terminé (contrôle de À valider → Terminé, CA1.5). */
export function canCloseTask(actor: Actor, projectId: string, ctx?: ProjectContext): boolean {
  if (actor.role !== "employee") return true;
  return leadsProject(actor, projectId, ctx);
}

/**
 * Droits propres au module Projets (R9, R12, R14 et tables du lot 1).
 * Appelée par `checkPermission` après le contrôle des tables modifiables.
 */
export function checkProjectPermission(actor: Actor, existing: SyncRecord | null, change: Change, ctx?: ProjectContext): string | null {
  const p = change.patch;
  const role = actor.role;
  const direction = DIRECTION.includes(role);

  switch (change.tbl) {
    case "team_members":
    case "cost_rates":
      return direction ? null : "annuaire et coûts horaires réservés à la direction";
    case "project_members":
      return ["admin", "director", "sales", "project_manager"].includes(role) ? null : "équipe du projet réservée au chef de projet";
    case "projects":
      if (has(p, DELETED) && p[DELETED] === true && !direction) return "suppression d'un projet réservée à la direction";
      return null;
    case "tasks": {
      if (role !== "employee") return null;
      const projectId = str(existing?.data.project_id) || str(p.project_id);
      if (leadsProject(actor, projectId, ctx)) return null;
      const own = teamMemberIdOf(actor.userId);
      if (has(p, DELETED) && p[DELETED]) return "un employé ne supprime pas une tâche";
      if (p.status === "done") return "un employé ne passe pas une tâche à Terminé";
      if (has(p, "assignee_id") && p.assignee_id !== "" && p.assignee_id !== own) return "un employé ne s'attribue que ses propres tâches";
      if (existing && !existing.data[DELETED]) {
        if (has(p, "assignee_id") && p.assignee_id === "" && str(existing.data.assignee_id) !== own) return "un employé ne change pas le responsable d'une tâche";
        const forbidden = Object.keys(p).filter((k) => !EMPLOYEE_TASK_FIELDS.has(k));
        if (forbidden.length) return `un employé ne modifie que le suivi de la tâche (${forbidden.join(", ")})`;
      }
      return null;
    }
    case "time_entries": {
      // Une nouvelle saisie sur un projet terminé ou annulé est refusée (R12, CA6.4).
      const projectId = str(p.project_id) || str(existing?.data.project_id);
      if (!existing && projectId && ctx) {
        const status = str(ctx.project(projectId)?.data.status);
        if (status === "done" || status === "cancelled") return "projet terminé : saisie de temps impossible";
      }
      if (role === "employee" && has(p, "date")) {
        // Référence : la date de l'appareil au moment de la saisie (HLC), pas celle du serveur.
        const ms = decodeHlc(change.hlc).ms - 7 * 86_400_000;
        const limit = new Date(ms).toISOString().slice(0, 10);
        if (str(p.date) < limit) return "saisie limitée aux 7 derniers jours";
      }
      return null;
    }
    default:
      return null;
  }
}

// ---- Confidentialité à l'envoi (§4.4) ----

/** Champs retirés de tout ce qu'un rôle reçoit, historique compris. */
export const REDACT: Record<string, Record<string, readonly string[]>> = {
  employee: {
    projects: ["budget", "hourly_rate", "cost_rate"],
  },
};

/** Retire les champs sensibles d'une modification ; null = plus rien à envoyer. */
export function redactPatch(actor: Actor, tbl: string, patch: Fields): Fields | null {
  const fields = REDACT[actor.role]?.[tbl];
  if (!fields) return patch;
  const out: Fields = {};
  let kept = 0;
  for (const [k, v] of Object.entries(patch)) {
    if (fields.includes(k)) continue;
    out[k] = v;
    kept++;
  }
  return kept > 0 ? out : null;
}

/** Même filtrage pour une ligne entière (ligne renvoyée après un refus). */
export function redactRecord(actor: Actor, record: SyncRecord | null): SyncRecord | null {
  if (!record) return record;
  const fields = REDACT[actor.role]?.[record.tbl];
  if (!fields) return record;
  const data = { ...record.data };
  const clocks = { ...record.clocks };
  for (const f of fields) {
    delete data[f];
    delete clocks[f];
  }
  return { ...record, data, clocks };
}
