/**
 * Module Projets : calculs partagés du lot 1 (Ma journée, annuaire, heures).
 * Fonctions pures, sans accès réseau ni stockage : la date du jour est passée en paramètre.
 */
import type { Rec } from "./projects.ts";
import { teamMemberIdOf } from "./projectRules.ts";

const num = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const live = (r: Rec) => !r.data._deleted;

/** Recherche insensible aux accents, à la casse et aux espaces multiples. */
export const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Initiales pour un avatar : « Junior Mintsa » → « JM ». */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

/** Libellés des motifs de blocage (RG12.3). */
export const BLOCK_LABELS: Record<string, string> = {
  material: "J'attends du matériel",
  client: "J'attends le client",
  info: "Il me manque une information",
  other: "Autre",
};

/** Libellés des rôles dans un projet. */
export const MEMBER_ROLE_LABELS: Record<string, string> = {
  manager: "Responsable du projet",
  sponsor: "Commanditaire",
  member: "Membre",
};

/**
 * Fiches d'annuaire à créer ou à mettre à jour à partir des comptes utilisateurs
 * (identifiant déterministe `tm-{user_id}` : aucun doublon, même à plusieurs appareils).
 */
export function teamSync(users: { id: string; name: string; active: number | boolean }[], members: Rec[], by: string, now: string): { id: string; patch: Record<string, unknown> }[] {
  const out: { id: string; patch: Record<string, unknown> }[] = [];
  for (const u of users) {
    const id = teamMemberIdOf(u.id);
    const existing = members.find((m) => m.id === id);
    const active = Boolean(u.active);
    if (!existing) {
      out.push({ id, patch: { user_id: u.id, name: u.name, active, created_by: by, created_at: now } });
    } else if (!active && existing.data.active !== false) {
      // Un compte désactivé n'est plus proposé ; une réactivation se fait dans l'annuaire.
      out.push({ id, patch: { active: false } });
    }
  }
  return out;
}

/**
 * Personne de l'annuaire dont le nom correspond exactement au texte libre
 * (sans accents ni casse) ; null s'il n'y en a aucune ou plusieurs (deux « Paul »).
 */
export function matchTeamMember(name: unknown, members: Rec[]): Rec | null {
  const target = fold(str(name));
  if (!target) return null;
  const found = members.filter((m) => live(m) && fold(str(m.data.name)) === target);
  return found.length === 1 ? found[0] : null;
}

/** Nom affiché du responsable d'une tâche : l'annuaire, sinon l'ancien texte libre. */
export function assigneeOf(task: Rec, members: Rec[]): { id: string; name: string; legacy: boolean } | null {
  const id = str(task.data.assignee_id);
  if (id) {
    const m = members.find((x) => x.id === id);
    return { id, name: m ? str(m.data.name) : "Personne retirée", legacy: false };
  }
  const text = str(task.data.assignee).trim();
  return text ? { id: "", name: text, legacy: true } : null;
}

/** Lundi de la semaine d'une date (AAAA-MM-JJ). */
export function mondayOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Jours calendaires entre deux dates (b − a). */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

/** Heures saisies par une personne un jour donné, toutes tâches confondues. */
export function hoursOn(userId: string, entries: Rec[], date: string): number {
  return entries.filter((e) => live(e) && e.data.user_id === userId && e.data.date === date).reduce((n, e) => n + num(e.data.hours), 0);
}

/** Heures de la semaine (lundi → date incluse). */
export function hoursWeek(userId: string, entries: Rec[], date: string): number {
  const from = mondayOf(date);
  return entries.filter((e) => live(e) && e.data.user_id === userId && str(e.data.date) >= from && str(e.data.date) <= date).reduce((n, e) => n + num(e.data.hours), 0);
}

/** Plafond de RG12.1 : refus au-delà de 24 h par jour, confirmation au-delà de 12 h. */
export function checkDayHours(already: number, adding: number): { ok: false; message: string } | { ok: true; confirm: boolean } {
  const total = Math.round((already + adding) * 100) / 100;
  if (!(adding > 0)) return { ok: false, message: "Indiquez une durée supérieure à 0 h." };
  if (total > 24) return { ok: false, message: "Pas plus de 24 h par jour" };
  return { ok: true, confirm: total > 12 };
}

/** Pourquoi une tâche figure dans « Ma journée », dans l'ordre de tri (§3.12). */
export type DayReason = "priority" | "late" | "due" | "doing" | "start" | "open";
export interface DayItem<T extends Rec = Rec> { task: T; reason: DayReason; lateDays: number }

