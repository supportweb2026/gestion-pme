import test from "node:test";
import assert from "node:assert/strict";
import { forecast, nextMonthStart, targetProgress } from "../src/shared/treasury.ts";

const inv = (id: string, data: Record<string, unknown>, due: number, grossXaf = due) => ({ rec: { id, data: { status: "validated", ...data } }, due, grossXaf });

test("trésorerie : retards à part, échéances cumulées à 30/60/90 jours", () => {
  const f = forecast({
    today: "2026-11-22",
    invoices: [
      inv("a", { date: "2026-10-01", due_date: "2026-10-31" }, 100_000),
      inv("b", { date: "2026-11-20", due_date: "2026-12-10" }, 50_000),
      inv("c", { date: "2026-11-20", due_date: "2027-01-15" }, 70_000),
      inv("d", { date: "2026-11-20", due_date: "2026-12-01" }, 0),
      { rec: { id: "e", data: { status: "draft", due_date: "2026-12-01" } }, due: 999, grossXaf: 999 },
    ],
    orders: [
      { id: "o1", data: { status: "ordered", date: "2026-11-20", expected_at: "2026-12-05", lines: [{ articleId: "x", label: "x", qty: 2, unitCost: 10_000 }] } },
      { id: "o2", data: { status: "received", date: "2026-11-20", lines: [{ articleId: "x", label: "x", qty: 9, unitCost: 10_000 }] } },
    ],
  });
  assert.equal(f.overdue, 100_000);
  assert.equal(f.overdueCount, 1);
  assert.deepEqual(f.buckets.map((b) => [b.days, b.inflow, b.outflow, b.net]), [[30, 50_000, 20_000, 30_000], [60, 120_000, 20_000, 100_000], [90, 120_000, 20_000, 100_000]]);
});

test("trésorerie : séries récurrentes, encaissées au délai de la facture modèle", () => {
  const f = forecast({
    today: "2026-11-22",
    invoices: [inv("r", { date: "2026-11-05", due_date: "2026-11-15", recurrence: { freq: "monthly", day: 5 }, recurrence_next: "2026-12-05" }, 0, 118_000)],
    orders: [],
  });
  // 05/12 → encaissé le 15/12 ; 05/01 → 15/01 ; 05/02 → 15/02 (au-delà de 90 j : 20/02, inclus).
  assert.deepEqual(f.buckets.map((b) => b.recurring), [118_000, 236_000, 354_000]);
});

test("objectifs : progression et rythme du mois", () => {
  assert.equal(targetProgress(0, 100, "2026-11-15"), null);
  const p = targetProgress(1_000_000, 600_000, "2026-11-15")!;
  assert.equal(p.ratio, 0.6);
  assert.equal(p.elapsed, 0.5);
  assert.equal(p.onTrack, true);
  assert.equal(targetProgress(1_000_000, 300_000, "2026-11-15")!.onTrack, false);
  assert.equal(nextMonthStart("2026-12-22"), "2027-01-01");
});
