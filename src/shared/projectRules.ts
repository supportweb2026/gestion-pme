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
 * Lot 6 : points de vigilance (sans montant), clôture tracée et projet clôturé en lecture
 * seule (RG1.3, RG17.1, RG17.2, CA6.3, CA6.4), vérifiés aussi par le serveur.
 */
import { decodeHlc } from "./hlc.ts";
import type { Actor, Change, Fields, SyncRecord } from "./sync.ts";
import { COMMENT_EDIT_MINUTES, COMMENT_EDIT_MS, COMMENT_MAX, FILE_ID_RE, LINK_RE, TASK_EVENT_KINDS } from "./projectBoard.ts";
import { WATCH_FIELDS, WATCH_RESPONSE_MAX, WATCH_STATUSES, WATCH_TITLE_MAX } from "./projectWatch.ts";

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

/** Dernière décision de clôture ou de réouverture du projet (RG17.2) : elle dit si le projet est clos. */
export function lastClosureKind(decisions: { id: string; data: Fields }[]): "project_closed" | "project_reopened" | null {
  const list = decisions.filter((d) => !d.data[DELETED] && (d.data.kind === "project_closed" || d.data.kind === "project_reopened"))
    .sort((a, b) => str(a.data.decided_at).localeCompare(str(b.data.decided_at)) || a.id.localeCompare(b.id));
  const kind = str(list.at(-1)?.data.kind);
  return kind === "project_closed" || kind === "project_reopened" ? kind : null;
}

/** Projet arrêté (« Arrêter le projet », F5) : ses étapes non validées ne bloquent pas la clôture (RG17.4). */
export const isStoppedProject = (decisions: { data: Fields }[]) => decisions.some((d) => !d.data[DELETED] && d.data.kind === "project_stopped");

/**
 * Condition bloquante de la clôture vérifiée aussi par le serveur (CA6.3) : toutes les étapes
 * sont validées ou arrêtées, sauf si le projet a été arrêté. Renvoie la raison, avec l'étape en cause.
 */
export function closureStageBlocker(stages: { id: string; data: Fields }[], decisions: { id: string; data: Fields }[]): string | null {
  if (isStoppedProject(decisions)) return null;
  const list = stages.filter((s) => !s.data[DELETED]).sort((a, b) => (Number(a.data.rank) || 0) - (Number(b.data.rank) || 0) || a.id.localeCompare(b.id));
  for (const s of list) {
    const state = decidedState(s.id, decisions);
    if (state === "approved" || state === "approved_reserves" || state === "stopped") continue;
    return `l'étape ${str(s.data.name)} n'est pas validée : validez-la avant de clôturer le projet`;
  }
  return null;
}

