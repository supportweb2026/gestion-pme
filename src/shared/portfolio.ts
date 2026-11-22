/**
 * Projets, lot 5 : portefeuille « Tous les projets » (F15).
 *
 * Une ligne par projet : météo (globale et ses trois critères), avancement réel et prévu,
 * étape en cours, fin prévue et retard estimé, tâches en retard ou bloquées, validations
 * d'étape en attente (en jours ouvrés), recettes et marge estimée. Tri par urgence : « À
 * redresser » d'abord, puis « À surveiller », puis « Tout va bien », chaque groupe par date
 * de fin (CA5.1). Les montants ne sont calculés que pour les rôles qui les voient.
 */
import { daysBetween, projectProgress, type ProgressInfo, type StageState } from "./projectControl.ts";
import { costForecast, weather, type BudgetData, type Light, type Weather } from "./projectBudget.ts";
import { isArchived } from "./projectBoard.ts";
import type { Rec } from "./projects.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const live = (r: Rec) => !r.data._deleted;

/** Jours ouvrés (lundi à vendredi) écoulés de `from` à `to` (`to` non compris si c'est le même jour). */
export function workingDaysBetween(from: string, to: string): number {
  if (!from || !to || to <= from) return 0;
  let n = 0;
  for (let d = Date.parse(`${from}T12:00:00Z`) + 864e5; d <= Date.parse(`${to}T12:00:00Z`); d += 864e5) {
    const wd = new Date(d).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

export interface PortfolioRow {
  project: Rec;
  name: string;
  client: string;
  manager: string;
  managerId: string;
  status: string;
  /** Météo globale, « grey » si aucun critère n'est suivi. */
  light: Light;
  weather: Weather;
  /** Avancement réel et prévu à date, en % (prévu null sans dates). */
  progress: number;
  planned: number | null;
  /** Étape en cours (ou à valider), sinon null. */
  stage: { name: string; state: StageState } | null;
  endDate: string;
  delayDays: number;
  tasksOpen: number;
  lateTasks: number;
  blockedTasks: number;
  /** Étapes dont la validation est demandée, et l'attente la plus longue en jours ouvrés. */
  validations: { count: number; days: number };
  /** Montants (FCFA HT) : null pour un rôle qui ne voit pas les montants. */
  money: { sold: number; invoiced: number; collected: number; toInvoice: number; margin: number | null; marginPct: number | null } | null;
}

export interface PortfolioNames {
  client: (id: string) => string;
  /** Responsable du projet : identifiant `tm-…` et nom. */
  manager: (project: Rec) => { id: string; name: string } | null;
}

/** Calcule la ligne d'un projet. `amounts` faux : aucun montant n'est calculé ni renvoyé. */
export function portfolioRow(project: Rec, d: BudgetData, today: string, names: PortfolioNames, amounts: boolean, prog: ProgressInfo = projectProgress(project, d, today)): PortfolioRow {
  const fc = costForecast(project, d, today, prog);
  const w = weather(project, d, today, prog, fc);
  const tasks = d.tasks.filter((t) => live(t) && t.data.project_id === project.id && !isArchived(t));
  const open = tasks.filter((t) => (str(t.data.status) || "todo") !== "done");
  const current = prog.stages.find((i) => i.state === "awaiting") ?? prog.stages.find((i) => i.state === "active" || i.state === "paused") ?? prog.stages.find((i) => i.state === "upcoming") ?? null;
  const awaiting = prog.stages.filter((i) => i.state === "awaiting");
  const oldest = awaiting.map((i) => str(i.stage.data.review_requested_at).slice(0, 10)).filter(Boolean).sort()[0] ?? "";
  const lead = names.manager(project);
  return {
    project,
    name: str(project.data.name),
    client: names.client(str(project.data.client_id)),
    manager: lead?.name ?? "",
    managerId: lead?.id ?? "",
    status: str(project.data.status),
    light: w.overall ?? "grey",
    weather: w,
    progress: Math.round(prog.A * 100),
    planned: prog.P === null ? null : Math.round(prog.P * 100),
    stage: current ? { name: str(current.stage.data.name), state: current.state } : null,
    endDate: str(project.data.end_date),
    delayDays: w.schedule.delayDays,
    tasksOpen: open.length,
    lateTasks: open.filter((t) => str(t.data.due_date) && str(t.data.due_date) < today).length,
    blockedTasks: open.filter((t) => t.data.blocked).length,
    validations: { count: awaiting.length, days: oldest ? workingDaysBetween(oldest, today) : 0 },
    money: amounts ? {
      sold: fc.RP, invoiced: fc.invoiced, collected: fc.collected, toInvoice: fc.toInvoice,
      margin: fc.RP > 0 ? fc.marginEstimated : null, marginPct: fc.marginEstimatedPct,
    } : null,
  };
}

const LIGHT_RANK: Record<Light, number> = { red: 0, orange: 1, green: 2, grey: 3 };

export type PortfolioSort = "urgency" | "end" | "name";

/**
 * Tri du portefeuille. Urgence : « À redresser », « À surveiller », « Tout va bien », « Non
 * suivi » ; dans chaque groupe, la fin prévue la plus proche d'abord (CA5.1), puis le nom.
 */
export function sortPortfolio(rows: PortfolioRow[], mode: PortfolioSort = "urgency"): PortfolioRow[] {
  const end = (r: PortfolioRow) => r.endDate || "9999-12-31";
  const byName = (a: PortfolioRow, b: PortfolioRow) => a.name.localeCompare(b.name, "fr");
  return [...rows].sort((a, b) => {
    if (mode === "name") return byName(a, b);
    if (mode === "end") return end(a).localeCompare(end(b)) || byName(a, b);
    return LIGHT_RANK[a.light] - LIGHT_RANK[b.light] || end(a).localeCompare(end(b)) || byName(a, b);
  });
}

export interface PortfolioFilter {
  /** "" : tous ; sinon l'identifiant `tm-…` du responsable du projet. */
  manager: string;
  /** "" : tous ; "none" : projets internes ; sinon l'identifiant du client. */
  client: string;
  /** "" : toutes les météos ; sinon une couleur. */
  light: "" | Light;
  /** "open" : en cours, planifiés et en pause ; "all" ; sinon un statut précis. */
  status: string;
  q: string;
}

export const EMPTY_PORTFOLIO_FILTER: PortfolioFilter = { manager: "", client: "", light: "", status: "open", q: "" };

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export function filterPortfolio(rows: PortfolioRow[], f: PortfolioFilter): PortfolioRow[] {
  const q = fold(f.q.trim());
  return rows.filter((r) =>
    (!f.manager || r.managerId === f.manager)
    && (!f.client || (f.client === "none" ? !str(r.project.data.client_id) : r.project.data.client_id === f.client))
    && (!f.light || r.light === f.light)
    && (f.status === "all" || (f.status === "open" ? !["done", "cancelled"].includes(r.status) : r.status === f.status))
    && (!q || fold(`${r.name} ${r.client} ${r.manager}`).includes(q)));
}

/** Chiffres du haut de page : projets en cours, à redresser, reste à facturer, marge estimée totale. */
export function portfolioTotals(rows: PortfolioRow[]): { active: number; red: number; orange: number; toInvoice: number | null; margin: number | null; marginPct: number | null; validations: number } {
  const withMoney = rows.filter((r) => r.money);
  const priced = withMoney.filter((r) => r.money!.margin !== null);
  const sold = priced.reduce((n, r) => n + r.money!.sold, 0);
  const margin = priced.reduce((n, r) => n + (r.money!.margin ?? 0), 0);
  return {
    active: rows.filter((r) => r.status === "active").length,
    red: rows.filter((r) => r.light === "red").length,
    orange: rows.filter((r) => r.light === "orange").length,
    toInvoice: withMoney.length ? withMoney.reduce((n, r) => n + r.money!.toInvoice, 0) : null,
    margin: priced.length ? margin : null,
    marginPct: sold > 0 ? Math.round((margin / sold) * 1000) / 10 : null,
    validations: rows.reduce((n, r) => n + r.validations.count, 0),
  };
}

const LIGHT_WORDS: Record<Light, string> = { green: "Tout va bien", orange: "À surveiller", red: "À redresser", grey: "Non suivi" };
const STATUS_WORDS: Record<string, string> = { planned: "Planifié", active: "En cours", on_hold: "En pause", done: "Terminé", cancelled: "Annulé" };
const ddmmyyyy = (iso: string) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Export CSV de la vue (CA5.4) : une ligne par projet affiché, les colonnes du tableau,
 * séparateur point-virgule (Excel en français). Sans montants si le rôle ne les voit pas.
 */
export function portfolioCsv(rows: PortfolioRow[], today: string): string {
  const amounts = rows.some((r) => r.money);
  const head = ["Projet", "Client", "Responsable du projet", "Statut", "Météo", "Délai", "Budget", "Réserves et blocages", "Avancement (%)", "Prévu à date (%)",
    "Étape en cours", "Fin prévue", "Retard estimé (jours)", "Tâches en retard", "Tâches bloquées", "Validations en attente",
    ...(amounts ? ["Vendu HT (FCFA)", "Facturé HT (FCFA)", "Encaissé HT (FCFA)", "Reste à facturer (FCFA)", "Marge estimée (FCFA)", "Marge estimée (%)"] : [])];
  const lines = [head.map(cell).join(";")];
  for (const r of rows) {
    lines.push([
      r.name, r.client || "Projet interne", r.manager, STATUS_WORDS[r.status] ?? r.status, LIGHT_WORDS[r.light],
      LIGHT_WORDS[r.weather.schedule.light], LIGHT_WORDS[r.weather.budget.light], LIGHT_WORDS[r.weather.reserves.light],
      r.progress, r.planned ?? "", r.stage ? `${r.stage.name}${r.stage.state === "awaiting" ? " (à valider)" : ""}` : "",
      ddmmyyyy(r.endDate), r.delayDays, r.lateTasks, r.blockedTasks, r.validations.count,
      ...(amounts ? [r.money?.sold ?? "", r.money?.invoiced ?? "", r.money?.collected ?? "", r.money?.toInvoice ?? "", r.money?.margin ?? "", r.money?.marginPct ?? ""] : []),
    ].map(cell).join(";"));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Nom de fichier de l'export : `portefeuille-2026-11-22.csv`. */
export const portfolioFileName = (today: string) => `portefeuille-${today}.csv`;

/** Retard de fin prévue en jours (0 si la fin n'est pas dépassée). */
export const endOverdue = (row: PortfolioRow, today: string) => (row.endDate && row.endDate < today && !["done", "cancelled"].includes(row.status) ? daysBetween(row.endDate, today) : 0);
