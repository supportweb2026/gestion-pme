import test from "node:test";
import assert from "node:assert/strict";
import { addMonths, describe, dueOccurrences, isFinished, nextAfter, occurrenceId, recurrenceOf, type Recurrence } from "../src/shared/recurrence.ts";
import { checkChange, type Change } from "../src/shared/sync.ts";

const monthly: Recurrence = { freq: "monthly", day: 31, until: "", active: true };

test("récurrence : fin de mois respectée, y compris février et années bissextiles", () => {
  assert.equal(addMonths("2026-01-31", 1, 31), "2026-02-28");
  assert.equal(addMonths("2028-01-31", 1, 31), "2028-02-29");
  assert.equal(nextAfter(monthly, "2026-02-28"), "2026-03-31");
  assert.equal(addMonths("2026-11-15", 3, 15), "2027-02-15");
  assert.equal(nextAfter({ freq: "yearly", day: 5 }, "2026-12-05"), "2027-12-05");
});

test("récurrence : échéances à préparer, rattrapage borné, fin de série", () => {
  const r = { ...monthly, day: 5 };
  assert.deepEqual(dueOccurrences(r, "2026-12-05", "2026-11-22"), { dates: [], next: "2026-12-05" });
  assert.deepEqual(dueOccurrences(r, "2026-09-05", "2026-11-22"), { dates: ["2026-09-05", "2026-10-05", "2026-11-05"], next: "2026-12-05" });
  assert.equal(dueOccurrences(r, "2020-01-05", "2026-11-22").dates.length, 12, "au plus 12 brouillons d'un coup");
  const ended = { ...r, until: "2026-10-31" };
  assert.deepEqual(dueOccurrences(ended, "2026-09-05", "2026-11-22").dates, ["2026-09-05", "2026-10-05"]);
  assert.equal(isFinished(ended, "2026-11-05"), true);
  assert.deepEqual(dueOccurrences({ ...r, active: false }, "2026-09-05", "2026-11-22").dates, []);
});

test("récurrence : lecture du réglage, identifiant stable, résumé", () => {
  assert.equal(recurrenceOf({}), null);
  assert.equal(recurrenceOf({ recurrence: { freq: "weekly" } }), null);
  assert.deepEqual(recurrenceOf({ recurrence: { freq: "quarterly", day: 10 } }), { freq: "quarterly", day: 10, until: "", active: true });
  assert.equal(occurrenceId("fa-abc", "2026-12-05"), "fa-abc-rec-2026-12-05");
  assert.equal(describe(monthly), "chaque mois, en fin de mois");
  assert.equal(describe({ ...monthly, freq: "quarterly", day: 1 }), "chaque trimestre, le 1er");
});

test("récurrence : réglable sur une facture validée, sans toucher à son contenu", () => {
  const existing = { tbl: "invoices" as const, id: "fa-1", data: { status: "validated", number: "FA-2026-00001", lines: [] }, clocks: {} };
  const change = (patch: Record<string, unknown>): Change => ({ id: "c1", tbl: "invoices", row: "fa-1", patch, hlc: "000001700000000-00000-dev", device: "dev" });
  assert.equal(checkChange(existing, change({ recurrence: { freq: "monthly", day: 5, until: "", active: true }, recurrence_next: "2026-12-05" })), null);
  assert.match(String(checkChange(existing, change({ lines: [] }))), /non modifiable/);
});
