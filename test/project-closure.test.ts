/**
 * Module Projets, lot 6 : points de vigilance et météo (CA6.1, CA6.2), clôture (CA6.3, CA6.5),
 * projet clôturé en lecture seule côté serveur (CA6.4, RG17.1, RG17.2), bilan, droits sur les montants.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { API_TABLES } from "../src/shared/apiKeys.ts";
import { canRead, checkChange, checkPermission, type Change, type SyncRecord } from "../src/shared/sync.ts";
import { encodeHlc } from "../src/shared/hlc.ts";
import { closedProjectBlocker, redactPatch, type ProjectContext } from "../src/shared/projectRules.ts";
import type { Rec } from "../src/shared/projects.ts";
import { budgetLineId, vigilanceLight, weather, type BudgetData } from "../src/shared/projectBudget.ts";
import { needsResponse, occurredPlan, suggestionKind, watchLevel, watchLight, watchScore, watchSuggestions } from "../src/shared/projectWatch.ts";
import { closureChecklist, prorataAmount, prorataInvoice, projectReview, readyToClose, type ClosureData } from "../src/shared/projectClosure.ts";

const TODAY = "2026-11-24";
const NOW = Date.parse("2026-11-24T09:00:00Z");
const r = (id: string, data: Record<string, unknown>): Rec => ({ id, data });
const rec = (tbl: SyncRecord["tbl"], id: string, data: Record<string, unknown>): SyncRecord => ({ tbl, id, data, clocks: {} });
const change = (tbl: Change["tbl"], row: string, patch: Record<string, unknown>): Change => ({ id: "op-12345678", tbl, row, patch, hlc: encodeHlc(NOW, 0, "dev-a"), device: "dev-a" });
const empty = (): ClosureData => ({ tasks: [], time_entries: [], expenses: [], project_stages: [], project_decisions: [], budget_lines: [], project_finance: [], cost_rates: [], quotes: [], invoices: [], credit_notes: [], payments: [], watch_points: [] });
const wp = (id: string, data: Record<string, unknown>) => r(id, { project_id: "prj-1", title: id, probability: 2, impact: 2, status: "open", ...data });

const emp = { userId: "u-junior", role: "employee" };
const pm = { userId: "u-ornella", role: "project_manager" };
const director = { userId: "u-jimmy", role: "director" };
const accountant = { userId: "u-awa", role: "accountant" };

function ctxOf(projects: SyncRecord[], o: { members?: SyncRecord[]; stages?: SyncRecord[]; decisions?: SyncRecord[] } = {}): ProjectContext {
  return {
    project: (pid) => projects.find((p) => p.id === pid) ?? null,
    rolesIn: (pid, uid) => (o.members ?? []).filter((m) => m.data.project_id === pid && m.data.user_id === uid).map((m) => String(m.data.role)),
    stages: (pid) => (o.stages ?? []).filter((s) => s.data.project_id === pid),
    decisions: (pid) => (o.decisions ?? []).filter((d) => d.data.project_id === pid),
  };
}

// ---------------------------------------------------------------------------
// Points de vigilance et météo
// ---------------------------------------------------------------------------

test("Niveaux : score = probabilité × impact ; 1-2 faible, 3-4 moyen, 6-9 fort", () => {
  assert.equal(watchScore(wp("a", { probability: 3, impact: 2 })), 6);
  assert.equal(watchLevel(wp("a", { probability: 1, impact: 2 })), "low");
  assert.equal(watchLevel(wp("a", { probability: 2, impact: 2 })), "medium");
  assert.equal(watchLevel(wp("a", { probability: 3, impact: 2 })), "high");
});

test("CA6.1 : point de probabilité forte et d'impact moyen sans parade → vigilance Rouge (score 6)", () => {
  const points = [wp("Luminaires bloqués chez le fournisseur", { probability: 3, impact: 2 })];
  const c = watchLight("prj-1", points, TODAY);
  assert.equal(c.light, "red");
  assert.match(c.reason, /sans parade.*score 6/);
  assert.equal(needsResponse(points[0], TODAY), true);
  // Avec une parade à jour : Orange ; parade en retard : Rouge ; maîtrisé : Vert.
  assert.equal(watchLight("prj-1", [wp("x", { probability: 3, impact: 2, response: "Second fournisseur", response_due: "2026-11-26" })], TODAY).light, "orange");
  const late = watchLight("prj-1", [wp("x", { probability: 3, impact: 2, response: "Second fournisseur", response_due: "2026-11-20" })], TODAY);
  assert.equal(late.light, "red");
  assert.match(late.reason, /Parade en retard depuis le 20\/11/);
  assert.equal(watchLight("prj-1", [wp("x", { probability: 3, impact: 2, status: "controlled" })], TODAY).light, "green");
  // 3 points moyens ouverts : Orange ; 2 : Vert ; aucun point : Gris.
  assert.equal(watchLight("prj-1", [wp("a", {}), wp("b", {}), wp("c", {})], TODAY).light, "orange");
  assert.equal(watchLight("prj-1", [wp("a", {}), wp("b", {})], TODAY).light, "green");
  assert.equal(watchLight("prj-1", [], TODAY).light, "grey");
  assert.equal(watchLight("prj-2", points, TODAY).light, "grey", "les points d'un autre projet ne comptent pas");
});

test("Météo : la vigilance alimente le critère « réserves ou risques » du lot 4", () => {
  const p = r("prj-1", { name: "Bureaux", status: "active" });
  const d: BudgetData = { ...empty(), watch_points: [wp("Pluies", { probability: 3, impact: 3 })] };
  const w = weather(p, d, TODAY);
  assert.equal(w.reserves.light, "red");
  assert.equal(w.overall, "red");
  assert.match(w.sentence, /Point de vigilance fort sans parade : « Pluies »/);
  // Sans point de vigilance : critère gris, comme au lot 4.
  assert.equal(weather(p, empty(), TODAY).reserves.light, "grey");
  // Réserve à lever (orange) et point moyen (vert) : orange, raison des réserves.
  const tasks = [r("t1", { project_id: "prj-1", kind: "reserve", status: "todo", title: "Joint" })];
  const c = vigilanceLight(p, tasks, [wp("a", {})], TODAY);
  assert.equal(c.light, "orange");
  assert.match(c.reason, /réserve du client à lever/);
  // Les deux orange : les deux raisons.
  const both = vigilanceLight(p, tasks, [wp("a", {}), wp("b", {}), wp("c", {})], TODAY);
  assert.match(both.reason, /3 points de vigilance moyens.*réserve du client/);
});

test("CA6.2 : « C'est arrivé » → problème, tâche « Traiter : … » pour le responsable, Rouge jusqu'à la clôture du problème", () => {
  const point = wp("wp-1", { title: "Luminaires bloqués chez le fournisseur", owner_id: "tm-u-ornella", response: "Commander chez un second fournisseur" });
  const plan = occurredPlan(point, { userId: "u-ornella", now: "2026-11-24T10:00:00Z", today: TODAY, assignOthers: true });
  assert.equal(plan.point.status, "occurred");
  assert.equal(plan.task!.id, "tsk-iss-wp-1");
  assert.equal(plan.task!.patch.title, "Traiter : Luminaires bloqués chez le fournisseur");
  assert.equal(plan.task!.patch.assignee_id, "tm-u-ornella");
  assert.equal(plan.task!.patch.kind, "issue");
  const occurred = r("wp-1", { ...point.data, ...plan.point });
  assert.equal(watchLight("prj-1", [occurred], TODAY).light, "red");
  assert.match(watchLight("prj-1", [occurred], TODAY).reason, /Problème ouvert : Luminaires/);
  // La tâche terminée ne suffit pas : le problème reste ouvert tant qu'il n'est pas clos.
  assert.equal(watchLight("prj-1", [occurred], TODAY).light, "red");
  assert.equal(watchLight("prj-1", [r("wp-1", { ...occurred.data, status: "closed" })], TODAY).light, "green");
  // Employé : la tâche n'est attribuée qu'à lui-même (R9) ; un second « C'est arrivé » ne duplique pas la tâche.
  const byEmp = occurredPlan(point, { userId: "u-junior", now: "x", today: TODAY, assignOthers: false });
  assert.equal(byEmp.task!.patch.assignee_id, undefined);
  const again = occurredPlan(occurred, { userId: "u-ornella", now: "x", today: TODAY, assignOthers: true, existingTask: r("tsk-iss-wp-1", { status: "done" }) });
  assert.deepEqual(again.task, { id: "tsk-iss-wp-1", patch: { status: "todo" } });
});

test("Suggestions par type de projet (RG14.1)", () => {
  assert.equal(suggestionKind(r("p", { name: "Réfection des bureaux, 2e étage" })), "btp");
  assert.equal(suggestionKind(r("p", { name: "Séminaire annuel" })), "event");
  assert.equal(suggestionKind(r("p", { name: "Site web de la SEEG" })), "it");
  const s = watchSuggestions(r("prj-1", { name: "Chantier Owendo" }), [wp("x", { title: "Pluies sur le chantier" })]);
  assert.ok(s.includes("Retard de livraison du ciment"));
  assert.ok(!s.includes("Pluies sur le chantier"));
});

test("Points de vigilance : contenu contrôlé, aucun montant, droits de l'employé", () => {
  const ok = { project_id: "prj-1", title: "Accès client non fournis", probability: 2, impact: 3, status: "open", created_by: "u-junior" };
  assert.equal(checkChange(null, change("watch_points", "wp-1", ok)), null);
  assert.match(checkChange(null, change("watch_points", "wp-1", { ...ok, amount: 500_000 }))!, /contenu invalide/);
  assert.match(checkChange(null, change("watch_points", "wp-1", { ...ok, probability: 4 }))!, /probabilité/);
  assert.match(checkChange(null, change("watch_points", "wp-1", { ...ok, title: " " }))!, /Décrivez|décrivez/);
  assert.match(checkChange(null, change("watch_points", "wp-1", { ...ok, status: "risky" }))!, /état/);
  assert.match(checkChange(rec("watch_points", "wp-1", ok), change("watch_points", "wp-1", { project_id: "prj-2" }))!, /change pas de projet/);
  // Tout le monde signale : l'employé crée un point en son nom.
  assert.equal(checkPermission(emp, null, change("watch_points", "wp-1", ok)), null);
  assert.match(checkPermission(emp, null, change("watch_points", "wp-1", { ...ok, created_by: "u-autre" }))!, /au nom de la personne/);
  // Il suit ceux dont il est responsable ou qu'il a signalés, pas les autres.
  const other = rec("watch_points", "wp-2", { ...ok, created_by: "u-ornella", owner_id: "tm-u-ornella" });
  assert.match(checkPermission(emp, other, change("watch_points", "wp-2", { status: "controlled" }))!, /seulement les points de vigilance/);
  const his = rec("watch_points", "wp-3", { ...ok, created_by: "u-ornella", owner_id: "tm-u-junior" });
  assert.equal(checkPermission(emp, his, change("watch_points", "wp-3", { status: "occurred" })), null);
  assert.equal(checkPermission(pm, other, change("watch_points", "wp-2", { status: "controlled" })), null);
  // Lus par tous, ouverts à l'API (aucun montant), jamais retirés à l'envoi.
  assert.equal(canRead(emp, "watch_points", "u-x", "wp-1"), true);
  assert.ok(API_TABLES.includes("watch_points"));
  assert.deepEqual(redactPatch(emp, "watch_points", { title: "x" }), { title: "x" });
});

// ---------------------------------------------------------------------------
// Clôture
// ---------------------------------------------------------------------------

const project = (data: Record<string, unknown> = {}) => r("prj-1", { name: "Réfection des bureaux", status: "active", billing: "stages", client_id: "cli-1", start_date: "2026-10-01", end_date: "2026-11-20", ...data });
const stage = (id: string, rank: number, name: string, pct = 0) => r(id, { project_id: "prj-1", name, rank, billing_pct: pct });
const decision = (id: string, kind: string, data: Record<string, unknown> = {}) => r(id, { project_id: "prj-1", kind, decided_by: "u-jimmy", decided_by_name: "Jimmy", decided_at: `2026-11-${String(10 + Number(id.replace(/\D/g, "") || 0)).padStart(2, "0")}T10:00:00Z`, ...data });

test("CA6.3 : une étape non validée → clôture refusée, l'étape en cause indiquée (appareil et serveur)", () => {
  const stages = [stage("s1", 1, "Démarrage", 30), stage("s2", 2, "Réalisation", 50), stage("s3", 3, "Réception", 20)];
  const decisions = [decision("d1", "stage_approved", { stage_id: "s1" }), decision("d2", "stage_approved", { stage_id: "s2" })];
  const d = { ...empty(), project_stages: stages, project_decisions: decisions };
  const list = closureChecklist(project(), d, TODAY);
  assert.equal(list.blocked, true);
  const item = list.items.find((i) => i.key === "stages")!;
  assert.equal(item.ok, false);
  assert.equal(item.stageId, "s3");
  assert.match(item.detail!, /Réception/);
  assert.equal(readyToClose(project(), d, TODAY), false);
  // Serveur : la décision de clôture est refusée, avec l'étape.
  const sp = (x: Rec) => rec("project_stages", x.id, x.data);
  const ctx = ctxOf([rec("projects", "prj-1", project().data)], { stages: stages.map(sp), decisions: decisions.map((x) => rec("project_decisions", x.id, x.data)) });
  const closing = change("project_decisions", "dec-close", { project_id: "prj-1", kind: "project_closed", decided_by: "u-jimmy", decided_at: "2026-11-24T10:00:00Z" });
  assert.equal(checkChange(null, closing), null);
  assert.match(checkPermission(director, null, closing, "", ctx)!, /l'étape Réception n'est pas validée/);
  // Réception validée : la clôture passe.
  const approved = [...decisions, decision("d3", "stage_approved", { stage_id: "s3" })];
  const ctx2 = ctxOf([rec("projects", "prj-1", project().data)], { stages: stages.map(sp), decisions: approved.map((x) => rec("project_decisions", x.id, x.data)) });
  assert.equal(checkPermission(director, null, closing, "", ctx2), null);
  assert.equal(readyToClose(project(), { ...d, project_decisions: approved }, TODAY), true);
  // Un responsable de projet sans délégation ne clôture pas ; avec délégation, si.
  const members = [rec("project_members", "pm-1", { project_id: "prj-1", user_id: "u-ornella", role: "manager" })];
  const byPm = change("project_decisions", "dec-close", { ...closing.patch, decided_by: "u-ornella" });
  assert.match(checkPermission(pm, null, byPm, "", { ...ctx2, rolesIn: ctxOf([], { members }).rolesIn })!, /clôturer ce projet/);
  const delegated = ctxOf([rec("projects", "prj-1", project({ manager_can_validate: true }).data)], { members, stages: stages.map(sp), decisions: approved.map((x) => rec("project_decisions", x.id, x.data)) });
  assert.equal(checkPermission(pm, null, byPm, "", delegated), null);
});

test("Liste de contrôle : dépenses à valider et réserves bloquent ; tâches ouvertes, reste à facturer et brouillons demandent un motif", () => {
  const stages = [stage("s1", 1, "Réalisation", 100)];
  const decisions = [decision("d1", "stage_approved_with_reserves", { stage_id: "s1", reserves: "Joint" })];
  const d: ClosureData = {
    ...empty(), project_stages: stages, project_decisions: decisions,
    tasks: [r("tsk-res-d1-1", { project_id: "prj-1", kind: "reserve", decision_id: "d1", status: "todo", title: "Joint" }), r("t2", { project_id: "prj-1", status: "doing", title: "Nettoyage" })],
    expenses: [r("e1", { project_id: "prj-1", status: "pending", amount: 18_000 })],
    project_finance: [r("fin-prj-1", { project_id: "prj-1", sold_manual: 1_000_000 })],
    invoices: [r("inv-1", { project_id: "prj-1", status: "draft", lines: [] })],
  };
  const list = closureChecklist(project(), d, TODAY);
  const by = (k: string) => list.items.find((i) => i.key === k)!;
  assert.equal(by("stages").ok, true);
  assert.equal(by("expenses").ok, false);
  assert.equal(by("expenses").blocking, true);
  assert.equal(by("reserves").ok, false);
  assert.match(by("reserves").detail!, /Joint/);
  assert.equal(by("tasks").ok, false);
  assert.equal(by("tasks").blocking, false);
  assert.match(by("tasks").label, /1 tâche est encore ouverte/);
  assert.match(by("sold").label, /Reste à facturer : 1 000 000/);
  assert.equal(by("drafts").blocking, false);
  assert.equal(list.blocked, true);
  assert.equal(list.warnings, 3);
  // Sans les montants (employé) : ni vendu ni brouillons dans la liste.
  const hidden = closureChecklist(project(), d, TODAY, { amounts: false });
  assert.equal(hidden.items.some((i) => i.key === "sold" || i.key === "drafts"), false);
});

test("CA6.5 : projet arrêté à 40 %, vendu 10 000 000, facturé 3 000 000 → facture proposée de 1 000 000 HT", () => {
  assert.equal(prorataAmount(10_000_000, 40, 3_000_000), 1_000_000);
  assert.equal(prorataAmount(10_000_000, 20, 3_000_000), 0, "rien si le facturé dépasse le prorata");
  const stages = [stage("s1", 1, "Démarrage", 30), stage("s2", 2, "Réalisation", 70)];
  const tasks = [
    r("t1", { project_id: "prj-1", stage_id: "s2", status: "done", estimate_hours: 10 }),
    r("t2", { project_id: "prj-1", stage_id: "s2", status: "todo", estimate_hours: 60 }),
  ];
  const decisions = [decision("d1", "stage_approved", { stage_id: "s1" }), decision("d2", "project_stopped", { stage_id: "s2", comment: "Le client arrête le chantier" })];
  const d: ClosureData = {
    ...empty(), project_stages: stages, project_decisions: decisions, tasks,
    project_finance: [r("fin-prj-1", { project_id: "prj-1", sold_manual: 10_000_000 })],
    invoices: [r("fa-jalon-s1-1", { project_id: "prj-1", status: "validated", number: "FA-1", lines: [{ label: "Démarrage", qty: 1, unitPrice: 3_000_000, vatRate: 18 }] })],
  };
  const p = project({ status: "cancelled" });
  const list = closureChecklist(p, d, TODAY);
  assert.equal(list.stopped, true);
  assert.equal(list.items.find((i) => i.key === "stages")!.ok, true, "les étapes d'un projet arrêté ne bloquent pas");
  // Avancement : Démarrage 30 % validé, Réalisation 70 % arrêtée avec 10 h faites sur 70 → 30 + 70 × 1/7 = 40 %.
  assert.equal(list.prorata!.pct, 40);
  assert.equal(list.prorata!.invoiced, 3_000_000);
  assert.equal(list.prorata!.amount, 1_000_000);
  assert.match(list.items.find((i) => i.key === "sold")!.label, /Travaux réalisés à facturer : 1 000 000/);
  const inv = prorataInvoice(p, d, TODAY, { paymentDays: 30, user: { id: "u-jimmy", name: "Jimmy" } })!;
  assert.equal(inv.id, "fa-prorata-prj-1");
  assert.equal(inv.patch.status, "draft");
  assert.equal(inv.patch.origin, "prorata");
  assert.equal((inv.patch.lines as { unitPrice: number }[]).reduce((n, l) => n + l.unitPrice, 0), inv.amount);
  // Le brouillon existe : plus rien à proposer.
  const again = closureChecklist(p, { ...d, invoices: [...d.invoices!, r(inv.id, inv.patch)] }, TODAY);
  assert.equal(again.prorata!.amount, 0);
  // Serveur : la clôture d'un projet arrêté passe malgré l'étape non validée.
  const ctx = ctxOf([rec("projects", "prj-1", p.data)], { stages: stages.map((x) => rec("project_stages", x.id, x.data)), decisions: decisions.map((x) => rec("project_decisions", x.id, x.data)) });
  assert.equal(checkPermission(director, null, change("project_decisions", "dec-c", { project_id: "prj-1", kind: "project_closed", decided_by: "u-jimmy", decided_at: "2026-11-24T10:00:00Z" }), "", ctx), null);
});

// ---------------------------------------------------------------------------
// Lecture seule après la clôture (serveur)
// ---------------------------------------------------------------------------

test("RG1.3 : un projet ne passe à Terminé que par sa décision de clôture ; il n'en sort que par une réouverture", () => {
  const open = rec("projects", "prj-1", project().data);
  const noClosure = ctxOf([open], { decisions: [] });
  assert.match(checkPermission(director, open, change("projects", "prj-1", { status: "done" }), "", noClosure)!, /seulement par sa clôture/);
  const closing = rec("project_decisions", "dec-c", decision("d5", "project_closed").data);
  assert.equal(checkPermission(director, open, change("projects", "prj-1", { status: "done", closed_at: "2026-11-24T10:00:00Z" }), "", ctxOf([open], { decisions: [closing] })), null);
  const done = rec("projects", "prj-1", project({ status: "done" }).data);
  assert.match(checkPermission(director, done, change("projects", "prj-1", { status: "active" }), "", ctxOf([done], { decisions: [closing] }))!, /rouvrez-le d'abord/);
  const reopening = rec("project_decisions", "dec-r", decision("d6", "project_reopened", { comment: "Facture de solde contestée" }).data);
  assert.equal(checkPermission(director, done, change("projects", "prj-1", { status: "active" }), "", ctxOf([done], { decisions: [closing, reopening] })), null);
  // Réouverture : direction seulement, avec motif (RG17.2).
  const reopen = change("project_decisions", "dec-r2", { project_id: "prj-1", kind: "project_reopened", decided_by: "u-ornella", decided_at: "2026-11-24T10:00:00Z", comment: "x" });
  assert.match(checkPermission(pm, null, reopen, "", ctxOf([done]))!, /rouvrir/);
  assert.match(checkChange(null, change("project_decisions", "dec-r3", { ...reopen.patch, comment: "" }))!, /motif/);
  // Décision de clôture immuable (R1).
  assert.match(checkChange(closing, change("project_decisions", "dec-c", { comment: "autre" }))!, /ne peut plus être modifiée/);
});

test("CA6.4 et RG17.1 : projet clôturé en lecture seule côté serveur, sauf dépenses et factures de la comptabilité", () => {
  const done = rec("projects", "prj-1", project({ status: "done" }).data);
  const ctx = ctxOf([done], { members: [rec("project_members", "pm-j", { project_id: "prj-1", user_id: "u-junior", role: "member" })] });
  // CA6.4 : temps refusé, même pour la direction.
  const entry = change("time_entries", "tmp-1", { project_id: "prj-1", date: TODAY, hours: 2, user_id: "u-junior" });
  assert.match(checkPermission(emp, null, entry, "", ctx)!, /clôturé.*temps/);
  assert.match(checkPermission(director, null, change("time_entries", "tmp-2", { project_id: "prj-1", date: TODAY, hours: 2, user_id: "u-jimmy" }), "", ctx)!, /clôturé/);
  // Tâches, étapes, vigilance, commentaires, équipe : refusés.
  const task = rec("tasks", "t1", { project_id: "prj-1", status: "todo", title: "x" });
  assert.match(checkPermission(director, task, change("tasks", "t1", { status: "done" }), "", ctx)!, /lecture seule/);
  assert.match(checkPermission(director, null, change("tasks", "t9", { project_id: "prj-1", title: "Nouvelle" }), "", ctx)!, /lecture seule/);
  assert.match(checkPermission(pm, null, change("watch_points", "wp-9", { project_id: "prj-1", title: "x", probability: 1, impact: 1 }), "", ctx)!, /lecture seule/);
  assert.match(checkPermission(emp, null, change("task_comments", "cmt-1", { task_id: "t1", project_id: "prj-1", body: "x", author_id: "u-junior", created_at: "2026-11-24T09:00:00Z" }), "", ctx)!, /lecture seule/);
  assert.match(checkPermission(director, null, change("project_stages", "stg-9", { project_id: "prj-1", name: "Bonus" }), "", ctx)!, /lecture seule/);
  assert.match(checkPermission(director, null, change("project_members", "pm-prj-1-tm-x", { project_id: "prj-1", team_member_id: "tm-x" }), "", ctx)!, /lecture seule/);
  assert.match(checkPermission(director, null, change("budget_lines", budgetLineId("prj-1", "", "labour"), { project_id: "prj-1", poste: "labour", amount: 1 }), "", ctx)!, /lecture seule/);
  // Fiche du projet : seules les réponses du bilan changent encore.
  assert.match(checkPermission(director, done, change("projects", "prj-1", { name: "Autre nom" }), "", ctx)!, /lecture seule/);
  assert.equal(checkPermission(director, done, change("projects", "prj-1", { closure_answers: { next: "Prévoir 10 % d'heures en plus" } }), "", ctx), null);
  assert.match(checkChange(done, change("projects", "prj-1", { closure_answers: { autre: "x" } }))!, /contenu invalide/);
  // Dépenses et factures : la comptabilité et la direction peuvent encore en rattacher, pas les autres.
  const expense = change("expenses", "exp-1", { project_id: "prj-1", date: TODAY, amount: 18_000, created_by: "u-junior" });
  assert.match(checkPermission(emp, null, expense, "", ctx)!, /rattacher/);
  assert.equal(checkPermission(accountant, null, expense, "", ctx), null);
  assert.equal(checkPermission(accountant, null, change("invoices", "inv-solde", { project_id: "prj-1", status: "draft" }), "", ctx), null);
  assert.match(checkPermission(pm, null, change("invoices", "inv-solde", { project_id: "prj-1", status: "draft" }), "", ctx)!, /rattacher/);
  // Facturer le temps après la clôture : la comptabilité pose la facture sur les temps, rien d'autre.
  const old = rec("time_entries", "tmp-0", { project_id: "prj-1", date: "2026-11-10", hours: 3, user_id: "u-junior" });
  assert.equal(checkPermission(accountant, old, change("time_entries", "tmp-0", { invoice_id: "inv-solde" }), "", ctx), null);
  assert.match(checkPermission(accountant, old, change("time_entries", "tmp-0", { hours: 4 }), "", ctx)!, /clôturé/);
  // Une deuxième clôture est refusée ; la réouverture passe (direction).
  assert.match(checkPermission(director, null, change("project_decisions", "dec-x", { project_id: "prj-1", kind: "project_closed", decided_by: "u-jimmy", decided_at: "x" }), "", ctx)!, /déjà clôturé/);
  assert.equal(closedProjectBlocker(director, null, change("project_decisions", "dec-y", { project_id: "prj-1", kind: "project_reopened", decided_by: "u-jimmy", decided_at: "x", comment: "Erreur" }), ctx), null);
  // Un projet ouvert n'est pas concerné.
  const ctxOpen = ctxOf([rec("projects", "prj-1", project().data)]);
  assert.equal(checkPermission(director, null, change("tasks", "t9", { project_id: "prj-1", title: "Nouvelle" }), "", ctxOpen), null);
});

// ---------------------------------------------------------------------------
// Bilan et droits sur les montants
// ---------------------------------------------------------------------------

test("Bilan : prévu contre réel (délai, budget par poste, marge, heures) ; montants selon le rôle", () => {
  const stages = [stage("s1", 1, "Réalisation", 100)];
  const decisions = [
    decision("d1", "deadline_revised", { comment: "Site ajouté", old_value: { end_date: "2026-11-15" }, new_value: { end_date: "2026-11-20" } }),
    decision("d2", "budget_revised", { comment: "Câblage", old_value: { budget: { [budgetLineId("prj-1", "", "labour")]: 400_000 }, total: 900_000 }, new_value: { budget: { [budgetLineId("prj-1", "", "labour")]: 500_000 }, total: 1_000_000 } }),
    decision("d3", "stage_approved", { stage_id: "s1" }),
    decision("d4", "project_closed", { comment: "" }),
  ];
  const d: ClosureData = {
    ...empty(), project_stages: stages, project_decisions: decisions,
    tasks: [r("t1", { project_id: "prj-1", stage_id: "s1", status: "done", estimate_hours: 10 })],
    time_entries: [
      r("e1", { project_id: "prj-1", task_id: "t1", hours: 8, user_id: "u-junior", user_name: "Junior", date: "2026-11-10" }),
      r("e2", { project_id: "prj-1", task_id: "t1", hours: 4, user_id: "u-paul", user_name: "Paul", date: "2026-11-11" }),
    ],
    budget_lines: [r(budgetLineId("prj-1", "", "labour"), { project_id: "prj-1", stage_id: "", poste: "labour", amount: 500_000 }), r(budgetLineId("prj-1", "", "purchases"), { project_id: "prj-1", stage_id: "", poste: "purchases", amount: 500_000 })],
    expenses: [r("x1", { project_id: "prj-1", status: "approved", amount: 590_000, vat_rate: 18, category: "goods", date: "2026-11-05" })],
    cost_rates: [r("cr-company", { hourly_cost: 40_000 })],
    project_finance: [r("fin-prj-1", { project_id: "prj-1", sold_manual: 1_500_000 })],
    invoices: [r("fa-1", { project_id: "prj-1", status: "validated", number: "FA-1", lines: [{ label: "Tout", qty: 1, unitPrice: 1_500_000, vatRate: 18 }] })],
  };
  const p = project({ status: "done", closed_at: "2026-11-22T10:00:00Z" });
  const review = projectReview(p, d, TODAY, { amounts: true });
  assert.equal(review.closed, true);
  assert.equal(review.delay.initialEnd, "2026-11-15");
  assert.equal(review.delay.finalEnd, "2026-11-20");
  assert.equal(review.delay.actualEnd, "2026-11-22");
  assert.equal(review.delay.gapInitial, 7);
  assert.equal(review.delay.gapFinal, 2);
  assert.equal(review.hours.estimated, 10);
  assert.equal(review.hours.spent, 12);
  assert.deepEqual(review.hours.byPerson.map((x) => [x.name, x.spent]), [["Junior", 8], ["Paul", 4]]);
  const a = review.amounts!;
  assert.equal(a.budgetRevised, 1_000_000);
  assert.equal(a.budgetInitial, 900_000);
  const labour = a.byPoste.find((x) => x.poste === "labour")!;
  assert.equal(labour.initial, 400_000);
  assert.equal(labour.revised, 500_000);
  assert.equal(labour.actual, 480_000, "12 h au coût moyen de 40 000");
  assert.equal(a.byPoste.find((x) => x.poste === "purchases")!.actual, 500_000, "dépense de 590 000 TTC à 18 %");
  assert.equal(a.actual, 980_000);
  assert.equal(a.sold, 1_500_000);
  assert.equal(a.invoiced, 1_500_000);
  assert.equal(a.marginReal, 520_000);
  assert.equal(a.marginRealPct, 34.7);
  assert.equal(a.marginPlannedPct, 40, "marge prévue au départ : (1 500 000 − 900 000) / 1 500 000");
  // L'employé n'a aucun montant dans le bilan (et n'en reçoit pas : budget_lines et project_finance lui sont fermés).
  assert.equal(projectReview(p, d, TODAY, { amounts: false }).amounts, null);
  for (const tbl of ["budget_lines", "project_finance", "cost_rates", "invoices", "expenses"]) assert.equal(canRead(emp, tbl, "u-x", "x"), false, tbl);
  // La photo de la décision de clôture est retirée à l'envoi pour l'employé.
  assert.deepEqual(redactPatch(emp, "project_decisions", { kind: "project_closed", snapshot: { cost: 1 }, comment: "ok" }), { kind: "project_closed", comment: "ok" });
});
