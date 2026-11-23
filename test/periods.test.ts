import { test } from "node:test";
import assert from "node:assert/strict";
import { inPeriod, periodRange } from "../src/shared/periods.ts";

test("périodes : bornes calculées depuis la date du jour", () => {
  assert.deepEqual(periodRange("month", "2026-02-10"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(periodRange("last_month", "2026-01-15"), { from: "2025-12-01", to: "2025-12-31" });
  assert.deepEqual(periodRange("quarter", "2026-11-23"), { from: "2026-10-01", to: "2026-12-31" });
  assert.deepEqual(periodRange("year", "2026-11-23"), { from: "2026-01-01", to: "2026-12-31" });
  assert.deepEqual(periodRange("last_year", "2026-11-23"), { from: "2025-01-01", to: "2025-12-31" });
  assert.deepEqual(periodRange("all", "2026-11-23"), { from: "", to: "" });
});

test("périodes : dates au choix, bornes ouvertes ou inversées", () => {
  assert.deepEqual(periodRange("custom", "2026-11-23", "2026-03-01", ""), { from: "2026-03-01", to: "" });
  assert.deepEqual(periodRange("custom", "2026-11-23", "2026-05-01", "2026-03-01"), { from: "2026-03-01", to: "2026-05-01" });
  assert.equal(inPeriod("2026-03-15", { from: "2026-03-01", to: "" }), true);
  assert.equal(inPeriod("2026-02-28", { from: "2026-03-01", to: "" }), false);
  assert.equal(inPeriod("2026-03-31T10:00:00Z", { from: "2026-03-01", to: "2026-03-31" }), true);
  assert.equal(inPeriod("", { from: "2026-03-01", to: "" }), false);
  assert.equal(inPeriod("", { from: "", to: "" }), true);
});
