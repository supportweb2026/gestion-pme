/**
 * Module Projets, lot 4 : budget par poste, coûts réels, coût final estimé, marges,
 * météo (délai, budget, réserves et blocages) et alertes de dépassement.
 * Références : CDC §3.7, §3.9, §3.10 ; modèle de données §3.1 à §3.4, §3.6, §3.7, §5.3.
 *
 * Fonctions pures : la date du jour est passée en paramètre, rien n'est écrit ici.
 * Sur l'appareil d'un employé, ni `budget_lines` ni `project_finance` n'existent :
 * le budget vaut 0, le critère budget est « Non suivi » et aucun montant n'est calculé.
 */
import { computeTotals, docTaxes, formatXaf, type InvoiceLine } from "./invoice.ts";
import { decimalsOf } from "./currency.ts";
import { entryCostRate, financeOf, netXaf, type Rec } from "./projects.ts";
import { daysBetween, fold, projectProgress, soldOf, stagesOf, type ProgressInfo, type StageState } from "./projectControl.ts";

const num = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const live = (r: Rec) => !r.data._deleted;
const ddmm = (iso: string) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "");
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const jours = (n: number) => plural(n, "jour", "jours");

// ---- Postes (F7) ----

export const POSTES = ["labour", "purchases", "subcontracting", "other"] as const;
export type Poste = (typeof POSTES)[number];
export const POSTE_LABELS: Record<Poste, string> = {
  labour: "Main-d'œuvre",
  purchases: "Achats et matériel",
  subcontracting: "Sous-traitance",
  other: "Autres frais",
};
/** Correspondance des catégories de dépense vers les postes (§3.2). La main-d'œuvre vient du temps seulement. */
export const EXPENSE_POSTE: Record<string, Poste> = {
  goods: "purchases", supplies: "purchases", maintenance: "purchases",
  fees: "subcontracting",
  fuel: "other", transport: "other", telecom: "other", advertising: "other", rent: "other",
  utilities: "other", insurance: "other", bank: "other", taxes: "other", other: "other",
};
/** Poste d'une dépense : corrigé à la main, sinon déduit de sa catégorie. Jamais la main-d'œuvre. */
export const posteOf = (e: Rec): Poste => {
  const p = str(e.data.poste) as Poste;
  return p && p !== "labour" && POSTES.includes(p) ? p : EXPENSE_POSTE[str(e.data.category)] ?? "other";
};
export const isPoste = (v: unknown): v is Poste => (POSTES as readonly string[]).includes(str(v));

/** Identifiant déterministe d'une case de la grille étape × poste (§2.1). */
export const budgetLineId = (projectId: string, stageId: string, poste: Poste) => `bl-${projectId}-${stageId || "all"}-${poste}`;

type ByPoste = Record<Poste, number>;
const zero = (): ByPoste => ({ labour: 0, purchases: 0, subcontracting: 0, other: 0 });
const sum = (b: ByPoste) => POSTES.reduce((n, p) => n + b[p], 0);

export interface BudgetData {
  tasks: Rec[];
  time_entries: Rec[];
  expenses: Rec[];
  project_stages: Rec[];
  project_decisions?: Rec[];
  budget_lines?: Rec[];
  project_finance?: Rec[];
  cost_rates?: Rec[];
  quotes?: Rec[];
  invoices?: Rec[];
  credit_notes?: Rec[];
  payments?: Rec[];
}

/** Coût horaire moyen de l'entreprise (ligne `cr-company`, lisible du responsable du projet), sinon 0. */
export function companyHourlyCost(costRates: Rec[] = []): number {
  return num(costRates.find((c) => c.id === "cr-company" && live(c))?.data.hourly_cost);
}

/** Coût horaire servant à chiffrer des heures prévues : coût du projet, sinon coût moyen de l'entreprise. */
export function plannedRate(project: Rec, d: BudgetData): number {
  return financeOf(project, d.project_finance).costRate || companyHourlyCost(d.cost_rates);
}

/** Montant d'une ligne de budget : son montant, sinon heures × coût horaire (main-d'œuvre). */
export const lineAmount = (line: Rec, rate: number) => (num(line.data.amount) > 0 ? num(line.data.amount) : Math.round(num(line.data.hours) * rate));

/** Lignes de budget vivantes d'un projet. */
export const budgetLinesOf = (projectId: string, lines: Rec[] = []) => lines.filter((l) => live(l) && l.data.project_id === projectId && isPoste(l.data.poste));

/**
 * Budget prévu (F7) : somme des lignes. `stageId` absent = tout le projet ; "" = lignes du
 * projet sans étape ; sinon les lignes de l'étape. Sans aucune ligne, l'ancien budget global
 * d'un projet d'avant le lot 4 (`legacy_budget`) tient lieu de total.
 */
