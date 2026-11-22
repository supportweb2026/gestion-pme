/**
 * Projets, lot 5 : piloter toutes les tâches (l'équivalent du tableau Trello).
 *
 * Fonctions pures, partagées par l'appareil, le serveur et les tests :
 *  - catégories de tâche (liste propre à l'entreprise, cinq catégories par défaut) ;
 *  - tâches visibles selon les droits, filtres du tableau de toutes les tâches ;
 *  - discussion : délai de 15 minutes pour modifier ou supprimer son commentaire ;
 *  - historique de la tâche, enregistré à l'écriture (`task_events`, en ajout seul) ;
 *  - rappel des échéances : en retard ou due dans les 2 jours.
 *
 * Référence : 04-remplacer-trello.md (points 1 à 6).
 */
import type { Rec } from "./projects.ts";
import type { DayItem } from "./projectControl.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const live = (r: Rec) => !r.data._deleted;
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const dayMs = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / dayMs);
const plusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
const mondayOf = (iso: string) => plusDays(iso, -((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7));
const ddmmyyyy = (iso: string) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");

// ---- Catégories ----

export interface TaskCategory { id: string; name: string; rank: number; active: boolean }

/** Catégories par défaut (étiquettes de couleur du tableau Trello « IDO – Pilotage », plus « Interne »). */
export const DEFAULT_TASK_CATEGORIES: readonly { id: string; name: string }[] = [
  { id: "cat-client", name: "Client" },
  { id: "cat-infra", name: "Infra" },
  { id: "cat-securite", name: "Sécurité" },
  { id: "cat-couts", name: "Coûts" },
  { id: "cat-interne", name: "Interne" },
];

/** Identifiant d'une nouvelle catégorie, tiré de son nom : « Relances clients » → `cat-relances-clients`. */
export function categoryIdFor(name: string, taken: Iterable<string> = []): string {
  const base = `cat-${name.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "categorie"}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Liste des catégories de l'entreprise : les catégories par défaut, modifiées ou retirées par
 * les lignes de `task_categories` de même identifiant, puis les catégories ajoutées. Aucune
 * ligne à créer au départ : la liste par défaut existe sans écriture, hors ligne compris.
 * Les catégories retirées restent dans la liste (`active` faux) pour nommer les anciennes tâches.
 */
export function taskCategories(rows: Rec[] = []): TaskCategory[] {
  const out = new Map<string, TaskCategory>();
  DEFAULT_TASK_CATEGORIES.forEach((c, i) => out.set(c.id, { id: c.id, name: c.name, rank: (i + 1) * 10, active: true }));
  for (const r of rows) {
    const prev = out.get(r.id);
    const name = str(r.data.name).trim() || prev?.name || "";
    if (!name) continue;
    const rank = typeof r.data.rank === "number" && Number.isFinite(r.data.rank) ? r.data.rank : prev?.rank ?? 1000;
    out.set(r.id, { id: r.id, name, rank, active: live(r) });
  }
  return [...out.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, "fr"));
}

/** Nom d'une catégorie, toujours en toutes lettres ; vide si la tâche n'en a pas. */
export function categoryName(id: unknown, categories: TaskCategory[]): string {
  const key = str(id);
  if (!key) return "";
  return categories.find((c) => c.id === key)?.name ?? "Catégorie retirée";
}

// ---- Droits de lecture du tableau ----

export const isArchived = (t: Rec) => t.data.archived === true;
export const isOpen = (t: Rec) => (str(t.data.status) || "todo") !== "done";

/**
 * Projets dont un utilisateur voit les tâches sur le tableau de toutes les tâches.
 * Direction, comptable, commercial et responsable de projet : tous les projets. Employé :
 * les projets de son équipe, ceux où une tâche lui est attribuée et les anciens projets sans
 * équipe (même règle que la liste des projets, lot 1).
 */
export function visibleProjectIds(role: string, teamMemberId: string, projects: Rec[], members: Rec[], tasks: Rec[]): Set<string> {
  const ids = new Set<string>();
  for (const p of projects) {
    if (!live(p)) continue;
    if (role !== "employee") { ids.add(p.id); continue; }
    const team = members.filter((m) => live(m) && m.data.project_id === p.id);
    if (team.length === 0 || team.some((m) => m.data.team_member_id === teamMemberId)
      || tasks.some((t) => live(t) && t.data.project_id === p.id && t.data.assignee_id === teamMemberId)) ids.add(p.id);
  }
  return ids;
}

// ---- Filtres du tableau ----

export type DueFilter = "" | "late" | "week";
export interface BoardFilter {
  /** "" : tout le monde ; "none" : non attribuées ; sinon l'identifiant `tm-…` de la personne. */
  person: string;
  /** "" : tous les projets ; sinon l'identifiant du projet. */
  project: string;
  /** "" : toutes ; "none" : sans catégorie ; sinon l'identifiant `cat-…`. */
  category: string;
  due: DueFilter;
  blocked: boolean;
  /** Vrai : seulement les tâches archivées ; faux : les tâches archivées sont masquées. */
  archived: boolean;
  /** Recherche dans le titre, la description et le nom du projet. */
  q: string;
}

export const EMPTY_FILTER: BoardFilter = { person: "", project: "", category: "", due: "", blocked: false, archived: false, q: "" };

/** Nombre de filtres actifs (hors recherche), pour « Effacer les filtres ». */
export const activeFilters = (f: BoardFilter) =>
  [f.person, f.project, f.category, f.due].filter(Boolean).length + Number(f.blocked) + Number(f.archived) + Number(!!f.q.trim());

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Vrai si l'échéance de la tâche tombe dans la semaine (lundi à dimanche) de `today`. */
export function dueThisWeek(task: Rec, today: string): boolean {
  const due = str(task.data.due_date);
  if (!due) return false;
  const monday = mondayOf(today);
  return due >= monday && due <= plusDays(monday, 6);
}

export const isLate = (task: Rec, today: string) => isOpen(task) && !!str(task.data.due_date) && str(task.data.due_date) < today;

/** Applique les filtres du tableau à une tâche. `projectName` sert à la recherche. */
export function matchesFilter(task: Rec, f: BoardFilter, today: string, projectName: (id: string) => string = () => ""): boolean {
  if (!live(task)) return false;
  if (isArchived(task) !== f.archived) return false;
  if (f.person === "none" ? !!(task.data.assignee_id || task.data.assignee) : f.person && task.data.assignee_id !== f.person) return false;
  if (f.project && task.data.project_id !== f.project) return false;
  if (f.category === "none" ? !!str(task.data.category_id) : f.category && task.data.category_id !== f.category) return false;
  if (f.due === "late" && !isLate(task, today)) return false;
  if (f.due === "week" && !dueThisWeek(task, today)) return false;
  if (f.blocked && !(task.data.blocked && isOpen(task))) return false;
  const q = fold(f.q.trim());
  if (q && !fold(`${str(task.data.title)} ${str(task.data.description)} ${projectName(str(task.data.project_id))}`).includes(q)) return false;
  return true;
}

/** Tâches du tableau : visibles selon les droits, puis filtrées. */
export function boardTasks<T extends Rec>(tasks: T[], visible: Set<string>, f: BoardFilter, today: string, projectName?: (id: string) => string): T[] {
  return tasks.filter((t) => visible.has(str(t.data.project_id)) && matchesFilter(t, f, today, projectName));
}

/** Tri d'une colonne : bloquées d'abord, puis en retard, priorité haute, échéance, rang. */
export function boardOrder(a: Rec, b: Rec, today: string): number {
  const pr = (t: Rec) => ({ high: 0, normal: 1, low: 2 }[str(t.data.priority)] ?? 1);
  return Number(!!b.data.blocked) - Number(!!a.data.blocked)
    || Number(isLate(b, today)) - Number(isLate(a, today))
    || pr(a) - pr(b)
    || (str(a.data.due_date) || "9999").localeCompare(str(b.data.due_date) || "9999")
    || str(a.data.title).localeCompare(str(b.data.title), "fr");
}

// ---- Discussion ----

/** Délai pendant lequel l'auteur peut modifier ou supprimer son commentaire ; ensuite il est figé. */
export const COMMENT_EDIT_MINUTES = 15;
export const COMMENT_EDIT_MS = COMMENT_EDIT_MINUTES * 60_000;
/** Longueur maximale d'un commentaire. */
export const COMMENT_MAX = 4000;

/** Instant (ms) jusqu'auquel le commentaire reste modifiable. */
export const commentEditableUntil = (comment: Rec) => Date.parse(str(comment.data.created_at)) + COMMENT_EDIT_MS;

/** Vrai si `userId` peut encore modifier ou supprimer ce commentaire à l'instant `nowMs`. */
export function canEditComment(comment: Rec, userId: string, nowMs: number): boolean {
  if (!live(comment) || comment.data.author_id !== userId) return false;
  const until = commentEditableUntil(comment);
  return Number.isFinite(until) && nowMs <= until;
}

/** Minutes restantes pour modifier le commentaire (arrondi supérieur), 0 s'il est figé. */
export function commentMinutesLeft(comment: Rec, nowMs: number): number {
  const left = commentEditableUntil(comment) - nowMs;
  return Number.isFinite(left) && left > 0 ? Math.ceil(left / 60_000) : 0;
}

/** Commentaires d'une tâche, du plus ancien au plus récent. */
export function commentsOf<T extends Rec>(taskId: string, comments: T[]): T[] {
  return comments.filter((c) => live(c) && c.data.task_id === taskId)
    .sort((a, b) => str(a.data.created_at).localeCompare(str(b.data.created_at)) || a.id.localeCompare(b.id));
}

// ---- Pièces jointes et liens ----

export const LINK_RE = /^https?:\/\/[^\s]+$/i;
export const FILE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Libellé d'un lien sans libellé : le domaine et le chemin, sans le protocole. */
export function linkLabel(url: string, label = ""): string {
  if (label.trim()) return label.trim();
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/** Pièces jointes et liens d'une tâche, du plus ancien au plus récent. */
export function attachmentsOf<T extends Rec>(taskId: string, rows: T[]): T[] {
  return rows.filter((a) => live(a) && a.data.tbl === "tasks" && a.data.row_id === taskId)
    .sort((a, b) => str(a.data.created_at).localeCompare(str(b.data.created_at)) || a.id.localeCompare(b.id));
}

// ---- Historique ----

export const TASK_EVENT_KINDS = ["moved", "due_changed", "blocked", "unblocked", "assigned", "archived", "unarchived"] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];
export interface TaskEventDraft { kind: TaskEventKind; from: string; to: string }

/**
 * Événements d'historique d'une modification de tâche : déplacée, échéance changée, bloquée
 * ou débloquée, personne changée, archivée. La création ne produit pas d'événement : elle se
 * lit sur la tâche elle-même (`created_at`, `created_by`).
 */
export function taskEventsOf(existing: Record<string, unknown> | null | undefined, patch: Record<string, unknown>): TaskEventDraft[] {
  if (!existing || existing._deleted || patch._deleted) return [];
  const out: TaskEventDraft[] = [];
  if (has(patch, "status") && (str(patch.status) || "todo") !== (str(existing.status) || "todo")) {
    out.push({ kind: "moved", from: str(existing.status) || "todo", to: str(patch.status) || "todo" });
  }
  if (has(patch, "due_date") && str(patch.due_date) !== str(existing.due_date)) {
    out.push({ kind: "due_changed", from: str(existing.due_date), to: str(patch.due_date) });
  }
  if (has(patch, "blocked") && !!patch.blocked !== !!existing.blocked) {
    out.push(patch.blocked
      ? { kind: "blocked", from: "", to: str(has(patch, "blocked_reason") ? patch.blocked_reason : existing.blocked_reason) }
      : { kind: "unblocked", from: str(existing.blocked_reason), to: "" });
  }
  if (has(patch, "assignee_id") && str(patch.assignee_id) !== str(existing.assignee_id)) {
    out.push({ kind: "assigned", from: str(existing.assignee_id) || str(existing.assignee), to: str(patch.assignee_id) });
  }
  if (has(patch, "archived") && !!patch.archived !== !!existing.archived) {
    out.push({ kind: patch.archived ? "archived" : "unarchived", from: "", to: "" });
  }
  return out;
}

const STATUS_LABELS: Record<string, string> = { todo: "À faire", doing: "En cours", review: "À vérifier", done: "Terminé" };
const BLOCK_LABELS: Record<string, string> = {
  material: "J'attends du matériel", client: "J'attends le client", info: "Il me manque une information", other: "Autre motif",
};

/** Phrase d'un événement d'historique. `nameOf` donne le nom d'une personne (`tm-…`) ou de l'ancien texte. */
export function eventLabel(e: { kind: string; from: string; to: string }, nameOf: (id: string) => string): string {
  switch (e.kind) {
    case "created": return "Tâche créée";
    case "moved": return `Déplacée de « ${STATUS_LABELS[e.from] ?? e.from} » vers « ${STATUS_LABELS[e.to] ?? e.to} »`;
    case "due_changed":
      if (!e.from) return `Échéance fixée au ${ddmmyyyy(e.to)}`;
      if (!e.to) return `Échéance retirée (elle était au ${ddmmyyyy(e.from)})`;
      return `Échéance changée du ${ddmmyyyy(e.from)} au ${ddmmyyyy(e.to)}`;
    case "blocked": return `Bloquée : ${BLOCK_LABELS[e.to] ?? "motif non précisé"}`;
    case "unblocked": return "Débloquée";
    case "assigned":
      if (!e.to) return `Plus attribuée${e.from ? ` (elle l'était à ${nameOf(e.from)})` : ""}`;
      return `Attribuée à ${nameOf(e.to)}${e.from ? ` à la place de ${nameOf(e.from)}` : ""}`;
    case "archived": return "Archivée";
    case "unarchived": return "Sortie des archives";
    default: return "Modifiée";
  }
}

export interface HistoryLine { at: string; by: string; byName: string; kind: string; label: string }

/**
 * Historique d'une tâche, du plus récent au plus ancien : ses événements, puis sa création
 * (lue sur la tâche, y compris pour les tâches d'avant le lot 5).
 */
export function taskHistory(task: Rec, events: Rec[], nameOf: (id: string) => string, userName: (userId: string) => string = () => ""): HistoryLine[] {
  const lines: HistoryLine[] = events
    .filter((e) => live(e) && e.data.task_id === task.id)
    .map((e) => {
      const ev = { kind: str(e.data.kind), from: str(e.data.from), to: str(e.data.to) };
      return { at: str(e.data.at), by: str(e.data.by), byName: str(e.data.by_name) || userName(str(e.data.by)), kind: ev.kind, label: eventLabel(ev, nameOf) };
    });
  lines.sort((a, b) => b.at.localeCompare(a.at));
  const created = str(task.data.created_at);
  lines.push({ at: created, by: str(task.data.created_by), byName: str(task.data.created_by_name) || userName(str(task.data.created_by)), kind: "created", label: "Tâche créée" });
  return lines;
}

// ---- Rappel des échéances ----

/** Une tâche due dans ce nombre de jours (ou en retard) remonte dans « Ma journée » et « À décider ». */
export const REMINDER_DAYS = 2;

export interface DeadlineReminder<T extends Rec = Rec> {
  task: T;
  /** late : échéance dépassée ; today : due aujourd'hui ; soon : due dans 1 ou 2 jours. */
  kind: "late" | "today" | "soon";
  /** Jours de retard (late) ou jours restants (soon) ; 0 aujourd'hui. */
  days: number;
}

/**
 * Rappels de la personne responsable : ses tâches ouvertes, non archivées, sur un projet
 * actif, en retard ou dues dans les 2 jours. Les plus en retard d'abord.
 */
export function deadlineReminders<T extends Rec>(teamMemberId: string, tasks: T[], projects: Rec[], today: string, within = REMINDER_DAYS): DeadlineReminder<T>[] {
  const open = new Set(projects.filter((p) => live(p) && !["done", "cancelled"].includes(str(p.data.status))).map((p) => p.id));
  const limit = plusDays(today, within);
  const out: DeadlineReminder<T>[] = [];
  for (const t of tasks) {
    if (!live(t) || isArchived(t) || !isOpen(t) || t.data.assignee_id !== teamMemberId || !open.has(str(t.data.project_id))) continue;
    const due = str(t.data.due_date);
    if (!due || due > limit) continue;
    const kind = due < today ? "late" : due === today ? "today" : "soon";
    out.push({ task: t, kind, days: Math.abs(daysBetween(today, due)) });
  }
  const rank = { late: 0, today: 1, soon: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.kind === "late" ? b.days - a.days : a.days - b.days) || str(a.task.data.title).localeCompare(str(b.task.data.title), "fr"));
}

/** Phrase courte d'un rappel : « En retard de 3 jours », « Échéance aujourd'hui », « Échéance demain ». */
export function reminderLabel(r: { kind: string; days: number }): string {
  if (r.kind === "late") return r.days === 1 ? "En retard d'1 jour" : `En retard de ${r.days} jours`;
  if (r.kind === "today") return "Échéance aujourd'hui";
  return r.days === 1 ? "Échéance demain" : `Échéance dans ${r.days} jours`;
}

/**
 * « Ma journée » avec le rappel des échéances : une tâche due dans 1 ou 2 jours remonte juste
 * après les tâches dues aujourd'hui, avant les tâches simplement en cours (`soonDays` > 0).
 * Le calcul de base (`myDay`) ne change pas : il reste celui du connecteur.
 */
export function withDeadlines<T extends Rec>(plan: { today: DayItem<T>[]; others: DayItem<T>[]; review: T[] }, today: string, limit = 7, within = REMINDER_DAYS): { today: (DayItem<T> & { soonDays: number })[]; others: (DayItem<T> & { soonDays: number })[]; review: T[] } {
  const rank = { priority: 0, late: 1, due: 2, doing: 4, start: 5, open: 6 } as Record<string, number>;
  const all = [...plan.today, ...plan.others].map((i, n) => {
    const due = str(i.task.data.due_date);
    const d = due && due > today ? daysBetween(today, due) : 0;
    const soonDays = d > 0 && d <= within && !["priority", "late", "due"].includes(i.reason) ? d : 0;
    return { ...i, soonDays, n, upcoming: plan.today.length <= n };
  });
  const key = (i: (typeof all)[number]) => (i.soonDays ? 3 : i.upcoming ? 10 : rank[i.reason] ?? 6);
  all.sort((a, b) => key(a) - key(b) || (a.soonDays && b.soonDays ? a.soonDays - b.soonDays : 0) || a.n - b.n);
  const clean = all.map(({ n: _n, upcoming: _u, ...i }) => i);
  return { today: clean.slice(0, limit), others: clean.slice(limit), review: plan.review };
}
