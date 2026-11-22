/**
 * Module Projets, lot 3 : validation d'étape et facture de jalon (CA3.1 à CA3.8),
 * journal des décisions immuable, « la première validation fait foi », droits de décision
 * et délégation, réserves en tâches, retenue jusqu'à la levée des réserves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { canRead, checkChange, checkPermission, type Change, type SyncRecord } from "../src/shared/sync.ts";
import { encodeHlc } from "../src/shared/hlc.ts";
import { sentence } from "../src/web/local/guard.ts";
import { approvalBlocker, canDecide, redactPatch, type ProjectContext } from "../src/shared/projectRules.ts";
import { nextDeadline, projectProgress, stageState } from "../src/shared/projectControl.ts";
import {
  cancelledByCredit, decisionsToMake, invoiceOfStage, reserveTasks, reservesOf, retentionInvoice, soldBases, stageInvoice,
  type BillingData, type InvoiceOptions, type StageInvoicePlan,
} from "../src/shared/projectDecisions.ts";
import type { Rec } from "../src/shared/projects.ts";

const NOW = Date.parse("2026-11-24T09:00:00Z");
const change = (tbl: Change["tbl"], row: string, patch: Record<string, unknown>): Change => ({ id: "op-12345678", tbl, row, patch, hlc: encodeHlc(NOW, 0, "dev-a"), device: "dev-a" });
const rec = (tbl: SyncRecord["tbl"], id: string, data: Record<string, unknown>): SyncRecord => ({ tbl, id, data, clocks: {} });
const r = (id: string, data: Record<string, unknown>): Rec => ({ id, data });

const quote = (id: string, lines: { qty: number; unitPrice: number; vatRate: number }[], extra: Record<string, unknown> = {}) =>
  r(id, { status: "accepted", number: "DV-2026-00042", client_id: "cli-1", currency: "XAF", lines: lines.map((l) => ({ label: "x", ...l })), ...extra });
const project = r("prj-1", { name: "Rénovation BGFI", client_id: "cli-1", billing: "stages", quote_id: "dv-1", currency: "XAF" });
const stage = (id: string, rank: number, pct: number, extra: Record<string, unknown> = {}) => r(id, { project_id: "prj-1", name: id, rank, billing_pct: pct, ...extra });
const approve = (id: string, stageId: string, at: string, extra: Record<string, unknown> = {}) =>
  r(id, { project_id: "prj-1", stage_id: stageId, kind: "stage_approved", decided_by: "u-jimmy", decided_by_name: "Jimmy Rerambyha", decided_at: at, ...extra });
const opts = (decisionId: string, retentionPct = 0): InvoiceOptions => ({ decisionId, retentionPct, today: "2026-11-24", paymentDays: 30, user: { id: "u-jimmy", name: "Jimmy" } });
const plan = (x: StageInvoicePlan | { error: string }): StageInvoicePlan => {
  if ("error" in x) throw new Error(`refus inattendu : ${x.error}`);
  return x;
};
const net = (p: StageInvoicePlan) => (p.patch.lines as { unitPrice: number; qty: number }[]).reduce((n, l) => n + l.unitPrice * l.qty, 0);
/** Facture écrite : la ligne que l'appareil enregistrerait. */
const asInvoice = (p: StageInvoicePlan, extra: Record<string, unknown> = {}) => r(p.id, { ...p.patch, ...extra });