export function budgetOf(project: Rec, d: BudgetData, stageId?: string): { byPoste: ByPoste; total: number; source: "lines" | "legacy" | "none" } {
  const all = budgetLinesOf(project.id, d.budget_lines);
  const rate = plannedRate(project, d);
  const lines = stageId === undefined ? all : all.filter((l) => str(l.data.stage_id) === stageId);
  const byPoste = zero();
  for (const l of lines) byPoste[l.data.poste as Poste] += lineAmount(l, rate);
  const total = sum(byPoste);
  if (all.length === 0 && stageId === undefined) {
    const legacy = financeOf(project, d.project_finance).budget;
    const legacyIsPrice = ["fixed", "milestone"].includes(str(project.data.billing));
    if (legacy > 0 && !legacyIsPrice) return { byPoste, total: legacy, source: "legacy" };
  }
  return { byPoste, total, source: total > 0 || all.length ? "lines" : "none" };
}

/** Étape d'une saisie de temps : la sienne, sinon celle de sa tâche. */
function entryStage(e: Rec, tasks: Map<string, Rec>): string {
  return str(e.data.stage_id) || str(tasks.get(str(e.data.task_id))?.data.stage_id);
}

export interface Actuals {
  byPoste: ByPoste;
  /** Dépenses « À valider » (engagé), par poste. */
  committedByPoste: ByPoste;
  committed: number;
  total: number;
  hours: number;
  /** Heures sans coût horaire connu : comptées 0 et signalées. */
  missingRateHours: number;
  /** Le coût de la main-d'œuvre est calculé au coût horaire de chaque personne (sinon au coût moyen). */
  perPerson: boolean;
}

/**
 * Coûts réels (F7) : main-d'œuvre = Σ heures × coût horaire (personne, projet, moyenne) ;
 * dépenses validées (ou sans statut) ramenées au HT ; dépenses « À valider » = engagé.
 * `stageId` absent = tout ; "" = hors des étapes vivantes ; sinon l'étape.
 */
export function actualCosts(project: Rec, d: BudgetData, stageId?: string): Actuals {
  const fin = financeOf(project, d.project_finance);
  const tasks = new Map(d.tasks.map((t) => [t.id, t]));
  const liveStages = new Set(stagesOf(project.id, d.project_stages).map((s) => s.id));
  const match = (sid: string) => stageId === undefined || (stageId === "" ? !liveStages.has(sid) : sid === stageId);
  const byPoste = zero();
  const committedByPoste = zero();
  let hours = 0;
  let missing = 0;
  let perPerson = false;
  let labour = 0;
  for (const e of d.time_entries) {
    if (!live(e) || e.data.project_id !== project.id || !match(entryStage(e, tasks))) continue;
    const h = num(e.data.hours);
    const r = entryCostRate(e, fin.costRate, d.cost_rates);
    if (r.source === "missing") missing += h;
    if (r.source === "person") perPerson = true;
    hours += h;
    labour += h * r.rate;
  }
  byPoste.labour = Math.round(labour);
  for (const e of d.expenses) {
    if (!live(e) || e.data.project_id !== project.id || e.data.status === "rejected" || !match(str(e.data.stage_id))) continue;
    const net = Math.round(num(e.data.amount) / (1 + num(e.data.vat_rate) / 100));
    if (e.data.status === "pending") committedByPoste[posteOf(e)] += net;
    else byPoste[posteOf(e)] += net;
  }
  return { byPoste, committedByPoste, committed: sum(committedByPoste), total: sum(byPoste), hours, missingRateHours: missing, perPerson };
}

// ---- Recettes : vendu, facturé, encaissé (§3.3) ----

export function revenue(project: Rec, d: BudgetData): { sold: number; invoiced: number; collected: number; toInvoice: number; overInvoiced: boolean } {
  const sold = soldOf(project, d).VXaf;
  const invoices = (d.invoices ?? []).filter((i) => live(i) && i.data.project_id === project.id && i.data.status === "validated");
  const ids = new Set(invoices.map((i) => i.id));
  const credits = (d.credit_notes ?? []).filter((c) => live(c) && c.data.status === "validated" && (c.data.project_id === project.id || ids.has(str(c.data.invoice_id))));
  const invoiced = invoices.reduce((n, i) => n + netXaf(i), 0) - credits.reduce((n, c) => n + netXaf(c), 0);
  let collected = 0;
  for (const inv of invoices) {
    const dec = decimalsOf(str(inv.data.currency) || "XAF");
    const gross = computeTotals((inv.data.lines as InvoiceLine[]) ?? [], dec, docTaxes(inv.data)).gross;
    if (gross <= 0) continue;
    const paid = (d.payments ?? []).filter((p) => live(p) && p.data.invoice_id === inv.id).reduce((n, p) => n + num(p.data.amount), 0) + num(inv.data.paid_amount);
    collected += Math.round((Math.min(paid, gross) / gross) * netXaf(inv));
  }
  return { sold, invoiced, collected, toInvoice: Math.max(0, sold - invoiced), overInvoiced: sold > 0 && invoiced > sold };
}

// ---- Coût final estimé, écarts et marges (§3.4) ----

