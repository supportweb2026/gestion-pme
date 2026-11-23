import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/shared/csv.ts";
import { DOC_TEMPLATE, historyRows, sheetDate, standardToRows } from "../src/shared/docImport.ts";
import { buildVfImport } from "../src/shared/vosfactures.ts";

test("import standard : dates de tableur", () => {
  assert.equal(sheetDate("23/11/2026"), "23/11/2026");
  assert.equal(sheetDate("3-1-26"), "03/01/2026");
  assert.equal(sheetDate("2026-11-23 10:00"), "23/11/2026");
  assert.equal(sheetDate("46349"), "23/11/2026");
  assert.equal(sheetDate("bientôt"), "");
});

test("import standard : le modèle se reprend tel quel", () => {
  const rows = historyRows(parseCsv(DOC_TEMPLATE));
  const imp = buildVfImport([rows]);
  assert.deepEqual(imp.counts, { clients: 1, invoices: 1, credit_notes: 1, quotes: 1, payments: 1, cancelled: 0 });
  const by = (tbl: string) => imp.records.filter((r) => r.tbl === tbl);
  const inv = by("invoices")[0].data as Record<string, any>;
  assert.equal(inv.number, "F-0001");
  assert.equal(inv.date, "2026-01-20");
  assert.equal(inv.due_date, "2026-02-19");
  assert.equal(inv.subject, "Site internet");
  assert.match(inv.client_ref, /BC 2026-014/);
  assert.equal(inv.lines.length, 2, "deux lignes du même numéro : une seule facture");
  // 1 500 000 + 12 × 15 000 − 10 % = 1 662 000 HT ; TVA 18 % = 299 160.
  assert.deepEqual(inv.lines.map((l: any) => [l.label, l.qty, l.net, l.vat]), [["Création du site", 1, 1_500_000, 270_000], ["Hébergement", 12, 162_000, 29_160]]);
  assert.equal(inv.lines[1].unit, "mois");
  assert.equal(inv.lines[0].description, "Maquette et intégration");
  const pay = by("payments")[0].data as Record<string, any>;
  assert.deepEqual([pay.amount, pay.date, pay.method], [1_961_160, "2026-02-15", "transfer"]);
  const quote = by("quotes")[0].data as Record<string, any>;
  assert.deepEqual([quote.number, quote.status, quote.doc_type, quote.valid_until], ["D-0001", "accepted", "quote", "2026-02-04"]);
  const credit = by("credit_notes")[0].data as Record<string, any>;
  assert.equal(credit.invoice_id, by("invoices")[0].id, "l'avoir est rattaché à sa facture");
  assert.deepEqual(credit.lines.map((l: any) => [l.qty, l.net, l.vat]), [[2, 27_000, 4_860]]);
  assert.equal((by("clients")[0].data as any).city, "Libreville");
  // Relancer avec le même fichier redonne les mêmes identifiants : aucun doublon.
  assert.deepEqual(buildVfImport([historyRows(parseCsv(DOC_TEMPLATE))]).records.map((r) => r.id), imp.records.map((r) => r.id));
});

test("import standard : autres intitulés, colonnes manquantes signalées", () => {
  const sheet = parseCsv("Invoice number,Invoice date,Customer,Item,Qty,Unit price,VAT,Status\nINV-9,2026-03-02,Delta SA,Audit,2,50000,18%,Unpaid\n,,,Rapport,1,20000,0,\n");
  const std = standardToRows(sheet);
  assert.deepEqual(std.missing, []);
  const imp = buildVfImport([std.rows]);
  const inv = imp.records.find((r) => r.tbl === "invoices")!.data as Record<string, any>;
  assert.equal(inv.lines.length, 2, "une ligne sans numéro continue le document précédent");
  assert.deepEqual(inv.lines.map((l: any) => [l.net, l.vat]), [[100_000, 18_000], [20_000, 0]]);
  assert.equal(imp.counts.payments, 0, "« Unpaid » n'est pas un paiement");
  assert.throws(() => historyRows(parseCsv("Nom;Montant\nA;1\n"), "ventes.csv"), /ventes\.csv : colonnes introuvables \(Numéro, Date, Client, Désignation, Prix unitaire HT\)/);
});