const ORDER: Record<DayReason, number> = { priority: 0, late: 1, due: 2, doing: 3, start: 4, open: 5 };

/** Semaine ISO (AAAA-Www) d'une date, pour les priorités de la semaine (lot 2). */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 864e5 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Ma journée : tâches ouvertes de la personne, triées (priorités de la semaine,
 * en retard, dues aujourd'hui, en cours, qui commencent aujourd'hui, puis les autres
 * tâches à faire), limitées à `limit`. Les tâches À vérifier attendent leur vérification : elles passent dans « autres ». Projets terminés ou annulés exclus.
 */
export function myDay<T extends Rec>(teamMemberId: string, all: { tasks: T[]; projects: Rec[] }, today: string, limit = 7): { today: DayItem<T>[]; others: DayItem<T>[]; review: T[] } {
  const closed = new Set(all.projects.filter((p) => p.data._deleted || ["done", "cancelled"].includes(str(p.data.status))).map((p) => p.id));
  const known = new Set(all.projects.map((p) => p.id));
  const mine = all.tasks.filter((t) => live(t) && t.data.assignee_id === teamMemberId && !closed.has(str(t.data.project_id)) && known.has(str(t.data.project_id)));
  const week = isoWeek(today);
  const items: DayItem<T>[] = [];
  const review: T[] = [];
  for (const t of mine) {
    const status = str(t.data.status) || "todo";
    if (status === "done") continue;
    if (status === "review") { review.push(t); continue; }
    const due = str(t.data.due_date);
    const start = str(t.data.start_date);
    const lateDays = due && due < today ? daysBetween(due, today) : 0;
    const reason: DayReason =
      t.data.priority_week === week ? "priority"
      : lateDays > 0 ? "late"
      : due === today ? "due"
      : status === "doing" ? "doing"
      : start === today ? "start"
      : "open";
    items.push({ task: t, reason, lateDays });
  }
  items.sort((a, b) =>
    ORDER[a.reason] - ORDER[b.reason]
    || b.lateDays - a.lateDays
    || (str(a.task.data.due_date) || "9999").localeCompare(str(b.task.data.due_date) || "9999")
    || str(a.task.data.title).localeCompare(str(b.task.data.title)));
  // Une tâche qui commence plus tard n'encombre pas la journée : elle va dans « autres ».
  const upcoming = (i: DayItem<T>) => i.reason === "open" && str(i.task.data.start_date) > today;
  const ready = items.filter((i) => !upcoming(i));
  return { today: ready.slice(0, limit), others: [...ready.slice(limit), ...items.filter(upcoming)], review };
}

/** Durée proposée à l'arrêt du chronomètre : arrondi à la demi-heure inférieure et supérieure. */
export function chronoRounding(ms: number): { exact: number; down: number; up: number } {
  const exact = Math.max(0, ms / 3_600_000);
  const down = Math.max(0.5, Math.floor(exact * 2) / 2);
  const up = Math.max(0.5, Math.ceil(exact * 2) / 2);
  return { exact, down, up };
}

/** Coût horaire moyen de l'équipe (personnes actives avec un coût), arrondi au franc. */
export function averageCost(members: Rec[], costRates: Rec[]): number {
  const active = new Set(members.filter((m) => live(m) && m.data.active !== false).map((m) => m.id));
  const rates = costRates.filter((c) => live(c) && c.id !== "cr-company" && active.has(str(c.data.team_member_id)) && num(c.data.hourly_cost) > 0).map((c) => num(c.data.hourly_cost));
  return rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : 0;
}

// ======================================================================
// Lot 2 : étapes, avancement pondéré, prévu à date, création depuis un devis,
// priorités de la semaine (02-modele-de-donnees.md §3.5, §3.7, §3.9 ; CDC §3.4, §3.8, §3.11).
// ======================================================================