test("CA3.1 : Réalisation 50 % d'un vendu de 18 000 000 → brouillon de 9 000 000 HT lié au projet, à l'étape, au devis et à la décision", () => {
  const stages = [stage("Démarrage", 1, 30, { kind: "start" }), stage("Réalisation", 2, 50), stage("Réception", 3, 20)];
  const d: BillingData = {
    quotes: [quote("dv-1", [{ qty: 1, unitPrice: 18_000_000, vatRate: 18 }])], project_stages: stages,
    project_decisions: [approve("dec-0", "Démarrage", "2026-11-02T10:00:00Z"), approve("dec-1", "Réalisation", "2026-11-24T10:00:00Z")],
  };
  const p = plan(stageInvoice(project, stages[1], d, opts("dec-1")));
  assert.equal(p.M, 9_000_000);
  assert.equal(net(p), 9_000_000);
  assert.equal(p.id, "fa-jalon-Réalisation-1", "identifiant déterministe fa-jalon-{étape}-{n}");
  assert.equal(p.patch.status, "draft");
  assert.deepEqual([p.patch.project_id, p.patch.stage_id, p.patch.quote_id, p.patch.decision_id, p.patch.client_id, p.patch.origin], ["prj-1", "Réalisation", "dv-1", "dec-1", "cli-1", "stage"]);
  assert.equal(p.patch.due_date, "2026-12-24", "échéance selon les délais de paiement");
  assert.match(String((p.patch.lines as { label: string }[])[0].label), /^Étape Réalisation : 50 % du devis DV-2026-00042$/);
  assert.equal(p.patch.deposit, undefined, "facture d'étape ordinaire, pas un acompte (arbitrage 1)");
  // Calculée sur le montant vendu, jamais sur le budget (un coût) : un budget n'y change rien.
  const withBudget = plan(stageInvoice({ ...project, data: { ...project.data, budget: 4_000_000 } }, stages[1], d, opts("dec-1")));
  assert.equal(withBudget.M, 9_000_000);
  // L'étape suivante passe « En cours » par le calcul.
  const info = projectProgress(project, { tasks: [], project_stages: stages, project_decisions: d.project_decisions }, "2026-11-24").stages;
  assert.deepEqual(info.map((i) => i.state), ["approved", "approved", "upcoming"]);
});

test("Démarrage : facture d'étape ordinaire, libellée « Étape Démarrage : 30 % du devis »", () => {
  const stages = [stage("Démarrage", 1, 30, { kind: "start" }), stage("Réalisation", 2, 70)];
  const d: BillingData = { quotes: [quote("dv-1", [{ qty: 1, unitPrice: 18_000_000, vatRate: 18 }])], project_stages: stages, project_decisions: [] };
  const p = plan(stageInvoice(project, stages[0], d, opts("dec-0")));
  assert.equal(p.M, 5_400_000);
  assert.ok(!(p.patch.lines as { deposit?: boolean }[]).some((l) => l.deposit));
  assert.match(String((p.patch.lines as { label: string }[])[0].label), /^Étape Démarrage : 30 % du devis/);
});

test("CA3.2 : 33/33/34 % d'un vendu de 1 000 001 → la somme des 3 factures vaut exactement 1 000 001", () => {
  const stages = [stage("A", 1, 33), stage("B", 2, 33), stage("C", 3, 34)];
  const d: BillingData = { quotes: [quote("dv-1", [{ qty: 1, unitPrice: 1_000_001, vatRate: 18 }])], project_stages: stages, project_decisions: [], invoices: [] };
  let total = 0;
  for (const s of stages) {
    d.project_decisions!.push(approve(`dec-${s.id}`, s.id, `2026-11-2${s.data.rank}T10:00:00Z`));
    const p = plan(stageInvoice(project, s, d, opts(`dec-${s.id}`)));
    d.invoices!.push(asInvoice(p));
    total += net(p);
  }
  assert.equal(total, 1_000_001);
  assert.deepEqual(d.invoices!.map((i) => (i.data.jalon_base as { amount: number }[])[0].amount), [330_000, 330_000, 340_001]);
});

test("CA3.3 : 600 000 HT à 18 % et 400 000 HT à 0 %, étape de 30 % → 180 000 à 18 % et 120 000 à 0 %", () => {
  const stages = [stage("S", 1, 30), stage("T", 2, 70)];
  const d: BillingData = { quotes: [quote("dv-1", [{ qty: 1, unitPrice: 600_000, vatRate: 18 }, { qty: 2, unitPrice: 200_000, vatRate: 0 }])], project_stages: stages, project_decisions: [] };
  const p = plan(stageInvoice(project, stages[0], d, opts("dec-1")));
  const lines = p.patch.lines as { unitPrice: number; vatRate: number; label: string }[];
  assert.deepEqual(lines.map((l) => [l.unitPrice, l.vatRate]), [[180_000, 18], [120_000, 0]]);
  assert.match(lines[0].label, /\(TVA 18 %\)$/);
  assert.deepEqual(soldBases(project, d).bases, [{ vatRate: 18, amount: 600_000 }, { vatRate: 0, amount: 400_000 }]);
});

