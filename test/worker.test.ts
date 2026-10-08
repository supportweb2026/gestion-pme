import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import worker from "../src/worker/index.ts";
import { createLocalD1 } from "../dev/d1-local.ts";
import { HlcClock } from "../src/shared/hlc.ts";
import type { Change, SyncResponse } from "../src/shared/sync.ts";

const env = { DB: createLocalD1(":memory:", join(import.meta.dirname, "..", "migrations")), FILES: createLocalD1(":memory:"), JWT_SECRET: "test-secret-0123456789-0123456789-abc" };

async function call(path: string, body?: unknown, token?: string) {
  const res = await worker.fetch(
    new Request(`http://local${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, data: (await res.json()) as any };
}

const DEV_A = "device-aaaa-0001";
const DEV_B = "device-bbbb-0002";
let tokenA = "";
let tokenB = "";
const clockA = new HlcClock(DEV_A);
const clockB = new HlcClock(DEV_B);
const change = (clock: HlcClock, tbl: Change["tbl"], row: string, patch: Record<string, unknown>): Change => ({
  id: crypto.randomUUID(), tbl, row, patch, hlc: clock.tick(), device: clock.deviceId,
});

test("installation : création de l'entreprise et de l'administrateur, une seule fois", async () => {
  assert.equal((await call("/api/status")).data.initialized, false);
  const r = await call("/api/setup", { company: "Sodepsi", name: "Johann", email: "admin@sodepsi.ga", password: "motdepasse1", deviceId: DEV_A });
  assert.equal(r.status, 201);
  tokenA = r.data.token;
  const again = await call("/api/setup", { company: "X", name: "Y", email: "x@y.ga", password: "motdepasse1", deviceId: DEV_A });
  assert.equal(again.status, 403);
});

test("connexion : mauvais mot de passe refusé, deuxième appareil accepté", async () => {
  assert.equal((await call("/api/login", { email: "admin@sodepsi.ga", password: "faux-mdp-123", deviceId: DEV_B })).status, 401);
  const r = await call("/api/login", { email: "ADMIN@sodepsi.ga", password: "motdepasse1", deviceId: DEV_B });
  assert.equal(r.status, 200);
  tokenB = r.data.token;
  assert.equal((await call("/api/sync", { changes: [], since: 0 }, "jeton-bidon")).status, 401);
});

test("synchronisation : A envoie, B reçoit ; un renvoi après coupure ne crée pas de doublon", async () => {
  const c1 = change(clockA, "clients", "client-0001", { name: "Total Gabon", city: "Port-Gentil" });
  const push = await call("/api/sync", { changes: [c1], since: 0 }, tokenA);
  assert.deepEqual(push.data.accepted, [c1.id]);
  assert.equal(push.data.changes.length, 0, "A ne reçoit pas ses propres modifications");

  const again = await call("/api/sync", { changes: [c1], since: push.data.cursor }, tokenA);
  assert.deepEqual(again.data.accepted, [c1.id]);

  const pull: SyncResponse = (await call("/api/sync", { changes: [], since: 0 }, tokenB)).data;
  assert.equal(pull.changes.length, 1, "une seule modification malgré le renvoi");
  assert.deepEqual(pull.changes[0].patch, { name: "Total Gabon", city: "Port-Gentil" });
});

test("conflit : deux appareils modifient le même client hors ligne, fusion champ par champ", async () => {
  // Hors ligne, chacun de son côté.
  const a = change(clockA, "clients", "client-0001", { phone: "+241 01 11 11 11" });
  const b1 = change(clockB, "clients", "client-0001", { city: "Libreville" });
  const b2 = change(clockB, "clients", "client-0001", { phone: "+241 02 22 22 22" });
  // B se reconnecte en premier, puis A.
  await call("/api/sync", { changes: [b1, b2], since: 0 }, tokenB);
  await call("/api/sync", { changes: [a], since: 0 }, tokenA);

  const rows = await env.DB.prepare(`SELECT data FROM records WHERE id = 'client-0001'`).all<{ data: string }>();
  const data = JSON.parse(rows.results[0].data);
  assert.equal(data.city, "Libreville");
  assert.equal(data.name, "Total Gabon");
  // Le téléphone retenu est celui de l'écriture la plus récente (horodatage HLC).
  assert.equal(data.phone, a.hlc > b2.hlc ? a.patch.phone : b2.patch.phone);
});

test("factures : numéros par blocs sans chevauchement, facture validée figée", async () => {
  const blockA = (await call("/api/numbers/reserve", { series: "FA-2026" }, tokenA)).data;
  const blockB = (await call("/api/numbers/reserve", { series: "FA-2026" }, tokenB)).data;
  assert.deepEqual([blockA.start, blockA.end, blockB.start, blockB.end], [1, 50, 51, 100]);

  const draft = change(clockA, "invoices", "invoice-0001", { status: "draft", client_id: "client-0001", lines: [{ label: "Audit", qty: 1, unitPrice: 500000, vatRate: 18 }] });
  const validate = change(clockA, "invoices", "invoice-0001", { status: "validated", number: "FA-2026-00001" });
  const r = await call("/api/sync", { changes: [draft, validate], since: 0 }, tokenA);
  assert.equal(r.data.accepted.length, 2);

  // B, resté hors ligne, avait modifié le brouillon : refusé, B reçoit l'état serveur.
  const late = change(clockB, "invoices", "invoice-0001", { lines: [] });
  const r2 = await call("/api/sync", { changes: [late], since: 0 }, tokenB);
  assert.equal(r2.data.rejected.length, 1);
  assert.match(r2.data.rejected[0].reason, /avoir/);
  assert.equal(r2.data.rejected[0].record.data.number, "FA-2026-00001");

  // Le paiement reste possible.
  const pay = change(clockB, "invoices", "invoice-0001", { paid_amount: 590000, payment_status: "paid" });
  assert.equal((await call("/api/sync", { changes: [pay], since: 0 }, tokenB)).data.accepted.length, 1);
});

test("sécurité : un appareil ne peut pas envoyer au nom d'un autre, horloge trop en avance refusée", async () => {
  const spoof = { ...change(clockA, "clients", "client-0002", { name: "X" }) };
  const r = await call("/api/sync", { changes: [spoof], since: 0 }, tokenB);
  assert.match(r.data.rejected[0].reason, /appareil/);
  const future = new HlcClock(DEV_B, () => Date.now() + 3 * 24 * 3600_000);
  const r2 = await call("/api/sync", { changes: [change(future, "clients", "client-0003", { name: "Y" })], since: 0 }, tokenB);
  assert.match(r2.data.rejected[0].reason, /horloge/);
});

test("utilisateurs : l'administrateur crée un commercial, qui ne peut pas créer d'utilisateur", async () => {
  const r = await call("/api/users", { name: "Awa", email: "awa@sodepsi.ga", role: "sales", password: "commercial1" }, tokenA);
  assert.equal(r.status, 201);
  const login = await call("/api/login", { email: "awa@sodepsi.ga", password: "commercial1", deviceId: "device-cccc-0003" });
  const r2 = await call("/api/users", { name: "Z", email: "z@sodepsi.ga", role: "admin", password: "zzzzzzzz1" }, login.data.token);
  assert.equal(r2.status, 403);
});

test("pagination : plus de 500 modifications reçues en plusieurs passes", async () => {
  const batch = (n: number) => Array.from({ length: n }, (_, i) => change(clockA, "tasks", `task-${String(i).padStart(6, "0")}`, { title: `Tâche ${i}` }));
  for (let i = 0; i < 3; i++) await call("/api/sync", { changes: batch(200), since: 0 }, tokenA);
  let since = 0;
  let received = 0;
  let passes = 0;
  for (;;) {
    const r: SyncResponse = (await call("/api/sync", { changes: [], since }, tokenB)).data;
    received += r.changes.filter((c) => c.tbl === "tasks").length;
    since = r.cursor;
    passes++;
    if (!r.more) break;
  }
  assert.equal(received, 600);
  assert.ok(passes >= 2);
});

test("utilisateurs : désactivation par l'administrateur, appareils révoqués aussitôt", async () => {
  const users = (await call("/api/users", undefined, tokenA)).data.users as { id: string; email: string }[];
  const awa = users.find((u) => u.email === "awa@sodepsi.ga")!;
  const login = await call("/api/login", { email: "awa@sodepsi.ga", password: "commercial1", deviceId: "device-dddd-0004" });
  assert.equal((await call("/api/sync", { changes: [], since: 0 }, login.data.token)).status, 200);
  assert.equal((await call("/api/users/update", { id: awa.id, active: false }, tokenA)).status, 200);
  const after = await call("/api/sync", { changes: [], since: 0 }, login.data.token);
  assert.equal(after.status, 401);
  assert.match(after.data.error, /révoqué/);
  assert.equal((await call("/api/login", { email: "awa@sodepsi.ga", password: "commercial1", deviceId: "device-dddd-0004" })).status, 401);
  // Réactivée : elle peut se reconnecter sur le même appareil.
  await call("/api/users/update", { id: awa.id, active: true, role: "accountant" }, tokenA);
  const back = await call("/api/login", { email: "awa@sodepsi.ga", password: "commercial1", deviceId: "device-dddd-0004" });
  assert.equal(back.data.user.role, "accountant");
  assert.equal((await call("/api/sync", { changes: [], since: 0 }, back.data.token)).status, 200);
});

test("droits : un commercial ne passe pas d'écriture comptable, un employé ne valide pas sa dépense", async () => {
  await call("/api/users", { name: "Paul", email: "paul@sodepsi.ga", role: "sales", password: "commercial2" }, tokenA);
  await call("/api/users", { name: "Léa", email: "lea@sodepsi.ga", role: "employee", password: "employee12" }, tokenA);
  const sales = (await call("/api/login", { email: "paul@sodepsi.ga", password: "commercial2", deviceId: "device-eeee-0005" })).data.token;
  const emp = (await call("/api/login", { email: "lea@sodepsi.ga", password: "employee12", deviceId: "device-ffff-0006" })).data.token;
  const salesClock = new HlcClock("device-eeee-0005");
  const empClock = new HlcClock("device-ffff-0006");

  const od = change(salesClock, "journal_entries", "od-000001", { date: "2026-10-01", lines: [] });
  assert.match((await call("/api/sync", { changes: [od], since: 0 }, sales)).data.rejected[0].reason, /rôle|réservées/);

  const selfApproved = change(empClock, "expenses", "dep-000001", { date: "2026-10-01", amount: 5000, status: "approved", created_by: "x" });
  assert.match((await call("/api/sync", { changes: [selfApproved], since: 0 }, emp)).data.rejected[0].reason, /direction/);
  const pending = change(empClock, "expenses", "dep-000002", { date: "2026-10-01", amount: 5000, status: "pending" });
  assert.equal((await call("/api/sync", { changes: [pending], since: 0 }, emp)).data.accepted.length, 1);
  const client = change(empClock, "clients", "client-9999", { name: "X" });
  assert.match((await call("/api/sync", { changes: [client], since: 0 }, emp)).data.rejected[0].reason, /rôle/);
});

test("clôture : plus aucune modification datée dans une période clôturée", async () => {
  const close = change(clockA, "settings", "company", { closed_until: "2026-01-31" });
  assert.equal((await call("/api/sync", { changes: [close], since: 0 }, tokenA)).data.accepted.length, 1);
  const inClosed = change(clockA, "expenses", "dep-closed-1", { date: "2026-01-15", amount: 1000, status: "approved" });
  const r = await call("/api/sync", { changes: [inClosed], since: 0 }, tokenA);
  assert.match(r.data.rejected[0].reason, /clôturée jusqu'au 31\/01\/2026/);
  const open = change(clockA, "expenses", "dep-open-1", { date: "2026-02-01", amount: 1000, status: "approved" });
  assert.equal((await call("/api/sync", { changes: [open], since: 0 }, tokenA)).data.accepted.length, 1);
  // Déplacer une dépense ouverte vers la période clôturée est aussi refusé.
  const move = change(clockA, "expenses", "dep-open-1", { date: "2026-01-20" });
  assert.equal((await call("/api/sync", { changes: [move], since: 0 }, tokenA)).data.rejected.length, 1);
});

test("lecture : chaque rôle ne reçoit que ses données", async () => {
  // Paul (commercial) et Léa (employée) ont été créés plus haut.
  const sales = (await call("/api/login", { email: "paul@sodepsi.ga", password: "commercial2", deviceId: "device-eeee-0005" })).data.token;
  const empLogin = (await call("/api/login", { email: "lea@sodepsi.ga", password: "employee12", deviceId: "device-ffff-0006" })).data;
  const emp = empLogin.token;
  const own = change(new HlcClock("device-ffff-0006"), "expenses", "dep-lea-0001", { date: "2026-10-03", amount: 3000, status: "pending", created_by: empLogin.user.id });
  assert.equal((await call("/api/sync", { changes: [own], since: 0 }, emp)).data.accepted.length, 1);
  const od = change(clockA, "journal_entries", "od-lecture-1", { date: "2026-10-02", label: "Capital", lines: [] });
  const adminExpense = change(clockA, "expenses", "dep-admin-1", { date: "2026-10-02", amount: 7000, status: "approved", created_by: "admin-x" });
  await call("/api/sync", { changes: [od, adminExpense], since: 0 }, tokenA);

  const pull = async (token: string) => {
    const all: Change[] = [];
    let since = 0;
    for (;;) {
      const r: SyncResponse = (await call("/api/sync", { changes: [], since }, token)).data;
      all.push(...r.changes);
      since = r.cursor;
      if (!r.more) return { changes: all, role: r.role };
    }
  };
  const s = await pull(sales);
  assert.equal(s.role, "sales");
  assert.ok(s.changes.some((c) => c.tbl === "clients"));
  assert.ok(!s.changes.some((c) => c.tbl === "journal_entries"), "pas d'écritures comptables");
  assert.ok(!s.changes.some((c) => c.row === "dep-admin-1"), "pas les dépenses des autres");

  const e = await pull(emp);
  const tables = new Set(e.changes.map((c) => c.tbl));
  assert.ok(!tables.has("clients") && !tables.has("invoices") && !tables.has("journal_entries"));
  // Ses propres modifications ne lui reviennent pas (même appareil) : on vérifie depuis un 2e appareil.
  const emp2 = (await call("/api/login", { email: "lea@sodepsi.ga", password: "employee12", deviceId: "device-ffff-0007" })).data.token;
  const e2 = await pull(emp2);
  assert.ok(e2.changes.some((c) => c.row === "dep-lea-0001"), "sa propre dépense");
  assert.ok(!e2.changes.some((c) => c.row === "dep-admin-1"));
  assert.ok(tables.has("tasks"));
});

test("justificatifs : envoi idempotent, lecture limitée à l'entreprise", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
  const put = (token: string, type = "image/jpeg") => worker.fetch(new Request("http://local/api/files/rcpt-00000001", {
    method: "PUT", headers: { "content-type": type, authorization: `Bearer ${token}` }, body: bytes,
  }), env);
  assert.equal((await put(tokenA)).status, 201);
  assert.equal((await put(tokenA)).status, 201, "renvoi sans erreur");
  assert.equal((await put(tokenA, "text/html")).status, 415);
  const get = await worker.fetch(new Request("http://local/api/files/rcpt-00000001", { headers: { authorization: `Bearer ${tokenB}` } }), env);
  assert.equal(get.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(new Uint8Array(await get.arrayBuffer()), bytes);
  const anon = await worker.fetch(new Request("http://local/api/files/rcpt-00000001"), env);
  assert.equal(anon.status, 401);
});
