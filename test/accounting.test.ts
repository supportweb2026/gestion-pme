import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountLedger, balanceSheet, clientBalance, entriesToCsv, generateEntries, incomeStatement, isBalanced, trialBalance, vatReturn,
  type LedgerInput,
} from "../src/shared/accounting.ts";

const input: LedgerInput = {
  clients: [{ id: "cli-1", data: { name: "Total Gabon" } }],
  articles: [
    { id: "art-prod", data: { label: "Routeur", kind: "product" } },
    { id: "art-svc", data: { label: "Audit", kind: "service" } },
  ],
  invoices: [
    {
      id: "fa-1",
      data: {
        status: "validated", number: "FA-2026-00001", date: "2026-10-05", client_id: "cli-1",
        lines: [
          { label: "Audit", qty: 2, unitPrice: 150000, vatRate: 18, articleId: "art-svc" },
          { label: "Routeur", qty: 1, unitPrice: 100000, vatRate: 18, articleId: "art-prod" },
        ],
      },
    },
    { id: "fa-draft", data: { status: "draft", date: "2026-10-06", client_id: "cli-1", lines: [{ label: "X", qty: 1, unitPrice: 999, vatRate: 18 }] } },
  ],
  credit_notes: [
    { id: "av-1", data: { status: "validated", number: "AV-2026-00001", date: "2026-10-10", client_id: "cli-1", invoice_id: "fa-1", lines: [{ label: "Audit", qty: 1, unitPrice: 150000, vatRate: 18, articleId: "art-svc" }] } },
  ],
  payments: [
    { id: "pay-1", data: { invoice_id: "fa-1", client_id: "cli-1", date: "2026-10-12", amount: 200000, method: "airtel" } },
  ],
  expenses: [
    { id: "dep-1", data: { date: "2026-10-03", amount: 118000, vat_rate: 18, category: "rent", method: "transfer", status: "approved", supplier: "SCI Okoumé" } },
    { id: "dep-2", data: { date: "2026-10-04", amount: 20000, vat_rate: 0, category: "fuel", method: "cash", status: "pending" } },
  ],
  journal_entries: [
    { id: "od-1", data: { journal: "OD", date: "2026-01-01", label: "Apport en capital", lines: [{ account: "521", debit: 1000000, credit: 0 }, { account: "101", debit: 0, credit: 1000000 }] } },
  ],
};

const entries = generateEntries(input);
const Y = ["2026-01-01", "2026-12-31"] as const;

test("Écritures : une par opération validée, toutes équilibrées", () => {
  assert.deepEqual(entries.map((e) => e.id).sort(), ["credit_notes/av-1", "expenses/dep-1", "invoices/fa-1", "journal_entries/od-1", "payments/pay-1"]);
  for (const e of entries) assert.ok(isBalanced(e.lines), e.id);
});

test("Facture : client au débit, produits 701 / 706 et TVA 4431 au crédit", () => {
  const e = entries.find((x) => x.id === "invoices/fa-1")!;
  const by = Object.fromEntries(e.lines.map((l) => [l.account, l.debit - l.credit]));
  assert.deepEqual(by, { "411": 472000, "706": -300000, "701": -100000, "4431": -72000 });
  assert.equal(e.journal, "VE");
});

test("Avoir, encaissement mobile money et dépense avec TVA récupérable", () => {
  const av = Object.fromEntries(entries.find((x) => x.id === "credit_notes/av-1")!.lines.map((l) => [l.account, l.debit - l.credit]));
  assert.deepEqual(av, { "411": -177000, "706": 150000, "4431": 27000 });
  const pay = entries.find((x) => x.id === "payments/pay-1")!;
  assert.equal(pay.journal, "MM");
  assert.deepEqual(pay.lines.map((l) => [l.account, l.debit, l.credit]), [["5215", 200000, 0], ["411", 0, 200000]]);
  const dep = Object.fromEntries(entries.find((x) => x.id === "expenses/dep-1")!.lines.map((l) => [l.account, l.debit - l.credit]));
  assert.deepEqual(dep, { "622": 100000, "4454": 18000, "521": -118000 });
});

