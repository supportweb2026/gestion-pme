/**
 * Module Projets, lot 4 : budget par poste, coûts réels, coût final estimé (CA4.1 à CA4.4),
 * météo (CA4.5, CA4.7, CA4.8), alertes et décisions (CA4.6, CA4.10), droits sur les montants.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { API_TABLES } from "../src/shared/apiKeys.ts";
import { canRead, checkChange, checkPermission, type Change, type SyncRecord } from "../src/shared/sync.ts";
import { encodeHlc } from "../src/shared/hlc.ts";
import { redactPatch, type ProjectContext } from "../src/shared/projectRules.ts";
import type { Rec } from "../src/shared/projects.ts";
import type { ProgressInfo } from "../src/shared/projectControl.ts";
import {
  actualCosts, alertMode, amendmentAmount, budgetFromQuote, budgetLight, budgetLineId, budgetOf, costForecast, finalCost, posteOf,
  projectAlerts, quoteBudgetLines, reservesLight, revisionValues, scheduleLight, weather, type BudgetData, type Forecast,
} from "../src/shared/projectBudget.ts";

const TODAY = "2026-11-24";
const NOW = Date.parse("2026-11-24T09:00:00Z");
const r = (id: string, data: Record<string, unknown>): Rec => ({ id, data });
const rec = (tbl: SyncRecord["tbl"], id: string, data: Record<string, unknown>): SyncRecord => ({ tbl, id, data, clocks: {} });
const change = (tbl: Change["tbl"], row: string, patch: Record<string, unknown>): Change => ({ id: "op-12345678", tbl, row, patch, hlc: encodeHlc(NOW, 0, "dev-a"), device: "dev-a" });
const empty = (): BudgetData => ({ tasks: [], time_entries: [], expenses: [], project_stages: [], project_decisions: [], budget_lines: [], project_finance: [], cost_rates: [], quotes: [], invoices: [], credit_notes: [], payments: [] });
const line = (pid: string, poste: string, amount: number, stageId = "") => r(budgetLineId(pid, stageId, poste as "labour"), { project_id: pid, stage_id: stageId, poste, amount });

test("CA4.1 : 10 produits à 50 000 et 40 h de service, coût moyen 8 000 → Achats 500 000, Main-d'œuvre 320 000", () => {
  const articles = [r("art-p", { kind: "product", cost: 50_000 }), r("art-s", { kind: "service", cost: null })];
  const quote = r("dv-1", { lines: [
    { label: "Fauteuils", qty: 10, unitPrice: 90_000, vatRate: 18, articleId: "art-p", unit: "u" },
    { label: "Pose", qty: 40, unitPrice: 15_000, vatRate: 18, articleId: "art-s", unit: "h" },
    { label: "Peinture", qty: 1, unitPrice: 400_000, vatRate: 18 },
  ] });
  const qb = budgetFromQuote(quote, articles, 8_000);
  assert.equal(qb.byPoste.purchases, 500_000);
  assert.equal(qb.byPoste.labour, 320_000);
  assert.deepEqual(qb.toComplete.map((x) => x.label), ["Peinture"]);
  const lines = quoteBudgetLines("prj-1", qb, { userId: "u", now: "x" });
  assert.deepEqual(lines.map((l) => l.id), ["bl-prj-1-all-labour", "bl-prj-1-all-purchases", "bl-prj-1-all-other"]);
  const d = { ...empty(), budget_lines: lines.map((l) => r(l.id, l.patch)) };
  const b = budgetOf(r("prj-1", {}), d);
  assert.equal(b.total, 820_000);
  // Chaque ligne passe les contrôles du serveur.
  for (const l of lines) assert.equal(checkChange(null, change("budget_lines", l.id, l.patch)), null);
  // Une journée vaut 8 h ; une sous-traitance va à son poste.
  const q2 = budgetFromQuote(r("dv-2", { lines: [{ label: "Audit", qty: 2, unit: "jour" }, { label: "Plomberie sous-traitée", qty: 1, articleId: "art-p" }] }), articles, 8_000);
  assert.equal(q2.byPoste.labour, 128_000);
  assert.equal(q2.byPoste.subcontracting, 50_000);
});

test("CA4.2 : dépense validée de 118 000 TTC à 18 % en Fournitures → Achats 100 000 de coût réel ; en attente = engagé", () => {
  const p = r("prj-1", {});
  const d = { ...empty(), expenses: [
    r("e1", { project_id: "prj-1", amount: 118_000, vat_rate: 18, category: "supplies", status: "approved" }),
    r("e2", { project_id: "prj-1", amount: 85_000, vat_rate: 0, category: "transport", status: "pending" }),
    r("e3", { project_id: "prj-1", amount: 50_000, vat_rate: 0, category: "fees", status: "rejected" }),
    r("e4", { project_id: "prj-1", amount: 30_000, vat_rate: 0, category: "transport", poste: "subcontracting" }),
  ] };
  const a = actualCosts(p, d);
  assert.equal(a.byPoste.purchases, 100_000);
  assert.equal(a.committedByPoste.other, 85_000);
  assert.equal(a.byPoste.subcontracting, 30_000, "poste corrigé à la main");
  assert.equal(a.total, 130_000);
  assert.equal(posteOf(r("x", { category: "fees" })), "subcontracting");
});

test("CA4.3, CA4.4 : coût final estimé d'une étape (extrapolé à partir de 25 %)", () => {
  assert.equal(finalCost(4_000_000, 2_300_000, 0.4, "active"), 5_750_000);
  assert.equal(finalCost(4_000_000, 500_000, 0.1, "active"), 4_000_000);
  assert.equal(finalCost(4_000_000, 4_200_000, 1, "done"), 4_200_000);
  // Même calcul dans le projet : étape à 40 % (4 h faites sur 10), 2 300 000 dépensés.
  const p = r("prj-1", { start_date: "2026-11-01", end_date: "2026-12-31", status: "active" });
  const d = {
    ...empty(),
    project_stages: [r("stg-1", { project_id: "prj-1", name: "Installation", rank: 1 })],
    tasks: [r("t1", { project_id: "prj-1", stage_id: "stg-1", status: "done", estimate_hours: 4 }), r("t2", { project_id: "prj-1", stage_id: "stg-1", status: "doing", estimate_hours: 6 })],
    expenses: [r("e1", { project_id: "prj-1", stage_id: "stg-1", amount: 2_300_000, vat_rate: 0, category: "goods" })],
    budget_lines: [line("prj-1", "purchases", 4_000_000, "stg-1")],
  };
  const fc = costForecast(p, d, TODAY);
  assert.equal(fc.byStage, true);
  assert.equal(fc.stages[0].CFE, 5_750_000);
  assert.equal(fc.CFE, 5_750_000);
  assert.equal(fc.stages[0].deltaPct, 44);
});

const fake = (o: Partial<Forecast>): Forecast => ({ BP: 0, CFE: 0, deltaB: 0, deltaBPct: null, RP: 0, marginEstimated: 0, ...o } as Forecast);

test("CA4.5, CA4.6 : budget 10 000 000, tolérance 10 % → Orange à 10 700 000, Rouge à 11 200 000", () => {
  const p = r("prj-1", {});
  const orange = budgetLight(p, fake({ BP: 10_000_000, CFE: 10_700_000, deltaB: 700_000, deltaBPct: 7 }));
  assert.equal(orange.light, "orange");
  assert.equal(orange.reason, "Le coût final estimé dépasse le budget de 700 000 FCFA (7 %).");
  assert.equal(budgetLight(p, fake({ BP: 10_000_000, CFE: 11_200_000, deltaB: 1_200_000, deltaBPct: 12 })).light, "red");
  assert.equal(budgetLight(p, fake({ BP: 10_000_000, CFE: 10_300_000, deltaB: 300_000, deltaBPct: 3 })).light, "green");
  // Marge estimée négative : rouge quel que soit l'écart.
  assert.equal(budgetLight(p, fake({ BP: 10_000_000, CFE: 10_100_000, deltaB: 100_000, deltaBPct: 1, RP: 10_000_000, marginEstimated: -100_000 })).light, "red");
  // Tolérance du projet changée à 20 % : 12 % redevient orange.
  assert.equal(budgetLight(r("p", { tolerance_budget_pct: 20 }), fake({ BP: 10_000_000, CFE: 11_200_000, deltaB: 1_200_000, deltaBPct: 12 })).light, "orange");
});

/** Projet de 10 000 000 de budget, à 50 % d'avancement, 5 600 000 dépensés → coût final estimé 11 200 000. */
function overrun(extra: Partial<BudgetData> = {}, spent = 5_600_000) {
  const p = r("prj-1", { name: "Déploiement réseau", status: "active", start_date: "2026-11-01", end_date: "2027-01-30", client_id: "cli-1" });
  const d: BudgetData = {
    ...empty(),
    tasks: [r("t1", { project_id: "prj-1", status: "done", estimate_hours: 5 }), r("t2", { project_id: "prj-1", status: "doing", estimate_hours: 5 })],
    expenses: [r("e1", { project_id: "prj-1", amount: spent, vat_rate: 0, category: "goods" })],
    budget_lines: [line("prj-1", "purchases", 10_000_000)],
    ...extra,
  };
  return { p, d };
}

