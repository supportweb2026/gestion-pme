/**
 * Module Projets : règles d'intégrité et de confidentialité (lot 1).
 *
 * Appelées en une ligne depuis `checkChange`, `checkPermission` et la boucle
 * de réception du serveur (voir sync.ts). Les mêmes fonctions tournent sur
 * l'appareil (src/web/local/guard.ts) pour refuser une action tout de suite,
 * même hors ligne.
 *
 * Références : 02-modele-de-donnees.md, §2.3 (tables), §4.3 (R1 à R6, R8, R9,
 * R11 à R14) et §4.4 (redactPatch). Lot 3 : journal des décisions immuable, « la
 * première validation fait foi », ordre des étapes, qui décide (délégation, Q2).
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
/** Natures d'étape (lot 2) : Démarrage, ordinaire, Levée des réserves. */
export const STAGE_KINDS = ["start", "normal", "reserves"] as const;
/** Décisions du journal `project_decisions` (§2.3). Le lot 3 écrit les six premières. */
export const DECISION_KINDS = [
  "stage_approved", "stage_approved_with_reserves", "stage_reopened", "project_paused", "project_resumed", "project_stopped",
  "budget_revised", "deadline_revised", "plan_requested", "amendment_proposed", "project_closed", "project_reopened",
] as const;
/** Décisions qui valident une étape. */
export const APPROVALS = ["stage_approved", "stage_approved_with_reserves"];
export const isApproval = (kind: unknown) => APPROVALS.includes(String(kind));
/** Décisions qui portent sur une étape (stage_id obligatoire). */
const STAGE_DECISIONS = ["stage_approved", "stage_approved_with_reserves", "stage_reopened"];
/** Décisions réservées à la direction (RG4.5, RG17.2). */
const DIRECTION_DECISIONS = ["stage_reopened", "project_reopened"];
/** Champs de suivi qu'un responsable d'étape peut écrire : « Demander la validation » (RG4.2). */
const REVIEW_FIELDS = new Set(["review_requested_at", "review_requested_by", "review_requested_by_name", "review_note"]);
/** Natures de tâche (lot 3 : tâches de réserve créées par une validation). */
export const TASK_KINDS = ["normal", "reserve", "plan", "issue"] as const;

/** Postes du budget (lot 4). */
export const BUDGET_POSTES = ["labour", "purchases", "subcontracting", "other"] as const;
/** Révisions tracées (RG7.3) : le responsable du projet les propose et les enregistre lui-même. */
const REVISIONS = ["budget_revised", "deadline_revised"];

/** Semaine ISO d'une priorité de la semaine : `2026-W48`. */
const WEEK = /^\d{4}-W\d{2}$/;

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
  /** Étapes du projet (lot 3), y compris celles acceptées plus tôt dans le même envoi. */
  stages?(projectId: string): SyncRecord[];
  /** Décisions du projet (lot 3), y compris celles acceptées plus tôt dans le même envoi. */
  decisions?(projectId: string): SyncRecord[];
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const isInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
const has = (patch: Fields, k: string) => Object.prototype.hasOwnProperty.call(patch, k);
const ddmmyyyy = (iso: string) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");

/** Décisions vivantes d'une étape, dans l'ordre (decided_at, id) : la dernière fait foi. */
export function decisionsOfStage<T extends { id: string; data: Fields }>(stageId: string, decisions: T[]): T[] {
  return decisions.filter((d) => !d.data[DELETED] && d.data.stage_id === stageId)
    .sort((a, b) => str(a.data.decided_at).localeCompare(str(b.data.decided_at)) || a.id.localeCompare(b.id));
}

/** État d'une étape d'après son journal seul : validée, arrêtée, en pause, ou rien (pas de décision en vigueur). */
export function decidedState(stageId: string, decisions: { id: string; data: Fields }[]): "approved" | "approved_reserves" | "stopped" | "paused" | null {
  const kind = str(decisionsOfStage(stageId, decisions).at(-1)?.data.kind);
  if (kind === "stage_approved") return "approved";
  if (kind === "stage_approved_with_reserves") return "approved_reserves";
  if (kind === "project_stopped" || kind === "stage_stopped") return "stopped";
  if (kind === "project_paused") return "paused";
  return null;
}

/**
 * R7 : une fois l'étape Démarrage (sinon la première étape) validée, le budget ne change plus
 * que par une révision tracée. Une réouverture ne rouvre pas le budget.
 */
