/**
 * Module Projets, lot 6 : clôture et bilan (CDC §3.17, F17 ; parcours §5.7 ; CA6.3 à CA6.5).
 *
 *  - Liste de contrôle avant de clore : étapes validées (bloquant, vérifié aussi par le serveur),
 *    dépenses à valider (bloquant), réserves levées ou retenue identifiée (bloquant), puis, non
 *    bloquants avec un motif : tâches ouvertes, montant vendu pas entièrement facturé, temps
 *    facturable pas facturé, factures en brouillon, retenue à facturer, problèmes ouverts.
 *  - Projet arrêté (RG17.4) : facture des travaux réalisés au prorata de l'avancement,
 *    `arrondi(V × A / 100) − Facturé`, si positive (CA6.5).
 *  - Bilan (prévu contre réel) : délai, budget par poste, résultat et marge, heures par étape
 *    et par personne. Les montants ne sont calculés que pour les rôles qui les voient.
 *
 * Fonctions pures : la date du jour est passée en paramètre, rien n'est écrit ici.
 */
import { addDays, computeTotals, roundAmount, type InvoiceLine } from "./invoice.ts";
import { decimalsOf, formatMoney } from "./currency.ts";
import type { Rec } from "./projects.ts";
import { daysBetween, projectProgress, stagesOf, stageState, stageWeights, STAGE_STATE_LABELS } from "./projectControl.ts";
import { costForecast, POSTE_LABELS, POSTES, type BudgetData, type Poste } from "./projectBudget.ts";
import { cancelledByCredit, invoiceOfStage, reservesOf, soldBases, type BillingData } from "./projectDecisions.ts";
import { closureStageBlocker, isStoppedProject, lastClosureKind } from "./projectRules.ts";
import { isIssue, watchPointsOf } from "./projectWatch.ts";
import { isArchived } from "./projectBoard.ts";

const num = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const live = (r: Rec) => !r.data._deleted;
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const hoursFr = (h: number) => `${(Math.round(h * 100) / 100).toLocaleString("fr-FR")} h`;

export type ClosureData = BudgetData & BillingData & { tasks: Rec[]; team_members?: Rec[] };

export type CheckKey = "stages" | "expenses" | "reserves" | "tasks" | "sold" | "time" | "drafts" | "retention" | "issues";

export interface CheckItem {
  key: CheckKey;
  ok: boolean;
  /** Bloquant : la clôture attend que ce point soit réglé. Sinon un motif est demandé. */
  blocking: boolean;
  label: string;
  detail?: string;
  /** Étape en cause (étape non validée, retenue à facturer). */
  stageId?: string;
}

export interface Prorata {
  /** Avancement retenu, en % entier. */
  pct: number;
  V: number;
  invoiced: number;
  /** arrondi(V × A / 100) − Facturé, si positif (sinon 0). */
  amount: number;
  currency: string;
}

export interface Checklist {
  items: CheckItem[];
  /** Au moins un point bloquant n'est pas réglé. */
  blocked: boolean;
  /** Points non bloquants non réglés : la clôture demande un motif. */
  warnings: number;
  stopped: boolean;
  prorata: Prorata | null;
}

/**
 * Avancement des travaux réalisés d'un projet arrêté (RG17.4) : comme l'avancement du projet,
 * mais les étapes arrêtées comptent aussi, pour ce qui y a été fait, sur tout le montant vendu.
 */
export function workDone(project: Rec, d: ClosureData, today: string): number {
  const prog = projectProgress(project, d, today);
  if (prog.method === "tasks" || prog.stages.length === 0) return prog.A;
  const weights = stageWeights(prog.stages.map((i) => i.stage));
  const W = prog.stages.reduce((n, i) => n + (weights.get(i.stage.id) ?? 1), 0);
  return W > 0 ? prog.stages.reduce((n, i) => n + (weights.get(i.stage.id) ?? 1) * i.progress, 0) / W : 0;
}

/** Facture du prorata d'un projet arrêté : identifiant déterministe, une seule par projet. */
export const prorataInvoiceId = (projectId: string) => `fa-prorata-${projectId}`;

/** Montant HT de la facture des travaux réalisés d'un projet arrêté (RG17.4, CA6.5). */
export function prorataAmount(V: number, pct: number, invoiced: number, decimals = 0): number {
  const due = roundAmount((V * Math.max(0, Math.min(100, pct))) / 100, decimals);
  return Math.max(0, roundAmount(due - invoiced, decimals));
}

