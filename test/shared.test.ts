import { test } from "node:test";
import assert from "node:assert/strict";
import { HlcClock, decodeHlc, encodeHlc } from "../src/shared/hlc.ts";
import { applyChange, checkChange, type Change, type SyncRecord } from "../src/shared/sync.ts";
import { computeTotals, formatXaf, formatInvoiceNumber } from "../src/shared/invoice.ts";

test("HLC : strictement croissante même si l'horloge recule", () => {
  let t = 1000;
  const clock = new HlcClock("devA", () => t);
  const a = clock.tick();
  t = 900; // l'horloge du téléphone recule
  const b = clock.tick();
  const c = clock.tick();
  assert.ok(a < b && b < c);
});

test("HLC : un appareil en retard passe devant après avoir observé un autre", () => {
  const ahead = new HlcClock("devA", () => 5000);
  const late = new HlcClock("devB", () => 1000);
  const remote = ahead.tick();
  late.observe(remote);
  assert.ok(late.tick() > remote);
});

test("HLC : encodage et décodage", () => {
  const h = encodeHlc(1728390000123, 7, "dev-1");
  assert.deepEqual(decodeHlc(h), { ms: 1728390000123, counter: 7, deviceId: "dev-1" });
});

const ch = (id: string, hlc: string, patch: Record<string, unknown>, row = "row-0001"): Change => ({
  id, tbl: "clients", row, patch, hlc, device: hlc.split("-")[2],
});

test("Fusion : champ par champ, la dernière écriture gagne", () => {
  const h1 = encodeHlc(100, 0, "A");
  const h2 = encodeHlc(200, 0, "B");
  const h3 = encodeHlc(150, 0, "A");
  let r: SyncRecord | null = null;
  r = applyChange(r, ch("1", h1, { name: "Sodepsi", phone: "01" })).record;
  r = applyChange(r, ch("2", h2, { phone: "02" })).record;
  r = applyChange(r, ch("3", h3, { phone: "03", city: "Libreville" })).record; // plus ancienne pour phone
  assert.deepEqual(r.data, { name: "Sodepsi", phone: "02", city: "Libreville" });
});

test("Fusion : même résultat quel que soit l'ordre d'arrivée, et idempotente", () => {
  const changes = [
    ch("1", encodeHlc(100, 0, "A"), { name: "X", phone: "1" }),
    ch("2", encodeHlc(300, 0, "B"), { name: "Y" }),
    ch("3", encodeHlc(200, 0, "C"), { phone: "3", name: "Z" }),
  ];
  const run = (order: Change[]) => order.reduce<SyncRecord | null>((r, c) => applyChange(r, c).record, null)!.data;
  const expected = run(changes);
  assert.deepEqual(run([...changes].reverse()), expected);
  assert.deepEqual(run([changes[1], changes[0], changes[2], changes[1], changes[0]]), expected);
  assert.deepEqual(expected, { name: "Y", phone: "3" });
});

test("Règles : facture validée figée, sauf paiement", () => {
  const validated: SyncRecord = {
    tbl: "invoices", id: "inv-0001", data: { status: "validated", number: "FA-2026-00001", lines: [] }, clocks: {},
  };
  const edit: Change = { id: "e", tbl: "invoices", row: "inv-0001", patch: { lines: [] }, hlc: encodeHlc(1, 0, "A"), device: "A" };
  assert.match(checkChange(validated, edit) ?? "", /avoir/);
  const pay: Change = { ...edit, patch: { paid_amount: 1000, payment_status: "partial" } };
  assert.equal(checkChange(validated, pay), null);
});

test("Règles : une validation exige un numéro", () => {
  const c: Change = { id: "v", tbl: "invoices", row: "inv-0001", patch: { status: "validated" }, hlc: encodeHlc(1, 0, "A"), device: "A" };
  assert.match(checkChange(null, c) ?? "", /numéro/);
  assert.equal(checkChange(null, { ...c, patch: { status: "validated", number: "FA-2026-00003" } }), null);
});

test("Règles : table et horodatage invalides refusés", () => {
  const c = ch("1", encodeHlc(1, 0, "A"), { a: 1 });
  assert.ok(checkChange(null, { ...c, tbl: "users" as never }));
  assert.ok(checkChange(null, { ...c, hlc: "n'importe quoi" }));
});

test("Facture : totaux HT, TVA 18 %, TTC en FCFA", () => {
  const t = computeTotals([
    { label: "Prestation", qty: 2, unitPrice: 150000, vatRate: 18 },
    { label: "Déplacement", qty: 1, unitPrice: 25000, vatRate: 18 },
  ]);
  assert.deepEqual(t, { net: 325000, vat: 58500, gross: 383500 });
  assert.equal(formatXaf(1250000), "1 250 000 FCFA");
  assert.equal(formatInvoiceNumber("FA-2026", 42), "FA-2026-00042");
});

import { amountInWords, invoiceBalance, addDays } from "../src/shared/invoice.ts";

test("Montant en lettres", () => {
  const cases: [number, string][] = [
    [0, "zéro"], [21, "vingt et un"], [71, "soixante et onze"], [80, "quatre-vingts"],
    [81, "quatre-vingt-un"], [99, "quatre-vingt-dix-neuf"], [200, "deux cents"], [201, "deux cent un"],
    [1000, "mille"], [80000, "quatre-vingt mille"], [200000, "deux cent mille"],
    [354000, "trois cent cinquante-quatre mille"], [1250000, "un million deux cent cinquante mille"],
    [2000000, "deux millions"], [17_591_311, "dix-sept millions cinq cent quatre-vingt-onze mille trois cent onze"],
  ];
  for (const [n, words] of cases) assert.equal(amountInWords(n), words, String(n));
});

test("Solde de facture : encaissements multiples et avoirs", () => {
  assert.deepEqual(invoiceBalance(354000, [100000, 54000], [200000]), { gross: 354000, paid: 154000, credited: 200000, due: 0, status: "paid" });
  assert.equal(invoiceBalance(354000, [100000], []).status, "partial");
  assert.equal(invoiceBalance(354000, [], []).due, 354000);
  assert.equal(addDays("2026-10-08", 30), "2026-11-07");
});

test("Règles : devis envoyé figé sauf statut, avoir numéroté dans sa série", () => {
  const sent: SyncRecord = { tbl: "quotes", id: "quote-1", data: { status: "sent", number: "DV-2026-00001", lines: [] }, clocks: {} };
  const base = { id: "x", tbl: "quotes" as const, row: "quote-1", hlc: encodeHlc(1, 0, "A"), device: "A" };
  assert.equal(checkChange(sent, { ...base, patch: { status: "accepted" } }), null);
  assert.ok(checkChange(sent, { ...base, patch: { lines: [] } }));
  const cn = { ...base, tbl: "credit_notes" as const, row: "credit-1" };
  assert.ok(checkChange(null, { ...cn, patch: { status: "validated", number: "FA-2026-00001" } }));
  assert.equal(checkChange(null, { ...cn, patch: { status: "validated", number: "AV-2026-00001" } }), null);
  assert.ok(checkChange(null, { ...cn, patch: { number: "AV-2026-00002" } }));
});
