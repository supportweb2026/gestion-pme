import test from "node:test";
import assert from "node:assert/strict";
import { computeTotals, docTaxes, invoiceBalance } from "../src/shared/invoice.ts";
import { CASH_LIMIT_XAF, DEFAULT_VAT_RATES, fiscalMentions, fiscalSettings, newDocTaxFields } from "../src/shared/taxes.ts";
import { generateEntries, isBalanced } from "../src/shared/accounting.ts";

const lines = [
  { label: "Audit", qty: 1, unitPrice: 1_000_000, vatRate: 18 },
  { label: "Export", qty: 1, unitPrice: 200_000, vatRate: 0 },
];

test("fiscalité : sans réglage, ni CSS ni retenue (documents existants inchangés)", () => {
  const t = computeTotals(lines, 0, docTaxes({}));
  assert.deepEqual([t.net, t.vat, t.css, t.gross, t.withholding, t.payable], [1_200_000, 180_000, 0, 1_380_000, 0, 1_380_000]);
});

test("fiscalité : CSS 1 % sur le HT des lignes taxées, hors base de TVA", () => {
  const t = computeTotals(lines, 0, { cssRate: 1 });
  assert.equal(t.css, 10_000, "1 % de 1 000 000 (la ligne à 0 % est exclue)");
  assert.equal(t.vat, 180_000, "la TVA ne porte pas sur la CSS");
  assert.equal(t.gross, 1_390_000);
  assert.equal(computeTotals(lines, 0, { cssRate: 1, cssOnZero: true }).css, 12_000);
});

test("fiscalité : retenue à la source sur le HT, net à payer", () => {
  const t = computeTotals(lines, 0, { cssRate: 1, withholdingRate: 9.5 });
  assert.equal(t.withholding, 114_000);
  assert.equal(t.payable, 1_390_000 - 114_000);
  assert.equal(invoiceBalance(t.payable, [t.payable], []).status, "paid", "payer le net solde la facture");
});

test("fiscalité : réglages par défaut du Gabon et champs figés sur un document", () => {
  const f = fiscalSettings({});
  assert.equal(f.cssEnabled, false);
  assert.equal(f.cssRate, 1);
  assert.deepEqual(f.vatRates, DEFAULT_VAT_RATES);
  assert.ok(f.withholdings.length >= 2);
  assert.deepEqual(newDocTaxFields(f), { css_rate: 0, css_on_zero: false });
  assert.deepEqual(newDocTaxFields(fiscalSettings({ css_enabled: true, css_rate: 1.5 })), { css_rate: 1.5, css_on_zero: false });
  assert.deepEqual(docTaxes({ css_rate: "1", withholding_rate: 150 }), { cssRate: 1, cssOnZero: false, withholdingRate: 100 });
});

test("fiscalité : mentions imprimées", () => {
  const settings = { vat_regime: "debits", late_penalty: "Pénalités : 1,5 % par mois." };
  const m = fiscalMentions({ kind: "invoices", settings, data: { efact_number: "GA-123" }, hasZeroVat: true, payableXaf: CASH_LIMIT_XAF });
  assert.ok(m.includes("TVA acquittée sur les débits."));
  assert.ok(m.some((x) => x.includes("0 %")));
  assert.ok(m.some((x) => x.includes("500 000 FCFA")));
  assert.ok(m.includes("Pénalités : 1,5 % par mois."));
  assert.ok(m.some((x) => x.includes("GA-123")));
  const small = fiscalMentions({ kind: "quotes", settings: {}, data: {}, hasZeroVat: false, payableXaf: 100_000 });
  assert.deepEqual(small, []);
  assert.deepEqual(fiscalMentions({ kind: "quotes", settings: {}, data: {}, hasZeroVat: true, payableXaf: 9e6, delivery: true }), []);
});

test("comptabilité : CSS en 4478, retenue subie en 4492, client au net à payer", () => {
  const entries = generateEntries({
    clients: [{ id: "c1", data: { name: "SEEG" } }], articles: [], credit_notes: [], payments: [], expenses: [], journal_entries: [],
    invoices: [{ id: "f1", data: { status: "validated", number: "FA-2026-00001", date: "2026-11-22", client_id: "c1", css_rate: 1, withholding_rate: 9.5, lines } }],
  });
  const l = entries[0].lines;
  assert.ok(isBalanced(l));
  const by = (a: string) => l.find((x) => x.account === a);
  assert.equal(by("411")?.debit, 1_276_000);
  assert.equal(by("4492")?.debit, 114_000);
  assert.equal(by("4478")?.credit, 10_000);
  assert.equal(by("4431")?.credit, 180_000);
});