test("CA3.6 : 2 réserves et une retenue de 5 % → 2 tâches « Réserve » dans l'étape suivante, facture à 95 % du jalon", () => {
  const stages = [stage("Conception", 1, 20, { owner_id: "tm-u-prisca" }), stage("Réalisation", 2, 80, { owner_id: "tm-u-landry", owner_name: "Landry Nzé" })];
  const d: BillingData = {
    quotes: [quote("dv-1", [{ qty: 1, unitPrice: 48_500_000, vatRate: 18 }])], project_stages: stages,
    project_decisions: [approve("dec-r", "Conception", "2026-11-24T10:00:00Z", { kind: "stage_approved_with_reserves", reserves: "A\nB", retention_pct: 5 })],
    tasks: [],
  };
  const res = reserveTasks(project, stages[0], "dec-r", "Ajouter le plan de la salle des coffres\n\n  Corriger la cote du guichet 3  \n", d, { userId: "u-jimmy", now: "2026-11-24T10:00:00Z", today: "2026-11-24" });
  assert.equal(res.stage, null, "pas d'étape créée : il y a une étape suivante");
  assert.deepEqual(res.tasks.map((t) => t.id), ["tsk-res-dec-r-1", "tsk-res-dec-r-2"]);
  assert.deepEqual(res.tasks.map((t) => [t.patch.stage_id, t.patch.kind, t.patch.decision_id, t.patch.assignee_id, t.patch.title]),
    [["Réalisation", "reserve", "dec-r", "tm-u-landry", "Ajouter le plan de la salle des coffres"], ["Réalisation", "reserve", "dec-r", "tm-u-landry", "Corriger la cote du guichet 3"]]);
  const p = plan(stageInvoice(project, stages[0], d, opts("dec-r", 5)));
  assert.equal(p.M, 9_700_000);
  assert.equal(p.retained, 485_000);
  assert.equal(net(p), 9_215_000, "95 % du jalon");
  assert.match(String(p.patch.notes), /moins une retenue de 5 % \(485 000 FCFA HT\)/);
  // Dernière étape validée avec réserves : une étape « Levée des réserves » est créée.
  const last = reserveTasks(project, stages[1], "dec-z", "Joint fissuré", d, { userId: "u", now: "x", today: "2026-11-30" });
  assert.equal(last.stage?.id, "stg-res-prj-1");
  assert.equal(last.stage?.patch.kind, "reserves");
  assert.equal(last.tasks[0].patch.stage_id, "stg-res-prj-1");
});