/** Facturé HT du projet dans la devise du vendu : factures validées non annulées, moins les avoirs. */
function invoicedHt(project: Rec, d: ClosureData, currency: string, rate: number): number {
  const inv = (d.invoices ?? []).filter((i) => live(i) && i.data.project_id === project.id && i.data.status === "validated");
  const ht = (doc: Rec) => computeTotals((doc.data.lines as InvoiceLine[]) ?? [], decimalsOf(str(doc.data.currency) || "XAF")).net;
  const conv = (doc: Rec) => {
    const c = str(doc.data.currency) || "XAF";
    const r = c === "XAF" ? 1 : num(doc.data.rate) || 1;
    return c === currency ? 1 : r / (rate || 1);
  };
  let total = inv.filter((i) => !cancelledByCredit(i, d.credit_notes)).reduce((n, i) => n + ht(i) * conv(i), 0);
  const ids = new Set(inv.map((i) => i.id));
  for (const c of d.credit_notes ?? []) {
    const cancelled = inv.find((i) => i.id === str(c.data.invoice_id) && cancelledByCredit(i, d.credit_notes));
    if (!cancelled && live(c) && c.data.status === "validated" && (c.data.project_id === project.id || ids.has(str(c.data.invoice_id)))) total -= ht(c) * conv(c);
  }
  return Math.round(total * 100) / 100;
}

/**
 * Liste de contrôle de clôture (F17). `amounts` faux : les points qui portent des montants
 * (vendu, retenue) ne sont pas calculés. Un projet déjà clos n'a plus de liste.
 */