test("CA4.6 : au Rouge, le commanditaire voit une décision, le responsable du projet une information ; l'orange ne va qu'au responsable", () => {
  const { p, d } = overrun();
  const fc = costForecast(p, d, TODAY);
  assert.equal(fc.CFE, 11_200_000);
  const alerts = projectAlerts(p, d, TODAY);
  const budget = alerts.find((a) => a.key === "budget")!;
  assert.equal(budget.level, "red");
  assert.equal(budget.step, 1);
  assert.equal(alertMode(budget, { decides: true, manages: false }), "decide");
  assert.equal(alertMode(budget, { decides: false, manages: true }), "info");
  assert.equal(alertMode(budget, { decides: false, manages: false }), null, "l'équipe ne reçoit pas l'alerte");
  const o = projectAlerts(overrun({}, 5_350_000).p, overrun({}, 5_350_000).d, TODAY).find((a) => a.key === "budget")!;
  assert.equal(o.level, "orange");
  assert.equal(alertMode(o, { decides: true, manages: false }), null, "gestion par exception");
  assert.equal(alertMode(o, { decides: false, manages: true }), "info");
  // Projet en pause : aucune alerte.
  assert.equal(projectAlerts(r("prj-1", { ...p.data, status: "on_hold" }), d, TODAY).length, 0);
});

