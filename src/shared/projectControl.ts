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
  manager: "Chef de projet",
  sponsor: "Commanditaire",
  member: "Équipe",
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
  if (!(adding > 0)) return { ok: false, message: "Durée invalide." };
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
 * tâches à faire), limitées à `limit`. Les tâches À valider attendent le contrôle
 * du chef de projet : elles passent dans « autres ». Projets terminés ou annulés exclus.
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