test("Levée des réserves : la retenue devient facturable quand toutes les tâches de réserve sont closes", () => {
  const stages = [stage("Conception", 1, 20), stage("Réalisation", 2, 80)];
  const dec = approve("dec-r", "Conception", "2026-11-24T10:00:00Z", { kind: "stage_approved_with_reserves", reserves: "A\nB", retention_pct: 5 });
  const d: BillingData = { quotes: [quote("dv-1", [{ qty: 1, unitPrice: 48_500_000, vatRate: 18 }])], project_stages: stages, project_decisions: [dec], invoices: [], tasks: [] };
  const p = plan(stageInvoice(project, stages[0], d, opts("dec-r", 5)));
  d.invoices!.push(asInvoice(p, { status: "validated", number: "FA-2026-00187" }));
  d.tasks = reserveTasks(project, stages[0], "dec-r", "A\nB", d, { userId: "u", now: "x", today: "y" }).tasks.map((t) => r(t.id, t.patch));
  assert.deepEqual(retentionInvoice(project, stages[0], d, opts("")), { error: "reserves_open" });
  assert.equal(reservesOf("Conception", d)?.lifted, false);
  d.tasks = d.tasks.map((t) => r(t.id, { ...t.data, status: "done" }));
  const s = reservesOf("Conception", d)!;
  assert.deepEqual([s.done, s.total, s.lifted, s.retained], [2, 2, true, 485_000]);
  const ret = retentionInvoice(project, stages[0], d, opts(""));
  assert.ok(!("error" in ret));
  assert.equal(ret.id, "fa-retenue-Conception-1");
  assert.equal(ret.amount, 485_000);
  assert.deepEqual((ret.patch.lines as { unitPrice: number; vatRate: number }[]).map((l) => [l.unitPrice, l.vatRate]), [[485_000, 18]]);
  assert.match(String((ret.patch.lines as { label: string }[])[0].label), /^Solde après levée des réserves : étape Conception, retenue de 5 % \(facture FA-2026-00187\)/);
  assert.equal(ret.patch.origin, "retention");
  assert.equal(ret.patch.decision_id, "dec-r");
  d.invoices!.push(r(ret.id, ret.patch));
  assert.deepEqual(retentionInvoice(project, stages[0], d, opts("")), { error: "already_invoiced" });
  // Bloc « À décider » : la retenue apparaît tant qu'elle n'est pas facturée.
  d.invoices!.pop();
  assert.equal(decisionsToMake([project], d, () => true, "2026-11-30", true)[0]?.kind, "retention");
  assert.equal(decisionsToMake([project], d, () => true, "2026-11-30", false).length, 0, "sans montants, pas de retenue");
});

test("CA3.8 et RG6.3 : une seule facture de jalon par étape ; brouillon supprimé recréé sous le même identifiant ; avoir total → n + 1", () => {
  const stages = [stage("S", 1, 50), stage("T", 2, 50)];
  const d: BillingData = { quotes: [quote("dv-1", [{ qty: 1, unitPrice: 1_000_000, vatRate: 18 }])], project_stages: stages, project_decisions: [approve("dec-1", "S", "2026-11-24T10:00:00Z")], invoices: [], credit_notes: [] };
  const p = plan(stageInvoice(project, stages[0], d, opts("dec-1")));
  d.invoices = [asInvoice(p)];
  assert.deepEqual(stageInvoice(project, stages[0], d, opts("dec-1")), { error: "already_invoiced" });
  d.invoices = [asInvoice(p, { _deleted: true })];
  const again = plan(stageInvoice(project, stages[0], d, opts("dec-1")));
  assert.equal(again.id, p.id, "même identifiant : pas de doublon");
  assert.equal(again.patch._deleted, false);
  // Facture validée puis annulée par un avoir total : nouvelle facture n° 2.
  const validated = asInvoice(p, { status: "validated", number: "FA-2026-00001" });
  d.invoices = [validated];
  d.credit_notes = [r("av-1", { status: "validated", invoice_id: p.id, lines: [{ label: "Annulation", qty: 1, unitPrice: 500_000, vatRate: 18 }] })];
  assert.equal(cancelledByCredit(validated, d.credit_notes), true);
  assert.equal(invoiceOfStage("S", "stage", d), null);
  assert.equal(plan(stageInvoice(project, stages[0], d, opts("dec-1"))).id, "fa-jalon-S-2");
});

test("Pas de facture : projet au temps passé, étape sans part, projet sans client, vendu inconnu, étape précédente non validée", () => {
  const stages = [stage("S", 1, 50), stage("T", 2, 50)];
  const d: BillingData = { quotes: [quote("dv-1", [{ qty: 1, unitPrice: 1_000_000, vatRate: 18 }])], project_stages: stages, project_decisions: [] };
  assert.deepEqual(stageInvoice({ ...project, data: { ...project.data, billing: "time" } }, stages[0], d, opts("x")), { error: "time_billing" });
  assert.deepEqual(stageInvoice(project, stage("Z", 3, 0), d, opts("x")), { error: "no_share" });
  assert.deepEqual(stageInvoice({ ...project, data: { ...project.data, client_id: "" } }, stages[0], d, opts("x")), { error: "no_client" });
  assert.deepEqual(stageInvoice(project, stages[0], { ...d, quotes: [] }, opts("x")), { error: "no_sold" });
  assert.deepEqual(stageInvoice(project, stages[1], d, opts("x")), { error: "previous_not_validated" });
  // Sans devis : montant vendu saisi à la main, au taux de TVA par défaut.
  const manual = plan(stageInvoice({ ...project, data: { ...project.data, quote_id: "" } }, stages[0], { ...d, quotes: [], project_finance: [r("fin-prj-1", { sold_manual: 2_000_000 })] }, opts("x")));
  assert.equal(manual.M, 1_000_000);
  assert.match(String((manual.patch.lines as { label: string }[])[0].label), /du montant vendu/);
});