export function closureChecklist(project: Rec, d: ClosureData, today: string, o: { amounts: boolean; defaultVat?: number } = { amounts: true }): Checklist {
  const items: CheckItem[] = [];
  const decisions = (d.project_decisions ?? []).filter((x) => live(x) && x.data.project_id === project.id);
  const stages = stagesOf(project.id, d.project_stages);
  const stopped = isStoppedProject(decisions) || str(project.data.status) === "cancelled";
  const tasks = d.tasks.filter((t) => live(t) && t.data.project_id === project.id);
  const billing = str(project.data.billing) || "time";

  // 1. Étapes validées ou arrêtées (bloquant, CA6.3).
  if (stages.length) {
    const blocker = closureStageBlocker(stages, decisions);
    const pending = stopped ? [] : stages.filter((s) => {
      const st = stageState(s, tasks, decisions);
      return !["approved", "approved_reserves", "stopped"].includes(st);
    });
    items.push({
      key: "stages", ok: !blocker, blocking: true,
      label: stopped ? "Projet arrêté : les étapes restantes n'ont pas à être validées" : blocker ? `${plural(pending.length, "étape n'est pas validée", "étapes ne sont pas validées")}` : "Toutes les étapes sont validées",
      ...(pending.length ? { detail: pending.map((s) => `${str(s.data.name)} (${STAGE_STATE_LABELS[stageState(s, tasks, decisions)]})`).join(", "), stageId: pending[0].id } : {}),
    });
  }

  // 2. Dépenses du projet à valider (bloquant).
  const pendingExp = (d.expenses ?? []).filter((e) => live(e) && e.data.project_id === project.id && e.data.status === "pending");
  items.push({
    key: "expenses", ok: pendingExp.length === 0, blocking: true,
    label: pendingExp.length ? `${plural(pendingExp.length, "dépense du projet attend", "dépenses du projet attendent")} sa validation` : "Aucune dépense du projet à valider",
    ...(pendingExp.length ? { detail: "Validez-les ou refusez-les dans Dépenses." } : {}),
  });

  // 3. Réserves levées, ou retenue facturable identifiée (bloquant si ni l'un ni l'autre).
  const toLift: string[] = [];
  const retentions: { stage: Rec; amount: number; currency: string }[] = [];
  let reservesSeen = false;
  for (const s of stages) {
    const r = reservesOf(s.id, { ...d, tasks: d.tasks });
    if (!r || r.total === 0) continue;
    reservesSeen = true;
    if (!r.lifted && !(r.retained > 0)) toLift.push(...r.tasks.filter((t) => t.data.status !== "done").map((t) => str(t.data.title)));
    if (r.retained > 0 && !r.retentionInvoice) retentions.push({ stage: s, amount: r.retained, currency: r.currency });
  }
  if (reservesSeen) {
    items.push({
      key: "reserves", ok: toLift.length === 0, blocking: true,
      label: toLift.length ? `${plural(toLift.length, "réserve du client reste à lever", "réserves du client restent à lever")}` : "Réserves du client levées, ou retenue identifiée",
      ...(toLift.length ? { detail: toLift.slice(0, 4).map((t) => `« ${t} »`).join(", ") + (toLift.length > 4 ? "…" : "") } : {}),
    });
  }

  // 4. Tâches encore ouvertes (non bloquant : elles restent en lecture seule). Les réserves sont comptées au-dessus.
  const open = tasks.filter((t) => t.data.status !== "done" && t.data.kind !== "reserve" && !isArchived(t));
  items.push({
    key: "tasks", ok: open.length === 0, blocking: false,
    label: open.length ? `${plural(open.length, "tâche est encore ouverte", "tâches sont encore ouvertes")}` : "Toutes les tâches sont terminées",
    ...(open.length ? { detail: `${open.slice(0, 3).map((t) => `« ${str(t.data.title)} »`).join(", ")}${open.length > 3 ? "…" : ""} : elles resteront ouvertes, en lecture seule.` } : {}),
  });

  // 5. Montant vendu facturé (non bloquant), ou facture du prorata d'un projet arrêté.
  let prorata: Prorata | null = null;
  if (o.amounts && billing !== "time" && billing !== "none") {
    const sold = soldBases(project, d, o.defaultVat ?? 18);
    if (sold.V > 0) {
      const invoiced = invoicedHt(project, d, sold.currency, sold.rate);
      const fm = (n: number) => formatMoney(n, sold.currency);
      if (stopped) {
        const pct = Math.round(workDone(project, d, today) * 100);
        const draft = (d.invoices ?? []).find((i) => live(i) && i.id === prorataInvoiceId(project.id));
        const amount = draft ? 0 : prorataAmount(sold.V, pct, invoiced, sold.decimals);
        prorata = { pct, V: sold.V, invoiced, amount, currency: sold.currency };
        items.push({
          key: "sold", ok: amount === 0, blocking: false,
          label: amount > 0 ? `Travaux réalisés à facturer : ${fm(amount)} HT` : draft ? "Facture des travaux réalisés préparée" : "Travaux réalisés facturés",
          detail: `Projet arrêté à ${pct} % d'avancement : ${pct} % de ${fm(sold.V)} vendus, ${fm(invoiced)} déjà facturés.`,
        });
      } else {
        const rest = roundAmount(sold.V - invoiced, sold.decimals);
        items.push({
          key: "sold", ok: rest <= 0, blocking: false,
          label: rest > 0 ? `Reste à facturer : ${fm(rest)} HT (${Math.round((rest / sold.V) * 100)} % du vendu)` : "Montant vendu facturé à 100 %",
          ...(rest > 0 ? { detail: `${fm(invoiced)} facturés sur ${fm(sold.V)} vendus.` } : {}),
        });
      }
    }
  }

  // 6. Temps facturable pas encore facturé, pour un projet au temps passé (non bloquant).
  if (billing === "time") {
    const invoiceIds = new Set((d.invoices ?? []).filter(live).map((i) => i.id));
    const unbilled = (d.time_entries ?? []).filter((e) => live(e) && e.data.project_id === project.id && e.data.billable !== false
      && !(e.data.invoice_id && invoiceIds.has(str(e.data.invoice_id)))).reduce((n, e) => n + num(e.data.hours), 0);
    if (unbilled > 0) items.push({ key: "time", ok: false, blocking: false, label: `${hoursFr(unbilled)} facturables pas encore facturées`, detail: "Facturez-les dans l'onglet Facturation, ou indiquez pourquoi elles ne le seront pas." });
  }

  // 7. Factures du projet en brouillon (non bloquant).
  const drafts = (d.invoices ?? []).filter((i) => live(i) && i.data.project_id === project.id && i.data.status === "draft");
  if (o.amounts && drafts.length) items.push({ key: "drafts", ok: false, blocking: false, label: `${plural(drafts.length, "facture du projet est en brouillon", "factures du projet sont en brouillon")}`, detail: "Validez-les ou supprimez-les dans Factures." });

  // 8. Retenue à facturer après la levée des réserves (non bloquant : « Facturer la retenue », §5.7).
  if (o.amounts) {
    for (const r of retentions) {
      items.push({
        key: "retention", ok: false, blocking: false, stageId: r.stage.id,
        label: `Retenue de ${formatMoney(r.amount, r.currency)} HT à facturer (étape ${str(r.stage.data.name)})`,
        detail: invoiceOfStage(r.stage.id, "stage", d) ? "Elle devient facturable quand toutes les réserves sont levées." : "",
      });
    }
  }

  // 9. Problèmes encore ouverts (non bloquant).
  const issues = watchPointsOf(project.id, d.watch_points).filter(isIssue);
  if (issues.length) items.push({ key: "issues", ok: false, blocking: false, label: `${plural(issues.length, "problème est encore ouvert", "problèmes sont encore ouverts")}`, detail: issues.map((p) => `« ${str(p.data.title)} »`).join(", ") });

  return {
    items,
    blocked: items.some((i) => i.blocking && !i.ok),
    warnings: items.filter((i) => !i.blocking && !i.ok).length,
    stopped,
    prorata,
  };
}