/** Statut calculé d'une étape (§3.7) : jamais stocké. */
export type StageState = "upcoming" | "active" | "awaiting" | "approved" | "approved_reserves" | "stopped";
export const STAGE_STATE_LABELS: Record<StageState, string> = {
  upcoming: "À venir",
  active: "En cours",
  awaiting: "À valider",
  approved: "Validée",
  approved_reserves: "Validée avec réserves",
  stopped: "Arrêtée",
};
export const STAGE_STATE_TONES: Record<StageState, string> = {
  upcoming: "", active: "info", awaiting: "warn", approved: "ok", approved_reserves: "ok", stopped: "danger",
};
/** Plafond de l'avancement d'une étape non validée (CDC F8). */
export const STAGE_CAP = 0.95;
/** Priorités de la semaine : au plus 7 par projet (F11, contrôle sur l'appareil, R13). */
export const MAX_WEEK_PRIORITIES = 7;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Étapes vivantes d'un projet, dans l'ordre (rang, puis nom). */
export function stagesOf<T extends Rec>(projectId: string, stages: T[]): T[] {
  return stages.filter((s) => live(s) && s.data.project_id === projectId)
    .sort((a, b) => num(a.data.rank) - num(b.data.rank) || str(a.data.name).localeCompare(str(b.data.name)) || a.id.localeCompare(b.id));
}

/** Décisions d'une étape, triées (decided_at, id). La table arrive au lot 3 : liste vide en attendant. */
export function stageDecisions(stageId: string, decisions: Rec[] = []): Rec[] {
  return decisions.filter((d) => live(d) && d.data.stage_id === stageId)
    .sort((a, b) => str(a.data.decided_at).localeCompare(str(b.data.decided_at)) || a.id.localeCompare(b.id));
}

/**
 * Statut d'une étape : la dernière décision fait foi (une réouverture annule la validation) ;
 * sans décision, « À valider » si la validation a été demandée, « En cours » si elle a
 * démarré (à la main, ou par une de ses tâches commencée, RG4.1), « À venir » sinon.
 */
export function stageState(stage: Rec, tasks: Rec[], decisions: Rec[] = []): StageState {
  const last = stageDecisions(stage.id, decisions).at(-1);
  const kind = str(last?.data.kind);
  if (kind === "stage_approved") return "approved";
  if (kind === "stage_approved_with_reserves") return "approved_reserves";
  if (kind === "stage_stopped" || kind === "project_stopped") return "stopped";
  if (stage.data.review_requested_at) return "awaiting";
  if (stage.data.started_at) return "active";
  const started = tasks.some((t) => live(t) && t.data.stage_id === stage.id && ["doing", "review", "done"].includes(str(t.data.status)));
  return started ? "active" : "upcoming";
}

const validated = (s: StageState) => s === "approved" || s === "approved_reserves";

/** Poids d'une tâche : son estimation, sinon la moyenne des estimées du groupe, sinon 1 (F8). */
export function taskWeight(task: Rec, group: Rec[]): number {
  const own = num(task.data.estimate_hours);
  if (own > 0) return own;
  const estimated = group.filter((t) => live(t) && num(t.data.estimate_hours) > 0).map((t) => num(t.data.estimate_hours));
  return estimated.length ? estimated.reduce((a, b) => a + b, 0) / estimated.length : 1;
}

/** Avancement d'un groupe de tâches : Σ w·fait / Σ w ; une tâche n'est faite qu'au statut Terminé. */
export function tasksProgress(tasks: Rec[]): number {
  const group = tasks.filter(live);
  let total = 0;
  let done = 0;
  for (const t of group) {
    const w = taskWeight(t, group);
    total += w;
    if (t.data.status === "done") done += w;
  }
  return total > 0 ? done / total : 0;
}

/** Avancement d'une étape (0..1) : 1 si validée, sinon plafonné à 95 % (CA2.3, CA2.4). */
export function stageProgress(stage: Rec, tasks: Rec[], decisions: Rec[] = []): number {
  if (validated(stageState(stage, tasks, decisions))) return 1;
  const own = tasks.filter((t) => live(t) && t.data.stage_id === stage.id);
  return Math.min(STAGE_CAP, tasksProgress(own));
}

/**
 * Poids des étapes : leur part de facturation si toutes en ont une ; sinon leur budget
 * si toutes en ont un (lot 4) ; sinon leur durée si toutes sont datées ; sinon 1.
 */
export function stageWeights(stages: Rec[], budgets?: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const all = (f: (s: Rec) => number) => stages.length > 0 && stages.every((s) => f(s) > 0);
  const pct = (s: Rec) => num(s.data.billing_pct);
  const budget = (s: Rec) => budgets?.get(s.id) ?? 0;
  const span = (s: Rec) => (str(s.data.start_date) && str(s.data.end_date) ? daysBetween(str(s.data.start_date), str(s.data.end_date)) + 1 : 0);
  const f = all(pct) ? pct : budgets && all(budget) ? budget : all(span) ? span : () => 1;
  for (const s of stages) out.set(s.id, f(s));
  return out;
}

