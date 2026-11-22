/**
 * Module Projets, lot 2 : étapes, avancement pondéré, prévu à date, statut d'étape,
 * création depuis un devis, priorités de la semaine (CA2.1 à CA2.7).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { canRead, checkChange, checkPermission, type Change, type SyncRecord } from "../src/shared/sync.ts";
import { encodeHlc } from "../src/shared/hlc.ts";
import {
  billingShareTotal, canPin, isoWeek, myDay, nextDeadline, pct100, periodPlanned, planStageDates, projectFromQuote, projectIdForQuote,
  projectOfQuote, projectProgress, projectSeed, quoteNet, soldOf, stageAmounts, stageProgress, stageState, stageWeights, taskWeight,
  tasksProgress, weekPriorities, weekSummaryText,
} from "../src/shared/projectControl.ts";
import { PROJECT_TEMPLATES, suggestTemplate } from "../src/shared/projectTemplates.ts";
import type { Rec } from "../src/shared/projects.ts";

const r = (id: string, data: Record<string, unknown>): Rec => ({ id, data });
const task = (id: string, data: Record<string, unknown>) => r(id, { project_id: "prj-1", status: "todo", title: id, ...data });
const stage = (id: string, data: Record<string, unknown>) => r(id, { project_id: "prj-1", name: id, ...data });
const project = r("prj-1", { name: "Rénovation", start_date: "2026-11-01", end_date: "2026-12-30" });

test("CA2.3 : étape avec une tâche de 10 h terminée et une de 30 h en cours = 25 %", () => {
  const s = stage("stg-a", {});
  const tasks = [task("t1", { stage_id: "stg-a", estimate_hours: 10, status: "done" }), task("t2", { stage_id: "stg-a", estimate_hours: 30, status: "doing" })];
  assert.equal(stageProgress(s, tasks), 0.25);
  assert.equal(stageState(s, tasks), "active", "une tâche commencée démarre l'étape");
});

test("CA2.4 : toutes les tâches terminées mais étape non validée = 95 %", () => {
  const s = stage("stg-a", {});
  const tasks = [task("t1", { stage_id: "stg-a", status: "done" }), task("t2", { stage_id: "stg-a", status: "done" })];
  assert.equal(stageProgress(s, tasks), 0.95);
  // Validée (décision du lot 3) : 100 %.
  const decisions = [r("dec-1", { stage_id: "stg-a", kind: "stage_approved", decided_at: "2026-11-20T10:00:00Z" })];
  assert.equal(stageProgress(s, tasks, decisions), 1);
  assert.equal(stageState(s, tasks, decisions), "approved");
});

test("CA2.5 : parts 30 % (validée) et 70 % (avancement 50 %) = 65 %", () => {
  const stages = [stage("s1", { rank: 1, billing_pct: 30 }), stage("s2", { rank: 2, billing_pct: 70 })];
  const tasks = [task("a", { stage_id: "s2", estimate_hours: 5, status: "done" }), task("b", { stage_id: "s2", estimate_hours: 5 })];
  const decisions = [r("dec-1", { stage_id: "s1", kind: "stage_approved", decided_at: "2026-11-05T10:00:00Z" })];
  const p = projectProgress(project, { tasks, project_stages: stages, project_decisions: decisions }, "2026-11-16");
  assert.equal(p.method, "stages");
  assert.equal(pct100(p.A), 65);
});

test("CA2.6 : étape du 01/11 au 30/11, aujourd'hui 16/11 : prévu 52 %", () => {
  assert.equal(pct100(periodPlanned("2026-11-01", "2026-11-30", "2026-11-16")!), 52);
  assert.equal(periodPlanned("2026-11-01", "2026-11-30", "2026-10-20"), 0);
  assert.equal(periodPlanned("2026-11-01", "2026-11-30", "2026-12-20"), 1);
  // Étape d'un seul jour : 0 avant, 1 à partir de ce jour.
  assert.equal(periodPlanned("2026-11-02", "2026-11-02", "2026-11-01"), 0);
  assert.equal(periodPlanned("2026-11-02", "2026-11-02", "2026-11-02"), 1);
  assert.equal(periodPlanned("", "2026-11-30", "2026-11-16"), null);
  const stages = [stage("s1", { rank: 1, billing_pct: 40, start_date: "2026-11-01", end_date: "2026-11-30" }), stage("s2", { rank: 2, billing_pct: 60, start_date: "2026-12-01", end_date: "2026-12-30" })];
  const p = projectProgress(project, { tasks: [], project_stages: stages }, "2026-11-16");
  assert.equal(Math.round(p.P! * 1000) / 1000, Math.round(0.4 * (15 / 29) * 1000) / 1000);
});

test("Prévu sans dates d'étapes : dates du projet ; sans aucune date : null", () => {
  const stages = [stage("s1", { rank: 1 }), stage("s2", { rank: 2 })];
  const p = projectProgress(project, { tasks: [], project_stages: stages }, "2026-11-30");
  assert.equal(Math.round(p.P! * 100), Math.round((29 / 59) * 100));
  const bare = r("prj-1", { name: "Sans dates" });
  assert.equal(projectProgress(bare, { tasks: [], project_stages: stages }, "2026-11-30").P, null);
});

test("CA2.7 : projet sans étape : avancement sur les tâches, comme avant (pondéré par les estimations)", () => {
  const tasks = [task("a", { status: "done" }), task("b", {}), task("c", { status: "done" }), task("d", {})];
  const p = projectProgress(project, { tasks, project_stages: [] }, "2026-11-16");
  assert.equal(p.method, "tasks");
  assert.equal(p.A, 0.5, "rien n'est estimé : nombre de tâches");
  const est = [task("a", { status: "done", estimate_hours: 6 }), task("b", { estimate_hours: 2 })];
  assert.equal(projectProgress(project, { tasks: est, project_stages: [] }, "2026-11-16").A, 0.75);
  assert.equal(projectProgress(project, { tasks: [task("x", { _deleted: true })], project_stages: [] }, "2026-11-16").A, 0, "tout supprimé : 0");
});

test("Poids : estimation, sinon moyenne des estimées du groupe, sinon 1", () => {
  const g = [task("a", { estimate_hours: 4 }), task("b", { estimate_hours: 8 }), task("c", {})];
  assert.equal(taskWeight(g[0], g), 4);
  assert.equal(taskWeight(g[2], g), 6);
  assert.equal(taskWeight(task("z", {}), [task("z", {})]), 1);
  assert.equal(tasksProgress([]), 0);
});

test("Étapes : tâches sans étape ignorées dès qu'il y a des étapes ; étape arrêtée exclue ; étape vide = 0", () => {
  const stages = [stage("s1", { rank: 1, billing_pct: 50 }), stage("s2", { rank: 2, billing_pct: 50 })];
  const tasks = [task("libre", { status: "done" }), task("a", { stage_id: "s1", status: "done" }), task("b", { stage_id: "s1" })];
  const p = projectProgress(project, { tasks, project_stages: stages }, "2026-11-16");
  assert.equal(p.A, 0.25, "s1 à 50 %, s2 vide à 0 %");
  const stopped = [r("dec", { stage_id: "s2", kind: "stage_stopped", decided_at: "2026-11-10T00:00:00Z" })];
  assert.equal(projectProgress(project, { tasks, project_stages: stages, project_decisions: stopped }, "2026-11-16").A, 0.5);
  const all = [r("d1", { stage_id: "s1", kind: "stage_stopped", decided_at: "x" }), ...stopped];
  assert.equal(projectProgress(project, { tasks, project_stages: stages, project_decisions: all }, "2026-11-16").method, "tasks", "toutes arrêtées : sur les tâches");
});

test("Poids des étapes : parts si toutes en ont, sinon durée si toutes datées, sinon 1", () => {
  const a = [stage("s1", { billing_pct: 30 }), stage("s2", { billing_pct: 70 })];
  assert.deepEqual([...stageWeights(a).values()], [30, 70]);
  const b = [stage("s1", { billing_pct: 50, start_date: "2026-11-01", end_date: "2026-11-10" }), stage("s2", { start_date: "2026-11-11", end_date: "2026-11-15" })];
  assert.deepEqual([...stageWeights(b).values()], [10, 5]);
  const c = [stage("s1", { billing_pct: 50 }), stage("s2", {})];
  assert.deepEqual([...stageWeights(c).values()], [1, 1]);
});

test("Statut d'étape : À venir, En cours (manuel ou par une tâche), À valider, réouverture", () => {
  const s = stage("s1", {});
  assert.equal(stageState(s, []), "upcoming");
  assert.equal(stageState(stage("s1", { started_at: "2026-11-02T08:00:00Z" }), []), "active");
  assert.equal(stageState(s, [task("t", { stage_id: "s1", status: "review" })]), "active");
  assert.equal(stageState(stage("s1", { review_requested_at: "2026-11-20T17:00:00Z" }), []), "awaiting");
  const reopened = [r("a", { stage_id: "s1", kind: "stage_approved", decided_at: "2026-11-20T10:00:00Z" }), r("b", { stage_id: "s1", kind: "stage_reopened", decided_at: "2026-11-21T10:00:00Z" })];
  assert.equal(stageState(s, [], reopened), "upcoming", "la réouverture annule la validation");
});

test("Montants des étapes : la dernière absorbe l'arrondi quand les parts font 100 %", () => {
  const stages = [stage("s1", { billing_pct: 33 }), stage("s2", { billing_pct: 33 }), stage("s3", { billing_pct: 34 })];
  const m = stageAmounts(1_000_001, stages);
  assert.equal([...m.values()].reduce((a, b) => a + b, 0), 1_000_001);
  assert.equal(billingShareTotal(stages), 100);
  assert.equal(billingShareTotal([stage("a", { billing_pct: 30 }), stage("b", { billing_pct: 60 })]), 90);
  assert.equal(stageAmounts(18_000_000, [stage("a", { billing_pct: 30 }), stage("b", { billing_pct: 0 })]).get("a"), 5_400_000);
});

test("Dates proposées : Démarrage le premier jour, le reste au prorata, bout à bout", () => {
  const specs = PROJECT_TEMPLATES.forfait.stages;
  const d = planStageDates("2026-11-02", "2026-12-13", specs);
  assert.deepEqual(d[0], { start_date: "2026-11-02", end_date: "2026-11-02" });
  assert.equal(d[1].start_date, "2026-11-03");
  assert.equal(d[2].end_date, "2026-12-13");
  assert.ok(d[1].end_date < d[2].start_date);
  assert.equal(planStageDates("2026-11-02", "", specs)[1].start_date, "", "sans fin : seul Démarrage est daté");
});

const quote = r("dv-abc", {
  number: "DV-2026-00042", status: "accepted", client_id: "cli-1", currency: "XAF", rate: 1, doc_type: "quote",
  lines: [
    { label: "Réfection des bureaux, 2e étage", section: true, qty: 0, unitPrice: 0, vatRate: 0 },
    { label: "Cloisons", qty: 1, unitPrice: 12_000_000, vatRate: 18, articleId: "art-1" },
    { label: "Main-d'œuvre", qty: 600, unitPrice: 10_000, vatRate: 18, unit: "h", discount: 0 },
  ],
});

test("CA2.1 : lancer le projet d'un devis accepté de 18 000 000 avec « Prestation au forfait »", () => {
  assert.equal(quoteNet(quote).net, 18_000_000);
  const seed = projectFromQuote(quote, PROJECT_TEMPLATES.forfait, { start_date: "2026-11-02", end_date: "2026-12-13", userId: "u-1", now: "2026-11-02T08:00:00Z", manager: { id: "tm-u-1", name: "Ornella Mba", user_id: "u-1" } });
  assert.equal(seed.project.id, projectIdForQuote("dv-abc"));
  assert.equal(seed.project.patch.client_id, "cli-1");
  assert.equal(seed.project.patch.quote_id, "dv-abc");
  assert.equal(seed.project.patch.name, "Réfection des bureaux, 2e étage");
  assert.equal(seed.project.patch.billing, "stages");
  assert.equal(seed.finance?.id, `fin-${seed.project.id}`);
  assert.equal(seed.finance?.patch.sold_manual, 18_000_000);
  assert.deepEqual(seed.stages.map((s) => [s.patch.name, s.patch.billing_pct]), [["Démarrage", 30], ["Réalisation", 50], ["Réception", 20]]);
  assert.equal(seed.stages[0].patch.kind, "start");
  assert.ok(seed.tasks.some((t) => t.patch.deliverable && t.patch.title === "PV de réception signé"));
  assert.deepEqual(seed.quoteLink, { id: "dv-abc", patch: { project_id: seed.project.id } });
  assert.deepEqual(seed.members.map((m) => [m.id, m.patch.role]), [[`pm-${seed.project.id}-tm-u-1`, "manager"]]);
  // Le montant vendu est lu sur les devis rattachés, sans double compte avec la ligne protégée.
  const proj = r(seed.project.id, seed.project.patch);
  const sold = soldOf(proj, { quotes: [{ ...quote, data: { ...quote.data, project_id: seed.project.id } }], project_finance: [r(seed.finance!.id, seed.finance!.patch)] });
  assert.equal(sold.V, 18_000_000);
  assert.equal(sold.source, "quotes");
  // Ids des lignes acceptés par les règles.
  for (const row of [seed.project, ...seed.stages, ...seed.tasks]) assert.ok(row.id.length <= 96);
});

test("RG3.1 : devis déjà facturé : étapes reprises mais facturation au temps passé", () => {
  const seed = projectFromQuote({ ...quote, data: { ...quote.data, status: "invoiced" } }, PROJECT_TEMPLATES.forfait, { start_date: "2026-11-02", end_date: "", userId: "u", now: "2026-11-02T08:00:00Z" });
  assert.equal(seed.project.patch.billing, "time");
  assert.equal(seed.stages.length, 3);
});

test("CA2.2 : un devis qui a déjà lancé un projet ouvre ce projet", () => {
  const p = r(projectIdForQuote("dv-abc"), { name: "x", quote_id: "dv-abc" });
  assert.equal(projectOfQuote(quote, [p])?.id, p.id);
  assert.equal(projectOfQuote(r("dv-z", {}), [p]), null);
});

test("Vendu : devis en euros (indicateurs en XAF), montant manuel, ancien forfait", () => {
  const eur = r("dv-eur", { status: "accepted", currency: "EUR", rate: 655.957, lines: [{ label: "x", qty: 1, unitPrice: 10_000, vatRate: 18 }] });
  const p = r("prj-e", { quote_id: "dv-eur", currency: "EUR" });
  const s = soldOf(p, { quotes: [eur] });
  assert.equal(s.V, 10_000);
  assert.equal(s.currency, "EUR");
  assert.equal(s.VXaf, 6_559_570);
  assert.equal(soldOf(r("prj-m", {}), { project_finance: [r("fin-prj-m", { sold_manual: 2_000_000 })] }).VXaf, 2_000_000);
  assert.equal(soldOf(r("prj-l", { billing: "fixed" }), { project_finance: [r("fin-prj-l", { legacy_budget: 900_000 })] }).source, "legacy");
  assert.equal(soldOf(r("prj-n", {}), {}).source, "none", "appareil d'un employé : rien");
  assert.equal(soldOf(p, { quotes: [{ ...eur, data: { ...eur.data, status: "refused" } }] }).source, "none", "un devis refusé ne compte pas");
});

test("Modèle proposé d'après le devis : heures seulement → régie, sinon forfait", () => {
  assert.equal(suggestTemplate([{ unit: "h" }, { unit: "jour" }]), "regie");
  assert.equal(suggestTemplate([{ unit: "h" }, { unit: "u" }]), "forfait");
  assert.equal(suggestTemplate([{ unit: "h", articleId: "a" }], [{ id: "a", data: { kind: "product" } }]), "forfait");
});

test("Projet créé d'un modèle sans devis : aucune ligne protégée sans montant, ids déterministes", () => {
  const seed = projectSeed({ id: "prj-x", name: " Interne ", client_id: "", template: "interne", billing: "none", stages: [], start_date: "2026-11-02", end_date: "", userId: "u", now: "2026-11-02T08:00:00Z" });
  assert.equal(seed.finance, null);
  assert.equal(seed.project.patch.name, "Interne");
  assert.equal(seed.quoteLink, null);
  const two = projectSeed({ id: "prj-y", name: "C", client_id: "", template: "conseil", billing: "stages", stages: PROJECT_TEMPLATES.conseil.stages, start_date: "", end_date: "", userId: "u", now: "2026-11-02T08:00:00Z" });
  assert.deepEqual(two.stages.map((s) => s.id), ["stg-prj-y-1", "stg-prj-y-2", "stg-prj-y-3", "stg-prj-y-4"]);
});

test("Prochaine échéance : validation attendue, sinon fin de l'étape en cours, sinon fin du projet", () => {
  const stages = [stage("s1", { rank: 1, name: "Démarrage", end_date: "2026-11-02" }), stage("s2", { rank: 2, name: "Conception", end_date: "2026-11-20" })];
  const info = projectProgress(project, { tasks: [], project_stages: stages }, "2026-11-16").stages;
  assert.equal(nextDeadline(project, info, "2026-11-16")?.label, "Fin de Démarrage");
  const awaiting = projectProgress(project, { tasks: [], project_stages: [stages[0], stage("s2", { rank: 2, name: "Conception", review_requested_at: "x" })] }, "2026-11-16").stages;
  assert.equal(nextDeadline(project, awaiting, "2026-11-16")?.label, "Validation de Conception");
  assert.equal(nextDeadline(project, [], "2026-11-16")?.label, "Fin du projet");
});

test("Priorités de la semaine : au plus 7, tenues la semaine dernière, en tête de Ma journée", () => {
  const today = "2026-11-23";
  const week = isoWeek(today);
  assert.equal(week, "2026-W48");
  const tasks = Array.from({ length: 7 }, (_, i) => task(`p${i}`, { priority_week: week, assignee_id: "tm-j" }));
  assert.equal(canPin("prj-1", tasks, today), false);
  assert.equal(canPin("prj-1", tasks.slice(1), today), true);
  const last = [task("l1", { priority_week: "2026-W47", status: "done" }), task("l2", { priority_week: "2026-W47" })];
  assert.deepEqual(weekPriorities("prj-1", [...tasks, ...last], today).lastWeek, { done: 1, total: 2 });
  const day = myDay("tm-j", { tasks: [task("late", { assignee_id: "tm-j", due_date: "2026-11-20" }), tasks[0]], projects: [project] }, today);
  assert.equal(day.today[0].task.id, "p0", "la priorité passe avant la tâche en retard");
  assert.equal(day.today[0].reason, "priority");
});

test("Résumé WhatsApp : priorités, terminé, en retard ou bloqué, sans montant", () => {
  const members = [r("tm-j", { name: "Junior Mintsa" })];
  const tasks = [
    task("a", { title: "Dépose des cloisons", priority_week: "2026-W48", assignee_id: "tm-j", due_date: "2026-11-24" }),
    task("b", { title: "Plans v3", status: "done", done_at: "2026-11-19T10:00:00Z" }),
    task("c", { title: "Plan électrique", blocked: true, blocked_reason: "client" }),
  ];
  const txt = weekSummaryText(r("prj-1", { name: "Rénovation BGFI" }), tasks, members, "2026-11-23");
  assert.match(txt, /Point de la semaine : Rénovation BGFI/);
  assert.match(txt, /1\. Dépose des cloisons \(Junior Mintsa · mar\. 24\/11/);
  assert.match(txt, /Terminé la semaine dernière \(1\)\*\n- Plans v3/);
  assert.match(txt, /Plan électrique \(à attribuer, bloqué : J'attends le client\)/);
  assert.ok(!/FCFA/.test(txt));
});

// ---- Règles de synchronisation du lot 2 ----

const NOW = Date.parse("2026-11-23T09:00:00Z");
const change = (tbl: Change["tbl"], row: string, patch: Record<string, unknown>): Change => ({ id: "op-12345678", tbl, row, patch, hlc: encodeHlc(NOW, 0, "dev-a"), device: "dev-a" });
const rec = (tbl: SyncRecord["tbl"], id: string, data: Record<string, unknown>): SyncRecord => ({ tbl, id, data, clocks: {} });

test("Étapes : contenu contrôlé (projet figé, nom, part entre 0 et 100, dates)", () => {
  assert.equal(checkChange(null, change("project_stages", "stg-1", { project_id: "prj-1", name: "Démarrage", rank: 1, kind: "start", billing_pct: 30 })), null);
  assert.match(checkChange(null, change("project_stages", "stg-1", { project_id: "prj-1", name: " " }))!, /nom/);
  assert.match(checkChange(null, change("project_stages", "stg-1", { project_id: "prj-1", name: "A", billing_pct: 120 }))!, /0 et 100/);
  assert.match(checkChange(null, change("project_stages", "stg-1", { project_id: "prj-1", name: "A", kind: "bidule" }))!, /nature/);
  assert.match(checkChange(null, change("project_stages", "stg-1", { project_id: "prj-1", name: "A", start_date: "2026-11-10", end_date: "2026-11-01" }))!, /précède/);
  const s = rec("project_stages", "stg-1", { project_id: "prj-1", name: "A" });
  assert.match(checkChange(s, change("project_stages", "stg-1", { project_id: "prj-2" }))!, /projet/);
  assert.equal(checkChange(s, change("project_stages", "stg-1", { _deleted: true })), null);
});

test("Étapes : l'employé les lit mais ne les écrit pas ; le chef de projet les écrit", () => {
  const emp = { userId: "u-j", role: "employee" };
  const pm = { userId: "u-o", role: "project_manager" };
  const c = change("project_stages", "stg-1", { project_id: "prj-1", name: "A" });
  assert.ok(checkPermission(emp, null, c));
  assert.equal(checkPermission(pm, null, c), null);
  assert.equal(canRead(emp, "project_stages", ""), true);
  assert.match(checkPermission(emp, rec("tasks", "tsk-1", { project_id: "prj-1", status: "todo" }), change("tasks", "tsk-1", { stage_id: "stg-1" }))!, /suivi/, "un employé ne change pas l'étape (R9)");
  assert.match(checkPermission(emp, rec("tasks", "tsk-1", { project_id: "prj-1", status: "todo" }), change("tasks", "tsk-1", { priority_week: "2026-W48" }))!, /suivi/);
  assert.match(checkChange(null, change("tasks", "tsk-1", { priority_week: "semaine 48" }))!, /semaine/);
});

test("RG3.2 : un devis envoyé reçoit son projet une seule fois, sans rien d'autre", () => {
  const sent = rec("quotes", "dv-1", { number: "DV-2026-00001", status: "accepted", lines: [] });
  assert.equal(checkChange(sent, change("quotes", "dv-1", { project_id: "prj-q-dv-1" })), null);
  const linked = rec("quotes", "dv-1", { ...sent.data, project_id: "prj-q-dv-1" });
  assert.match(checkChange(linked, change("quotes", "dv-1", { project_id: "prj-autre" }))!, /déjà rattaché/);
  assert.match(checkChange(linked, change("quotes", "dv-1", { project_id: "" }))!, /déjà rattaché/);
  assert.match(checkChange(sent, change("quotes", "dv-1", { lines: [] }))!, /numéroté/, "le reste du devis reste figé");
});
