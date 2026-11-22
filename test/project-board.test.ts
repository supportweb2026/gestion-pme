/**
 * Projets, lot 5 : tableau de toutes les tâches (filtres, droits), catégories, discussion
 * (délai de 15 minutes), pièces jointes, historique, archivage, rappels et portefeuille.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { canRead, checkChange, checkPermission, SYNC_TABLES, type Change, type SyncRecord } from "../src/shared/sync.ts";
import { encodeHlc } from "../src/shared/hlc.ts";
import { API_TABLES, API_TABLE_LABELS } from "../src/shared/apiKeys.ts";
import type { ProjectContext } from "../src/shared/projectRules.ts";
import {
  activeFilters, boardOrder, boardTasks, canEditComment, categoryIdFor, categoryName, commentMinutesLeft, commentsOf, deadlineReminders, DEFAULT_TASK_CATEGORIES,
  dueThisWeek, EMPTY_FILTER, withDeadlines, eventLabel, matchesFilter, reminderLabel, taskCategories, taskEventsOf, taskHistory, visibleProjectIds, type BoardFilter,
} from "../src/shared/projectBoard.ts";
import { filterPortfolio, portfolioCsv, portfolioRow, portfolioTotals, sortPortfolio, workingDaysBetween, EMPTY_PORTFOLIO_FILTER } from "../src/shared/portfolio.ts";
import { myDay } from "../src/shared/projectControl.ts";

const T0 = Date.parse("2026-11-23T09:00:00Z");
const MIN = 60_000;
const change = (tbl: Change["tbl"], row: string, patch: Record<string, unknown>, ms = T0): Change => ({ id: "op-12345678", tbl, row, patch, hlc: encodeHlc(ms, 0, "dev-a"), device: "dev-a" });
const rec = (tbl: SyncRecord["tbl"], id: string, data: Record<string, unknown>): SyncRecord => ({ tbl, id, data, clocks: {} });
const r = (id: string, data: Record<string, unknown>) => ({ id, data });

const emp = { userId: "u-junior", role: "employee" };
const pm = { userId: "u-ornella", role: "project_manager" };
const director = { userId: "u-jimmy", role: "director" };
const accountant = { userId: "u-awa", role: "accountant" };

const members = [
  rec("project_members", "pm-prj-1-tm-u-ornella", { project_id: "prj-1", team_member_id: "tm-u-ornella", user_id: "u-ornella", role: "manager" }),
  rec("project_members", "pm-prj-1-tm-u-junior", { project_id: "prj-1", team_member_id: "tm-u-junior", user_id: "u-junior", role: "member" }),
];
const ctx: ProjectContext = {
  project: () => null,
  rolesIn: (pid, uid) => members.filter((m) => m.data.project_id === pid && m.data.user_id === uid).map((m) => String(m.data.role)),
};
const check = (actor: { userId: string; role: string }, existing: SyncRecord | null, c: Change) => checkChange(existing, c) ?? checkPermission(actor, existing, c, "", ctx);

// ---- Catégories ----

test("catégories : cinq par défaut sans aucune écriture, renommer, retirer, ajouter", () => {
  const base = taskCategories([]);
  assert.deepEqual(base.map((c) => c.name), ["Client", "Infra", "Sécurité", "Coûts", "Interne"]);
  assert.equal(DEFAULT_TASK_CATEGORIES.length, 5);
  const edited = taskCategories([
    r("cat-infra", { name: "Infrastructure", rank: 20 }),
    r("cat-interne", { name: "Interne", rank: 50, _deleted: true }),
    r("cat-relances", { name: "Relances", rank: 15 }),
  ]);
  assert.deepEqual(edited.filter((c) => c.active).map((c) => c.name), ["Client", "Relances", "Infrastructure", "Sécurité", "Coûts"]);
  // Une catégorie retirée garde son nom pour les anciennes tâches.
  assert.equal(categoryName("cat-interne", edited), "Interne");
  assert.equal(categoryName("", edited), "");
  assert.equal(categoryName("cat-inconnue", edited), "Catégorie retirée");
  assert.equal(categoryIdFor("Relances clients"), "cat-relances-clients");
  assert.equal(categoryIdFor("Sécurité", ["cat-securite"]), "cat-securite-2");
});

test("catégories : seule la direction modifie la liste ; nom obligatoire ; tâche rangée dans une catégorie", () => {
  const c = change("task_categories", "cat-relances", { name: "Relances", rank: 60 });
  assert.equal(check(director, null, c), null);
  assert.match(check(pm, null, c)!, /rôle/);
  assert.match(check(accountant, null, c)!, /catégories/);
  assert.match(check(emp, null, c)!, /rôle/);
  assert.match(checkChange(null, change("task_categories", "cat-x", { name: "  " }))!, /nom/);
  assert.match(checkChange(null, change("task_categories", "Rouge", { name: "Sécurité" }))!, /identifiant/);
  assert.match(checkChange(null, change("tasks", "tsk-1", { category_id: "rouge" }))!, /catégorie/);
  assert.equal(checkChange(null, change("tasks", "tsk-1", { category_id: "cat-securite" })), null);
  assert.ok(canRead(emp, "task_categories", null));
});

// ---- Filtres et droits du tableau ----

const today = "2026-11-25"; // mercredi
const tasks = [
  r("t1", { project_id: "prj-1", title: "Renouveler le certificat TLS", assignee_id: "tm-u-junior", category_id: "cat-securite", due_date: "2026-11-20", status: "todo" }),
  r("t2", { project_id: "prj-1", title: "Relancer la SEEG", assignee_id: "tm-u-ornella", category_id: "cat-client", due_date: "2026-11-27", status: "doing", blocked: true, blocked_reason: "client" }),
  r("t3", { project_id: "prj-2", title: "Comparer les offres de stockage", category_id: "cat-couts", due_date: "2026-12-10", status: "todo" }),
  r("t4", { project_id: "prj-2", title: "Sauvegardes vérifiées", assignee_id: "tm-u-junior", status: "done", archived: true, due_date: "2026-11-10" }),
  r("t5", { project_id: "prj-1", title: "Ancienne tâche terminée", status: "done", due_date: "2026-11-01" }),
  r("t6", { project_id: "prj-1", title: "Supprimée", _deleted: true }),
];
const f = (x: Partial<BoardFilter>): BoardFilter => ({ ...EMPTY_FILTER, ...x });
const ids = (list: { id: string }[]) => list.map((t) => t.id).sort();

test("filtres : personne, projet, catégorie, échéance, bloquées, archivées, recherche", () => {
  const all = new Set(["prj-1", "prj-2"]);
  assert.deepEqual(ids(boardTasks(tasks, all, EMPTY_FILTER, today)), ["t1", "t2", "t3", "t5"], "archivées et supprimées masquées");
  assert.deepEqual(ids(boardTasks(tasks, all, f({ person: "tm-u-junior" }), today)), ["t1"]);
  assert.deepEqual(ids(boardTasks(tasks, all, f({ person: "none" }), today)), ["t3", "t5"]);
  assert.deepEqual(ids(boardTasks(tasks, all, f({ project: "prj-2" }), today)), ["t3"]);
  assert.deepEqual(ids(boardTasks(tasks, all, f({ category: "cat-client" }), today)), ["t2"]);
  assert.deepEqual(ids(boardTasks(tasks, all, f({ category: "none" }), today)), ["t5"]);
  assert.deepEqual(ids(boardTasks(tasks, all, f({ due: "late" }), today)), ["t1"], "une tâche terminée n'est jamais en retard");
  assert.deepEqual(ids(boardTasks(tasks, all, f({ due: "week" }), today)), ["t2"], "semaine du lundi 23 au dimanche 29");
  assert.deepEqual(ids(boardTasks(tasks, all, f({ blocked: true }), today)), ["t2"]);
  assert.deepEqual(ids(boardTasks(tasks, all, f({ archived: true }), today)), ["t4"]);
  assert.deepEqual(ids(boardTasks(tasks, all, f({ q: "seeg" }), today)), ["t2"]);
  assert.deepEqual(ids(boardTasks(tasks, all, f({ q: "infra" }), today, (id) => (id === "prj-2" ? "IDO – Infra" : ""))), ["t3"], "recherche dans le nom du projet");
  assert.deepEqual(ids(boardTasks(tasks, all, f({ person: "tm-u-junior", due: "late", category: "cat-securite" }), today)), ["t1"], "filtres combinés");
  assert.equal(activeFilters(f({ person: "x", blocked: true, q: "a" })), 3);
  assert.equal(dueThisWeek(tasks[1], today), true);
  assert.equal(matchesFilter(tasks[5], EMPTY_FILTER, today), false);
});

test("droits du tableau : l'employé voit les projets de son équipe, ses tâches et les projets sans équipe", () => {
  const projects = [r("prj-1", { name: "A" }), r("prj-2", { name: "B" }), r("prj-3", { name: "Sans équipe" }), r("prj-4", { name: "Supprimé", _deleted: true })];
  const team = [...members, rec("project_members", "pm-prj-2-tm-u-ornella", { project_id: "prj-2", team_member_id: "tm-u-ornella", user_id: "u-ornella", role: "manager" })];
  assert.deepEqual([...visibleProjectIds("employee", "tm-u-junior", projects, team, [])].sort(), ["prj-1", "prj-3"]);
  // Une tâche qui lui est attribuée ouvre le projet.
  assert.deepEqual([...visibleProjectIds("employee", "tm-u-junior", projects, team, [r("x", { project_id: "prj-2", assignee_id: "tm-u-junior" })])].sort(), ["prj-1", "prj-2", "prj-3"]);
  assert.deepEqual([...visibleProjectIds("director", "tm-u-jimmy", projects, team, [])].sort(), ["prj-1", "prj-2", "prj-3"]);
  assert.deepEqual(ids(boardTasks(tasks, new Set(["prj-1"]), EMPTY_FILTER, today)), ["t1", "t2", "t5"]);
});

test("tri d'une colonne : bloquées, puis en retard, priorité haute, échéance", () => {
  const col = [
    r("a", { title: "a", due_date: "2026-11-30" }),
    r("b", { title: "b", due_date: "2026-11-20" }),
    r("c", { title: "c", blocked: true }),
    r("d", { title: "d", priority: "high", due_date: "2026-12-30" }),
  ].sort((x, y) => boardOrder(x, y, today));
  assert.deepEqual(col.map((t) => t.id), ["c", "b", "d", "a"]);
});

test("archivage : seule une tâche terminée s'archive, et l'employé ne l'archive pas", () => {
  const done = rec("tasks", "tsk-1", { project_id: "prj-1", status: "done" });
  const open = rec("tasks", "tsk-2", { project_id: "prj-1", status: "doing" });
  assert.equal(check(pm, done, change("tasks", "tsk-1", { archived: true, archived_at: "2026-11-23T09:00:00Z" })), null);
  assert.match(check(pm, open, change("tasks", "tsk-2", { archived: true }))!, /terminée/);
  assert.match(check(emp, done, change("tasks", "tsk-1", { archived: true }))!, /seulement l'avancement/);
  const archived = rec("tasks", "tsk-3", { project_id: "prj-1", status: "done", archived: true });
  assert.match(check(pm, archived, change("tasks", "tsk-3", { status: "doing" }))!, /terminée/, "sortir des archives avant de rouvrir");
  assert.equal(check(pm, archived, change("tasks", "tsk-3", { status: "doing", archived: false })), null);
});

// ---- Discussion : droits et délai de 15 minutes ----

const comment = (author: string, createdMs = T0) => rec("task_comments", "cmt-1", { task_id: "t1", project_id: "prj-1", body: "Certificat commandé.", author_id: author, author_name: "Junior", created_at: new Date(createdMs).toISOString() });

test("commentaires : toute personne qui voit la tâche commente, en son nom", () => {
  const patch = { task_id: "t1", project_id: "prj-1", body: "Je m'en occupe demain.", author_id: "u-junior", author_name: "Junior Mintsa", created_at: new Date(T0).toISOString() };
  assert.equal(check(emp, null, change("task_comments", "cmt-1", patch)), null);
  assert.equal(check(accountant, null, change("task_comments", "cmt-2", { ...patch, author_id: "u-awa" })), null);
  assert.equal(check({ userId: "u-sales", role: "sales" }, null, change("task_comments", "cmt-3", { ...patch, author_id: "u-sales" })), null);
  assert.match(check(emp, null, change("task_comments", "cmt-1", { ...patch, author_id: "u-ornella" }))!, /au nom de la personne/);
  assert.match(checkChange(null, change("task_comments", "cmt-1", { ...patch, body: "   " }))!, /écrivez/);
  assert.match(checkChange(null, change("task_comments", "cmt-1", { ...patch, task_id: "" }))!, /aucune tâche/);
  assert.match(checkChange(null, change("task_comments", "cmt-1", { ...patch, body: "x".repeat(4001) }))!, /4000/);
  // Une date de création dans le futur prolongerait le délai : refusée.
  assert.match(check(emp, null, change("task_comments", "cmt-1", { ...patch, created_at: new Date(T0 + 30 * MIN).toISOString() }))!, /date/);
  assert.ok(canRead(emp, "task_comments", "u-ornella"));
});

test("commentaires : l'auteur modifie ou supprime le sien pendant 15 minutes, ensuite il est figé", () => {
  const mine = comment("u-junior");
  assert.equal(check(emp, mine, change("task_comments", "cmt-1", { body: "Certificat commandé chez Gandi.", edited_at: "x" }, T0 + 5 * MIN)), null);
  assert.equal(check(emp, mine, change("task_comments", "cmt-1", { _deleted: true }, T0 + 15 * MIN)), null, "15 minutes pile : encore modifiable");
  assert.match(check(emp, mine, change("task_comments", "cmt-1", { body: "Trop tard" }, T0 + 15 * MIN + 1000))!, /figé/);
  assert.match(check(emp, mine, change("task_comments", "cmt-1", { _deleted: true }, T0 + 60 * MIN))!, /figé/);
  // Personne d'autre, même la direction, ne modifie le commentaire d'un autre.
  assert.match(check(director, mine, change("task_comments", "cmt-1", { body: "Corrigé" }, T0 + MIN))!, /vos propres commentaires/);
  assert.match(check(pm, mine, change("task_comments", "cmt-1", { _deleted: true }, T0 + MIN))!, /vos propres commentaires/);
  // L'auteur et la tâche ne changent pas.
  assert.match(checkChange(mine, change("task_comments", "cmt-1", { author_id: "u-ornella" }))!, /auteur/);
  assert.match(checkChange(mine, change("task_comments", "cmt-1", { task_id: "t2" }))!, /tâche/);
  // Écran : mêmes règles, et le temps restant.
  assert.equal(canEditComment(mine, "u-junior", T0 + 14 * MIN), true);
  assert.equal(canEditComment(mine, "u-junior", T0 + 16 * MIN), false);
  assert.equal(canEditComment(mine, "u-ornella", T0 + MIN), false);
  assert.equal(commentMinutesLeft(mine, T0 + 4 * MIN + 10_000), 11);
  assert.equal(commentMinutesLeft(mine, T0 + 20 * MIN), 0);
  const list = commentsOf("t1", [r("b", { task_id: "t1", created_at: "2026-11-23T10:00:00Z" }), r("a", { task_id: "t1", created_at: "2026-11-23T09:00:00Z" }), r("c", { task_id: "t2", created_at: "2026-11-23T08:00:00Z" }), r("d", { task_id: "t1", created_at: "x", _deleted: true })]);
  assert.deepEqual(list.map((c) => c.id), ["a", "b"]);
});

// ---- Pièces jointes et liens ----

test("pièces jointes : fichier du stockage des justificatifs ou lien https ; retrait par l'auteur ou le responsable", () => {
  const base = { tbl: "tasks", row_id: "t1", project_id: "prj-1", created_by: "u-junior", created_at: "2026-11-23T09:00:00Z" };
  assert.equal(check(emp, null, change("attachments", "att-1", { ...base, kind: "file", file_id: "pj-abcdef123456", label: "capture.png" })), null);
  assert.equal(check(emp, null, change("attachments", "att-2", { ...base, kind: "link", url: "https://github.com/supportweb2026/gestion-pme/pull/22" })), null);
  assert.match(checkChange(null, change("attachments", "att-3", { ...base, kind: "link", url: "javascript:alert(1)" }))!, /https/);
  assert.match(checkChange(null, change("attachments", "att-3", { ...base, kind: "file", file_id: "../x" }))!, /fichier/);
  assert.match(checkChange(null, change("attachments", "att-3", { ...base, tbl: "invoices", kind: "link", url: "https://a.ga" }))!, /aucune tâche/);
  assert.match(check(emp, null, change("attachments", "att-4", { ...base, created_by: "u-ornella", kind: "link", url: "https://a.ga" }))!, /au nom/);
  const att = rec("attachments", "att-2", { ...base, kind: "link", url: "https://a.ga" });
  assert.equal(check(emp, att, change("attachments", "att-2", { _deleted: true })), null, "l'auteur retire");
  assert.equal(check(pm, att, change("attachments", "att-2", { _deleted: true })), null, "le responsable du projet retire");
  assert.match(check({ userId: "u-paul", role: "employee" }, att, change("attachments", "att-2", { _deleted: true }))!, /que vous avez ajoutées/);
  assert.match(checkChange(att, change("attachments", "att-2", { url: "https://b.ga" }))!, /ne change pas/);
});

// ---- Historique ----

test("historique : déplacée, échéance changée, bloquée, débloquée, personne changée, archivée", () => {
  const before = { status: "todo", due_date: "2026-11-20", assignee_id: "tm-u-junior", blocked: false };
  assert.deepEqual(taskEventsOf(null, { status: "todo" }), [], "la création se lit sur la tâche");
  assert.deepEqual(taskEventsOf(before, { status: "doing" }), [{ kind: "moved", from: "todo", to: "doing" }]);
  assert.deepEqual(taskEventsOf(before, { status: "todo", description: "x" }), []);
  assert.deepEqual(taskEventsOf(before, { due_date: "2026-11-27" }), [{ kind: "due_changed", from: "2026-11-20", to: "2026-11-27" }]);
  assert.deepEqual(taskEventsOf(before, { blocked: true, blocked_reason: "client" }), [{ kind: "blocked", from: "", to: "client" }]);
  assert.deepEqual(taskEventsOf({ ...before, blocked: true, blocked_reason: "client" }, { blocked: false, blocked_reason: "" }), [{ kind: "unblocked", from: "client", to: "" }]);
  assert.deepEqual(taskEventsOf(before, { assignee_id: "tm-u-ornella" }), [{ kind: "assigned", from: "tm-u-junior", to: "tm-u-ornella" }]);
  assert.deepEqual(taskEventsOf({ ...before, status: "done" }, { archived: true }), [{ kind: "archived", from: "", to: "" }]);
  assert.equal(taskEventsOf(before, { status: "done", due_date: "", blocked: false }).length, 2);
  const names = (id: string) => ({ "tm-u-junior": "Junior Mintsa", "tm-u-ornella": "Ornella Mba" }[id] ?? id);
  assert.equal(eventLabel({ kind: "moved", from: "todo", to: "review" }, names), "Déplacée de « À faire » vers « À vérifier »");
  assert.equal(eventLabel({ kind: "due_changed", from: "2026-11-20", to: "2026-11-27" }, names), "Échéance changée du 20/11/2026 au 27/11/2026");
  assert.equal(eventLabel({ kind: "due_changed", from: "", to: "2026-11-27" }, names), "Échéance fixée au 27/11/2026");
  assert.equal(eventLabel({ kind: "blocked", from: "", to: "client" }, names), "Bloquée : J'attends le client");
  assert.equal(eventLabel({ kind: "assigned", from: "tm-u-junior", to: "tm-u-ornella" }, names), "Attribuée à Ornella Mba à la place de Junior Mintsa");
  const history = taskHistory(r("t1", { created_at: "2026-11-20T08:00:00Z", created_by: "u-jimmy" }), [
    r("e1", { task_id: "t1", kind: "moved", from: "todo", to: "doing", by: "u-junior", by_name: "Junior Mintsa", at: "2026-11-21T08:00:00Z" }),
    r("e2", { task_id: "t1", kind: "unblocked", from: "client", to: "", by: "u-ornella", at: "2026-11-22T08:00:00Z" }),
    r("e3", { task_id: "t9", kind: "moved", from: "todo", to: "doing", by: "u-x", at: "2026-11-22T09:00:00Z" }),
  ], names, (uid) => (uid === "u-ornella" ? "Ornella Mba" : uid === "u-jimmy" ? "Jimmy" : ""));
  assert.deepEqual(history.map((h) => h.label), ["Débloquée", "Déplacée de « À faire » vers « En cours »", "Tâche créée"]);
  assert.deepEqual(history.map((h) => h.byName), ["Ornella Mba", "Junior Mintsa", "Jimmy"]);
});

test("historique : en ajout seul, au nom de son auteur", () => {
  const ev = { task_id: "t1", project_id: "prj-1", kind: "moved", from: "todo", to: "doing", by: "u-junior", at: "2026-11-23T09:00:00Z" };
  assert.equal(check(emp, null, change("task_events", "tev-1", ev)), null);
  assert.match(check(emp, null, change("task_events", "tev-1", { ...ev, by: "u-ornella" }))!, /au nom/);
  assert.match(checkChange(rec("task_events", "tev-1", ev), change("task_events", "tev-1", { to: "done" }))!, /ne se modifie pas/);
  assert.match(checkChange(null, change("task_events", "tev-2", { ...ev, kind: "renamed" }))!, /nature/);
});

// ---- Rappels des échéances ----

test("rappels : en retard ou due dans les 2 jours, pour la personne responsable seulement", () => {
  const projects = [r("prj-1", { status: "active" }), r("prj-2", { status: "done" })];
  const list = [
    r("late3", { project_id: "prj-1", assignee_id: "tm-j", due_date: "2026-11-22", status: "doing", title: "B" }),
    r("late1", { project_id: "prj-1", assignee_id: "tm-j", due_date: "2026-11-24", status: "todo", title: "A" }),
    r("today", { project_id: "prj-1", assignee_id: "tm-j", due_date: "2026-11-25", status: "todo", title: "C" }),
    r("soon2", { project_id: "prj-1", assignee_id: "tm-j", due_date: "2026-11-27", status: "review", title: "D" }),
    r("soon1", { project_id: "prj-1", assignee_id: "tm-j", due_date: "2026-11-26", status: "todo", title: "E" }),
    r("later", { project_id: "prj-1", assignee_id: "tm-j", due_date: "2026-11-28", status: "todo", title: "F" }),
    r("other", { project_id: "prj-1", assignee_id: "tm-k", due_date: "2026-11-20", status: "todo", title: "G" }),
    r("done", { project_id: "prj-1", assignee_id: "tm-j", due_date: "2026-11-20", status: "done", title: "H" }),
    r("closed", { project_id: "prj-2", assignee_id: "tm-j", due_date: "2026-11-20", status: "todo", title: "I" }),
    r("archived", { project_id: "prj-1", assignee_id: "tm-j", due_date: "2026-11-20", status: "done", archived: true, title: "J" }),
    r("nodate", { project_id: "prj-1", assignee_id: "tm-j", status: "todo", title: "K" }),
  ];
  const rem = deadlineReminders("tm-j", list, projects, today);
  assert.deepEqual(rem.map((x) => x.task.id), ["late3", "late1", "today", "soon1", "soon2"]);
  assert.deepEqual(rem.map((x) => reminderLabel(x)), ["En retard de 3 jours", "En retard d'1 jour", "Échéance aujourd'hui", "Échéance demain", "Échéance dans 2 jours"]);
  // Ma journée : la tâche due dans 2 jours remonte avant les tâches simplement en cours.
  const day = withDeadlines(myDay("tm-j", { tasks: [
    r("doing", { project_id: "prj-1", assignee_id: "tm-j", status: "doing", title: "En cours sans échéance" }),
    r("soon", { project_id: "prj-1", assignee_id: "tm-j", status: "todo", due_date: "2026-11-27", title: "Due après-demain" }),
    r("far", { project_id: "prj-1", assignee_id: "tm-j", status: "todo", due_date: "2026-12-27", title: "Lointaine" }),
    r("arch", { project_id: "prj-1", assignee_id: "tm-j", status: "done", archived: true, title: "Archivée" }),
  ], projects }, today), today);
  assert.deepEqual(day.today.map((i) => `${i.task.id}:${i.soonDays}`), ["soon:2", "doing:0", "far:0"]);
});

// ---- Portefeuille ----

const proj = (id: string, data: Record<string, unknown>) => r(id, { status: "active", start_date: "2026-11-16", ...data });
const empty = { tasks: [] as ReturnType<typeof r>[], time_entries: [], expenses: [], project_stages: [] as ReturnType<typeof r>[], project_decisions: [] };
const names = { client: (id: string) => (id === "cli-1" ? "CNAMGS" : ""), manager: () => ({ id: "tm-u-ornella", name: "Ornella Mba" }) };

test("portefeuille : rouge d'abord, puis orange par date de fin, puis vert (CA5.1)", () => {
  const today2 = "2026-11-22";
  const blocked = (pid: string, n: number, since = "2026-11-21") => Array.from({ length: n }, (_, i) => r(`${pid}-b${i}`, { project_id: pid, title: `B${i}`, status: "todo", blocked: true, blocked_at: `${since}T08:00:00Z` }));
  const d = { ...empty, tasks: [...blocked("red", 3), ...blocked("orange-late", 1), ...blocked("orange-soon", 1), r("g1", { project_id: "green-1", status: "done", kind: "reserve" }), r("g2", { project_id: "green-2", status: "done", kind: "reserve" })] };
  const projects = [
    proj("green-1", { name: "Vert 1", end_date: "2027-03-01" }),
    proj("orange-late", { name: "Orange tardif", end_date: "2027-06-01" }),
    proj("red", { name: "Rouge", end_date: "2027-09-01" }),
    proj("green-2", { name: "Vert 2", end_date: "2027-01-01" }),
    proj("orange-soon", { name: "Orange proche", end_date: "2027-02-01" }),
  ];
  const rows = projects.map((p) => portfolioRow(p, d, today2, names, true));
  assert.deepEqual(rows.map((x) => x.light), ["green", "orange", "red", "green", "orange"]);
  assert.deepEqual(sortPortfolio(rows).map((x) => x.name), ["Rouge", "Orange proche", "Orange tardif", "Vert 2", "Vert 1"]);
  assert.deepEqual(sortPortfolio(rows, "name").map((x) => x.name)[0], "Orange proche");
  assert.equal(rows[2].blockedTasks, 3);
  const totals = portfolioTotals(rows);
  assert.equal(totals.active, 5);
  assert.equal(totals.red, 1);
  assert.equal(totals.orange, 2);
  assert.deepEqual(filterPortfolio(rows, { ...EMPTY_PORTFOLIO_FILTER, light: "orange" }).map((x) => x.project.id).sort(), ["orange-late", "orange-soon"]);
  assert.equal(filterPortfolio(rows, { ...EMPTY_PORTFOLIO_FILTER, q: "rouge" }).length, 1);
});

test("portefeuille : validation en attente en jours ouvrés (CA5.3), export CSV (CA5.4), sans montants pour l'employé", () => {
  assert.equal(workingDaysBetween("2026-11-16", "2026-11-20"), 4, "du lundi au vendredi : 4 jours ouvrés");
  assert.equal(workingDaysBetween("2026-11-20", "2026-11-23"), 1, "vendredi → lundi : le week-end ne compte pas");
  assert.equal(workingDaysBetween("2026-11-20", "2026-11-20"), 0);
  const p = proj("prj-v", { name: "Bureaux; 2e étage", client_id: "cli-1", end_date: "2026-12-31" });
  const d = { ...empty, project_stages: [r("stg-1", { project_id: "prj-v", name: "Démarrage", rank: 1, review_requested_at: "2026-11-16T09:00:00Z" })] };
  const row = portfolioRow(p, d, "2026-11-20", names, true);
  assert.deepEqual(row.validations, { count: 1, days: 4 });
  assert.deepEqual(row.stage, { name: "Démarrage", state: "awaiting" });
  const csv = portfolioCsv([row, portfolioRow(proj("prj-w", { name: "Interne" }), empty, "2026-11-20", names, true)], "2026-11-20");
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 3, "en-tête + une ligne par projet affiché");
  assert.match(lines[0], /^Projet;Client;Responsable du projet;Statut;Météo/);
  assert.match(lines[0], /Marge estimée \(FCFA\)/);
  assert.match(lines[1], /^"Bureaux; 2e étage";CNAMGS;Ornella Mba;En cours;/);
  assert.match(lines[1], /Démarrage \(à valider\)/);
  assert.match(lines[2], /^Interne;Projet interne;/);
  const hidden = portfolioRow(p, d, "2026-11-20", names, false);
  assert.equal(hidden.money, null);
  assert.doesNotMatch(portfolioCsv([hidden], "2026-11-20"), /Marge|Vendu/);
});

// ---- Synchronisation et API ----

test("tables du lot 5 : synchronisées, lisibles et écrites par l'employé, ouvertes à l'API", () => {
  for (const t of ["task_categories", "task_comments", "attachments", "task_events"]) {
    assert.ok((SYNC_TABLES as readonly string[]).includes(t), t);
    assert.ok(canRead(emp, t, null), t);
    assert.ok((API_TABLES as readonly string[]).includes(t), t);
    assert.ok(API_TABLE_LABELS[t], t);
  }
  assert.equal(checkPermission(emp, null, change("task_categories", "cat-x", { name: "X" })), "votre rôle ne permet pas cette modification");
  assert.equal(checkPermission(emp, null, change("task_comments", "cmt-9", { author_id: "u-junior", created_at: new Date(T0).toISOString() })), null);
});