/**
 * Avancement prévu à date d'une période : borne(0, 1, (aujourd'hui − début) / (fin − début)),
 * en jours calendaires ; une période d'un seul jour vaut 0 avant ce jour, 1 à partir de ce jour.
 * Null si la période n'est pas datée.
 */
export function periodPlanned(start: string, end: string, today: string): number | null {
  if (!start || !end) return null;
  const length = daysBetween(start, end);
  if (length <= 0) return today >= end ? 1 : 0;
  return clamp01(daysBetween(start, today) / length);
}

export interface StageInfo<T extends Rec = Rec> { stage: T; state: StageState; progress: number; planned: number | null; weight: number; tasks: number; deliverables: number; deliverablesDone: number }
export interface ProgressInfo<T extends Rec = Rec> {
  /** Avancement réel du projet, 0..1 (arrondi à l'affichage seulement). */
  A: number;
  /** Avancement prévu à date, 0..1, ou null sans dates. */
  P: number | null;
  method: "stages" | "tasks";
  stages: StageInfo<T>[];
}

/**
 * Avancement pondéré et prévu à date d'un projet (§3.5). Les étapes arrêtées sont exclues ;
 * les tâches « Sans étape » ne comptent que si le projet n'a aucune étape (RG4.6).
 * Sans dates d'étape, le prévu d'une étape reprend les dates du projet.
 */
export function projectProgress<T extends Rec>(project: Rec, d: { tasks: Rec[]; project_stages: T[]; project_decisions?: Rec[] }, today: string): ProgressInfo<T> {
  const tasks = d.tasks.filter((t) => live(t) && t.data.project_id === project.id);
  const stages = stagesOf(project.id, d.project_stages);
  const decisions = d.project_decisions ?? [];
  const pStart = str(project.data.start_date);
  const pEnd = str(project.data.end_date);
  const info: StageInfo<T>[] = stages.map((s) => {
    const own = tasks.filter((t) => t.data.stage_id === s.id);
    const deliverables = own.filter((t) => t.data.deliverable);
    const start = str(s.data.start_date) || (str(s.data.end_date) ? "" : pStart);
    const end = str(s.data.end_date) || (str(s.data.start_date) ? "" : pEnd);
    return {
      stage: s, state: stageState(s, tasks, decisions), progress: stageProgress(s, tasks, decisions),
      planned: periodPlanned(start, end, today), weight: 1, tasks: own.length,
      deliverables: deliverables.length, deliverablesDone: deliverables.filter((t) => t.data.status === "done").length,
    };
  });
  const counted = info.filter((i) => i.state !== "stopped");
  if (counted.length === 0) {
    return { A: tasksProgress(tasks), P: periodPlanned(pStart, pEnd, today), method: "tasks", stages: info };
  }
  const weights = stageWeights(counted.map((i) => i.stage));
  for (const i of counted) i.weight = weights.get(i.stage.id) ?? 1;
  const W = counted.reduce((n, i) => n + i.weight, 0);
  const A = W > 0 ? counted.reduce((n, i) => n + i.weight * i.progress, 0) / W : 0;
  const planned = counted.filter((i) => i.planned !== null);
  const PW = planned.reduce((n, i) => n + i.weight, 0);
  const P = planned.length === counted.length && PW > 0 ? planned.reduce((n, i) => n + i.weight * (i.planned ?? 0), 0) / PW : null;
  return { A, P, method: "stages", stages: info };
}

/** Pourcentage affiché : arrondi à l'entier le plus proche, à l'affichage seulement (CA2.6). */
export const pct100 = (x: number) => Math.round(x * 100);

/** Somme des parts de facturation des étapes (RG4.4 : avertissement si ≠ 100). */
export const billingShareTotal = (stages: Rec[]) => Math.round(stages.filter(live).reduce((n, s) => n + num(s.data.billing_pct), 0) * 100) / 100;

/**
 * Montant prévu de chaque étape : round(V × p / 100). Quand les parts font 100 %, la
 * dernière étape qui facture reçoit le reste, pour que la somme vaille exactement V.
 */
export function stageAmounts(V: number, stages: Rec[]): Map<string, number> {
  const out = new Map<string, number>();
  const billing = stages.filter((s) => live(s) && num(s.data.billing_pct) > 0);
  const full = Math.abs(billingShareTotal(billing) - 100) < 1e-9;
  let given = 0;
  billing.forEach((s, i) => {
    const m = full && i === billing.length - 1 ? V - given : Math.round((V * num(s.data.billing_pct)) / 100);
    out.set(s.id, m);
    given += m;
  });
  return out;
}