// ---- Règles serveur : journal immuable, première validation, ordre, droits, délégation ----

const director = { userId: "u-jimmy", role: "director" };
const pm = { userId: "u-ornella", role: "project_manager" };
const sales = { userId: "u-awa", role: "sales" };
const emp = { userId: "u-junior", role: "employee" };
const member = (uid: string, role: string) => rec("project_members", `pm-prj-1-tm-${uid}`, { project_id: "prj-1", user_id: uid, team_member_id: `tm-${uid}`, role });
const ctxOf = (o: { members?: SyncRecord[]; delegate?: boolean; stages?: SyncRecord[]; decisions?: SyncRecord[] } = {}): ProjectContext => {
  const prj = rec("projects", "prj-1", { name: "P", manager_can_validate: o.delegate === true });
  return {
    project: (pid) => (pid === "prj-1" ? prj : null),
    rolesIn: (pid, uid) => (o.members ?? []).filter((m) => m.data.project_id === pid && m.data.user_id === uid).map((m) => String(m.data.role)),
    stages: (pid) => (o.stages ?? []).filter((s) => s.data.project_id === pid),
    decisions: (pid) => (o.decisions ?? []).filter((s) => s.data.project_id === pid),
  };
};
const sStages = [rec("project_stages", "stg-1", { project_id: "prj-1", name: "Démarrage", rank: 1, kind: "start" }), rec("project_stages", "stg-2", { project_id: "prj-1", name: "Réalisation", rank: 2 })];
const decision = (who: { userId: string }, stageId: string, kind = "stage_approved", extra: Record<string, unknown> = {}) =>
  ({ project_id: "prj-1", stage_id: stageId, kind, decided_by: who.userId, decided_by_name: "X", decided_at: "2026-11-24T10:00:00Z", ...extra });

test("R1 : une décision enregistrée ne se modifie ni ne se supprime ; contenu obligatoire selon la nature", () => {
  const existing = rec("project_decisions", "dec-1", decision(director, "stg-1"));
  assert.match(checkChange(existing, change("project_decisions", "dec-1", { comment: "corrigé" }))!, /déjà enregistrée et ne peut plus être modifiée/);
  assert.match(checkChange(existing, change("project_decisions", "dec-1", { _deleted: true }))!, /ne peut plus être modifiée/);
  assert.equal(checkChange(null, change("project_decisions", "dec-2", decision(director, "stg-1"))), null);
  assert.match(checkChange(null, change("project_decisions", "dec-3", decision(director, "stg-1", "stage_approved_with_reserves")))!, /au moins une réserve/);
  assert.match(checkChange(null, change("project_decisions", "dec-4", decision(director, "stg-1", "project_stopped")))!, /motif/);
  assert.match(checkChange(null, change("project_decisions", "dec-5", decision(director, "stg-1", "project_paused")))!, /motif/);
  assert.match(checkChange(null, change("project_decisions", "dec-6", decision(director, "stg-1", "stage_approved_with_reserves", { reserves: "A", retention_pct: 120 })))!, /retenue/);
  assert.match(checkChange(null, change("project_decisions", "dec-7", { ...decision(director, "stg-1"), kind: "go" }))!, /nature/);
  assert.match(checkChange(null, change("project_decisions", "dec-8", { ...decision(director, ""), stage_id: "" }))!, /étape/);
});