export function budgetLocked(stages: { id: string; data: Fields }[], decisions: { id: string; data: Fields }[] = []): boolean {
  const list = stages.filter((s) => !s.data[DELETED]).sort((a, b) => (Number(a.data.rank) || 0) - (Number(b.data.rank) || 0) || a.id.localeCompare(b.id));
  const lock = list.find((s) => s.data.kind === "start") ?? list[0];
  if (!lock) return false;
  return decisionsOfStage(lock.id, decisions).some((d) => isApproval(d.data.kind));
}

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
      if (frozen(existing, p, "user_id")) return "le compte lié à cette personne ne peut pas être changé";
      const userId = str(value("user_id"));
      if (userId && row !== teamMemberIdOf(userId)) return "identifiant invalide";
      if (!existing && !str(p.name).trim()) return "indiquez le nom de la personne";
      if (has(p, "name") && !str(p.name).trim()) return "indiquez le nom de la personne";
      return null;
    }
    case "cost_rates": {
      if (frozen(existing, p, "team_member_id")) return "identifiant invalide";
      if (row !== COMPANY_COST_ID && row !== costRateIdOf(str(value("team_member_id")))) return "identifiant invalide";
      if (has(p, "hourly_cost") && !isInt(p.hourly_cost)) return "le coût horaire doit être un nombre entier positif";
      return null;
    }
    case "project_finance": {
      if (frozen(existing, p, "project_id")) return "une ligne ne change pas de projet";
      if (row !== financeIdOf(str(value("project_id")))) return "identifiant invalide";
      for (const k of ["sold_manual", "hourly_rate", "cost_rate", "legacy_budget"]) {
        if (has(p, k) && !isInt(p[k])) return "le montant doit être un nombre entier positif";
      }
      return null;
    }
    case "budget_lines": {
      if (frozen(existing, p, "project_id") || frozen(existing, p, "poste")) return "une ligne ne change pas de projet";
      if (existing && has(p, "stage_id") && str(p.stage_id) !== str(existing.data.stage_id)) return "une ligne ne change pas de projet";
      const poste = str(value("poste"));
      if (!(BUDGET_POSTES as readonly string[]).includes(poste)) return "poste de budget inconnu";
      if (row !== `bl-${str(value("project_id"))}-${str(value("stage_id")) || "all"}-${poste}`) return "identifiant invalide";
      if (has(p, "amount") && !isInt(p.amount)) return "le montant doit être un nombre entier positif";
      if (has(p, "hours") && (typeof p.hours !== "number" || !Number.isFinite(p.hours) || p.hours < 0)) return "indiquez un nombre d'heures positif";
      return null;
    }
    case "projects": {
      for (const k of ["tolerance_budget_pct", "tolerance_delay_pct"]) {
        if (has(p, k) && p[k] !== "" && (typeof p[k] !== "number" || !Number.isFinite(p[k] as number) || (p[k] as number) < 0 || (p[k] as number) > 100)) return "la tolérance doit être comprise entre 0 et 100 %";
      }
      return null;
    }
    case "project_members": {
      if (frozen(existing, p, "project_id")) return "une ligne ne change pas de projet";
      if (frozen(existing, p, "team_member_id")) return "identifiant invalide";
      if (row !== memberIdOf(str(value("project_id")), str(value("team_member_id")))) return "identifiant invalide";
      if (has(p, "role") && !(MEMBER_ROLES as readonly string[]).includes(str(p.role))) return "rôle dans le projet inconnu";
      return null;
    }
    case "project_stages": {
      if (frozen(existing, p, "project_id")) return "une ligne ne change pas de projet";
      if (!existing && !str(p.project_id)) return "cette étape n'est rattachée à aucun projet";
      if ((!existing || has(p, "name")) && !str(value("name")).trim() && !p[DELETED]) return "donnez un nom à l'étape";
      if (has(p, "kind") && !(STAGE_KINDS as readonly string[]).includes(str(p.kind))) return "nature d'étape inconnue";
      if (has(p, "billing_pct")) {
        const v = p.billing_pct;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) return "la part du vendu doit être comprise entre 0 et 100 %";
      }
      if (has(p, "rank") && (typeof p.rank !== "number" || !Number.isFinite(p.rank))) return "ordre invalide";
      if (has(p, "owner_id") && p.owner_id !== "" && !str(p.owner_id).startsWith("tm-")) return "personne introuvable dans l'annuaire";
      for (const k of ["start_date", "end_date"]) if (has(p, k) && p[k] !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(str(p[k]))) return "date invalide";
      const start = str(value("start_date"));
      const end = str(value("end_date"));
      if (start && end && end < start) return "la fin de l'étape précède son début";
      return null;
    }
    case "project_decisions": {
      // R1 : journal en ajout seul ; une décision enregistrée ne change plus, suppression comprise.
      if (existing) return "cette décision est déjà enregistrée et ne peut plus être modifiée : enregistrez une nouvelle décision";
      const kind = str(p.kind);
      if (!(DECISION_KINDS as readonly string[]).includes(kind)) return "nature de décision inconnue";
      if (!str(p.project_id)) return "cette décision n'est rattachée à aucun projet";
      if ((STAGE_DECISIONS.includes(kind) || kind === "project_paused" || kind === "project_stopped") && !str(p.stage_id)) return "indiquez l'étape concernée";
      if (!str(p.decided_by) || !str(p.decided_at)) return "une décision porte son auteur et sa date";
      if (["project_stopped", "stage_reopened", "project_reopened", "project_paused", "budget_revised", "deadline_revised"].includes(kind) && !str(p.comment).trim()) return "indiquez le motif de la décision";
      if (kind === "stage_approved_with_reserves" && !str(p.reserves).trim()) return "indiquez au moins une réserve, une par ligne";
      if (REVISIONS.includes(kind) && (!p.new_value || typeof p.new_value !== "object" || Array.isArray(p.new_value))) return "une révision porte l'ancienne et la nouvelle valeur";
      if (has(p, "retention_pct")) {
        const v = p.retention_pct;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) return "la retenue doit être comprise entre 0 et 100 %";
      }
      if (p[DELETED]) return "une décision ne se supprime pas";
      return null;
    }
    case "quotes": {
      // Un devis envoyé ne reçoit son projet qu'une fois : de vide à une valeur (RG3.2, RG3.6).
      const numbered = typeof existing?.data.number === "string" && existing.data.number !== "";
      if (numbered && has(p, "project_id") && frozen(existing, p, "project_id")) return "ce devis est déjà rattaché à un autre projet";
      if (numbered && has(p, "project_id") && !str(p.project_id) && str(existing?.data.project_id)) return "ce devis est déjà rattaché à un autre projet";
      return null;
    }
    case "tasks": {
      if (has(p, "priority_week") && p.priority_week !== "" && !WEEK.test(str(p.priority_week))) return "semaine invalide";
      if (has(p, "stage_id") && typeof p.stage_id !== "string") return "étape inconnue";
      if (has(p, "status") && !(TASK_STATUSES as readonly string[]).includes(str(p.status))) return "statut de tâche inconnu";
      if (has(p, "blocked_reason") && p.blocked_reason !== "" && !(BLOCK_REASONS as readonly string[]).includes(str(p.blocked_reason))) return "motif de blocage inconnu";
      if (has(p, "assignee_id") && p.assignee_id !== "" && !str(p.assignee_id).startsWith("tm-")) return "personne introuvable dans l'annuaire";
      if (has(p, "kind") && !(TASK_KINDS as readonly string[]).includes(str(p.kind))) return "nature de tâche inconnue";
      if (frozen(existing, p, "decision_id")) return "identifiant invalide";
      return null;
    }
    case "time_entries": {
      if (has(p, "hours")) {
        const h = p.hours;
        if (typeof h !== "number" || !Number.isFinite(h) || h <= 0 || h > 24) return "pas plus de 24 h par jour";
      }
      return null;
    }
    default:
      return null;
  }
}