/** Avancement à partir duquel on extrapole le coût (CDC F7). */
export const EXTRAPOLATE_FROM = 0.25;

/**
 * Coût final estimé d'un ensemble (étape ou projet) : fait = coût réel ; pas commencé =
 * max(budget, réel) ; en cours à 25 % ou plus = max(réel, réel / avancement) ; sinon max(budget, réel).
 */
export function finalCost(BP: number, CR: number, A: number, phase: "done" | "upcoming" | "active"): number {
  if (phase === "done") return CR;
  if (phase === "active" && A >= EXTRAPOLATE_FROM) return Math.round(Math.max(CR, CR / A));
  return Math.max(BP, CR);
}

const phaseOf = (s: StageState): "done" | "upcoming" | "active" =>
  s === "approved" || s === "approved_reserves" || s === "stopped" ? "done" : s === "upcoming" ? "upcoming" : "active";

export interface StageForecast {
  stageId: string;
  name: string;
  state: StageState;
  BP: number;
  CR: number;
  committed: number;
  A: number;
  CFE: number;
  /** Écart du coût final estimé au budget de l'étape, en % ; null sans budget. */
  deltaPct: number | null;
}

export interface Forecast {
  BP: number;
  budgetSource: "lines" | "legacy" | "none";
  /** Budget de départ, avant la première révision (RG7.3) ; null si jamais révisé. */
  initialBP: number | null;
  revisions: number;
  byPoste: { poste: Poste; BP: number; CR: number; committed: number; pct: number | null; unplanned: boolean }[];
  actuals: Actuals;
  CR: number;
  committed: number;
  CFE: number;
  deltaB: number;
  deltaBPct: number | null;
  consumptionPct: number | null;
  A: number;
  RP: number;
  invoiced: number;
  collected: number;
  toInvoice: number;
  marginPlanned: number;
  marginEstimated: number;
  marginPlannedPct: number | null;
  marginEstimatedPct: number | null;
  stages: StageForecast[];
  /** Le budget est détaillé par étape (au moins une ligne d'étape). */
  byStage: boolean;
}

const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);

/** Budget, coûts réels, coût final estimé, écarts et marges d'un projet (F7). */
export function costForecast(project: Rec, d: BudgetData, today: string, prog: ProgressInfo = projectProgress(project, d, today)): Forecast {
  const budget = budgetOf(project, d);
  const actuals = actualCosts(project, d);
  const rate = plannedRate(project, d);
  const lines = budgetLinesOf(project.id, d.budget_lines);
  const liveStages = new Set(prog.stages.map((i) => i.stage.id));
  const byStage = lines.some((l) => liveStages.has(str(l.data.stage_id)));
  const closed = ["done", "cancelled"].includes(str(project.data.status));

  const stages: StageForecast[] = prog.stages.map((i) => {
    const BP = budgetLinesOf(project.id, d.budget_lines).filter((l) => l.data.stage_id === i.stage.id).reduce((n, l) => n + lineAmount(l, rate), 0);
    const a = actualCosts(project, d, i.stage.id);
    const CFE = finalCost(BP, a.total, i.progress, phaseOf(i.state)) + a.committed;
    return { stageId: i.stage.id, name: str(i.stage.data.name), state: i.state, BP, CR: a.total, committed: a.committed, A: i.progress, CFE, deltaPct: BP > 0 ? Math.round(((CFE - BP) / BP) * 100) : null };
  });

  let CFE: number;
  const projectPhase = closed ? "done" : prog.A <= 0 && actuals.total === 0 ? "upcoming" : "active";
  if (byStage) {
    // Étapes budgétées une par une, puis le reste (lignes du projet, coûts hors étape) au rythme du projet.
    const restBP = lines.filter((l) => !liveStages.has(str(l.data.stage_id))).reduce((n, l) => n + lineAmount(l, rate), 0);
    const rest = actualCosts(project, d, "");
    CFE = stages.reduce((n, s) => n + s.CFE, 0) + finalCost(restBP, rest.total, prog.A, projectPhase) + rest.committed;
  } else {
    CFE = finalCost(budget.total, actuals.total, prog.A, projectPhase) + actuals.committed;
  }

  const rev = revenue(project, d);
  const BP = budget.total;
  const deltaB = CFE - BP;
  const revisions = (d.project_decisions ?? []).filter((x) => live(x) && x.data.project_id === project.id && x.data.kind === "budget_revised")
    .sort((a, b) => str(a.data.decided_at).localeCompare(str(b.data.decided_at)));
  const firstOld = revisions[0]?.data.old_value as { total?: number } | undefined;
  return {
    BP,
    budgetSource: budget.source,
    initialBP: revisions.length && typeof firstOld?.total === "number" ? firstOld.total : null,
    revisions: revisions.length,
    byPoste: POSTES.map((p) => ({
      poste: p, BP: budget.byPoste[p], CR: actuals.byPoste[p], committed: actuals.committedByPoste[p],
      pct: pctOf(actuals.byPoste[p], budget.byPoste[p]), unplanned: budget.source === "lines" && budget.byPoste[p] === 0 && actuals.byPoste[p] + actuals.committedByPoste[p] > 0,
    })),
    actuals,
    CR: actuals.total,
    committed: actuals.committed,
    CFE,
    deltaB,
    deltaBPct: BP > 0 ? Math.round((deltaB / BP) * 100) : null,
    consumptionPct: pctOf(actuals.total, BP),
    A: prog.A,
    RP: rev.sold,
    invoiced: rev.invoiced,
    collected: rev.collected,
    toInvoice: rev.toInvoice,
    marginPlanned: rev.sold - BP,
    marginEstimated: rev.sold - CFE,
    marginPlannedPct: rev.sold > 0 && BP > 0 ? Math.round(((rev.sold - BP) / rev.sold) * 1000) / 10 : null,
    marginEstimatedPct: rev.sold > 0 ? Math.round(((rev.sold - CFE) / rev.sold) * 1000) / 10 : null,
    stages,
    byStage,
  };
}