test("R2 : la première validation fait foi (CA3.4) ; une réouverture crée une nouvelle ligne et permet de revalider", () => {
  const first = rec("project_decisions", "dec-a", { ...decision(director, "stg-1"), decided_by_name: "Jimmy Rerambyha", decided_at: "2026-11-24T08:00:00Z" });
  const ctx = ctxOf({ stages: sStages, decisions: [first] });
  const second = checkPermission(director, null, change("project_decisions", "dec-b", decision(director, "stg-1")), "", ctx);
  assert.equal(second, "cette étape est déjà validée par Jimmy Rerambyha le 24/11/2026");
  assert.equal(sentence(second!), "Cette étape est déjà validée par Jimmy Rerambyha le 24/11/2026.");
  const reopened = rec("project_decisions", "dec-c", { ...decision(director, "stg-1", "stage_reopened"), comment: "erreur de métré", decided_at: "2026-11-25T08:00:00Z" });
  const ctx2 = ctxOf({ stages: sStages, decisions: [first, reopened] });
  assert.equal(checkPermission(director, null, change("project_decisions", "dec-d", decision(director, "stg-1")), "", ctx2), null);
  assert.equal(stageState(sStages[0], [], [first, reopened]), "upcoming", "la réouverture annule la validation");
});

test("R3 / CA3.7 : valider Réalisation avant Démarrage est refusé : « Validez d'abord l'étape Démarrage »", () => {
  const ctx = ctxOf({ stages: sStages, decisions: [] });
  const reason = checkPermission(director, null, change("project_decisions", "dec-x", decision(director, "stg-2")), "", ctx);
  assert.equal(sentence(reason!), "Validez d'abord l'étape Démarrage.");
  const stopped = rec("project_decisions", "dec-s", { ...decision(director, "stg-1", "project_stopped"), comment: "abandon" });
  assert.match(approvalBlocker("stg-1", sStages, [stopped])!, /arrêtée/);
  assert.equal(approvalBlocker("stg-2", sStages, [rec("project_decisions", "d", decision(director, "stg-1"))]), null);
});

test("R4 et délégation (Q2, CA3.5) : direction et commanditaire décident ; le responsable du projet seulement si la case est cochée", () => {
  const add = (who: { userId: string }) => change("project_decisions", "dec-1", decision(who, "stg-1"));
  const base = { stages: sStages, members: [member("u-ornella", "manager"), member("u-awa", "sponsor"), member("u-junior", "member")] };
  assert.equal(checkPermission(director, null, add(director), "", ctxOf(base)), null);
  assert.equal(checkPermission(sales, null, add(sales), "", ctxOf(base)), null, "le commanditaire du projet valide");
  assert.equal(checkPermission(pm, null, add(pm), "", ctxOf(base)), "vous ne pouvez pas valider les étapes de ce projet", "responsable sans délégation");
  assert.equal(checkPermission(pm, null, add(pm), "", ctxOf({ ...base, delegate: true })), null, "responsable avec délégation");
  assert.equal(canDecide(pm, "prj-1", ctxOf({ ...base, delegate: true })), true);
  assert.equal(canDecide(pm, "prj-1", ctxOf(base)), false);
  assert.equal(canDecide({ userId: "u-x", role: "project_manager" }, "prj-1", ctxOf({ ...base, delegate: true })), false, "hors du projet");
  assert.match(checkPermission(emp, null, add(emp), "", ctxOf(base))!, /ne pouvez pas faire cette modification|votre rôle/);
  assert.match(checkPermission(director, null, change("project_decisions", "dec-1", decision(pm, "stg-1")), "", ctxOf(base))!, /au nom de la personne qui la prend/);
  // Réouverture : direction seulement.
  const reopen = (who: { userId: string }) => change("project_decisions", "dec-r", { ...decision(who, "stg-1", "stage_reopened"), comment: "motif" });
  assert.equal(checkPermission(director, null, reopen(director), "", ctxOf(base)), null);
  assert.match(checkPermission(sales, null, reopen(sales), "", ctxOf(base))!, /rouvrir/);
  // La case de délégation : direction ou commanditaire du projet.
  const toggle = change("projects", "prj-1", { manager_can_validate: true });
  assert.equal(checkPermission(director, rec("projects", "prj-1", {}), toggle, "", ctxOf(base)), null);
  assert.equal(checkPermission(sales, rec("projects", "prj-1", {}), toggle, "", ctxOf(base)), null);
  assert.match(checkPermission(pm, rec("projects", "prj-1", {}), toggle, "", ctxOf(base))!, /qui valide les étapes/);
});