/** Champs qu'un employé peut modifier sur une tâche existante (R9). */
const EMPLOYEE_TASK_FIELDS = new Set(["status", "blocked", "blocked_reason", "blocked_note", "blocked_at", "blocked_by", "description", "rank", "assignee_id"]);

/** Vrai si l'acteur dirige ce projet : direction, ou commanditaire ou responsable du projet dans l'équipe. */
export function leadsProject(actor: Actor, projectId: string, ctx?: ProjectContext): boolean {
  if (DIRECTION.includes(actor.role)) return true;
  if (!ctx || !projectId) return false;
  return ctx.rolesIn(projectId, actor.userId).some((r) => r === "manager" || r === "sponsor");
}

/**
 * Qui décide pour un projet (R4) : la direction, le commanditaire du projet, ou le
 * responsable du projet si la case « peut valider les étapes » est cochée (Q2).
 */
export function canDecide(actor: Actor, projectId: string, ctx?: ProjectContext): boolean {
  if (DIRECTION.includes(actor.role)) return true;
  if (actor.role === "employee" || !ctx || !projectId) return false;
  const roles = ctx.rolesIn(projectId, actor.userId);
  if (roles.includes("sponsor")) return true;
  return roles.includes("manager") && ctx.project(projectId)?.data.manager_can_validate === true;
}