/** Réponses du bilan (« Ce qui a bien marché », « Ce qu'on ferait autrement », « À retenir pour le prochain devis »). */
export const LESSON_KEYS = ["good", "change", "next"] as const;
export const LESSON_MAX = 1000;

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
      // Lot 6 : réponses du bilan, trois textes courts.
      if (has(p, "closure_answers")) {
        const a = p.closure_answers;
        if (!a || typeof a !== "object" || Array.isArray(a)) return "contenu invalide";
        for (const [k, v] of Object.entries(a as Fields)) {
          if (!(LESSON_KEYS as readonly string[]).includes(k) || typeof v !== "string") return "contenu invalide";
          if (v.length > LESSON_MAX) return `une réponse du bilan ne doit pas dépasser ${LESSON_MAX} caractères`;
        }
      }
      return null;
    }
    case "watch_points": {
      // Lot 6 : aucun montant (liste fermée de champs), projet figé, niveaux de 1 à 3.
      if (Object.keys(p).some((k) => !WATCH_FIELDS.has(k))) return "contenu invalide : un point de vigilance ne porte que sa description, ses niveaux, sa parade, son responsable et son état";
      if (frozen(existing, p, "project_id")) return "une ligne ne change pas de projet";
      if (frozen(existing, p, "issue_task_id")) return "identifiant invalide";
      if (!existing && !str(p.project_id)) return "ce point de vigilance n'est rattaché à aucun projet";
      if ((!existing || has(p, "title")) && !p[DELETED] && !str(value("title")).trim()) return "décrivez le point de vigilance";
      if (has(p, "title") && str(p.title).length > WATCH_TITLE_MAX) return `la description ne doit pas dépasser ${WATCH_TITLE_MAX} caractères`;
      if (has(p, "response") && str(p.response).length > WATCH_RESPONSE_MAX) return `la parade ne doit pas dépasser ${WATCH_RESPONSE_MAX} caractères`;
      for (const k of ["probability", "impact"]) {
        if ((!existing && !p[DELETED]) || has(p, k)) {
          if (![1, 2, 3].includes(value(k) as number)) return k === "probability" ? "choisissez la probabilité : faible, moyenne ou forte" : "choisissez l'impact : faible, moyen ou fort";
        }
      }
      if (has(p, "status") && !(WATCH_STATUSES as readonly string[]).includes(str(p.status))) return "état du point de vigilance inconnu";
      if (has(p, "owner_id") && p.owner_id !== "" && !str(p.owner_id).startsWith("tm-")) return "personne introuvable dans l'annuaire";
      if (has(p, "response_due") && p.response_due !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(str(p.response_due))) return "date invalide";
      if (has(p, "rank") && (typeof p.rank !== "number" || !Number.isFinite(p.rank))) return "ordre invalide";
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
      // Lot 5 : catégorie et archivage (seule une tâche terminée s'archive).
      if (has(p, "category_id") && p.category_id !== "" && !str(p.category_id).startsWith("cat-")) return "catégorie inconnue";
      if (has(p, "archived") && typeof p.archived !== "boolean") return "contenu invalide";
      if (value("archived") === true && (str(value("status")) || "todo") !== "done" && !p[DELETED]) return "seule une tâche terminée peut être archivée";
      return null;
    }
    case "task_categories": {
      if (!/^cat-[a-z0-9-]{1,60}$/.test(row)) return "identifiant invalide";
      if ((!existing || has(p, "name")) && !p[DELETED] && !str(value("name")).trim()) return "donnez un nom à la catégorie";
      if (has(p, "name") && str(p.name).trim().length > 40) return "le nom de la catégorie ne doit pas dépasser 40 caractères";
      if (has(p, "rank") && (typeof p.rank !== "number" || !Number.isFinite(p.rank))) return "ordre invalide";
      return null;
    }
    case "task_comments": {
      for (const k of ["task_id", "project_id", "author_id", "created_at"]) if (frozen(existing, p, k)) return "un commentaire ne change pas de tâche ni d'auteur";
      if (!existing) {
        if (!str(p.task_id)) return "ce commentaire n'est rattaché à aucune tâche";
        if (!str(p.author_id) || !str(p.created_at)) return "un commentaire porte son auteur et sa date";
        if (!Number.isFinite(Date.parse(str(p.created_at)))) return "date invalide";
      }
      if ((!existing || has(p, "body")) && !p[DELETED] && !str(value("body")).trim()) return "écrivez le commentaire";
      if (has(p, "body") && str(p.body).length > COMMENT_MAX) return `un commentaire ne doit pas dépasser ${COMMENT_MAX} caractères`;
      const extra = Object.keys(p).filter((k) => !["task_id", "project_id", "body", "author_id", "author_name", "created_at", "edited_at", "created_by", "created_by_name", DELETED].includes(k));
      if (extra.length) return "contenu invalide";
      return null;
    }
    case "attachments": {
      for (const k of ["tbl", "row_id", "project_id", "kind", "file_id", "url", "created_by", "created_at"]) if (frozen(existing, p, k)) return "une pièce jointe ne change pas de tâche";
      if (!existing) {
        if (str(p.tbl) !== "tasks" || !str(p.row_id)) return "cette pièce jointe n'est rattachée à aucune tâche";
        if (str(p.kind) === "file") {
          if (!FILE_ID_RE.test(str(p.file_id))) return "fichier introuvable";
        } else if (str(p.kind) === "link") {
          if (!LINK_RE.test(str(p.url)) || str(p.url).length > 2000) return "indiquez une adresse qui commence par https://";
        } else return "nature de pièce jointe inconnue";
      }
      if (has(p, "label") && str(p.label).length > 200) return "le libellé ne doit pas dépasser 200 caractères";
      return null;
    }
    case "task_events": {
      // Historique en ajout seul : un événement enregistré ne change plus.
      if (existing) return "l'historique d'une tâche ne se modifie pas";
      if (!(TASK_EVENT_KINDS as readonly string[]).includes(str(p.kind))) return "nature d'événement inconnue";
      if (!str(p.task_id) || !str(p.by) || !str(p.at)) return "un événement porte sa tâche, son auteur et sa date";
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

/** Tables rattachées à un projet par `project_id`, figées quand le projet est clôturé (RG17.1). */
const PROJECT_ROWS = new Set([
  "tasks", "time_entries", "project_stages", "project_members", "project_finance", "budget_lines", "project_decisions",
  "task_comments", "attachments", "task_events", "watch_points", "expenses", "invoices", "credit_notes",
]);
/** Après la clôture, dépenses et factures restent rattachables par la comptabilité et la direction (RG17.1). */
const ACCOUNTING = ["admin", "director", "accountant"];
export const CLOSED_PROJECT = "ce projet est clôturé : il est en lecture seule";

/**
 * Projet clôturé en lecture seule (RG1.3, RG17.1, RG17.2), sur l'appareil et sur le serveur :
 *  - le projet ne passe à Terminé que par sa décision de clôture, et n'en sort que par une réouverture ;
 *  - un projet clôturé ne change plus, sauf les réponses du bilan ;
 *  - ses lignes (tâches, temps, étapes, équipe, budget, vigilance, commentaires…) ne changent plus ;
 *    seules une réouverture, et les dépenses et factures de la comptabilité, passent encore.
 * Sans contexte (ni projet ni décisions connus), la règle ne s'applique pas.
 */
export function closedProjectBlocker(actor: Actor, existing: SyncRecord | null, change: Change, ctx?: ProjectContext): string | null {
  const p = change.patch;
  if (change.tbl === "projects") {
    const was = str(existing?.data.status);
    const next = has(p, "status") ? str(p.status) : was;
    const decisions = ctx?.decisions?.(change.row);
    if (was !== "done" && next === "done" && decisions && lastClosureKind(decisions) !== "project_closed") {
      return "un projet passe à Terminé seulement par sa clôture : utilisez « Clôturer le projet »";
    }
    if (was !== "done" || existing?.data[DELETED]) return null;
    if (next !== "done") {
      return decisions && lastClosureKind(decisions) !== "project_reopened" ? "ce projet est clôturé : rouvrez-le d'abord, avec le motif de la réouverture" : null;
    }
    return Object.keys(p).every((k) => k === "closure_answers" || k === "status") ? null : CLOSED_PROJECT;
  }
  if (!ctx || !PROJECT_ROWS.has(change.tbl)) return null;
  const projectId = str(existing?.data.project_id) || str(p.project_id);
  if (!projectId || str(ctx.project(projectId)?.data.status) !== "done") return null;
  switch (change.tbl) {
    case "project_decisions":
      return p.kind === "project_reopened" ? null : p.kind === "project_closed" ? "ce projet est déjà clôturé" : CLOSED_PROJECT;
    case "expenses":
    case "invoices":
    case "credit_notes":
      return ACCOUNTING.includes(actor.role) ? null : "ce projet est clôturé : vous ne pouvez plus y rattacher de dépense ni de facture";
    case "time_entries":
      // Facturation du temps après la clôture (une facture de solde peut arriver après, RG17.1).
      if (ACCOUNTING.includes(actor.role) && existing && Object.keys(p).every((k) => k === "invoice_id")) return null;
      return "ce projet est clôturé : vous ne pouvez plus y saisir de temps";
    default:
      return CLOSED_PROJECT;
  }
}

/**
 * Droits propres au module Projets (R9, R12, R14 et tables du lot 1).
 * Appelée par `checkPermission` après le contrôle des tables modifiables.
 */
export function checkProjectPermission(actor: Actor, existing: SyncRecord | null, change: Change, ctx?: ProjectContext): string | null {
  const p = change.patch;
  const role = actor.role;
  const direction = DIRECTION.includes(role);
  const closed = closedProjectBlocker(actor, existing, change, ctx);
  if (closed) return closed;

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
      } else if (kind === "project_closed") {
        // Clôture (F17) : qui décide du projet ; toutes les étapes validées ou arrêtées (CA6.3).
        if (!canDecide(actor, projectId, ctx)) return "vous ne pouvez pas clôturer ce projet";
        if (ctx?.stages && ctx.decisions) {
          const blocker = closureStageBlocker(ctx.stages(projectId), ctx.decisions(projectId));
          if (blocker) return blocker;
        }
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
    case "task_categories":
      return direction ? null : "vous ne pouvez pas modifier les catégories de tâche";
    case "watch_points": {
      // Tout le monde signale un point ; l'employé suit ceux dont il est responsable ou qu'il a signalés.
      if (!existing && str(p.created_by) && str(p.created_by) !== actor.userId) return "un point de vigilance est signalé au nom de la personne qui le signale";
      if (role !== "employee") return null;
      const projectId = str(existing?.data.project_id) || str(p.project_id);
      if (leadsProject(actor, projectId, ctx)) return null;
      if (!existing) return null;
      const own = teamMemberIdOf(actor.userId);
      if (str(existing.data.owner_id) !== own && str(existing.data.created_by) !== actor.userId) {
        return "vous pouvez suivre seulement les points de vigilance dont vous êtes responsable ou que vous avez signalés";
      }
      if (has(p, "owner_id") && p.owner_id !== own && p.owner_id !== existing.data.owner_id) return "vous pouvez confier ce point de vigilance seulement à vous-même";
      return null;
    }
    case "task_comments": {
      // Toute personne qui voit la tâche peut commenter ; seul l'auteur modifie ou supprime son
      // commentaire, et seulement pendant 15 minutes (heure de l'appareil, comme pour le temps).
      const at = decodeHlc(change.hlc).ms;
      if (!existing) {
        if (str(p.author_id) !== actor.userId) return "un commentaire est publié au nom de la personne qui l'écrit";
        if (Date.parse(str(p.created_at)) > at + 60_000) return "date invalide";
        return null;
      }
      if (str(existing.data.author_id) !== actor.userId) return "vous pouvez modifier ou supprimer seulement vos propres commentaires";
      if (existing.data[DELETED]) return "ce commentaire est supprimé";
      if (at - Date.parse(str(existing.data.created_at)) > COMMENT_EDIT_MS) return `ce commentaire est figé : il ne peut plus être modifié ni supprimé après ${COMMENT_EDIT_MINUTES} minutes`;
      return null;
    }
    case "attachments": {
      if (!existing) return str(p.created_by) === actor.userId ? null : "une pièce jointe est ajoutée au nom de la personne qui la joint";
      if (str(existing.data.created_by) === actor.userId || leadsProject(actor, str(existing.data.project_id), ctx)) return null;
      return "vous pouvez retirer seulement les pièces jointes que vous avez ajoutées";
    }
    case "task_events":
      return str(p.by) === actor.userId ? null : "un événement d'historique est enregistré au nom de son auteur";
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