/** Ajoute n jours à une date AAAA-MM-JJ. */
const plusDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Dates proposées des étapes (parcours 5.1) : l'étape Démarrage le premier jour, les
 * autres se partagent le reste, au prorata de leur poids, bout à bout. Sans date de fin,
 * seules les étapes Démarrage sont datées.
 */
export function planStageDates(start: string, end: string, specs: { kind?: string; span?: number }[]): { start_date: string; end_date: string }[] {
  const out = specs.map(() => ({ start_date: "", end_date: "" }));
  if (!start) return out;
  const starts = specs.map((s, i) => (s.kind === "start" ? i : -1)).filter((i) => i >= 0);
  for (const i of starts) out[i] = { start_date: start, end_date: start };
  if (!end || end < start) return out;
  const rest = specs.map((s, i) => ({ s, i })).filter(({ s }) => s.kind !== "start");
  if (rest.length === 0) return out;
  const from = starts.length && end > start ? plusDays(start, 1) : start;
  const total = daysBetween(from, end) + 1;
  const weights = rest.map(({ s }) => (num(s.span) > 0 ? num(s.span) : 1));
  const W = weights.reduce((a, b) => a + b, 0);
  let cursor = from;
  let used = 0;
  rest.forEach(({ i }, k) => {
    const last = k === rest.length - 1;
    const len = last ? total - used : Math.max(1, Math.round((total * weights[k]) / W));
    const stop = last ? end : (() => { const e = plusDays(cursor, len - 1); return e > end ? end : e; })();
    out[i] = { start_date: cursor > end ? end : cursor, end_date: stop };
    used += len;
    cursor = plusDays(stop, 1);
  });
  return out;
}

// ---- Montant vendu (§3.3, partie « vendu » seulement au lot 2) ----

interface QuoteLineLike { qty: number; unitPrice: number; vatRate: number; discount?: number; section?: boolean; deposit?: boolean; depositInvoiceId?: string; label?: string; unit?: string; articleId?: string }

/** Net HT d'un devis (après remises, hors titres et acomptes), dans sa devise et en XAF. */
export function quoteNet(quote: Rec): { net: number; currency: string; rate: number; netXaf: number } {
  const currency = str(quote.data.currency) || "XAF";
  const rate = currency === "XAF" ? 1 : num(quote.data.rate) || 1;
  const decimals = currency === "XAF" ? 0 : 2;
  const f = 10 ** decimals;
  let net = 0;
  for (const l of (quote.data.lines as QuoteLineLike[] | undefined) ?? []) {
    if (l.section || l.deposit || l.depositInvoiceId) continue;
    const d = Math.min(100, Math.max(0, Number(l.discount) || 0));
    net += Math.round(((num(l.qty) * num(l.unitPrice) * (100 - d)) / 100 + Number.EPSILON) * f) / f;
  }
  net = Math.round(net * f) / f;
  return { net, currency, rate, netXaf: Math.round(net * rate) };
}

/** Statuts de devis qui comptent dans le vendu (RG3.5). */
const SOLD_STATUSES = ["accepted", "invoiced"];

/**
 * Montant vendu d'un projet : devis acceptés rattachés (project_id, ou le devis principal
 * `quote_id`), sinon le montant saisi à la main (`project_finance.sold_manual`), sinon
 * l'ancien budget d'un forfait. Sur l'appareil d'un employé, rien n'est connu : source « none ».
 */
export function soldOf(project: Rec, d: { quotes?: Rec[]; project_finance?: Rec[] }): { V: number; VXaf: number; currency: string; source: "quotes" | "manual" | "legacy" | "none"; quoteIds: string[] } {
  const main = str(project.data.quote_id);
  const quotes = (d.quotes ?? []).filter((q) => live(q) && (q.id === main || q.data.project_id === project.id) && SOLD_STATUSES.includes(str(q.data.status)));
  const fin = (d.project_finance ?? []).find((f) => live(f) && f.id === `fin-${project.id}`);
  const currency = str(project.data.currency) || "XAF";
  if (quotes.length) {
    const principal = quotes.find((q) => q.id === main) ?? quotes[0];
    const pc = quoteNet(principal);
    let VXaf = 0;
    let V = 0;
    for (const q of quotes) {
      const n = quoteNet(q);
      VXaf += n.netXaf;
      V += n.currency === pc.currency ? n.net : Math.round((n.netXaf / pc.rate) * 100) / 100;
    }
    return { V, VXaf, currency: pc.currency, source: "quotes", quoteIds: quotes.map((q) => q.id) };
  }
  const rate = currency === "XAF" ? 1 : num(project.data.rate) || 1;
  if (fin && num(fin.data.sold_manual) > 0) return { V: num(fin.data.sold_manual), VXaf: Math.round(num(fin.data.sold_manual) * rate), currency, source: "manual", quoteIds: [] };
  const legacy = fin && fin.data.legacy_budget !== undefined ? num(fin.data.legacy_budget) : num(project.data.budget);
  if (["fixed", "milestone"].includes(str(project.data.billing)) && legacy > 0) return { V: legacy, VXaf: legacy, currency: "XAF", source: "legacy", quoteIds: [] };
  return { V: 0, VXaf: 0, currency, source: "none", quoteIds: [] };
}