/** Vrai si l'acteur peut demander la validation de l'étape : son responsable, ou qui dirige le projet (RG4.2). */
export function canRequestReview(actor: Actor, stage: { data: Fields } | null, ctx?: ProjectContext): boolean {
  if (!stage) return false;
  if (actor.role !== "employee") return true;
  if (str(stage.data.owner_id) === teamMemberIdOf(actor.userId)) return true;
  return leadsProject(actor, str(stage.data.project_id), ctx);
}

/**
 * Raison de refuser une validation d'étape, d'après le journal et les étapes du projet :
 * étape déjà validée (R2, « la première validation fait foi »), étape arrêtée, ou étape
 * précédente pas encore validée (R3, CA3.7). Null si la validation est possible.
 */
export function approvalBlocker(stageId: string, stages: { id: string; data: Fields }[], decisions: { id: string; data: Fields }[]): string | null {
  const last = decisionsOfStage(stageId, decisions).at(-1);
  if (last && isApproval(last.data.kind)) {
    const who = str(last.data.decided_by_name);
    return `cette étape est déjà validée${who ? ` par ${who}` : ""} le ${ddmmyyyy(str(last.data.decided_at).slice(0, 10))}`;
  }
  if (last && last.data.kind === "project_stopped") return "cette étape est arrêtée : elle ne peut plus être validée";
  const live = stages.filter((s) => !s.data[DELETED]);
  const stage = live.find((s) => s.id === stageId);
  if (!stage) return null;
  const rank = Number(stage.data.rank) || 0;
  const before = live.filter((s) => s.id !== stageId && (Number(s.data.rank) || 0) < rank)
    .sort((a, b) => (Number(a.data.rank) || 0) - (Number(b.data.rank) || 0));
  for (const s of before) {
    const state = decidedState(s.id, decisions);
    if (state === "approved" || state === "approved_reserves" || state === "stopped") continue;
    return `validez d'abord l'étape ${str(s.data.name)}`;
  }
  return null;
}