test("alerte d'étape (« exception ») : une étape qui dépasse sa tolérance remonte seule, avec ses chiffres", () => {
  const p = r("prj-1", { name: "P", status: "active" });
  const d = {
    ...empty(),
    project_stages: [r("stg-1", { project_id: "prj-1", name: "Conception", rank: 1 }), r("stg-2", { project_id: "prj-1", name: "Réalisation", rank: 2 })],
    tasks: [r("t1", { project_id: "prj-1", stage_id: "stg-1", status: "done", estimate_hours: 8 }), r("t2", { project_id: "prj-1", stage_id: "stg-1", status: "doing", estimate_hours: 2 })],
    expenses: [r("e1", { project_id: "prj-1", stage_id: "stg-1", amount: 4_032_000, vat_rate: 0, category: "fees" })],
    budget_lines: [line("prj-1", "subcontracting", 4_500_000, "stg-1"), line("prj-1", "purchases", 20_000_000, "stg-2")],
  };
  const alerts = projectAlerts(p, d, TODAY);
  const st = alerts.find((a) => a.key === "stage:stg-1")!;
  assert.equal(st.level, "red");
  assert.equal(st.figures.cfe, 5_040_000);
  assert.equal(st.figures.deltaPct, 12);
  assert.match(st.title, /L'étape Conception dépasse son budget de 12 %/);
  assert.equal(alerts.find((a) => a.key === "budget"), undefined, "le projet reste dans sa tolérance");
});

test("CA4.7 : 60 jours, tolérance 6 jours ; prévu 60 %, réel 50 % → 6 jours Orange ; réel 45 % → 9 jours Rouge", () => {
  const p = r("prj-1", { start_date: "2026-10-01", end_date: "2026-11-30", status: "active" });
  const prog = (A: number): ProgressInfo => ({ A, P: 0.6, method: "tasks", stages: [] });
  const o = scheduleLight(p, prog(0.5), TODAY);
  assert.deepEqual([o.light, o.delayDays, o.toleranceDays], ["orange", 6, 6]);
  assert.match(o.reason, /Retard estimé de 6 jours : 50 % fait pour 60 % prévu, tolérance de 6 jours/);
  const red = scheduleLight(p, prog(0.45), TODAY);
  assert.deepEqual([red.light, red.delayDays], ["red", 9]);
  assert.equal(scheduleLight(p, prog(0.6), TODAY).light, "green");
  assert.equal(scheduleLight(r("p", { start_date: "2026-10-01" }), prog(0.1), TODAY).light, "grey", "sans fin prévue");
  // Fin prévue dépassée.
  const late = scheduleLight(r("p", { start_date: "2026-10-01", end_date: "2026-11-10", status: "active" }), { A: 1, P: 1, method: "tasks", stages: [] }, TODAY);
  assert.deepEqual([late.light, late.delayDays], ["red", 14]);
});

test("Délai mesuré en jours : proche de (P − A) × D sur un plan linéaire ; une étape qui finit aujourd'hui n'est pas en retard", () => {
  const p = r("prj-1", { start_date: "2026-10-01", end_date: "2026-11-30", status: "active" });
  const day = (iso: string) => Math.round((Date.parse(`${iso}T12:00:00Z`) - Date.parse("2026-10-01T12:00:00Z")) / 864e5);
  const linear = (iso: string) => Math.max(0, Math.min(1, day(iso) / 60));
  const P = linear(TODAY);
  const o = scheduleLight(p, { A: P - 0.1, P, method: "tasks", stages: [] }, TODAY, linear);
  // (P − A) × D = 6 jours ; le prévu comptant au matin, le retard mesuré est d'un jour de moins.
  assert.deepEqual([o.light, o.delayDays], ["orange", 5]);
  // Projet lancé aujourd'hui : Démarrage (30 % du poids) finit aujourd'hui, rien n'est fait.
  const q = r("prj-2", { start_date: TODAY, end_date: "2027-01-08", status: "active" });
  const steps = (iso: string) => (iso >= TODAY ? 0.3 : 0);
  const fresh = scheduleLight(q, { A: 0, P: 0.3, method: "stages", stages: [] }, TODAY, steps);
  assert.deepEqual([fresh.light, fresh.delayDays], ["green", 0]);
  // Le lendemain, l'étape non faite compte un jour de retard.
  const next = scheduleLight(q, { A: 0, P: 0.3, method: "stages", stages: [] }, "2026-11-25", steps);
  assert.deepEqual([next.light, next.delayDays], ["orange", 1]);
});

test("CA4.8 : sans budget, le critère budget est « Non suivi » et la météo suit les autres critères ; employé sans montants", () => {
  const p = r("prj-1", { start_date: "2026-10-01", end_date: "2026-11-30", status: "active" });
  const d = { ...empty(), tasks: [r("t1", { project_id: "prj-1", status: "done" }), r("t2", { project_id: "prj-1", status: "todo" })] };
  const w = weather(p, d, TODAY);
  assert.equal(w.budget.light, "grey");
  assert.equal(w.overall, w.schedule.light);
  assert.ok(w.sentence.length > 10, "toujours une phrase qui dit pourquoi");
  // Appareil d'un employé : ni budget_lines ni project_finance ; aucune erreur, budget gris.
  const employee: BudgetData = { tasks: d.tasks, time_entries: [], expenses: [], project_stages: [] };
  assert.equal(weather(p, employee, TODAY).budget.light, "grey");
  // Projet minimal (nom et tâches, sans dates) : pas de météo du tout.
  assert.equal(weather(r("p2", {}), { ...employee, tasks: [] }, TODAY).overall, null);
});

test("réserves et blocages : réserve ouverte Orange, blocage de plus de 3 jours Rouge, réserves levées Vert", () => {
  const p = r("prj-1", {});
  const t = (id: string, data: Record<string, unknown>) => r(id, { project_id: "prj-1", ...data });
  assert.equal(reservesLight(p, [], TODAY).light, "grey");
  assert.equal(reservesLight(p, [t("a", { kind: "reserve", status: "todo" })], TODAY).light, "orange");
  assert.equal(reservesLight(p, [t("a", { kind: "reserve", status: "done" })], TODAY).light, "green");
  const old = reservesLight(p, [t("b", { title: "Câblage", status: "doing", blocked: true, blocked_at: "2026-11-18T08:00:00Z" })], TODAY);
  assert.equal(old.light, "red");
  assert.equal(old.reason, "La tâche « Câblage » est bloquée depuis 6 jours.");
});

test("CA4.10 : après « Accepter et réviser », l'alerte disparaît ; elle revient si le nouveau budget est dépassé de plus de 10 %", () => {
  const { p, d } = overrun();
  // Révision : budget porté à 11 200 000.
  const next = { [budgetLineId("prj-1", "", "purchases")]: 11_200_000 };
  const values = revisionValues(p, d, next);
  assert.deepEqual(values.old_value, { budget: next && { "bl-prj-1-all-purchases": 10_000_000 }, total: 10_000_000 });
  const revised: BudgetData = {
    ...d,
    budget_lines: [line("prj-1", "purchases", 11_200_000)],
    project_decisions: [r("dec-1", { project_id: "prj-1", kind: "budget_revised", alert_key: "budget", alert_level: 1, decided_at: "2026-11-24T10:00:00Z", ...values })],
  };
  assert.equal(projectAlerts(p, revised, TODAY).length, 0);
  assert.equal(costForecast(p, revised, TODAY).initialBP, 10_000_000, "le budget initial reste visible");
  // Le coût final estimé dépasse ensuite le nouveau budget de plus de 10 % : 6 200 000 à 50 % → 12 400 000.
  const worse = { ...revised, expenses: [r("e1", { project_id: "prj-1", amount: 6_200_000, vat_rate: 0, category: "goods" })] };
  const again = projectAlerts(p, worse, TODAY).find((a) => a.key === "budget");
  assert.equal(again?.level, "red");
});

test("avenant : la décision répond à son palier ; l'alerte revient au palier suivant (RG10.1)", () => {
  const { p, d } = overrun();
  const amend = r("dec-2", { project_id: "prj-1", kind: "amendment_proposed", alert_key: "budget", alert_level: 1, quote_id: "dv-av", decided_at: "2026-11-24T10:00:00Z" });
  assert.equal(projectAlerts(p, { ...d, project_decisions: [amend] }, TODAY).filter((a) => a.key === "budget").length, 0);
  // Écart de 24 % : palier 2.
  const worse = { ...d, project_decisions: [amend], expenses: [r("e1", { project_id: "prj-1", amount: 6_200_000, vat_rate: 0, category: "goods" })] };
  assert.equal(projectAlerts(p, worse, TODAY).find((a) => a.key === "budget")?.step, 2);
  // Un plan demandé laisse l'alerte ouverte, avec la mention.
  const plan = r("dec-3", { project_id: "prj-1", kind: "plan_requested", alert_key: "budget", alert_level: 1, decided_at: "2026-11-24T10:00:00Z" });
  assert.equal(projectAlerts(p, { ...d, project_decisions: [plan] }, TODAY).find((a) => a.key === "budget")?.planRequested?.id, "dec-3");
  // Montant proposé : dépassement majoré de la marge prévue (CDC 5.5 : 1 750 000 à 20 % → 2 188 000).
  assert.equal(amendmentAmount(1_750_000, 20), 2_188_000);
  assert.equal(amendmentAmount(1_750_000, null), 1_750_000);
});

test("marges et recettes : vendu (devis acceptés, avenant compris), facturé, encaissé", () => {
  const { p, d } = overrun({
    quotes: [
      r("dv-1", { status: "accepted", project_id: "prj-1", currency: "XAF", lines: [{ qty: 1, unitPrice: 14_000_000, vatRate: 18 }] }),
      r("dv-av", { status: "accepted", project_id: "prj-1", currency: "XAF", lines: [{ qty: 1, unitPrice: 2_100_000, vatRate: 18 }] }),
      r("dv-draft", { status: "draft", project_id: "prj-1", currency: "XAF", lines: [{ qty: 1, unitPrice: 9_000_000, vatRate: 18 }] }),
    ],
    invoices: [r("fa-1", { status: "validated", project_id: "prj-1", currency: "XAF", lines: [{ qty: 1, unitPrice: 4_000_000, vatRate: 0 }] })],
    payments: [r("pay-1", { invoice_id: "fa-1", amount: 1_000_000 })],
  });
  const fc = costForecast(p, d, TODAY);
  assert.equal(fc.RP, 16_100_000, "CA4.9 : l'avenant accepté augmente les recettes prévues");
  assert.equal(fc.invoiced, 4_000_000);
  assert.equal(fc.collected, 1_000_000);
  assert.equal(fc.marginEstimated, 16_100_000 - 11_200_000);
  assert.equal(fc.marginPlanned, 6_100_000);
});

// ---- Droits sur les montants ----

const ctxOf = (o: { roles?: Record<string, string[]>; stages?: SyncRecord[]; decisions?: SyncRecord[]; project?: Record<string, unknown> }): ProjectContext => ({
  rolesIn: (_pid, uid) => o.roles?.[uid] ?? [],
  project: () => rec("projects", "prj-1", o.project ?? { name: "P" }),
  stages: () => o.stages ?? [],
  decisions: () => o.decisions ?? [],
});
const director = { userId: "u-dir", role: "director" };
const pm = { userId: "u-pm", role: "project_manager" };
const employee = { userId: "u-emp", role: "employee" };
const blId = budgetLineId("prj-1", "", "labour");

test("droits : l'employé ne lit ni n'écrit aucun budget ; le responsable lit le budget et le coût moyen, jamais le coût de chaque personne", () => {
  assert.equal(canRead(employee, "budget_lines", ""), false);
  assert.equal(canRead(employee, "project_finance", ""), false);
  assert.equal(canRead(employee, "cost_rates", "", "cr-company"), false);
  assert.equal(canRead(pm, "budget_lines", ""), true);
  assert.equal(canRead(pm, "project_finance", ""), true);
  assert.equal(canRead(pm, "cost_rates", "", "cr-company"), true);
  assert.equal(canRead(pm, "cost_rates", "", "cr-tm-u-emp"), false);
  assert.equal(canRead({ userId: "a", role: "accountant" }, "cost_rates", "", "cr-tm-u-emp"), true);
  const write = change("budget_lines", blId, { project_id: "prj-1", stage_id: "", poste: "labour", amount: 100 });
  assert.match(String(checkPermission(employee, null, write, "", ctxOf({}))), /ne permet pas/);
  assert.equal(checkPermission(pm, null, write, "", ctxOf({})), null);
  // Les montants d'une révision ne partent jamais vers un employé, historique compris.
  const out = redactPatch(employee, "project_decisions", { kind: "budget_revised", comment: "Avenant accepté", old_value: { total: 1 }, new_value: { total: 2 }, snapshot: { cfe: 3 } });
  assert.deepEqual(out, { kind: "budget_revised", comment: "Avenant accepté" });
});

test("contrôles d'une ligne de budget : identifiant déterministe, poste connu, montant entier positif", () => {
  assert.equal(checkChange(null, change("budget_lines", "bl-prj-1-all-labour", { project_id: "prj-1", stage_id: "", poste: "labour", amount: 1 })), null);
  assert.match(String(checkChange(null, change("budget_lines", "bl-x", { project_id: "prj-1", stage_id: "", poste: "labour", amount: 1 }))), /identifiant/);
  assert.match(String(checkChange(null, change("budget_lines", "bl-prj-1-all-food", { project_id: "prj-1", stage_id: "", poste: "food", amount: 1 }))), /poste/);
  assert.match(String(checkChange(null, change("budget_lines", blId, { project_id: "prj-1", stage_id: "", poste: "labour", amount: -5 }))), /entier positif/);
  assert.match(String(checkChange(null, change("projects", "prj-1", { tolerance_budget_pct: 140 }))), /tolérance/);
});

test("R7 : une fois Démarrage validé, le budget change seulement par une révision tracée qui porte le nouveau montant", () => {
  const stages = [rec("project_stages", "stg-1", { project_id: "prj-1", name: "Démarrage", kind: "start", rank: 1 })];
  const approved = rec("project_decisions", "dec-0", { project_id: "prj-1", stage_id: "stg-1", kind: "stage_approved", decided_at: "2026-11-02T10:00:00Z" });
  const existing = rec("budget_lines", blId, { project_id: "prj-1", stage_id: "", poste: "labour", amount: 9_800_000 });
  const patch = change("budget_lines", blId, { amount: 10_240_000 });
  // Avant la validation : modification libre.
  assert.equal(checkPermission(pm, existing, patch, "", ctxOf({ stages })), null);
  // Après : refusée sans révision…
  const locked = ctxOf({ stages, decisions: [approved], roles: { "u-pm": ["manager"] } });
  assert.match(String(checkPermission(pm, existing, patch, "", locked)), /révision/);
  // … acceptée avec la révision qui porte ce montant.
  const revision = rec("project_decisions", "dec-1", { project_id: "prj-1", kind: "budget_revised", new_value: { budget: { [blId]: 10_240_000 } } });
  assert.equal(checkPermission(pm, existing, patch, "", ctxOf({ stages, decisions: [approved, revision], roles: { "u-pm": ["manager"] } })), null);
  // La révision elle-même : le responsable du projet peut l'enregistrer, l'employé non.
  const dec = change("project_decisions", "dec-9", { project_id: "prj-1", kind: "budget_revised", comment: "Avenant", decided_by: "u-pm", decided_at: "2026-11-24", new_value: { budget: {} }, old_value: { budget: {} } });
  assert.equal(checkChange(null, dec), null);
  assert.equal(checkPermission(pm, null, dec, "", locked), null);
  assert.match(String(checkPermission(employee, null, { ...dec, patch: { ...dec.patch, decided_by: "u-emp" } }, "", locked)), /ne permet pas/);
  assert.match(String(checkChange(null, change("project_decisions", "dec-8", { project_id: "prj-1", kind: "budget_revised", comment: "x", decided_by: "u", decided_at: "x" }))), /ancienne et la nouvelle/);
  // Avenant et plan : réservés à qui décide (pas au responsable sans délégation).
  const amend = change("project_decisions", "dec-7", { project_id: "prj-1", kind: "amendment_proposed", decided_by: "u-pm", decided_at: "2026-11-24" });
  assert.match(String(checkPermission(pm, null, amend, "", locked)), /décider/);
  assert.equal(checkPermission(director, null, { ...amend, patch: { ...amend.patch, decided_by: "u-dir" } }, "", locked), null);
  const delegated = ctxOf({ stages, decisions: [approved], roles: { "u-pm": ["manager"] }, project: { manager_can_validate: true } });
  assert.equal(checkPermission(pm, null, amend, "", delegated), null);
});

test("Le budget n'est jamais exposé par l'API v1, comme les autres montants des projets", () => {
  assert.ok(!API_TABLES.includes("budget_lines" as never));
});
