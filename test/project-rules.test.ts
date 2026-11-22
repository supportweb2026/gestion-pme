import { test } from "node:test";
import assert from "node:assert/strict";
import { canRead, checkChange, checkPermission, type Change, type SyncRecord } from "../src/shared/sync.ts";
import { encodeHlc } from "../src/shared/hlc.ts";
import { canCloseTask, redactPatch, redactRecord, type ProjectContext } from "../src/shared/projectRules.ts";
import { averageCost, checkDayHours, chronoRounding, hoursOn, hoursWeek, isoWeek, matchTeamMember, myDay, teamSync } from "../src/shared/projectControl.ts";
import { entryCostRate, financeOf, projectStats } from "../src/shared/projects.ts";
import { sentence } from "../src/web/local/guard.ts";

const NOW = Date.parse("2026-11-23T09:00:00Z");
const change = (tbl: Change["tbl"], row: string, patch: Record<string, unknown>, ms = NOW): Change => ({ id: "op-12345678", tbl, row, patch, hlc: encodeHlc(ms, 0, "dev-a"), device: "dev-a" });
const rec = (tbl: SyncRecord["tbl"], id: string, data: Record<string, unknown>): SyncRecord => ({ tbl, id, data, clocks: {} });

const emp = { userId: "u-junior", role: "employee" };
const pm = { userId: "u-ornella", role: "project_manager" };
const director = { userId: "u-jimmy", role: "director" };

const ctx = (members: SyncRecord[] = [], projects: SyncRecord[] = []): ProjectContext => ({
  project: (pid) => projects.find((p) => p.id === pid) ?? null,
  rolesIn: (pid, uid) => members.filter((m) => m.data.project_id === pid && m.data.user_id === uid && !m.data._deleted).map((m) => String(m.data.role)),
});

test("R6 : identifiants déterministes vérifiés (tm-, cr-, fin-, pm-)", () => {
  assert.equal(checkChange(null, change("team_members", "tm-u-junior", { user_id: "u-junior", name: "Junior" })), null);
  assert.match(checkChange(null, change("team_members", "tm-autre", { user_id: "u-junior", name: "Junior" }))!, /identifiant/);
  assert.equal(checkChange(null, change("team_members", "tm-sans-compte-1", { name: "Steeve" })), null, "personne sans compte");
  assert.match(checkChange(null, change("team_members", "tm-x", { name: " " }))!, /nom/);
  assert.equal(checkChange(null, change("cost_rates", "cr-tm-u-junior", { team_member_id: "tm-u-junior", hourly_cost: 3500 })), null);
  assert.equal(checkChange(null, change("cost_rates", "cr-company", { hourly_cost: 4000 })), null);
  assert.match(checkChange(null, change("cost_rates", "cr-tm-a", { team_member_id: "tm-b", hourly_cost: 1 }))!, /identifiant/);
  assert.match(checkChange(null, change("cost_rates", "cr-company", { hourly_cost: -5 }))!, /coût/);
  assert.equal(checkChange(null, change("project_finance", "fin-prj-1", { project_id: "prj-1", hourly_rate: 25000 })), null);
  assert.match(checkChange(null, change("project_finance", "fin-prj-2", { project_id: "prj-1" }))!, /identifiant/);
  assert.match(checkChange(null, change("project_finance", "fin-prj-1", { project_id: "prj-1", legacy_budget: 12.5 }))!, /montant/);
  const pmRow = "pm-prj-1-tm-u-junior";
  assert.equal(checkChange(null, change("project_members", pmRow, { project_id: "prj-1", team_member_id: "tm-u-junior", role: "member", name: "Junior" })), null);
  assert.match(checkChange(null, change("project_members", pmRow, { project_id: "prj-1", team_member_id: "tm-u-junior", role: "boss" }))!, /rôle/);
  // Identifiant long (uuid) accepté : pm-{projet}-tm-{uuid} dépasse 64 caractères.
  const long = `pm-prj-abcdefghijabcdefghij-tm-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`;
  assert.ok(long.length > 64);
  assert.equal(checkChange(null, change("project_members", long, { project_id: "prj-abcdefghijabcdefghij", team_member_id: `tm-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`, role: "member" })), null);
});