// ---- Création d'un projet (modèle, et depuis un devis accepté : §3.9, §5.1) ----

type Patch = Record<string, unknown>;
export interface StageSpec { name: string; kind: string; billing_pct: number; span?: number; tasks?: { title: string; deliverable?: boolean }[] }
export interface ProjectSeedInput {
  id: string;
  name: string;
  client_id: string;
  template: string;
  billing: string;
  stages: StageSpec[];
  start_date: string;
  end_date: string;
  site_address?: string;
  description?: string;
  status?: string;
  currency?: string;
  rate?: number;
  quote?: Rec | null;
  manager?: { id: string; name: string; user_id?: string } | null;
  sponsor?: { id: string; name: string; user_id?: string } | null;
  /** Montants (rôles autorisés seulement) : rangés dans la ligne protégée `fin-{projet}`. */
  money?: { sold_manual?: number; hourly_rate?: number; cost_rate?: number; legacy_budget?: number } | null;
  userId: string;
  now: string;
}
export interface ProjectSeed {
  project: { id: string; patch: Patch };
  finance: { id: string; patch: Patch } | null;
  members: { id: string; patch: Patch }[];
  stages: { id: string; patch: Patch }[];
  tasks: { id: string; patch: Patch }[];
  quoteLink: { id: string; patch: { project_id: string } } | null;
}

/** Identifiant déterministe du projet lancé par un devis : deux lancements hors ligne fusionnent (RG3.6). */
export const projectIdForQuote = (quoteId: string) => `prj-q-${quoteId}`;
/** Identifiants déterministes des étapes et tâches types d'un projet créé : pas de doublon. */
export const seedStageId = (projectId: string, n: number) => `stg-${projectId}-${n}`;
export const seedTaskId = (projectId: string, stage: number, n: number) => `tsk-${projectId}-${stage}-${n}`;

/**
 * Lignes à écrire pour créer un projet, dans l'ordre de §5.1 : projet, finance, équipe,
 * étapes, tâches types, puis le lien du devis. Aucune facture ni budget par poste (lots 3 et 4).
 */
export function projectSeed(o: ProjectSeedInput): ProjectSeed {
  const id = o.id;
  const stamp = { created_by: o.userId, created_at: o.now };
  const project: Patch = {
    name: o.name.trim(), client_id: o.client_id, status: o.status || (o.start_date && o.start_date > o.now.slice(0, 10) ? "planned" : "active"),
    billing: o.billing, template: o.template, start_date: o.start_date, end_date: o.end_date,
    site_address: (o.site_address ?? "").trim(), description: (o.description ?? "").trim(),
    currency: o.currency || "XAF", ...(o.currency && o.currency !== "XAF" ? { rate: o.rate ?? 1 } : {}),
    ...(o.quote ? { quote_id: o.quote.id } : {}),
    ...(o.manager ? { manager: o.manager.name } : {}),
    ...stamp,
  };
  const money = o.money ?? null;
  const finance = money && Object.values(money).some((v) => num(v) > 0)
    ? { id: `fin-${id}`, patch: { project_id: id, ...Object.fromEntries(Object.entries(money).map(([k, v]) => [k, Math.max(0, Math.round(num(v)))])), ...stamp } }
    : null;
  const members: { id: string; patch: Patch }[] = [];
  const member = (p: { id: string; name: string; user_id?: string }, role: string) =>
    members.push({ id: `pm-${id}-${p.id}`, patch: { project_id: id, team_member_id: p.id, user_id: p.user_id ?? "", name: p.name, role, _deleted: false, ...stamp } });
  if (o.manager) member(o.manager, "manager");
  if (o.sponsor && o.sponsor.id !== o.manager?.id) member(o.sponsor, "sponsor");
  const dates = planStageDates(o.start_date, o.end_date, o.stages);
  const stages: { id: string; patch: Patch }[] = [];
  const tasks: { id: string; patch: Patch }[] = [];
  o.stages.forEach((s, i) => {
    const sid = seedStageId(id, i + 1);
    stages.push({
      id: sid,
      patch: {
        project_id: id, name: s.name.trim(), rank: i + 1, kind: s.kind || "normal", billing_pct: Math.max(0, Math.min(100, num(s.billing_pct))),
        owner_id: o.manager?.id ?? "", owner_name: o.manager?.name ?? "", ...dates[i], ...stamp,
      },
    });
    (s.tasks ?? []).forEach((t, j) => tasks.push({
      id: seedTaskId(id, i + 1, j + 1),
      patch: { project_id: id, stage_id: sid, title: t.title, status: "todo", priority: "normal", deliverable: Boolean(t.deliverable), rank: j + 1, ...stamp },
    }));
  });
  return { project: { id, patch: project }, finance, members, stages, tasks, quoteLink: o.quote ? { id: o.quote.id, patch: { project_id: id } } : null };
}

