import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, buckets, comparePeriod, EMPTY_FILTERS, granularityFor, type ReportInput } from "../src/web/reports.ts";
import type { SyncRecord, SyncTable } from "../src/shared/sync.ts";

const rec = (tbl: SyncTable, id: string, data: Record<string, unknown>): SyncRecord => ({ tbl, id, data, clocks: {} });

/** Jeu d'essai : deux clients, deux vendeurs, un article à prix d'achat connu. */
function sample(): ReportInput {
  const articles = [
    rec("articles", "a1", { label: "Ciment", kind: "product", price: 10_000, cost: 6_000 }),
    rec("articles", "a2", { label: "Conseil", kind: "service", price: 50_000 }),
  ];
  const invoices = [
    rec("invoices", "f1", {
      status: "validated", number: "FA-2026-00001", date: "2026-11-03", due_date: "2026-11-10", client_id: "c1", created_by: "u1",
      lines: [{ label: "Ciment", articleId: "a1", qty: 10, unitPrice: 10_000, vatRate: 18, cost: 6_000 }],
    }),
    rec("invoices", "f2", {
      status: "validated", number: "FA-2026-00002", date: "2026-11-15", due_date: "2026-12-15", client_id: "c2", created_by: "u2",
      lines: [{ label: "Conseil", articleId: "a2", qty: 2, unitPrice: 50_000, vatRate: 18 }],
    }),
    rec("invoices", "f3", {
      status: "validated", number: "FA-2026-00003", date: "2026-10-20", due_date: "2026-10-30", client_id: "c1", created_by: "u1",
      lines: [{ label: "Ciment", articleId: "a1", qty: 5, unitPrice: 10_000, vatRate: 18 }],
    }),
    rec("invoices", "draft", { status: "draft", date: "2026-11-16", client_id: "c2", lines: [{ label: "x", qty: 1, unitPrice: 999_999, vatRate: 18 }] }),
    // Facture en euros : 100 € au taux fixe.
    rec("invoices", "f4", {
      status: "validated", number: "FA-2026-00004", date: "2026-11-20", due_date: "2026-12-20", client_id: "c2", created_by: "u2",
      currency: "EUR", rate: 655.957, lines: [{ label: "Audit", qty: 1, unitPrice: 100, vatRate: 0 }],
    }),
  ];
  const credits = [
    rec("credit_notes", "av1", {
      status: "validated", number: "AV-2026-00001", date: "2026-11-18", client_id: "c1", invoice_id: "f1",
      lines: [{ label: "Ciment", articleId: "a1", qty: 1, unitPrice: 10_000, vatRate: 18, cost: 6_000 }],
    }),
  ];
  const payments = [
    rec("payments", "p1", { invoice_id: "f1", date: "2026-11-05", amount: 50_000, method: "airtel" }),
    rec("payments", "p2", { invoice_id: "f3", date: "2026-11-02", amount: 59_000, method: "cash" }),
    rec("payments", "p3", { invoice_id: "f2", date: "2026-11-25", amount: 118_000, method: "transfer" }),
  ];
  const quotes = [
    rec("quotes", "q1", { status: "invoiced", number: "DV-1", date: "2026-11-01", client_id: "c1", created_by: "u1", lines: [{ label: "a", qty: 1, unitPrice: 1000, vatRate: 18 }] }),
    rec("quotes", "q2", { status: "refused", number: "DV-2", date: "2026-11-02", client_id: "c2", created_by: "u2", lines: [{ label: "a", qty: 1, unitPrice: 1000, vatRate: 18 }] }),
    rec("quotes", "q3", { status: "draft", date: "2026-11-02", client_id: "c2", lines: [] }),
  ];
  return { invoices, credits, payments, quotes, articles, today: "2026-11-22" };
}

const NOV = { ...EMPTY_FILTERS, from: "2026-11-01", to: "2026-11-30" };

test("chiffre d'affaires, TVA, avoirs et marge du mois", () => {
  const r = buildReport(sample(), NOV);
  // 100 000 + 100 000 + 65 596 (100 € arrondi) − 10 000 d'avoir
  assert.equal(r.kpis.revenue, 100_000 + 100_000 + 65_596 - 10_000);
  assert.equal(r.kpis.credits, 10_000);
  assert.equal(r.kpis.vat, 18_000 + 18_000 - 1_800);
  // Marge connue seulement sur le ciment : (100 000 − 60 000) − (10 000 − 6 000)
  assert.equal(r.kpis.margin, 36_000);
  assert.equal(r.kpis.invoiceCount, 3);
  assert.equal(r.kpis.activeClients, 2);
  assert.equal(r.kpis.newClients, 1, "c1 avait déjà une facture en octobre");
});