// ---- Météo (F9) ----

export type Light = "green" | "orange" | "red" | "grey";
export const LIGHT_LABELS: Record<Light, string> = { green: "Tout va bien", orange: "À surveiller", red: "À redresser", grey: "Non suivi" };
const RANK: Record<Light, number> = { grey: 0, green: 1, orange: 2, red: 3 };
export const WEATHER_RULES = { delayMinDays: 3, defaultDelayPct: 10, defaultBudgetPct: 10, blockedDays: 3 } as const;

/** Tolérances du projet (RG9.3), 10 % par défaut. */
export function tolerances(project: Rec): { budgetPct: number; delayPct: number } {
  const pick = (v: unknown, def: number) => (v === undefined || v === null || v === "" ? def : Math.max(0, Math.min(100, num(v))));
  return { budgetPct: pick(project.data.tolerance_budget_pct, WEATHER_RULES.defaultBudgetPct), delayPct: pick(project.data.tolerance_delay_pct, WEATHER_RULES.defaultDelayPct) };
}

export interface Criterion { light: Light; reason: string }
export interface ScheduleCriterion extends Criterion { delayDays: number; toleranceDays: number; stageId?: string }

/**
 * Délai : retard estimé R = max(retard de l'étape en cours la plus ancienne, retard d'avancement
 * (P − A) × D, dépassement de la fin prévue). Vert si R = 0 ; orange jusqu'à la tolérance
 * T_d = max(3, D × t_d / 100) ; rouge au-delà ; gris sans fin prévue.
 *
 * Avec `plannedAt` (prévu à une date), le retard d'avancement se mesure en jours de calendrier :
 * aujourd'hui moins le jour où le plan atteignait l'avancement réel A (le prévu d'un jour compte
 * au matin : une étape qui finit aujourd'hui n'est pas en retard). Sans cela, (P − A) × D
 * prêterait 30 % de la durée de retard à une étape d'un jour dont le poids est de 30 %.
 */
export function scheduleLight(project: Rec, prog: ProgressInfo, today: string, plannedAt?: (iso: string) => number | null): ScheduleCriterion {
  const start = str(project.data.start_date);
  const end = str(project.data.end_date);
  if (!end) return { light: "grey", reason: "Pas de fin prévue : le délai n'est pas suivi.", delayDays: 0, toleranceDays: 0 };
  const D = start && end > start ? daysBetween(start, end) : 0;
  const Td = Math.max(WEATHER_RULES.delayMinDays, Math.round((D * tolerances(project).delayPct) / 100));
  const closed = ["done", "cancelled"].includes(str(project.data.status));
  // Étape en cours dont la fin prévue est passée.
  let stageLate = 0;
  let stage: { id: string; name: string; end: string } | null = null;
  for (const i of prog.stages) {
    if (["approved", "approved_reserves", "stopped"].includes(i.state)) continue;
    const se = str(i.stage.data.end_date);
    if (se && se < today && daysBetween(se, today) > stageLate) {
      stageLate = daysBetween(se, today);
      stage = { id: i.stage.id, name: str(i.stage.data.name), end: se };
    }
  }
  const P = prog.P ?? 0;
  const progressLate = !(D > 0 && P > prog.A) ? 0 : plannedAt && start && start <= today ? earnedDelay(start, today, prog.A, plannedAt) : Math.round((P - prog.A) * D);
  const endLate = !closed && end < today ? daysBetween(end, today) : 0;
  const R = closed ? 0 : Math.max(stageLate, progressLate, endLate);
  const tol = `tolérance de ${jours(Td)}`;
  const light: Light = R === 0 ? "green" : R <= Td ? "orange" : "red";
  let reason: string;
  if (R === 0) reason = `Dans les temps (${tol}).`;
  else if (R === endLate && endLate >= stageLate && endLate >= progressLate) reason = `Fin prévue le ${ddmm(end)} dépassée de ${jours(R)}, ${tol}.`;
  else if (R === stageLate && stage) reason = `L'étape ${stage.name} devait finir le ${ddmm(stage.end)} : retard de ${jours(R)}, ${tol}.`;
  else reason = `Retard estimé de ${jours(R)} : ${Math.round(prog.A * 100)} % fait pour ${Math.round(P * 100)} % prévu, ${tol}.`;
  return { light, reason, delayDays: R, toleranceDays: Td, ...(R > 0 && R === stageLate && stage ? { stageId: stage.id } : {}) };
}

