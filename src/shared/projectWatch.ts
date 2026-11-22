/**
 * Module Projets, lot 6 : points de vigilance (CDC §3.14, F14 ; météo §3.9 « Vigilance »).
 *
 * Un point de vigilance note ce qui peut mal tourner, qui s'en occupe et ce qu'on fait pour
 * l'éviter (la parade). Trois niveaux seulement (faible, moyen, fort), sans matrice 5 × 5 :
 * score = probabilité (1 à 3) × impact (1 à 3) ; 1 à 2 faible, 3 à 4 moyen, 6 à 9 fort.
 * « C'est arrivé » le transforme en problème (statut Survenu) et crée une tâche « Traiter : … ».
 *
 * Aucun montant : la table `watch_points` est lue par tout le monde, employé compris, et
 * ouverte à l'API et au connecteur. Le contrôle des champs (projectRules.ts) refuse tout
 * champ hors de la liste ci-dessous, pour qu'aucun montant n'y entre jamais.
 *
 * Fonctions pures : la date du jour est passée en paramètre.
 */
import type { Rec } from "./projects.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const live = (r: Rec) => !r.data._deleted;
const ddmm = (iso: string) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "");

export const WATCH_STATUSES = ["open", "controlled", "occurred", "closed"] as const;
export type WatchStatus = (typeof WATCH_STATUSES)[number];
export const WATCH_STATUS_LABELS: Record<WatchStatus, string> = { open: "Ouvert", controlled: "Maîtrisé", occurred: "Survenu", closed: "Clos" };

/** Probabilité (féminin) et impact (masculin), de 1 à 3. */
export const PROBABILITY_LABELS: Record<number, string> = { 1: "Faible", 2: "Moyenne", 3: "Forte" };
export const IMPACT_LABELS: Record<number, string> = { 1: "Faible", 2: "Moyen", 3: "Fort" };

export type WatchLevel = "low" | "medium" | "high";
export const WATCH_LEVEL_LABELS: Record<WatchLevel, string> = { low: "Faible", medium: "Moyen", high: "Fort" };

/** Champs admis sur un point de vigilance : aucun montant (projectRules.ts refuse les autres). */
export const WATCH_FIELDS = new Set([
  "project_id", "stage_id", "title", "probability", "impact", "response", "owner_id", "owner_name", "response_due", "status",
  "issue_task_id", "occurred_at", "occurred_by", "closed_at", "closed_by", "rank", "created_by", "created_by_name", "created_at", "_deleted",
]);
export const WATCH_TITLE_MAX = 200;
export const WATCH_RESPONSE_MAX = 500;

/** Valeur 1, 2 ou 3 (défaut 2) : un point incomplet reste lisible. */
const level3 = (v: unknown) => {
  const n = Number(v);
  return n === 1 || n === 2 || n === 3 ? n : 2;
};

export const watchScore = (p: Rec) => level3(p.data.probability) * level3(p.data.impact);
export const levelOfScore = (score: number): WatchLevel => (score >= 6 ? "high" : score >= 3 ? "medium" : "low");
export const watchLevel = (p: Rec) => levelOfScore(watchScore(p));
export const watchStatus = (p: Rec): WatchStatus => ((WATCH_STATUSES as readonly string[]).includes(str(p.data.status)) ? (str(p.data.status) as WatchStatus) : "open");

/** Point en vigilance active : ouvert ou maîtrisé (ni survenu, ni clos). */
export const isWatching = (p: Rec) => ["open", "controlled"].includes(watchStatus(p));
/** Problème ouvert : le risque est survenu et le problème n'est pas encore clos. */
export const isIssue = (p: Rec) => watchStatus(p) === "occurred";

/** La parade a une échéance dépassée alors que le point est encore ouvert. */
export const responseLate = (p: Rec, today: string) => watchStatus(p) === "open" && !!str(p.data.response_due) && str(p.data.response_due) < today;

/** Point fort ouvert sans parade, ou dont la parade est en retard (alerte du responsable du projet, F13). */
export const needsResponse = (p: Rec, today: string) =>
  watchStatus(p) === "open" && watchLevel(p) === "high" && (!str(p.data.response).trim() || responseLate(p, today));

const ORDER: Record<WatchStatus, number> = { occurred: 0, open: 1, controlled: 2, closed: 3 };

/** Points vivants d'un projet : problèmes d'abord, puis ouverts, maîtrisés et clos ; les plus forts d'abord. */
export function watchPointsOf<T extends Rec>(projectId: string, points: T[] = []): T[] {
  return points.filter((p) => live(p) && p.data.project_id === projectId)
    .sort((a, b) => ORDER[watchStatus(a)] - ORDER[watchStatus(b)] || watchScore(b) - watchScore(a)
      || (Number(a.data.rank) || 0) - (Number(b.data.rank) || 0) || str(a.data.created_at).localeCompare(str(b.data.created_at)) || a.id.localeCompare(b.id));
}

export interface WatchCriterion { light: "green" | "orange" | "red" | "grey"; reason: string }

const more = (n: number) => (n > 1 ? ` et ${n - 1} autre${n > 2 ? "s" : ""}` : "");

/**
 * Critère « vigilance » de la météo (§3.9) :
 *  - rouge si un problème (risque survenu) est ouvert, ou si un point fort (score ≥ 6) ouvert
 *    n'a pas de parade ou a une parade en retard (CA6.1, CA6.2) ;
 *  - orange si un point fort a une parade à jour, ou si au moins 3 points moyens sont ouverts ;
 *  - vert sinon ; gris si aucun point de vigilance n'a jamais été saisi.
 * Un point « Maîtrisé » ne compte plus : la parade a fait son effet.
 */