/** Nom proposé pour un projet lancé depuis un devis : premier titre de section, sinon « Projet » + client. */
export function projectNameFromQuote(quote: Rec, clientName: string): string {
  const lines = (quote.data.lines as QuoteLineLike[] | undefined) ?? [];
  const section = lines.find((l) => l.section && str(l.label).trim());
  if (section) return str(section.label).trim();
  const billable = lines.filter((l) => !l.section && !l.deposit && !l.depositInvoiceId);
  if (billable.length === 1 && str(billable[0].label).trim()) return str(billable[0].label).trim();
  return clientName ? `Projet ${clientName}` : "Nouveau projet";
}

/**
 * Création depuis un devis accepté (CA2.1) : client, nom, devise, montant vendu (ligne
 * protégée), étapes du modèle avec leurs parts, lien `quote_id` et `quotes.project_id`.
 * Un devis déjà facturé garde ses étapes mais passe au temps passé (RG3.1).
 */
export function projectFromQuote(quote: Rec, template: { id: string; billing: string; stages: StageSpec[] }, o: Omit<ProjectSeedInput, "id" | "name" | "client_id" | "template" | "billing" | "stages" | "quote" | "currency" | "rate"> & { name?: string; clientName?: string; stages?: StageSpec[] }): ProjectSeed {
  const n = quoteNet(quote);
  const invoiced = str(quote.data.status) === "invoiced";
  return projectSeed({
    ...o,
    id: projectIdForQuote(quote.id),
    name: o.name?.trim() || projectNameFromQuote(quote, o.clientName ?? ""),
    client_id: str(quote.data.client_id),
    template: template.id,
    billing: invoiced && template.billing === "stages" ? "time" : template.billing,
    stages: o.stages ?? template.stages,
    quote,
    currency: n.currency,
    rate: n.rate,
    money: { ...(o.money ?? {}), sold_manual: n.net },
  });
}

/** Projet déjà lancé par ce devis (CA2.2 : « Ouvrir le projet » au lieu de « Lancer le projet »). */
export function projectOfQuote<T extends Rec>(quote: Rec, projects: T[]): T | null {
  const pid = str(quote.data.project_id);
  return projects.find((p) => live(p) && (p.id === pid || p.data.quote_id === quote.id || p.id === projectIdForQuote(quote.id))) ?? null;
}

// ---- Prochaine échéance (en-tête, F1) ----

/** Toutes les tâches de l'étape sont terminées (avancement au plafond, sans validation). */
export const stageTasksDone = (i: StageInfo) => i.tasks > 0 && i.progress >= STAGE_CAP - 1e-9;

export function nextDeadline(project: Rec, stages: StageInfo[], today: string): { label: string; date: string } | null {
  // Une étape dont toutes les tâches sont terminées n'a plus d'échéance à tenir (elle attend sa validation).
  const open = stages.filter((i) => !["approved", "approved_reserves", "stopped"].includes(i.state) && !stageTasksDone(i));
  const awaiting = open.find((i) => i.state === "awaiting");
  if (awaiting) return { label: `Validation de ${str(awaiting.stage.data.name)}`, date: str(awaiting.stage.data.end_date) };
  const next = open.filter((i) => str(i.stage.data.end_date)).sort((a, b) => str(a.stage.data.end_date).localeCompare(str(b.stage.data.end_date)))[0];
  if (next) return { label: `Fin de ${str(next.stage.data.name)}`, date: str(next.stage.data.end_date) };
  if (str(project.data.end_date)) return { label: "Fin du projet", date: str(project.data.end_date) };
  void today;
  return null;
}