/** Jours entre aujourd'hui et le dernier jour où le prévu (au matin) ne dépassait pas A ; recherche dichotomique. */
function earnedDelay(start: string, today: string, A: number, plannedAt: (iso: string) => number | null): number {
  const n = daysBetween(start, today);
  const morning = (k: number) => plannedAt(addDaysIso(start, k - 1)) ?? 0;
  if (morning(n) <= A + 1e-9) return 0;
  let lo = 0;
  let hi = n;
  if (morning(0) > A + 1e-9) return n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (morning(mid) <= A + 1e-9) lo = mid; else hi = mid;
  }
  return n - lo;
}
const addDaysIso = (iso: string, k: number) => { const t = new Date(`${iso}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); };

/**
 * Budget : écart ΔB % du coût final estimé au budget. Vert sous la moitié de la tolérance,
 * orange jusqu'à la tolérance, rouge au-delà ; rouge aussi si la marge estimée est négative.
 * Gris sans budget (et sur l'appareil d'un employé).
 */
export function budgetLight(project: Rec, fc: Forecast): Criterion {
  if (fc.BP <= 0) return { light: "grey", reason: "Pas de budget prévu : le budget n'est pas suivi." };
  const t = tolerances(project).budgetPct;
  const pct = fc.deltaBPct ?? 0;
  if (fc.RP > 0 && fc.marginEstimated < 0) {
    return { light: "red", reason: `La marge estimée est négative : le coût final estimé (${formatXaf(fc.CFE)}) dépasse le montant vendu (${formatXaf(fc.RP)}).` };
  }
  const light: Light = pct > t ? "red" : pct >= t / 2 ? "orange" : "green";
  if (fc.deltaB > 0 && light !== "green") return { light, reason: `Le coût final estimé dépasse le budget de ${formatXaf(fc.deltaB)} (${pct} %).` };
  if (fc.deltaB > 0) return { light, reason: `Coût final estimé à ${pct} % au-dessus du budget, tolérance de ${t} %.` };
  return { light, reason: `Coût final estimé dans le budget : ${formatXaf(fc.CFE)} pour ${formatXaf(fc.BP)} prévus.` };
}

/**
 * Réserves et blocages (en attendant les points de vigilance du lot 6) : rouge si une tâche
 * est bloquée depuis plus de 3 jours ou si 3 tâches sont bloquées ; orange s'il reste une
 * réserve du client à lever ou une tâche bloquée ; vert quand toutes les réserves sont levées ;
 * gris s'il n'y a jamais eu de réserve et rien n'est bloqué.
 */
export function reservesLight(project: Rec, tasks: Rec[], today: string): Criterion {
  const mine = tasks.filter((t) => live(t) && t.data.project_id === project.id);
  const open = mine.filter((t) => t.data.status !== "done");
  const blocked = open.filter((t) => t.data.blocked);
  const since = (t: Rec) => (str(t.data.blocked_at) ? daysBetween(str(t.data.blocked_at).slice(0, 10), today) : 0);
  const old = blocked.filter((t) => since(t) > WEATHER_RULES.blockedDays).sort((a, b) => since(b) - since(a));
  const reserves = mine.filter((t) => t.data.kind === "reserve");
  const openReserves = reserves.filter((t) => t.data.status !== "done");
  if (old.length) return { light: "red", reason: `La tâche « ${str(old[0].data.title)} » est bloquée depuis ${jours(since(old[0]))}.` };
  if (blocked.length >= 3) return { light: "red", reason: `${blocked.length} tâches sont bloquées.` };
  const parts: string[] = [];
  if (openReserves.length) parts.push(`${plural(openReserves.length, "réserve du client à lever", "réserves du client à lever")}`);
  if (blocked.length) parts.push(`${plural(blocked.length, "tâche bloquée", "tâches bloquées")} : « ${str(blocked[0].data.title)} »`);
  if (parts.length) return { light: "orange", reason: `${parts.join(", ")}.`.replace(/^./, (c) => c.toUpperCase()) };
  if (reserves.length) return { light: "green", reason: "Toutes les réserves du client sont levées, aucune tâche bloquée." };
  return { light: "grey", reason: "Aucune réserve ni tâche bloquée." };
}

export interface Weather {
  /** Pire couleur non grise ; null si les trois critères sont gris. */
  overall: Exclude<Light, "grey"> | null;
  schedule: ScheduleCriterion;
  budget: Criterion;
  reserves: Criterion;
  /** Phrase d'explication : le critère le plus défavorable, avec son chiffre. */
  sentence: string;
}

/** Météo calculée du projet (F9) : jamais modifiable à la main (RG9.1). */
export function weather(project: Rec, d: BudgetData, today: string, prog: ProgressInfo = projectProgress(project, d, today), fc: Forecast = costForecast(project, d, today, prog)): Weather {
  const schedule = scheduleLight(project, prog, today, (iso) => projectProgress(project, d, iso).P);
  const budget = budgetLight(project, fc);
  const reserves = reservesLight(project, d.tasks, today);
  const order: Criterion[] = [budget, schedule, reserves];
  const worst = order.reduce((w, c) => (RANK[c.light] > RANK[w.light] ? c : w), order[0]);
  const overall = RANK[worst.light] === 0 ? null : (worst.light as Exclude<Light, "grey">);
  // La pastille porte déjà le mot (« Tout va bien »…) : la phrase donne la raison seule.
  const sentence = overall === null ? "" : worst.reason;
  return { overall, schedule, budget, reserves, sentence };
}

// ---- Alertes de dépassement (F10, F13) ----

export type AlertKey = "budget" | "delay" | "margin" | `stage:${string}`;
export interface ProjectAlert {
  key: AlertKey;
  /** Rouge = hors tolérance (décision du commanditaire) ; orange = approche (information du responsable). */
  level: "red" | "orange";
  /** Palier d'écart : l'alerte réapparaît au palier suivant après une décision (RG10.1). */
  step: number;
  projectId: string;
  stageId?: string;
  title: string;
  detail: string;
  figures: { budget?: number; cfe?: number; delta?: number; deltaPct?: number | null; delayDays?: number; toleranceDays?: number; tolerancePct?: number; actual?: number };
  /** Décision qui a répondu à ce palier (avenant) : l'alerte n'est plus affichée. */
  answeredBy: Rec | null;
  /** Plan de redressement demandé : l'alerte reste ouverte, avec cette mention. */
  planRequested: Rec | null;
}

/** Décisions du journal qui répondent à une alerte (§5.3). */
export const ANSWERS = ["amendment_proposed", "plan_requested"];

/**
 * Alertes d'un projet, calculées et jamais stockées (CDC 2.4) : dépassement de tolérance
 * du projet (budget, délai), d'une étape (budget), marge estimée négative. Une alerte
 * disparaît quand sa cause disparaît (révision du budget ou de la date) ou quand un avenant
 * est proposé à son palier ; elle réapparaît au palier suivant. Aucune alerte sur un projet
 * terminé, annulé ou en pause.
 */
export function projectAlerts(project: Rec, d: BudgetData, today: string, prog: ProgressInfo = projectProgress(project, d, today), fc: Forecast = costForecast(project, d, today, prog), w: Weather = weather(project, d, today, prog, fc)): ProjectAlert[] {
  if (!live(project) || ["done", "cancelled", "on_hold"].includes(str(project.data.status))) return [];
  const t = tolerances(project).budgetPct;
  const decisions = (d.project_decisions ?? []).filter((x) => live(x) && x.data.project_id === project.id)
    .sort((a, b) => str(a.data.decided_at).localeCompare(str(b.data.decided_at)) || a.id.localeCompare(b.id));
  const lastRevision = (kind: string) => str(decisions.filter((x) => x.data.kind === kind).at(-1)?.data.decided_at);
  const out: ProjectAlert[] = [];
  const add = (a: Omit<ProjectAlert, "answeredBy" | "planRequested">, revisionKind: string) => {
    const after = lastRevision(revisionKind);
    const answers = decisions.filter((x) => x.data.alert_key === a.key && str(x.data.decided_at) >= after);
    const answeredBy = a.level === "red" ? answers.filter((x) => x.data.kind === "amendment_proposed" && num(x.data.alert_level) >= a.step).at(-1) ?? null : null;
    const planRequested = answers.filter((x) => x.data.kind === "plan_requested" && num(x.data.alert_level) >= a.step).at(-1) ?? null;
    out.push({ ...a, answeredBy, planRequested });
  };

  // Budget du projet.
  if (fc.BP > 0 && fc.RP > 0 && fc.marginEstimated < 0) {
    add({
      key: "margin", level: "red", step: 1, projectId: project.id, title: "La marge estimée est négative",
      detail: `Le coût final estimé (${formatXaf(fc.CFE)}) dépasse le montant vendu (${formatXaf(fc.RP)}).`,
      figures: { budget: fc.BP, cfe: fc.CFE, delta: fc.deltaB, deltaPct: fc.deltaBPct, tolerancePct: t, actual: fc.CR },
    }, "budget_revised");
  } else if (w.budget.light === "red" || w.budget.light === "orange") {
    const pct = fc.deltaBPct ?? 0;
    const red = w.budget.light === "red";
    add({
      key: "budget", level: red ? "red" : "orange", step: red ? Math.max(1, Math.floor(pct / Math.max(1, t))) : 0, projectId: project.id,
      title: red ? `Le projet dépasse son budget de ${pct} %` : `Le budget approche la limite : +${pct} %`,
      detail: `${w.budget.reason} Tolérance de ${t} %.`,
      figures: { budget: fc.BP, cfe: fc.CFE, delta: fc.deltaB, deltaPct: pct, tolerancePct: t, actual: fc.CR },
    }, "budget_revised");
  }

  // Budget de chaque étape en cours (« exception » : une étape sort de sa tolérance).
  for (const s of fc.stages) {
    if (s.BP <= 0 || s.deltaPct === null || phaseOf(s.state) === "done") continue;
    const stage = prog.stages.find((i) => i.stage.id === s.stageId)?.stage;
    const ts = stage && stage.data.tolerance_budget_pct !== undefined && stage.data.tolerance_budget_pct !== "" ? num(stage.data.tolerance_budget_pct) : t;
    if (s.deltaPct < ts / 2) continue;
    const red = s.deltaPct > ts;
    add({
      key: `stage:${s.stageId}`, level: red ? "red" : "orange", step: red ? Math.max(1, Math.floor(s.deltaPct / Math.max(1, ts))) : 0, projectId: project.id, stageId: s.stageId,
      title: red ? `L'étape ${s.name} dépasse son budget de ${s.deltaPct} %` : `Le budget de l'étape ${s.name} approche la limite : +${s.deltaPct} %`,
      detail: `Coût final estimé de l'étape : ${formatXaf(s.CFE)} pour ${formatXaf(s.BP)} prévus (${formatXaf(s.CR)} dépensés à ${Math.round(s.A * 100)} % d'avancement), tolérance de ${ts} %.`,
      figures: { budget: s.BP, cfe: s.CFE, delta: s.CFE - s.BP, deltaPct: s.deltaPct, tolerancePct: ts, actual: s.CR },
    }, "budget_revised");
  }

  // Délai.
  if (w.schedule.light === "red" || w.schedule.light === "orange") {
    const red = w.schedule.light === "red";
    const sc = w.schedule;
    add({
      key: "delay", level: red ? "red" : "orange", step: red ? Math.max(1, Math.floor(sc.delayDays / Math.max(1, sc.toleranceDays))) : 0, projectId: project.id,
      ...(sc.stageId ? { stageId: sc.stageId } : {}),
      title: red ? `Retard estimé de ${jours(sc.delayDays)}, au-delà de la tolérance` : `Retard estimé de ${jours(sc.delayDays)}, dans la tolérance`,
      detail: sc.reason,
      figures: { delayDays: sc.delayDays, toleranceDays: sc.toleranceDays },
    }, "deadline_revised");
  }
  return out.filter((a) => !a.answeredBy);
}

/** Comment une alerte apparaît à quelqu'un : décision à prendre, ou information. */
export type AlertMode = "decide" | "info";

/**
 * Gestion par exception (RG10.2, CA4.6) : un dépassement (rouge) est une décision pour qui
 * décide du projet (commanditaire, direction, responsable délégué) et une information pour le
 * responsable du projet ; une approche (orange) n'est montrée qu'au responsable du projet.
 */
export function alertMode(alert: ProjectAlert, viewer: { decides: boolean; manages: boolean }): AlertMode | null {
  if (alert.level === "red") return viewer.decides ? "decide" : viewer.manages ? "info" : null;
  return viewer.manages ? "info" : null;
}

/** Heures saisies sans coût horaire : signalées au responsable, sans rendre la météo rouge. */
export function missingRateNotice(fc: Forecast): string | null {
  const h = fc.actuals.missingRateHours;
  if (h <= 0) return null;
  return `${h.toLocaleString("fr-FR")} h saisies sans coût horaire : elles sont comptées à 0. Renseignez le coût horaire moyen dans Projets › Personnes.`;
}

// ---- Budget repris du devis (RG3.3, CA4.1) ----

interface QuoteLineLike { qty?: number; unitPrice?: number; unit?: string; label?: string; articleId?: string; article_id?: string; section?: boolean; deposit?: boolean; depositInvoiceId?: string }

const TIME_UNITS: Record<string, number> = { h: 1, heure: 1, heures: 1, hr: 1, j: 8, jour: 8, jours: 8, "j/h": 8, "h/j": 8 };

export interface QuoteBudget {
  byPoste: ByPoste;
  hours: number;
  /** Libellés des lignes dont le coût reste à compléter (« Peinture : coût à compléter »). */
  toComplete: { poste: Poste; label: string }[];
}

/**
 * Budget prévu par poste tiré des lignes d'un devis (RG3.3) : services ou unités de temps →
 * main-d'œuvre (heures × coût horaire moyen, 8 h par jour) ; produits → achats (quantité ×
 * prix d'achat) ; « sous-traitance » dans le libellé → sous-traitance ; le reste → autres, à compléter.
 */
export function budgetFromQuote(quote: Rec, articles: Rec[], hourlyCost: number): QuoteBudget {
  const byPoste = zero();
  const toComplete: QuoteBudget["toComplete"] = [];
  let hours = 0;
  for (const l of (quote.data.lines as QuoteLineLike[] | undefined) ?? []) {
    if (l.section || l.deposit || l.depositInvoiceId) continue;
    const label = str(l.label).trim() || "Ligne sans libellé";
    const qty = num(l.qty);
    const article = articles.find((a) => a.id === (l.articleId ?? l.article_id));
    const cost = article && article.data.cost !== null && article.data.cost !== undefined && article.data.cost !== "" ? num(article.data.cost) : null;
    const unit = fold(str(l.unit)).replace(/\.$/, "");
    if (/sous[- ]?trait/.test(fold(label)) || article?.data.subcontracted === true) {
      if (cost !== null && cost > 0) byPoste.subcontracting += Math.round(qty * cost);
      else toComplete.push({ poste: "subcontracting", label });
      continue;
    }
    if (unit in TIME_UNITS) {
      const h = qty * TIME_UNITS[unit];
      hours += h;
      if (hourlyCost > 0) byPoste.labour += Math.round(h * hourlyCost);
      else toComplete.push({ poste: "labour", label });
      continue;
    }
    if (article?.data.kind === "service") { toComplete.push({ poste: "labour", label }); continue; }
    if (article?.data.kind === "product") {
      if (cost !== null && cost > 0) byPoste.purchases += Math.round(qty * cost);
      else toComplete.push({ poste: "purchases", label });
      continue;
    }
    toComplete.push({ poste: "other", label });
  }
  return { byPoste, hours, toComplete };
}

/** Lignes `budget_lines` du projet (niveau projet, « all ») pour un budget tiré du devis. */
export function quoteBudgetLines(projectId: string, qb: QuoteBudget, o: { userId: string; now: string }): { id: string; patch: Record<string, unknown> }[] {
  return POSTES.filter((p) => qb.byPoste[p] > 0 || (p === "labour" && qb.hours > 0) || qb.toComplete.some((x) => x.poste === p)).map((p) => ({
    id: budgetLineId(projectId, "", p),
    patch: {
      project_id: projectId, stage_id: "", poste: p, amount: qb.byPoste[p], ...(p === "labour" && qb.hours > 0 ? { hours: Math.round(qb.hours * 100) / 100 } : {}),
      source: "quote", to_complete: qb.toComplete.some((x) => x.poste === p),
      ...(qb.toComplete.some((x) => x.poste === p) ? { note: qb.toComplete.filter((x) => x.poste === p).map((x) => x.label).join(" ; ").slice(0, 300) } : {}),
      created_by: o.userId, created_at: o.now, _deleted: false,
    },
  }));
}

// ---- Révision et avenant (§5.3, RG7.3) ----

/** Montant proposé pour l'avenant : dépassement estimé majoré de la marge prévue, arrondi au millier. */
export function amendmentAmount(overrun: number, marginPlannedPct: number | null): number {
  const m = marginPlannedPct && marginPlannedPct > 0 && marginPlannedPct < 90 ? marginPlannedPct : 0;
  return Math.max(0, Math.round((overrun / (1 - m / 100)) / 1000) * 1000);
}

/** Brouillon de devis complémentaire rattaché au projet (CA4.9). Modifiable : il n'a pas de numéro. */
export function amendmentQuote(project: Rec, amount: number, cause: string, o: { today: string; userId: string; userName: string; vatRate: number; validityDays?: number }): Record<string, unknown> {
  const valid = new Date(`${o.today}T12:00:00Z`);
  valid.setUTCDate(valid.getUTCDate() + (o.validityDays ?? 30));
  return {
    status: "draft",
    client_id: str(project.data.client_id),
    date: o.today,
    valid_until: valid.toISOString().slice(0, 10),
    currency: "XAF",
    rate: 1,
    lines: [{ label: `Avenant : ${cause}`, qty: 1, unitPrice: amount, vatRate: o.vatRate, unit: "forfait" }],
    notes: `Avenant au projet ${str(project.data.name)}.`,
    project_id: project.id,
    origin: "amendment",
    created_by: o.userId,
    created_by_name: o.userName,
    _deleted: false,
  };
}

/** Valeurs d'une révision de budget : montants par ligne avant et après, et totaux (RG7.3). */
export function revisionValues(project: Rec, d: BudgetData, next: Record<string, number>): { old_value: Record<string, unknown>; new_value: Record<string, unknown> } {
  const rate = plannedRate(project, d);
  const lines = budgetLinesOf(project.id, d.budget_lines);
  const before: Record<string, number> = {};
  for (const id of Object.keys(next)) {
    const l = lines.find((x) => x.id === id);
    before[id] = l ? lineAmount(l, rate) : 0;
  }
  const total = budgetOf(project, d).total;
  const after = total + Object.keys(next).reduce((n, id) => n + next[id] - before[id], 0);
  return { old_value: { budget: before, total }, new_value: { budget: next, total: after } };
}

/** Le budget ne change plus que par une révision tracée (R7), règle partagée avec le serveur. */
export { budgetLocked } from "./projectRules.ts";