export function watchLight(projectId: string, points: Rec[] = [], today: string): WatchCriterion {
  const mine = watchPointsOf(projectId, points);
  if (mine.length === 0) return { light: "grey", reason: "Aucun point de vigilance." };
  const issues = mine.filter(isIssue);
  if (issues.length) return { light: "red", reason: `Problème ouvert : ${str(issues[0].data.title)}${more(issues.length)}.` };
  const open = mine.filter((p) => watchStatus(p) === "open");
  const high = open.filter((p) => watchLevel(p) === "high");
  const bare = high.filter((p) => !str(p.data.response).trim());
  if (bare.length) return { light: "red", reason: `Point de vigilance fort sans parade : « ${str(bare[0].data.title)} » (score ${watchScore(bare[0])})${more(bare.length)}.` };
  const late = high.filter((p) => responseLate(p, today));
  if (late.length) return { light: "red", reason: `Parade en retard depuis le ${ddmm(str(late[0].data.response_due))} : « ${str(late[0].data.title)} »${more(late.length)}.` };
  if (high.length) {
    const due = str(high[0].data.response_due);
    return { light: "orange", reason: `Point de vigilance fort suivi : « ${str(high[0].data.title)} », parade ${due ? `prévue le ${ddmm(due)}` : "en place"}${more(high.length)}.` };
  }
  const medium = open.filter((p) => watchLevel(p) === "medium");
  if (medium.length >= 3) return { light: "orange", reason: `${medium.length} points de vigilance moyens ouverts.` };
  const watching = mine.filter(isWatching).length;
  return { light: "green", reason: watching ? `${watching} point${watching > 1 ? "s" : ""} de vigilance sous contrôle.` : "Aucun point de vigilance ouvert." };
}

/** Identifiant déterministe de la tâche « Traiter : … » d'un point survenu : deux appareils, une seule tâche. */
export const issueTaskId = (pointId: string) => `tsk-iss-${pointId}`;

/**
 * « C'est arrivé » (RG14.2, CA6.2) : le point passe Survenu et une tâche « Traiter : … » est
 * créée, attribuée au responsable du point. `assignOthers` faux (employé) : la tâche n'est
 * attribuée que si le responsable est lui-même (règle R9), sinon elle reste à attribuer.
 * Si le point a déjà sa tâche (survenu une première fois), elle est reprise, pas dupliquée.
 */
export function occurredPlan(point: Rec, o: { userId: string; now: string; today: string; assignOthers: boolean; existingTask?: Rec | null }): {
  point: Record<string, unknown>; task: { id: string; patch: Record<string, unknown> } | null;
} {
  const owner = str(point.data.owner_id);
  const self = `tm-${o.userId}`;
  const taskId = str(point.data.issue_task_id) || issueTaskId(point.id);
  const pointPatch: Record<string, unknown> = { status: "occurred", occurred_at: o.now, occurred_by: o.userId, issue_task_id: taskId };
  if (o.existingTask && live(o.existingTask)) {
    return { point: pointPatch, task: o.existingTask.data.status === "done" ? { id: taskId, patch: { status: "todo" } } : null };
  }
  const assignee = owner && (o.assignOthers || owner === self) ? owner : "";
  const title = `Traiter : ${str(point.data.title)}`.slice(0, WATCH_TITLE_MAX);
  const response = str(point.data.response).trim();
  return {
    point: pointPatch,
    task: {
      id: taskId,
      patch: {
        project_id: str(point.data.project_id), title, status: "todo", priority: "high", kind: "issue", watch_point_id: point.id,
        ...(assignee ? { assignee_id: assignee } : {}),
        ...(response ? { description: `Parade prévue : ${response}` } : {}),
        due_date: o.today, created_by: o.userId, created_at: o.now,
      },
    },
  };
}

/** Suggestions par type de projet (RG14.1), choisies d'un geste. Le type se lit dans le modèle et le nom. */
export const WATCH_SUGGESTIONS: Record<"btp" | "event" | "it" | "general", string[]> = {
  btp: ["Retard de livraison du ciment", "Pluies sur le chantier", "Matériel bloqué au port", "Accès au site retardé par le client"],
  event: ["Coupure de courant le jour J", "Prestataire traiteur défaillant", "Salle non disponible à la date prévue", "Retard des invités officiels"],
  it: ["Accès client non fournis", "Données du client incomplètes", "Validation du client en retard", "Panne du serveur d'hébergement"],
  general: ["Le client tarde à valider", "Personne clé absente", "Matériel livré en retard", "Paiement du client en retard"],
};

export function suggestionKind(project: Rec): keyof typeof WATCH_SUGGESTIONS {
  const text = `${str(project.data.name)} ${str(project.data.description)} ${str(project.data.objective)}`.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  if (/chantier|btp|batiment|construction|refection|travaux|amenagement|genie civil|maconnerie|electricit/.test(text)) return "btp";
  if (/evenement|seminaire|salon|ceremonie|gala|conference|festival|lancement/.test(text)) return "event";
  if (/site|logiciel|informatique|reseau|serveur|application|web|migration|developpement/.test(text)) return "it";
  if (str(project.data.template) === "forfait") return "btp";
  if (str(project.data.template) === "creation") return "it";
  return "general";
}

/** Suggestions pas encore saisies sur ce projet. */
export function watchSuggestions(project: Rec, points: Rec[] = []): string[] {
  const taken = new Set(watchPointsOf(project.id, points).map((p) => str(p.data.title).trim().toLowerCase()));
  return WATCH_SUGGESTIONS[suggestionKind(project)].filter((s) => !taken.has(s.toLowerCase()));
}
