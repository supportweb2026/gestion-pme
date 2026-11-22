import { test } from "node:test";
import assert from "node:assert/strict";
import { allows, API_TABLES, parseScopes } from "../src/shared/apiKeys.ts";

test("portée : tables inconnues, protégées et modes invalides écartés", () => {
  const s = parseScopes({ projects: "rw", tasks: "r", cost_rates: "rw", settings: "r", nope: "rw", invoices: "x" });
  assert.deepEqual(s, { projects: "rw", tasks: "r" });
  assert.deepEqual(parseScopes(null), {});
  assert.ok(!API_TABLES.includes("settings" as never));
});

test("droits : lecture, écriture, tables protégées", () => {
  const s = parseScopes({ projects: "rw", tasks: "r" });
  assert.ok(allows(s, "projects", true));
  assert.ok(allows(s, "tasks", false));
  assert.ok(!allows(s, "tasks", true));
  assert.ok(!allows(s, "invoices", false));
  assert.ok(!allows({ cost_rates: "rw" } as never, "cost_rates", false));
});
