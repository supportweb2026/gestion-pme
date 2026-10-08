import { test } from "node:test";
import assert from "node:assert/strict";
import { projectStats, timeToInvoiceLines } from "../src/shared/projects.ts";
import { checkPermission } from "../src/shared/sync.ts";
import { encodeHlc } from "../src/shared/hlc.ts";

const project = { id: "prj-1", data: { name: "Site web", budget: 2_000_000, hourly_rate: 25_000, cost_rate: 10_000 } };
const data = {
  tasks: [
    { id: "t1", data: { project_id: "prj-1", title: "Maquettes", status: "done", estimate_hours: 10 } },
    { id: "t2", data: { project_id: "prj-1", title: "Développement", status: "doing", estimate_hours: 40, due_date: "2026-10-01" } },
    { id: "t3", data: { project_id: "autre", title: "X", status: "todo" } },
  ],
  time_entries: [
    { id: "h1", data: { project_id: "prj-1", task_id: "t1", hours: 8 } },
    { id: "h2", data: { project_id: "prj-1", task_id: "t2", hours: 12, invoice_id: "fa-1" } },
    { id: "h3", data: { project_id: "prj-1", task_id: "t2", hours: 4.5 } },
    { id: "h4", data: { project_id: "prj-1", hours: 2, billable: false } },
  ],
  expenses: [
    { id: "e1", data: { project_id: "prj-1", amount: 118000, vat_rate: 18, status: "approved" } },
    { id: "e2", data: { project_id: "prj-1", amount: 50000, status: "pending" } },
  ],
  invoices: [
    { id: "fa-1", data: { project_id: "prj-1", status: "validated", lines: [{ label: "Dév", qty: 12, unitPrice: 25000, vatRate: 18 }] } },
    { id: "fa-eur", data: { project_id: "prj-1", status: "validated", currency: "EUR", rate: 655.957, lines: [{ label: "Hébergement", qty: 1, unitPrice: 100, vatRate: 0 }] } },
  ],
  credit_notes: [],
};

test("Projet : avancement, heures, coûts, facturé, marge, budget", () => {
  const s = projectStats(project, data, "2026-10-08");
  assert.equal(s.tasks, 2);
  assert.equal(s.progress, 50);
  assert.equal(s.hours, 26.5);
  assert.equal(s.timeCost, 265000);
  assert.equal(s.expenses, 100000, "dépense HT validée seulement");
  assert.equal(s.invoiced, 300000 + 65596, "facture en euros convertie en FCFA");
  assert.equal(s.margin, 365596 - 365000);
  assert.equal(s.budgetUsed, 18);
  assert.equal(s.unbilledHours, 12.5);
  assert.equal(s.overdueTasks, 1);
});

test("Facturation du temps : lignes par tâche, temps marqués", () => {
  const { lines, entryIds } = timeToInvoiceLines(project, data.tasks, data.time_entries, 18, new Set(["fa-1"]));
  assert.deepEqual(entryIds.sort(), ["h1", "h3"]);
  assert.deepEqual(lines.map((l) => [l.label, l.qty, l.unitPrice]).sort(), [["Site web · Développement", 4.5, 25000], ["Site web · Maquettes", 8, 25000]]);
});

test("Droits : un employé ne saisit que ses propres temps", () => {
  const c = (patch: Record<string, unknown>) => ({ id: "x1234567", tbl: "time_entries" as const, row: "time-0001", patch, hlc: encodeHlc(1, 0, "A"), device: "A" });
  const emp = { userId: "u-emp", role: "employee" };
  assert.equal(checkPermission(emp, null, c({ hours: 2, user_id: "u-emp" })), null);
  assert.ok(checkPermission(emp, null, c({ hours: 2, user_id: "u-autre" })));
  assert.ok(checkPermission(emp, null, { ...c({ name: "X" }), tbl: "projects" }));
});

test("Un temps rattaché à une facture supprimée redevient facturable", () => {
  const s = projectStats(project, { ...data, invoices: data.invoices.filter((i) => i.id !== "fa-1") }, "2026-10-08");
  assert.equal(s.unbilledHours, 24.5);
});