// ---- Priorités de la semaine (F11, point de la semaine simple) ----

/** Semaine ISO précédente. */
export const previousWeek = (date: string) => isoWeek(plusDays(mondayOf(date), -7));

/** Lundi et dimanche de la semaine d'une date. */
export const weekBounds = (date: string) => ({ monday: mondayOf(date), sunday: plusDays(mondayOf(date), 6) });

/** Tâches épinglées cette semaine, et priorités tenues la semaine dernière. */
export function weekPriorities<T extends Rec>(projectId: string, tasks: T[], today: string): { week: string; pinned: T[]; lastWeek: { done: number; total: number } } {
  const week = isoWeek(today);
  const last = previousWeek(today);
  const mine = tasks.filter((t) => live(t) && t.data.project_id === projectId);
  const pinned = mine.filter((t) => t.data.priority_week === week)
    .sort((a, b) => (str(a.data.due_date) || "9999").localeCompare(str(b.data.due_date) || "9999") || str(a.data.title).localeCompare(str(b.data.title)));
  const before = mine.filter((t) => t.data.priority_week === last);
  return { week, pinned, lastWeek: { done: before.filter((t) => t.data.status === "done").length, total: before.length } };
}

/** Peut-on épingler une tâche de plus ? (au plus 7, contrôle sur l'appareil). */
export function canPin(projectId: string, tasks: Rec[], today: string): boolean {
  return weekPriorities(projectId, tasks, today).pinned.length < MAX_WEEK_PRIORITIES;
}

const shortDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * Résumé du point de la semaine, prêt à coller dans WhatsApp : priorités (responsable,
 * échéance), terminé la semaine dernière, en retard ou bloqué. Aucun montant.
 */
export function weekSummaryText(project: Rec, tasks: Rec[], members: Rec[], today: string, stages: Rec[] = []): string {
  const { pinned, lastWeek } = weekPriorities(project.id, tasks, today);
  const { monday, sunday } = weekBounds(today);
  const lastMonday = plusDays(monday, -7);
  const mine = tasks.filter((t) => live(t) && t.data.project_id === project.id);
  const who = (t: Rec) => assigneeOf(t, members)?.name ?? "à attribuer";
  const stageName = (t: Rec) => str(stages.find((s) => s.id === t.data.stage_id)?.data.name);
  const lines: string[] = [];
  lines.push(`*Point de la semaine : ${str(project.data.name)}*`);
  lines.push(`Semaine du ${ddmm(monday)} au ${ddmm(sunday)}`);
  lines.push("");
  lines.push(`*Priorités de la semaine (${pinned.length})*`);
  if (pinned.length === 0) lines.push("Aucune priorité épinglée.");
  pinned.forEach((t, i) => {
    const due = str(t.data.due_date);
    const bits = [who(t), due ? shortDay(due) : "", stageName(t)].filter(Boolean).join(" · ");
    lines.push(`${i + 1}. ${t.data.status === "done" ? "✅ " : ""}${str(t.data.title)} (${bits})`);
  });
  const doneLast = mine.filter((t) => t.data.status === "done" && str(t.data.done_at).slice(0, 10) >= lastMonday && str(t.data.done_at).slice(0, 10) < monday);
  const late = mine.filter((t) => t.data.status !== "done" && (t.data.blocked || (str(t.data.due_date) && str(t.data.due_date) < today)));
  lines.push("");
  lines.push(`*Terminé la semaine dernière (${doneLast.length})*`);
  if (doneLast.length === 0) lines.push("Rien de terminé.");
  for (const t of doneLast) lines.push(`- ${str(t.data.title)}`);
  if (lastWeek.total) lines.push(`Priorités tenues la semaine dernière : ${lastWeek.done} sur ${lastWeek.total}`);
  lines.push("");
  lines.push(`*En retard ou bloqué (${late.length})*`);
  if (late.length === 0) lines.push("Rien en retard.");
  for (const t of late) {
    const reason = t.data.blocked ? `bloqué : ${BLOCK_LABELS[str(t.data.blocked_reason)] ?? "motif non précisé"}` : `en retard depuis le ${ddmm(str(t.data.due_date))}`;
    lines.push(`- ${str(t.data.title)} (${who(t)}, ${reason})`);
  }
  return lines.join("\n");
}
