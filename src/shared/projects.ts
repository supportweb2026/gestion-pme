/**
 * Projets : avancement, temps passés et rentabilité, calculés à partir des
 * tâches, des temps saisis, des dépenses et des factures rattachés au projet.
 * Tous les montants sont en francs CFA, hors taxes.
 */
import { computeTotals, type InvoiceLine } from "./invoice.ts";
import { decimalsOf, toXaf } from "./currency.ts";

export interface Rec {
  id: string;
  data: Record<string, unknown>;
}

export const PROJECT_STATUS: Record<string, string> = {
  planned: "Planifié",
  active: "En cours",
  on_hold: "En pause",
  done: "Terminé",
  cancelled: "Annulé",
};

export const TASK_STATUS: [string, string][] = [
  ["todo", "À faire"],
  ["doing", "En cours"],
  ["review", "À vérifier"],
  ["done", "Terminé"],
];

export const BILLING_MODES: Record<string, string> = {
  stages: "Par étapes",
  time: "Au temps passé",
  none: "Sans facturation",
  // Anciens modes, lus comme « par étapes » (lot 2).
  fixed: "Forfait",
  milestone: "Par jalons",
};

const num = (v: unknown) => Number(v ?? 0) || 0;
const is = (r: Rec, projectId: string) => r.data.project_id === projectId;
const live = (r: Rec) => !r.data._deleted;

/**
 * Données financières d'un projet : la ligne protégée `fin-{projet}` d'abord,
 * puis les anciens champs de `projects` (reprise transparente des projets d'avant le lot 1).
 * Sur l'appareil d'un employé, aucune des deux sources n'existe : tout vaut 0.
 */
export function financeOf(project: Rec, finances: Rec[] = []): { budget: number; hourlyRate: number; costRate: number; source: "finance" | "legacy" | "none" } {
  const fin = finances.find((f) => f.id === `fin-${project.id}` && live(f));
  const pick = (finField: string, legacyField: string) =>
    fin && fin.data[finField] !== undefined && fin.data[finField] !== "" ? num(fin.data[finField]) : num(project.data[legacyField]);
  const budget = pick("legacy_budget", "budget");
  const hourlyRate = pick("hourly_rate", "hourly_rate");
  const costRate = pick("cost_rate", "cost_rate");
  const legacy = ["budget", "hourly_rate", "cost_rate"].some((k) => num(project.data[k]) > 0);
  return { budget, hourlyRate, costRate, source: fin ? "finance" : legacy ? "legacy" : "none" };
}

/**
 * Coût horaire d'une saisie de temps : celui de la personne (`cost_rates`), sinon
 * celui du projet, sinon le coût moyen de l'entreprise (`cr-company`), sinon 0.
 * Le chef de projet ne reçoit pas le coût par personne : son calcul passe au coût
 * du projet ou au coût moyen (estimation, arbitrage 2).
 */
export function entryCostRate(entry: Rec, projectCost: number, costRates: Rec[] = []): { rate: number; source: "person" | "project" | "company" | "missing" } {
  const tm = String(entry.data.team_member_id || (entry.data.user_id ? `tm-${entry.data.user_id}` : ""));
  const person = tm ? costRates.find((c) => c.id === `cr-${tm}` && live(c)) : undefined;
  if (person && num(person.data.hourly_cost) > 0) return { rate: num(person.data.hourly_cost), source: "person" };
  if (projectCost > 0) return { rate: projectCost, source: "project" };
  const company = costRates.find((c) => c.id === "cr-company" && live(c));
  if (company && num(company.data.hourly_cost) > 0) return { rate: num(company.data.hourly_cost), source: "company" };
  return { rate: 0, source: "missing" };
}

/** Montant HT en XAF d'un document (facture ou avoir) dans sa devise d'origine. */
export function netXaf(doc: Rec): number {
  const currency = String(doc.data.currency || "XAF");
  const rate = currency === "XAF" ? 1 : num(doc.data.rate) || 1;
  const totals = computeTotals((doc.data.lines as InvoiceLine[]) ?? [], decimalsOf(currency));
  return toXaf(totals.net, rate);
}