test("encaissements datés dans la période, quel que soit la date de la facture", () => {
  const r = buildReport(sample(), NOV);
  assert.equal(r.kpis.collected, 50_000 + 59_000 + 118_000);
  const airtel = r.byMethod.find((m) => m.key === "airtel")!;
  assert.equal(airtel.collected, 50_000);
  assert.equal(airtel.label, "Airtel Money");
});

test("reste dû, retard et balance âgée", () => {
  const r = buildReport(sample(), NOV);
  // f1 : 118 000 − 50 000 − 11 800 (avoir TTC) = 56 200, échue le 10/11 → 12 jours
  const f1 = r.documents.find((d) => d.id === "f1")!;
  assert.equal(f1.due, 56_200);
  assert.equal(f1.status, "overdue");
  assert.equal(r.kpis.overdue, 56_200);
  const b30 = r.aging.find((a) => a.key === "30")!;
  assert.equal(b30.amount, 56_200);
  assert.equal(r.aging.find((a) => a.key === "current")!.count, 1, "f4 pas encore échue (f2 soldée)");
});

test("filtres client, vendeur, article, moyen de paiement et statut", () => {
  const input = sample();
  assert.equal(buildReport(input, { ...NOV, clients: ["c2"] }).kpis.revenue, 165_596);
  assert.equal(buildReport(input, { ...NOV, sellers: ["u1"] }).kpis.revenue, 90_000);
  const ciment = buildReport(input, { ...NOV, articles: ["a:a1"] });
  assert.equal(ciment.kpis.revenue, 90_000);
  assert.equal(ciment.byArticle.length, 1);
  assert.equal(ciment.byArticle[0].qty, 9);
  const services = buildReport(input, { ...NOV, kinds: ["service"] });
  assert.equal(services.kpis.revenue, 100_000);
  const airtel = buildReport(input, { ...NOV, methods: ["airtel"] });
  assert.equal(airtel.kpis.collected, 50_000);
  assert.deepEqual(airtel.documents.map((d) => d.id), ["f1"]);
  const paid = buildReport(input, { ...NOV, statuses: ["paid"] });
  assert.deepEqual(paid.documents.map((d) => d.id), ["f2"]);
  const eur = buildReport(input, { ...NOV, currencies: ["EUR"] });
  assert.equal(eur.kpis.revenue, 65_596);
  const vat0 = buildReport(input, { ...NOV, vatRates: [0] });
  assert.equal(vat0.kpis.revenue, 65_596);
});

test("les brouillons ne comptent jamais", () => {
  const r = buildReport(sample(), NOV);
  assert.ok(!r.documents.some((d) => d.id === "draft"));
});

test("délai moyen de paiement et conversion des devis", () => {
  const r = buildReport(sample(), NOV);
  assert.equal(r.kpis.paymentDelay, 10, "f2 : 15/11 → 25/11");
  assert.equal(r.kpis.quotesSent, 2);
  assert.equal(r.kpis.conversion, 0.5);
});

test("évolution : granularité selon la durée, séries cohérentes avec les totaux", () => {
  assert.equal(granularityFor("2026-11-01", "2026-11-30"), "day");
  assert.equal(granularityFor("2026-09-01", "2026-11-30"), "week");
  assert.equal(granularityFor("2026-01-01", "2026-12-31"), "month");
  assert.equal(buckets("2025-12-01", "2026-11-30", "month").length, 12);
  assert.equal(buckets("2026-11-01", "2026-11-30", "day").length, 30);
  const r = buildReport(sample(), NOV);
  assert.equal(r.series.reduce((n, p) => n + p.revenue, 0), r.kpis.revenue);
  assert.equal(r.series.reduce((n, p) => n + p.collected, 0), r.kpis.collected);
  const year = buildReport(sample(), { ...EMPTY_FILTERS, from: "2026-01-01", to: "2026-12-31" });
  assert.equal(year.series.find((p) => p.key === "2026-10")!.revenue, 50_000);
});

test("périodes de comparaison", () => {
  assert.deepEqual(comparePeriod("2026-11-01", "2026-11-30", "previous"), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(comparePeriod("2026-10-01", "2026-12-31", "previous"), { from: "2026-07-01", to: "2026-09-30" });
  assert.deepEqual(comparePeriod("2026-11-10", "2026-11-19", "previous"), { from: "2026-10-31", to: "2026-11-09" });
  assert.deepEqual(comparePeriod("2026-11-01", "2026-11-30", "year"), { from: "2025-11-01", to: "2025-11-30" });
  assert.deepEqual(comparePeriod("2028-02-01", "2028-02-29", "year"), { from: "2027-02-01", to: "2027-02-28" });
});