test("Balance : total des débits = total des crédits ; solde client = reste dû", () => {
  const rows = trialBalance(entries, ...Y);
  assert.equal(rows.reduce((n, r) => n + r.debit, 0), rows.reduce((n, r) => n + r.credit, 0));
  assert.equal(rows.find((r) => r.account === "411")!.balance, 472000 - 177000 - 200000);
  assert.deepEqual(clientBalance(entries, ...Y), [{ aux: "cli-1", debit: 472000, credit: 377000, balance: 95000 }]);
});

test("Grand livre : solde d'ouverture et solde progressif", () => {
  const l = accountLedger(entries, "521", "2026-10-01", "2026-10-31");
  assert.equal(l.opening, 1000000);
  assert.equal(l.closing, 882000);
  assert.equal(l.moves.length, 1);
});

test("Résultat : produits − charges ; bilan équilibré", () => {
  const rows = trialBalance(entries, ...Y);
  const is = incomeStatement(rows);
  // Produits : 300 000 + 100 000 − 150 000 ; charges : 100 000 de loyer.
  assert.equal(is.revenue, 250000);
  assert.equal(is.result, 150000);
  const bs = balanceSheet(rows);
  assert.equal(bs.totalAssets, bs.totalLiabilities);
  assert.equal(bs.result, 150000);
});

test("TVA : collectée − déductible, bases par taux", () => {
  const v = vatReturn(entries, "2026-10-01", "2026-10-31", input.invoices, input.credit_notes);
  assert.equal(v.collected, 72000 - 27000);
  assert.equal(v.deductible, 18000);
  assert.equal(v.due, 27000);
  assert.deepEqual(v.bases, [{ rate: 18, base: 250000, vat: 45000 }]);
});

test("Export CSV : en-tête FEC, une ligne par mouvement", () => {
  const csv = entriesToCsv(entries, ...Y, () => "Total Gabon").split("\r\n");
  assert.match(csv[0], /^JournalCode;JournalLib;EcritureNum/);
  assert.equal(csv.length, 1 + entries.reduce((n, e) => n + e.lines.length, 0));
  assert.ok(csv.some((l) => l.includes(";411;Clients;cli-1;Total Gabon;")));
});

import { amountInWordsWithCurrency, formatMoney, rateFor } from "../src/shared/currency.ts";

test("Devises : format, parités fixes, montant en lettres", () => {
  assert.equal(formatMoney(1250.5, "EUR"), "1 250,50 €");
  assert.equal(formatMoney(1250000, "XAF"), "1 250 000 FCFA");
  assert.equal(rateFor("EUR", { EUR: 700 }), 655.957, "la parité euro est fixe");
  assert.equal(rateFor("USD", { USD: 610 }), 610);
  assert.equal(amountInWordsWithCurrency(1200.5, "EUR"), "mille deux cents euros et cinquante centimes");
  assert.equal(amountInWordsWithCurrency(1, "USD"), "un dollar");
});

test("Facture en dollars : conversion en FCFA, écart de change à l'encaissement", () => {
  const usd: LedgerInput = {
    ...input,
    invoices: [{ id: "fa-usd", data: { status: "validated", number: "FA-2026-00002", date: "2026-10-01", client_id: "cli-1", currency: "USD", rate: 600, lines: [{ label: "Conseil", qty: 1, unitPrice: 1000, vatRate: 0 }] } }],
    credit_notes: [],
    payments: [{ id: "pay-usd", data: { invoice_id: "fa-usd", client_id: "cli-1", date: "2026-10-20", amount: 1000, rate: 610, method: "transfer" } }],
    expenses: [], journal_entries: [],
  };
  const es = generateEntries(usd);
  for (const e of es) assert.ok(isBalanced(e.lines), e.id);
  const inv = Object.fromEntries(es.find((e) => e.id === "invoices/fa-usd")!.lines.map((l) => [l.account, l.debit - l.credit]));
  assert.deepEqual(inv, { "411": 600000, "706": -600000 });
  const pay = Object.fromEntries(es.find((e) => e.id === "payments/pay-usd")!.lines.map((l) => [l.account, l.debit - l.credit]));
  assert.deepEqual(pay, { "521": 610000, "411": -600000, "776": -10000 });
  const rows = trialBalance(es, ...Y);
  assert.equal(rows.find((r) => r.account === "411")!.balance, 0, "créance soldée");
});