/** Le projet est prêt à clôturer : liste sans point bloquant, et au moins une étape (§5.7, « Prêt à clôturer »). */
export function readyToClose(project: Rec, d: ClosureData, today: string): boolean {
  if (["done", "draft"].includes(str(project.data.status))) return false;
  if (!stagesOf(project.id, d.project_stages).length) return false;
  return !closureChecklist(project, d, today, { amounts: false }).blocked;
}

/**
 * Brouillon de la facture des travaux réalisés d'un projet arrêté (RG17.4) : le montant est
 * réparti sur les taux de TVA du vendu, au prorata ; l'écart d'arrondi va sur la dernière ligne.
 */
export function prorataInvoice(project: Rec, d: ClosureData, today: string, o: {
  paymentDays: number; user: { id: string; name: string }; taxes?: Record<string, unknown>; defaultVat?: number;
}): { id: string; amount: number; currency: string; patch: Record<string, unknown> } | null {
  const list = closureChecklist(project, d, today, { amounts: true, defaultVat: o.defaultVat });
  const pr = list.prorata;
  if (!pr || pr.amount <= 0 || !str(project.data.client_id)) return null;
  const sold = soldBases(project, d, o.defaultVat ?? 18);
  const dec = sold.decimals;
  const parts = sold.bases.map((b) => ({ vatRate: b.vatRate, amount: roundAmount((pr.amount * b.amount) / sold.V, dec) }));
  const gap = roundAmount(pr.amount - parts.reduce((n, b) => n + b.amount, 0), dec);
  if (parts.length && gap !== 0) parts[parts.length - 1].amount = roundAmount(parts[parts.length - 1].amount + gap, dec);
  const lines: InvoiceLine[] = parts.filter((b) => b.amount > 0).map((b) => ({
    label: `Travaux réalisés au ${pr.pct} % du projet ${str(project.data.name)}, arrêté${parts.length > 1 ? ` (TVA ${b.vatRate.toLocaleString("fr-FR")} %)` : ""}`,
    qty: 1, unitPrice: b.amount, vatRate: b.vatRate, unit: "forfait",
  }));
  if (!lines.length) return null;
  const principal = sold.principal;
  return {
    id: prorataInvoiceId(project.id),
    amount: pr.amount,
    currency: sold.currency,
    patch: {
      status: "draft", client_id: str(project.data.client_id), date: today, due_date: addDays(today, o.paymentDays), lines,
      notes: `Projet ${str(project.data.name)} arrêté : travaux réalisés à ${pr.pct} % du montant vendu, moins ${formatMoney(pr.invoiced, sold.currency)} déjà facturés.`,
      currency: sold.currency, rate: sold.currency === "XAF" ? 1 : sold.rate, ...(o.taxes ?? {}),
      withholding_rate: num(principal?.data.withholding_rate), withholding_label: str(principal?.data.withholding_label),
      project_id: project.id, origin: "prorata",
      ...(principal ? { quote_id: principal.id, quote_number: str(principal.data.number) } : {}),
      created_by: o.user.id, created_by_name: o.user.name, _deleted: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Bilan (prévu contre réel)
// ---------------------------------------------------------------------------

export interface ReviewPoste { poste: Poste; label: string; initial: number; revised: number; actual: number; gap: number; gapPct: number | null }

export interface ProjectReview {
  /** Le projet est clos (sinon : bilan provisoire à la date du jour). */
  closed: boolean;
  closedAt: string;
  closedBy: string;
  closureComment: string;
  stopped: { at: string; comment: string; by: string } | null;
  delay: { start: string; initialEnd: string; finalEnd: string; actualEnd: string; gapInitial: number | null; gapFinal: number | null; revisions: number };
  hours: {
    estimated: number; spent: number;
    byStage: { id: string; name: string; estimated: number; spent: number }[];
    byPerson: { id: string; name: string; spent: number }[];
  };
  tasks: { done: number; total: number };
  watch: { total: number; occurred: number };
  /** Seulement pour les rôles qui voient les montants. */
  amounts: null | {
    budgetInitial: number; budgetRevised: number; actual: number; gap: number; gapPct: number | null; revisions: number;
    byPoste: ReviewPoste[];
    sold: number; invoiced: number; collected: number;
    marginPlanned: number; marginPlannedPct: number | null; marginReal: number; marginRealPct: number | null;
  };
}

const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/** Décision de clôture en vigueur (la dernière, si le projet n'a pas été rouvert depuis). */
export function closureDecision(projectId: string, decisions: Rec[] = []): Rec | null {
  const mine = decisions.filter((x) => live(x) && x.data.project_id === projectId);
  if (lastClosureKind(mine) !== "project_closed") return null;
  return mine.filter((x) => x.data.kind === "project_closed").sort((a, b) => str(a.data.decided_at).localeCompare(str(b.data.decided_at))).at(-1) ?? null;
}

/**
 * Bilan du projet (F17) : délai (fin prévue initiale, finale, réelle), heures estimées contre
 * passées par étape et par personne, et pour les rôles qui voient les montants : budget initial,
 * révisé et coût réel par poste, vendu, facturé, encaissé, marge réelle contre marge prévue.
 */
export function projectReview(project: Rec, d: ClosureData, today: string, o: { amounts: boolean }): ProjectReview {
  const decisions = (d.project_decisions ?? []).filter((x) => live(x) && x.data.project_id === project.id)
    .sort((a, b) => str(a.data.decided_at).localeCompare(str(b.data.decided_at)) || a.id.localeCompare(b.id));
  const closing = closureDecision(project.id, decisions);
  const closed = str(project.data.status) === "done";
  const closedAt = (str(project.data.closed_at) || str(closing?.data.decided_at)).slice(0, 10);
  const stop = decisions.filter((x) => x.data.kind === "project_stopped").at(-1);

  // Délai : la première révision garde la fin prévue initiale.
  const deadlineRevs = decisions.filter((x) => x.data.kind === "deadline_revised");
  const firstOld = (deadlineRevs[0]?.data.old_value as { end_date?: string } | undefined)?.end_date;
  const finalEnd = str(project.data.end_date);
  const initialEnd = str(firstOld) || finalEnd;
  const actualEnd = closed && closedAt ? closedAt : today;
  const gap = (end: string) => (end && actualEnd ? daysBetween(end, actualEnd) : null);

  // Heures : estimées sur les tâches, passées sur les temps saisis ; par étape et par personne.
  const tasks = d.tasks.filter((t) => live(t) && t.data.project_id === project.id);
  const entries = (d.time_entries ?? []).filter((e) => live(e) && e.data.project_id === project.id);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const stageOf = (e: Rec) => str(e.data.stage_id) || str(taskById.get(str(e.data.task_id))?.data.stage_id);
  const stages = stagesOf(project.id, d.project_stages);
  const byStage = stages.map((s) => ({
    id: s.id, name: str(s.data.name),
    estimated: tasks.filter((t) => t.data.stage_id === s.id).reduce((n, t) => n + num(t.data.estimate_hours), 0),
    spent: entries.filter((e) => stageOf(e) === s.id).reduce((n, e) => n + num(e.data.hours), 0),
  }));
  const ids = new Set(stages.map((s) => s.id));
  const restEst = tasks.filter((t) => !ids.has(str(t.data.stage_id))).reduce((n, t) => n + num(t.data.estimate_hours), 0);
  const restSpent = entries.filter((e) => !ids.has(stageOf(e))).reduce((n, e) => n + num(e.data.hours), 0);
  if (stages.length && (restEst > 0 || restSpent > 0)) byStage.push({ id: "", name: "Hors étape", estimated: restEst, spent: restSpent });
  const people = new Map<string, { id: string; name: string; spent: number }>();
  for (const e of entries) {
    const id = str(e.data.team_member_id) || (str(e.data.user_id) ? `tm-${str(e.data.user_id)}` : "");
    const name = str((d.team_members ?? []).find((m) => m.id === id)?.data.name) || str(e.data.user_name) || "Personne inconnue";
    const cur = people.get(id || name) ?? { id, name, spent: 0 };
    cur.spent += num(e.data.hours);
    people.set(id || name, cur);
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;

  let amounts: ProjectReview["amounts"] = null;
  if (o.amounts) {
    const fc = costForecast(project, d, today);
    // Budget initial par poste : le budget actuel, moins les écarts portés par chaque révision.
    const initial: Record<Poste, number> = Object.fromEntries(POSTES.map((p) => [p, fc.byPoste.find((x) => x.poste === p)!.BP])) as Record<Poste, number>;
    for (const r of decisions.filter((x) => x.data.kind === "budget_revised")) {
      const before = ((r.data.old_value as { budget?: Record<string, number> } | undefined)?.budget) ?? {};
      const after = ((r.data.new_value as { budget?: Record<string, number> } | undefined)?.budget) ?? {};
      for (const line of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const poste = line.split("-").at(-1) as Poste;
        if (POSTES.includes(poste)) initial[poste] -= num(after[line]) - num(before[line]);
      }
    }
    const byPoste: ReviewPoste[] = fc.byPoste.map((x) => ({
      poste: x.poste, label: POSTE_LABELS[x.poste], initial: Math.max(0, initial[x.poste]), revised: x.BP, actual: x.CR,
      gap: x.CR - x.BP, gapPct: x.BP > 0 ? Math.round(((x.CR - x.BP) / x.BP) * 100) : null,
    }));
    const budgetInitial = fc.initialBP ?? fc.BP;
    const marginReal = fc.invoiced - fc.CR;
    amounts = {
      budgetInitial, budgetRevised: fc.BP, actual: fc.CR, gap: fc.CR - fc.BP, gapPct: fc.BP > 0 ? Math.round(((fc.CR - fc.BP) / fc.BP) * 100) : null,
      revisions: fc.revisions, byPoste,
      sold: fc.RP, invoiced: fc.invoiced, collected: fc.collected,
      marginPlanned: fc.RP - budgetInitial, marginPlannedPct: fc.RP > 0 && budgetInitial > 0 ? pctOf(fc.RP - budgetInitial, fc.RP) : null,
      marginReal, marginRealPct: pctOf(marginReal, fc.invoiced),
    };
  }

  const points = watchPointsOf(project.id, d.watch_points);
  return {
    closed,
    closedAt,
    closedBy: str(closing?.data.decided_by_name),
    closureComment: str(closing?.data.comment),
    stopped: stop ? { at: str(stop.data.decided_at).slice(0, 10), comment: str(stop.data.comment), by: str(stop.data.decided_by_name) } : null,
    delay: { start: str(project.data.start_date), initialEnd, finalEnd, actualEnd, gapInitial: gap(initialEnd), gapFinal: gap(finalEnd), revisions: deadlineRevs.length },
    hours: {
      estimated: round2(tasks.reduce((n, t) => n + num(t.data.estimate_hours), 0)),
      spent: round2(entries.reduce((n, e) => n + num(e.data.hours), 0)),
      byStage: byStage.map((s) => ({ ...s, estimated: round2(s.estimated), spent: round2(s.spent) })),
      byPerson: [...people.values()].map((p) => ({ ...p, spent: round2(p.spent) })).sort((a, b) => b.spent - a.spent || a.name.localeCompare(b.name, "fr")),
    },
    tasks: { done: tasks.filter((t) => t.data.status === "done").length, total: tasks.length },
    watch: { total: points.length, occurred: points.filter((p) => ["occurred", "closed"].includes(str(p.data.status)) && !!p.data.occurred_at).length },
    amounts,
  };
}

/** Photographie figée dans la décision de clôture (§2.3 `snapshot`) ; l'employé n'en reçoit que l'avancement et la météo. */
export function closureSnapshot(project: Rec, d: ClosureData, today: string, weatherLight: string | null): Record<string, unknown> {
  const prog = projectProgress(project, d, today);
  const fc = costForecast(project, d, today, prog);
  const r = projectReview(project, d, today, { amounts: false });
  return {
    progress: Math.round(prog.A * 100), plannedProgress: prog.P === null ? null : Math.round(prog.P * 100),
    cost: fc.CR, budget: fc.BP, cfe: fc.CFE, sold: fc.RP, invoiced: fc.invoiced, delayDays: r.delay.gapFinal ?? 0, weather: weatherLight,
  };
}