/** Vrai si l'acteur peut passer une tâche à Terminé (vérification de À vérifier → Terminé, CA1.5). */
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
      return direction ? null : "vous ne pouvez pas modifier l'annuaire ni les coûts horaires";
    case "project_members":
      return ["admin", "director", "sales", "project_manager"].includes(role) ? null : "vous ne pouvez pas modifier l'équipe de ce projet";
    case "budget_lines": {
      // R7 : après la validation de Démarrage, un montant ne change qu'avec la révision qui le porte.
      const projectId = str(existing?.data.project_id) || str(p.project_id);
      if (!ctx?.stages || !ctx.decisions || !budgetLocked(ctx.stages(projectId), ctx.decisions(projectId))) return null;
      for (const [field, key] of [["amount", "budget"], ["hours", "hours"]] as const) {
        if (!has(p, field)) continue;
        if (existing && !existing.data[DELETED] && existing.data[field] === p[field]) continue;
        if (!existing && !p[field]) continue;
        const covered = ctx.decisions(projectId).some((d) => d.data.kind === "budget_revised" && (d.data.new_value as Record<string, Record<string, unknown>> | undefined)?.[key]?.[change.row] === p[field]);
        if (!covered) return "le budget est validé : modifiez-le par une révision, avec son motif";
      }
      if (has(p, DELETED) && p[DELETED] && existing && Number(existing.data.amount) > 0) return "le budget est validé : modifiez-le par une révision, avec son motif";
      return null;
    }
    case "project_stages": {
      // Écriture ouverte aux rôles qui gèrent les projets (WRITABLE, comptable compris).
      if (role !== "employee") return null;
      // L'employé responsable de l'étape (ou du projet) peut seulement en demander la validation (RG4.2).
      const reviewOnly = Object.keys(p).every((k) => REVIEW_FIELDS.has(k));
      if (existing && reviewOnly && canRequestReview(actor, existing, ctx)) return null;
      return "vous ne pouvez pas modifier les étapes de ce projet";
    }
    case "projects": {
      if (has(p, DELETED) && p[DELETED] === true && !direction) return "vous ne pouvez pas supprimer ce projet";
      // Délégation de la validation (Q2) : direction ou commanditaire du projet seulement.
      if (has(p, "manager_can_validate") && !direction && !(ctx && ctx.rolesIn(change.row, actor.userId).includes("sponsor"))) {
        return "vous ne pouvez pas changer qui valide les étapes de ce projet";
      }
      return null;
    }
    case "project_decisions": {
      const projectId = str(p.project_id);
      const kind = str(p.kind);
      if (str(p.decided_by) !== actor.userId) return "une décision est enregistrée au nom de la personne qui la prend";
      if (DIRECTION_DECISIONS.includes(kind)) {
        if (!direction) return "vous ne pouvez pas rouvrir une étape ou un projet";
      } else if (REVISIONS.includes(kind)) {
        if (!canDecide(actor, projectId, ctx) && !leadsProject(actor, projectId, ctx)) return "vous ne pouvez pas réviser le budget ni les dates de ce projet";
      } else if (["plan_requested", "amendment_proposed"].includes(kind)) {
        if (!canDecide(actor, projectId, ctx)) return "vous ne pouvez pas décider pour ce projet";
      } else if (!canDecide(actor, projectId, ctx)) {
        return "vous ne pouvez pas valider les étapes de ce projet";
      }
      if (isApproval(kind) && ctx?.decisions && ctx.stages) {
        const blocker = approvalBlocker(str(p.stage_id), ctx.stages(projectId), ctx.decisions(projectId));
        if (blocker) return blocker;
      }
      return null;
    }
    case "invoices": {
      // Facture d'étape ou de retenue (R11, CA3.4) : la décision doit exister, et une même
      // facture ne passe pas d'une décision à une autre (une seule facture de jalon par étape).
      if (!has(p, "decision_id") || !str(p.decision_id)) return null;
      if (existing && !existing.data[DELETED] && str(existing.data.decision_id) && str(existing.data.decision_id) !== str(p.decision_id)) {
        return "cette étape a déjà sa facture";
      }
      const projectId = str(p.project_id) || str(existing?.data.project_id);
      if (ctx?.decisions && !ctx.decisions(projectId).some((d) => d.id === p.decision_id)) return "la décision de cette facture n'a pas été enregistrée";
      return null;
    }
    case "tasks": {
      const projectId = str(existing?.data.project_id) || str(p.project_id);
      // Tâche issue d'une décision (réserve) : refusée si la décision ne l'est (R11, pas de doublon).
      if (!existing && str(p.decision_id) && ctx?.decisions && !ctx.decisions(projectId).some((d) => d.id === p.decision_id)) {
        return "la décision de cette tâche n'a pas été enregistrée";
      }
      if (role !== "employee") return null;
      if (leadsProject(actor, projectId, ctx)) return null;
      const own = teamMemberIdOf(actor.userId);
      if (has(p, DELETED) && p[DELETED]) return "vous ne pouvez pas supprimer cette tâche";
      if (p.status === "done") return "vous ne pouvez pas passer cette tâche à Terminé : elle sera close après vérification";
      if (has(p, "assignee_id") && p.assignee_id !== "" && p.assignee_id !== own) return "vous pouvez attribuer une tâche seulement à vous-même";
      if (existing && !existing.data[DELETED]) {
        if (has(p, "assignee_id") && p.assignee_id === "" && str(existing.data.assignee_id) !== own) return "vous ne pouvez pas retirer cette tâche à la personne qui en est chargée";
        const forbidden = Object.keys(p).filter((k) => !EMPLOYEE_TASK_FIELDS.has(k));
        if (forbidden.length) return "vous pouvez modifier seulement l'avancement et la description de cette tâche";
      }
      return null;
    }
    case "time_entries": {
      // Une nouvelle saisie sur un projet terminé ou annulé est refusée (R12, CA6.4).
      const projectId = str(p.project_id) || str(existing?.data.project_id);
      if (!existing && projectId && ctx) {
        const status = str(ctx.project(projectId)?.data.status);
        if (status === "done" || status === "cancelled") return "ce projet est terminé : vous ne pouvez plus y saisir de temps";
      }
      if (role === "employee" && has(p, "date")) {
        // Référence : la date de l'appareil au moment de la saisie (HLC), pas celle du serveur.
        const ms = decodeHlc(change.hlc).ms - 7 * 86_400_000;
        const limit = new Date(ms).toISOString().slice(0, 10);
        if (str(p.date) < limit) return "vous pouvez saisir du temps sur les 7 derniers jours seulement";
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
    project_decisions: ["old_value", "new_value", "snapshot", "retention_pct"],
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