test("R5 : project_id et compte lié non modifiables une fois posés", () => {
  const fin = rec("project_finance", "fin-prj-1", { project_id: "prj-1" });
  assert.match(checkChange(fin, change("project_finance", "fin-prj-1", { project_id: "prj-2" }))!, /projet/);
  const tm = rec("team_members", "tm-u-1", { user_id: "u-1", name: "A" });
  assert.match(checkChange(tm, change("team_members", "tm-u-1", { user_id: "u-2" }))!, /compte lié/);
  assert.equal(checkChange(tm, change("team_members", "tm-u-1", { job: "Électricien" })), null);
});

test("R13 : énumérations et bornes des tâches et des temps", () => {
  assert.match(checkChange(null, change("tasks", "tsk-1", { status: "fini" }))!, /statut/);
  assert.match(checkChange(null, change("tasks", "tsk-1", { blocked: true, blocked_reason: "pluie" }))!, /motif/);
  assert.equal(checkChange(null, change("tasks", "tsk-1", { blocked: true, blocked_reason: "material" })), null);
  assert.match(checkChange(null, change("tasks", "tsk-1", { assignee_id: "Paul" }))!, /introuvable dans l'annuaire/);
  assert.match(checkChange(null, change("time_entries", "tmp-1", { hours: 25 }))!, /24 h/);
  assert.match(checkChange(null, change("time_entries", "tmp-1", { hours: 0 }))!, /24 h/);
});

test("Annuaire et coûts : écriture réservée à la direction ; équipe du projet au responsable", () => {
  const c = change("team_members", "tm-x", { name: "X" });
  assert.equal(checkPermission(director, null, c), null);
  assert.match(sentence(checkPermission(pm, null, c)!), /^Vous ne pouvez pas (faire cette modification|modifier l'annuaire)\.$/);
  assert.match(checkPermission({ userId: "u-c", role: "accountant" }, null, change("cost_rates", "cr-company", { hourly_cost: 1 }))!, /coûts horaires/);
  const m = change("project_members", "pm-prj-1-tm-x", { project_id: "prj-1", team_member_id: "tm-x", role: "member" });
  assert.equal(checkPermission(pm, null, m), null);
  assert.ok(checkPermission(emp, null, m), "un employé ne compose pas l'équipe");
  assert.match(checkPermission({ userId: "u-c", role: "accountant" }, null, m)!, /vous ne pouvez pas modifier l'équipe de ce projet/);
  assert.ok(checkPermission(emp, null, change("project_finance", "fin-prj-1", { project_id: "prj-1" })), "un employé n'écrit aucun montant");
  assert.match(checkPermission(pm, null, change("projects", "prj-1", { _deleted: true }))!, /vous ne pouvez pas supprimer ce projet/);
});

test("R9 / CA1.5 : l'employé amène sa tâche jusqu'à À vérifier, seul le responsable la passe à Terminé", () => {
  const task = rec("tasks", "tsk-1", { project_id: "prj-1", title: "Cloisons", status: "review", assignee_id: "tm-u-junior" });
  const toDone = change("tasks", "tsk-1", { status: "done" });
  assert.match(checkPermission(emp, task, toDone, "", ctx())!, /passer cette tâche à Terminé : elle sera close après vérification/);
  assert.equal(checkPermission(emp, task, change("tasks", "tsk-1", { status: "review" }), "", ctx()), null);
  assert.equal(checkPermission(emp, task, change("tasks", "tsk-1", { blocked: true, blocked_reason: "material", blocked_at: "x", blocked_by: "u-junior" }), "", ctx()), null);
  assert.match(checkPermission(emp, task, change("tasks", "tsk-1", { estimate_hours: 2 }), "", ctx())!, /seulement l'avancement et la description/);
  assert.match(checkPermission(emp, task, change("tasks", "tsk-1", { _deleted: true }), "", ctx())!, /vous ne pouvez pas supprimer cette tâche/);
  assert.match(checkPermission(emp, task, change("tasks", "tsk-1", { assignee_id: "tm-u-autre" }), "", ctx())!, /attribuer une tâche seulement à vous-même/);
  assert.equal(checkPermission(emp, null, change("tasks", "tsk-2", { project_id: "prj-1", title: "Nouvelle", status: "todo" }), "", ctx()), null);
  assert.match(checkPermission(emp, null, change("tasks", "tsk-3", { project_id: "prj-1", title: "N", status: "done" }), "", ctx())!, /Terminé/);
  // Le chef de projet (rôle Gestia ou chef désigné dans l'équipe) contrôle.
  assert.equal(checkPermission(pm, task, toDone, "", ctx()), null);
  assert.equal(checkPermission(director, task, toDone), null);
  const lead = rec("project_members", "pm-prj-1-tm-u-junior", { project_id: "prj-1", user_id: "u-junior", role: "manager" });
  assert.equal(checkPermission(emp, task, toDone, "", ctx([lead])), null, "un employé chef de ce projet contrôle ses tâches");
  assert.equal(canCloseTask(emp, "prj-1", ctx([lead])), true);
  assert.equal(canCloseTask(emp, "prj-2", ctx([lead])), false);
});

test("R12 : saisie de temps limitée à 7 jours pour l'employé, refusée sur un projet terminé", () => {
  const entry = (date: string, pid = "prj-1") => change("time_entries", "tmp-1", { project_id: pid, date, hours: 2, user_id: "u-junior" });
  assert.equal(checkPermission(emp, null, entry("2026-11-16")), null);
  assert.match(checkPermission(emp, null, entry("2026-11-15"))!, /7 derniers jours/);
  assert.equal(checkPermission(director, null, entry("2026-10-01")), null, "le chef de projet saisit pour lui au-delà");
  const done = ctx([], [rec("projects", "prj-9", { status: "done" })]);
  assert.match(checkPermission(director, null, entry("2026-11-23", "prj-9"), "", done)!, /ce projet est clôturé : vous ne pouvez plus y saisir de temps/);
});

test("Confidentialité (CA1.4) : montants retirés à l'envoi pour l'employé, historique compris", () => {
  assert.deepEqual(redactPatch(emp, "projects", { name: "BGFI", budget: 1, hourly_rate: 2, cost_rate: 3 }), { name: "BGFI" });
  assert.equal(redactPatch(emp, "projects", { budget: 5_000_000 }), null, "un patch qui ne contenait que des montants n'est pas envoyé");
  assert.deepEqual(redactPatch(pm, "projects", { budget: 1 }), { budget: 1 });
  const r = redactRecord(emp, { tbl: "projects", id: "prj-1", data: { name: "X", budget: 9 }, clocks: { name: "h", budget: "h" } })!;
  assert.deepEqual(r.data, { name: "X" });
  assert.deepEqual(r.clocks, { name: "h" });
  for (const tbl of ["project_finance", "cost_rates", "invoices", "quotes", "clients"]) assert.equal(canRead(emp, tbl, null, "x"), false, tbl);
  for (const tbl of ["team_members", "project_members", "tasks", "projects"]) assert.equal(canRead(emp, tbl, null, "x"), true, tbl);
});

test("Arbitrage 2 : le chef de projet lit le coût moyen, pas le coût de chaque personne", () => {
  assert.equal(canRead(pm, "cost_rates", null, "cr-company"), true);
  assert.equal(canRead(pm, "cost_rates", null, "cr-tm-u-junior"), false);
  assert.equal(canRead({ userId: "s", role: "sales" }, "cost_rates", null, "cr-tm-u-junior"), false);
  assert.equal(canRead(pm, "project_finance", null, "fin-prj-1"), true);
  assert.equal(canRead({ userId: "c", role: "accountant" }, "cost_rates", null, "cr-tm-u-junior"), true);
  assert.equal(canRead(director, "cost_rates", null, "cr-tm-u-junior"), true);
});

test("Reprise : données financières lues dans project_finance, sinon dans les anciens champs", () => {
  const old = { id: "prj-1", data: { budget: 2_000_000, hourly_rate: 25_000, cost_rate: 10_000 } };
  assert.deepEqual(financeOf(old), { budget: 2_000_000, hourlyRate: 25_000, costRate: 10_000, source: "legacy" });
  const fin = [{ id: "fin-prj-1", data: { project_id: "prj-1", legacy_budget: 3_000_000, hourly_rate: 30_000 } }];
  assert.deepEqual(financeOf(old, fin), { budget: 3_000_000, hourlyRate: 30_000, costRate: 10_000, source: "finance" });
  assert.equal(financeOf({ id: "prj-2", data: {} }).source, "none");
  // Coût du temps : personne, puis projet, puis coût moyen.
  const rates = [{ id: "cr-tm-u-1", data: { team_member_id: "tm-u-1", hourly_cost: 4000 } }, { id: "cr-company", data: { hourly_cost: 3000 } }];
  assert.deepEqual(entryCostRate({ id: "h", data: { user_id: "u-1" } }, 10_000, rates), { rate: 4000, source: "person" });
  assert.deepEqual(entryCostRate({ id: "h", data: { user_id: "u-2" } }, 10_000, rates), { rate: 10_000, source: "project" });
  assert.deepEqual(entryCostRate({ id: "h", data: { user_id: "u-2" } }, 0, rates), { rate: 3000, source: "company" });
  assert.deepEqual(entryCostRate({ id: "h", data: { user_id: "u-2" } }, 0, []), { rate: 0, source: "missing" });
  const s = projectStats({ id: "prj-1", data: {} }, {
    tasks: [], expenses: [], invoices: [], credit_notes: [], project_finance: [{ id: "fin-prj-1", data: { cost_rate: 10_000 } }], cost_rates: rates,
    time_entries: [{ id: "a", data: { project_id: "prj-1", hours: 2, user_id: "u-1" } }, { id: "b", data: { project_id: "prj-1", hours: 1, user_id: "u-2" } }],
  }, "2026-11-23");
  assert.equal(s.timeCost, 2 * 4000 + 10_000);
});

test("Annuaire : une fiche tm-{user_id} par compte, sans doublon ; rapprochement par nom", () => {
  const users = [{ id: "u-1", name: "Junior Mintsa", active: 1 }, { id: "u-2", name: "Paul", active: 0 }];
  const first = teamSync(users, [], "u-admin", "2026-11-23T08:00:00Z");
  assert.deepEqual(first.map((x) => x.id), ["tm-u-1", "tm-u-2"]);
  assert.equal(first[1].patch.active, false);
  const again = teamSync(users, first.map((x) => ({ id: x.id, data: x.patch })), "u-admin", "x");
  assert.deepEqual(again, [], "idempotent");
  const team = [{ id: "tm-1", data: { name: "Paul Ndong" } }, { id: "tm-2", data: { name: "Paul" } }, { id: "tm-3", data: { name: "Paul" } }, { id: "tm-4", data: { name: "Élodie Mba" } }];
  assert.equal(matchTeamMember("paul ndong", team)?.id, "tm-1");
  assert.equal(matchTeamMember("Paul", team), null, "deux « Paul » : rien d'automatique");
  assert.equal(matchTeamMember("ELODIE  MBA", team)?.id, "tm-4", "sans accents ni casse");
  assert.equal(averageCost(team.map((m) => ({ ...m, data: { ...m.data, active: true } })), [
    { id: "cr-tm-1", data: { team_member_id: "tm-1", hourly_cost: 3000 } }, { id: "cr-tm-4", data: { team_member_id: "tm-4", hourly_cost: 5000 } }, { id: "cr-company", data: { hourly_cost: 1 } },
  ]), 4000);
});

test("Ma journée (CA1.1) : mes tâches seulement, en retard d'abord, À valider à part", () => {
  const today = "2026-11-23";
  const projects = [{ id: "prj-1", data: { status: "active" } }, { id: "prj-2", data: { status: "done" } }];
  const t = (id: string, data: Record<string, unknown>) => ({ id, data: { project_id: "prj-1", assignee_id: "tm-u-j", status: "todo", title: id, ...data } });
  const tasks = [
    t("aujourdhui", { due_date: today }),
    t("en-retard", { due_date: "2026-11-22" }),
    t("autre-personne", { assignee_id: "tm-u-x", due_date: "2026-11-01" }),
    t("en-cours", { status: "doing" }),
    t("a-valider", { status: "review" }),
    t("terminee", { status: "done" }),
    t("projet-clos", { project_id: "prj-2" }),
    t("plus-tard", { start_date: "2026-12-01" }),
    t("priorite", { priority_week: isoWeek(today) }),
    t("supprimee", { _deleted: true }),
  ];
  const d = myDay("tm-u-j", { tasks, projects }, today);
  assert.deepEqual(d.today.map((i) => i.task.id), ["priorite", "en-retard", "aujourdhui", "en-cours"]);
  assert.equal(d.today[1].lateDays, 1);
  assert.deepEqual(d.others.map((i) => i.task.id), ["plus-tard"]);
  assert.deepEqual(d.review.map((x) => x.id), ["a-valider"]);
  const many = Array.from({ length: 9 }, (_, i) => t(`t${i}`, { due_date: today }));
  const capped = myDay("tm-u-j", { tasks: many, projects }, today);
  assert.equal(capped.today.length, 7);
  assert.equal(capped.others.length, 2);
  assert.equal(isoWeek("2026-11-23"), "2026-W48");
  assert.equal(isoWeek("2027-01-01"), "2026-W53");
});

test("Heures (CA1.3) : plafond de 24 h par jour, confirmation au-delà de 12 h, chronomètre arrondi", () => {
  const entries = [
    { id: "a", data: { user_id: "u-j", date: "2026-11-23", hours: 12 } },
    { id: "b", data: { user_id: "u-j", date: "2026-11-23", hours: 8 } },
    { id: "c", data: { user_id: "u-j", date: "2026-11-21", hours: 3 } },
    { id: "d", data: { user_id: "u-x", date: "2026-11-23", hours: 5 } },
    { id: "e", data: { user_id: "u-j", date: "2026-11-23", hours: 4, _deleted: true } },
  ];
  assert.equal(hoursOn("u-j", entries, "2026-11-23"), 20);
  assert.equal(hoursWeek("u-j", entries, "2026-11-23"), 20, "la semaine commence le lundi");
  assert.deepEqual(checkDayHours(20, 8), { ok: false, message: "Pas plus de 24 h par jour" });
  assert.deepEqual(checkDayHours(20, 4), { ok: true, confirm: true });
  assert.deepEqual(checkDayHours(2, 2), { ok: true, confirm: false });
  const r = chronoRounding((3 * 60 + 40) * 60_000);
  assert.deepEqual([r.down, r.up], [3.5, 4]);
  assert.deepEqual([chronoRounding(5 * 60_000).down, chronoRounding(5 * 60_000).up], [0.5, 0.5]);
});

test("Messages de refus à l'écran : une phrase qui dit le fait, sans renvoyer vers un rôle", () => {
  assert.equal(sentence("votre rôle ne permet pas cette modification"), "Vous ne pouvez pas faire cette modification.");
  assert.equal(sentence("un employé ne saisit que ses propres temps"), "Vous pouvez saisir ou supprimer seulement votre propre temps.");
  assert.equal(sentence("pas plus de 24 h par jour"), "Pas plus de 24 h par jour.");
  const task = rec("tasks", "tsk-1", { project_id: "prj-1", title: "Cloisons", status: "review", assignee_id: "tm-u-junior" });
  const emp = { userId: "u-junior", role: "employee" };
  const reasons = [
    checkPermission(emp, task, change("tasks", "tsk-1", { status: "done" })),
    checkPermission(emp, task, change("tasks", "tsk-1", { estimate_hours: 2 })),
    checkPermission(emp, null, change("project_members", "pm-prj-1-tm-x", { project_id: "prj-1", team_member_id: "tm-x", role: "member" })),
    checkPermission({ userId: "u-p", role: "project_manager" }, null, change("projects", "prj-1", { _deleted: true })),
  ];
  for (const r of reasons) {
    assert.ok(r, "refus attendu");
    assert.doesNotMatch(sentence(r), /chef de projet|direction|demandez|responsable verra|un employé/i, r);
  }
});