test("R11 : réserves et facture refusées si leur décision ne l'est pas ; une facture de jalon ne change pas de décision", () => {
  const dec = rec("project_decisions", "dec-ok", decision(director, "stg-1"));
  const ctx = ctxOf({ stages: sStages, decisions: [dec] });
  const res = (decisionId: string) => change("tasks", `tsk-res-${decisionId}-1`, { project_id: "prj-1", stage_id: "stg-2", title: "Joint", kind: "reserve", decision_id: decisionId, status: "todo" });
  assert.equal(checkPermission(director, null, res("dec-ok"), "", ctx), null);
  assert.match(checkPermission(director, null, res("dec-refusee"), "", ctx)!, /n'a pas été enregistrée/);
  const inv = (decisionId: string) => change("invoices", "fa-jalon-stg-1-1", { project_id: "prj-1", stage_id: "stg-1", decision_id: decisionId, status: "draft" });
  assert.equal(checkPermission(director, null, inv("dec-ok"), "", ctx), null);
  const existing = rec("invoices", "fa-jalon-stg-1-1", { project_id: "prj-1", stage_id: "stg-1", decision_id: "dec-ok", status: "draft" });
  assert.equal(checkPermission(director, existing, inv("dec-autre"), "", ctxOf({ stages: sStages, decisions: [dec, rec("project_decisions", "dec-autre", decision(director, "stg-1"))] })), "cette étape a déjà sa facture");
  assert.equal(checkPermission(director, { ...existing, data: { ...existing.data, _deleted: true } }, inv("dec-ok"), "", ctx), null, "brouillon supprimé recréé (CA3.8)");
  assert.match(checkChange(null, change("tasks", "tsk-x", { kind: "bonus" }))!, /nature de tâche/);
});

test("Demander la validation : le responsable de l'étape (même employé) peut seulement poser la demande", () => {
  const owned = rec("project_stages", "stg-2", { project_id: "prj-1", name: "Réalisation", owner_id: "tm-u-junior" });
  const ask = change("project_stages", "stg-2", { review_requested_at: "2026-11-20T17:00:00Z", review_requested_by: "tm-u-junior", review_requested_by_name: "Junior", review_note: "visite mercredi" });
  assert.equal(checkPermission(emp, owned, ask, "", ctxOf()), null);
  assert.match(checkPermission(emp, owned, change("project_stages", "stg-2", { billing_pct: 10 }), "", ctxOf())!, /étapes de ce projet/);
  assert.match(checkPermission(emp, { ...owned, data: { ...owned.data, owner_id: "tm-u-autre" } }, ask, "", ctxOf())!, /étapes de ce projet/);
  assert.equal(stageState(r("stg-2", { review_requested_at: "2026-11-20T17:00:00Z" }), []), "awaiting");
});

test("Employé : il lit le journal (une étape validée) sans retenue ni chiffres", () => {
  assert.equal(canRead(emp, "project_decisions", "u-jimmy"), true);
  assert.equal(canRead(emp, "invoices", "u-jimmy"), false, "aucune facture");
  const out = redactPatch(emp, "project_decisions", { kind: "stage_approved_with_reserves", stage_id: "s", reserves: "A", retention_pct: 5, snapshot: { sold: 18_000_000, progress: 95 } });
  assert.deepEqual(out, { kind: "stage_approved_with_reserves", stage_id: "s", reserves: "A" });
});

test("Statut d'étape : pause et reprise ; prochaine échéance = prochaine validation", () => {
  const s1 = r("s1", { project_id: "prj-1", name: "Démarrage", rank: 1, end_date: "2026-11-02" });
  const s2 = r("s2", { project_id: "prj-1", name: "Conception", rank: 2, end_date: "2026-11-20", review_requested_at: "2026-11-18T10:00:00Z", review_note: "point avec BGFI mardi 24/11" });
  const paused = r("p", { project_id: "prj-1", stage_id: "s2", kind: "project_paused", decided_at: "2026-11-19T10:00:00Z", comment: "financement" });
  assert.equal(stageState(s2, [], [paused]), "paused");
  const resumed = r("q", { project_id: "prj-1", stage_id: "s2", kind: "project_resumed", decided_at: "2026-11-21T10:00:00Z" });
  assert.equal(stageState(s2, [], [paused, resumed]), "upcoming", "demande antérieure à la reprise : à redemander");
  const approved = [r("a", { project_id: "prj-1", stage_id: "s1", kind: "stage_approved", decided_at: "2026-11-02T10:00:00Z" })];
  const info = projectProgress(project, { tasks: [], project_stages: [s1, s2], project_decisions: approved }, "2026-11-22").stages;
  assert.deepEqual(nextDeadline(project, info, "2026-11-22"), { label: "Validation de Conception", date: "", note: "point avec BGFI mardi 24/11" });
  const items = decisionsToMake([project], { project_stages: [s1, s2], project_decisions: approved }, () => true, "2026-11-22", true);
  assert.deepEqual(items.map((i) => [i.kind, i.stage.id, i.days]), [["review", "s2", 4]]);
  assert.equal(decisionsToMake([project], { project_stages: [s1, s2], project_decisions: approved }, () => false, "2026-11-22", true).length, 0, "seulement pour qui peut décider");
});

test("Refus du lot 3 à l'écran : une phrase qui dit le fait, sans renvoyer vers une hiérarchie", () => {
  const base = { stages: sStages, members: [member("u-ornella", "manager")] };
  const existing = rec("project_decisions", "dec-1", decision(director, "stg-1"));
  const reasons = [
    checkChange(existing, change("project_decisions", "dec-1", { comment: "x" })),
    checkChange(null, change("project_decisions", "d", decision(director, "stg-1", "project_stopped"))),
    checkChange(null, change("project_decisions", "d", decision(director, "stg-1", "stage_approved_with_reserves"))),
    checkPermission(pm, null, change("project_decisions", "d", decision(pm, "stg-1")), "", ctxOf(base)),
    checkPermission(pm, null, change("project_decisions", "d", { ...decision(pm, "stg-1", "stage_reopened"), comment: "m" }), "", ctxOf(base)),
    checkPermission(director, null, change("project_decisions", "d", decision(pm, "stg-1")), "", ctxOf(base)),
    checkPermission(director, null, change("project_decisions", "d", decision(director, "stg-2")), "", ctxOf(base)),
    checkPermission(director, null, change("project_decisions", "d", decision(director, "stg-1")), "", ctxOf({ ...base, decisions: [existing] })),
    checkPermission(pm, rec("projects", "prj-1", {}), change("projects", "prj-1", { manager_can_validate: true }), "", ctxOf(base)),
    checkPermission(emp, rec("project_stages", "stg-1", { project_id: "prj-1" }), change("project_stages", "stg-1", { review_requested_at: "x" }), "", ctxOf(base)),
    checkPermission(director, null, change("tasks", "tsk-res-x-1", { project_id: "prj-1", decision_id: "x", title: "t" }), "", ctxOf(base)),
    checkPermission(director, rec("invoices", "fa", { decision_id: "a", project_id: "prj-1" }), change("invoices", "fa", { decision_id: "b", project_id: "prj-1" }), "", ctxOf(base)),
  ];
  for (const reason of reasons) {
    assert.ok(reason, "refus attendu");
    const s = sentence(reason!);
    assert.doesNotMatch(s, /chef de projet|direction|directeur|commanditaire|demandez|votre responsable|responsable verra|un employé|réservée? /i, s);
    assert.match(s, /^[A-ZÀ-Ý].*\.$/, s);
  }
});