export interface ProjectStats {
  tasks: number;
  tasksDone: number;
  progress: number;
  hours: number;
  hoursEstimated: number;
  timeCost: number;
  expenses: number;
  costs: number;
  invoiced: number;
  budget: number;
  /** Part du budget consommée par les coûts, en %. */
  budgetUsed: number;
  margin: number;
  unbilledHours: number;
  unbilledValue: number;
  overdueTasks: number;
}

export function projectStats(
  project: Rec,
  all: { tasks: Rec[]; time_entries: Rec[]; expenses: Rec[]; invoices: Rec[]; credit_notes: Rec[]; project_finance?: Rec[]; cost_rates?: Rec[] },
  today: string,
): ProjectStats {
  const id = project.id;
  const finance = financeOf(project, all.project_finance);
  const billRate = finance.hourlyRate;
  const tasks = all.tasks.filter((t) => is(t, id));
  const done = tasks.filter((t) => t.data.status === "done").length;
  const times = all.time_entries.filter((t) => is(t, id));
  const hours = times.reduce((n, t) => n + num(t.data.hours), 0);
  // Un temps n'est facturé que si sa facture existe encore (un brouillon supprimé le libère).
  const invoiceIds = new Set(all.invoices.map((i) => i.id));
  const unbilled = times.filter((t) => !(t.data.invoice_id && invoiceIds.has(String(t.data.invoice_id))) && t.data.billable !== false);
  const unbilledHours = unbilled.reduce((n, t) => n + num(t.data.hours), 0);
  const expenses = all.expenses
    .filter((e) => is(e, id) && e.data.status !== "rejected" && e.data.status !== "pending")
    .reduce((n, e) => n + Math.round(num(e.data.amount) / (1 + num(e.data.vat_rate) / 100)), 0);
  const invoiced =
    all.invoices.filter((i) => is(i, id) && i.data.status === "validated").reduce((n, i) => n + netXaf(i), 0) -
    all.credit_notes.filter((c) => is(c, id) && c.data.status === "validated").reduce((n, c) => n + netXaf(c), 0);
  const timeCost = Math.round(times.reduce((n, t) => n + num(t.data.hours) * entryCostRate(t, finance.costRate, all.cost_rates).rate, 0));
  const costs = timeCost + expenses;
  const budget = finance.budget;
  return {
    tasks: tasks.length,
    tasksDone: done,
    progress: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
    hours,
    hoursEstimated: tasks.reduce((n, t) => n + num(t.data.estimate_hours), 0),
    timeCost,
    expenses,
    costs,
    invoiced,
    budget,
    budgetUsed: budget ? Math.round((costs / budget) * 100) : 0,
    margin: invoiced - costs,
    unbilledHours,
    unbilledValue: Math.round(unbilledHours * billRate),
    overdueTasks: tasks.filter((t) => t.data.status !== "done" && typeof t.data.due_date === "string" && t.data.due_date < today).length,
  };
}

/**
 * Lignes de facture pour le temps non facturé, regroupées par tâche.
 * Retourne aussi les identifiants des temps à marquer comme facturés.
 */
export function timeToInvoiceLines(project: Rec, tasks: Rec[], timeEntries: Rec[], vatRate: number, invoiceIds: Set<string> = new Set(), hourlyRate?: number) {
  const rate = hourlyRate ?? num(project.data.hourly_rate);
  const pending = timeEntries.filter((t) =>
    is(t, project.id) && !(t.data.invoice_id && invoiceIds.has(String(t.data.invoice_id))) && t.data.billable !== false && num(t.data.hours) > 0);
  const byTask = new Map<string, number>();
  for (const t of pending) byTask.set(String(t.data.task_id ?? ""), (byTask.get(String(t.data.task_id ?? "")) ?? 0) + num(t.data.hours));
  const title = (id: string) => String(tasks.find((t) => t.id === id)?.data.title ?? "");
  const lines: InvoiceLine[] = [...byTask.entries()].map(([taskId, hours]) => ({
    label: `${String(project.data.name)}${taskId && title(taskId) ? ` · ${title(taskId)}` : ""}`,
    qty: Math.round(hours * 100) / 100,
    unitPrice: rate,
    vatRate,
    unit: "h",
  }));
  return { lines, entryIds: pending.map((t) => t.id) };
}
