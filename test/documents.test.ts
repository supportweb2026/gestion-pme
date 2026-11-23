import test from "node:test";
import assert from "node:assert/strict";
import {
  applyGlobalDiscount, baseByRate, deductionLines, depositLines, docArrete, docRefs, docSearchText, docTitle, percentForAmount, quoteTypeOf, relatedDocs, sectionSubtotals,
} from "../src/shared/documents.ts";
import { generateEntries, isBalanced } from "../src/shared/accounting.ts";
import { checkChange, type Change } from "../src/shared/sync.ts";
import { encodeHlc } from "../src/shared/hlc.ts";
import type { InvoiceLine } from "../src/shared/invoice.ts";

const devis: InvoiceLine[] = [
  { label: "Travaux", qty: 0, unitPrice: 0, vatRate: 0, section: true },
  { label: "Pose", qty: 2, unitPrice: 100_000, vatRate: 18 },
  { label: "Fournitures", qty: 1, unitPrice: 50_000, vatRate: 18 },
  { label: "Formation", qty: 1, unitPrice: 100_000, vatRate: 0 },
];

test("documents : base par taux hors titres", () => {
  assert.deepEqual([...baseByRate(devis)], [[18, 250_000], [0, 100_000]]);
});

test("documents : acompte de 30 % ventilé par taux de TVA", () => {
  const lines = depositLines(devis, 30, "DV-2026-00001");
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => [l.vatRate, l.unitPrice, l.deposit]), [[18, 75_000], [0, 30_000]].map(([r, p]) => [r, p, true]));
  assert.match(lines[0].label, /Acompte de 30 % sur DV-2026-00001 \(TVA 18 %\)/);
});

test("documents : pourcentage déduit d'un montant TTC", () => {
  // TTC total = 250 000 × 1,18 + 100 000 = 395 000 ; 79 000 TTC = 20 %.
  assert.equal(Math.round(percentForAmount(devis, 79_000) * 100) / 100, 20);
  assert.equal(percentForAmount([], 1000), 0);
});

test("documents : déduction d'acompte sur la facture de solde", () => {
  const dep = { id: "fa-acompte", number: "FA-2026-00002", date: "2026-11-10", lines: depositLines(devis, 30, "DV-2026-00001") };
  const ded = deductionLines(dep);
  assert.deepEqual(ded.map((l) => [l.unitPrice, l.vatRate, l.depositInvoiceId]), [[-75_000, 18, "fa-acompte"], [-30_000, 0, "fa-acompte"]]);
  assert.match(ded[0].label, /Déduction de l'acompte FA-2026-00002 du 10\/11\/2026/);
});

test("documents : remise globale et sous-totaux de section", () => {
  const remise = applyGlobalDiscount(devis, 10);
  assert.equal(remise[0].discount, undefined, "un titre ne porte pas de remise");
  assert.equal(remise[1].discount, 10);
  assert.deepEqual([...sectionSubtotals(remise)], [[0, 315_000]]);
  const avecDeduction = [...remise, { label: "Déduction", qty: 1, unitPrice: -50_000, vatRate: 18, depositInvoiceId: "x" }];
  assert.deepEqual([...sectionSubtotals(avecDeduction)], [[0, 315_000]], "une déduction d'acompte n'entre pas dans la section");
});

test("documents : intitulés selon le type", () => {
  assert.equal(quoteTypeOf({ doc_type: "proforma" }), "proforma");
  assert.equal(quoteTypeOf({ doc_type: "inconnu" }), "quote");
  assert.equal(docTitle("quotes", { doc_type: "delivery" }), "Bon de livraison");
  assert.equal(docTitle("invoices", { deposit: true }), "Facture d'acompte");
  assert.equal(docArrete("quotes", { doc_type: "delivery" }), "");
});

test("comptabilité : acompte en 4191, soldé sur la facture finale", () => {
  const depLines = depositLines(devis.slice(1, 3), 40, "DV-2026-00001"); // 100 000 HT à 18 %
  const entries = generateEntries({
    clients: [{ id: "c1", data: { name: "SEEG" } }], articles: [], credit_notes: [], payments: [], expenses: [], journal_entries: [],
    invoices: [
      { id: "fa-1", data: { status: "validated", number: "FA-2026-00001", date: "2026-11-01", client_id: "c1", deposit: true, lines: depLines } },
      { id: "fa-2", data: { status: "validated", number: "FA-2026-00002", date: "2026-11-20", client_id: "c1", lines: [...devis.slice(1, 3), ...deductionLines({ id: "fa-1", number: "FA-2026-00001", date: "2026-11-01", lines: depLines })] } },
    ],
  });
  const all = entries.flatMap((e) => e.lines);
  for (const e of entries) assert.ok(isBalanced(e.lines), `écriture ${e.ref} équilibrée`);
  const sum = (acc: string, side: "debit" | "credit") => all.filter((l) => l.account === acc).reduce((a, l) => a + l[side], 0);
  assert.equal(sum("4191", "credit") - sum("4191", "debit"), 0, "l'avance est soldée");
  assert.equal(sum("706", "credit"), 250_000);
  assert.equal(sum("411", "debit"), 118_000 + 177_000);
});

test("synchronisation : séries admises pour les documents d'avant-vente", () => {
  const send = (number: string): Change => ({ id: "x", tbl: "quotes", row: "quote-1", patch: { status: "sent", number }, hlc: encodeHlc(1, 0, "A"), device: "A" });
  for (const n of ["PF-2026-00001", "BC-2026-00001", "BL-2026-00001", "DV-2026-00001"]) assert.equal(checkChange(null, send(n)), null, n);
  assert.notEqual(checkChange(null, send("FA-2026-00001")), null);
});

test("Références : un document saisi dans Gestia garde chaque référence dans son champ", () => {
  const r = docRefs({ subject: "Maintenance", client_ref: "BC 4521", payment_terms: "30 jours", notes: "Merci." });
  assert.deepEqual(r, { subject: "Maintenance", clientRef: "BC 4521", paymentTerms: "30 jours", notes: "Merci." });
  assert.match(docSearchText({ number: "FA-2026-00001", subject: "Maintenance", client_ref: "BC 4521" }), /FA-2026-00001 Maintenance BC 4521/);
});

test("Références : un document repris avant la version 2 est relu depuis sa note, sans être modifié", () => {
  const old = {
    imported: "vosfactures", subject: "Campagne médias",
    notes: "Objet : Campagne médias\nORDRE D'ACHAT N°2035609\nFL : 1436\nRèglement : 50% à la commande",
  };
  assert.deepEqual(docRefs(old), { subject: "Campagne médias", clientRef: "ORDRE D'ACHAT N°2035609\nFL : 1436", paymentTerms: "50% à la commande", notes: "" });
  // Complété par une nouvelle reprise : la référence complétée l'emporte, les informations imprimées rejoignent la note.
  const done = docRefs({ ...old, client_ref: "ORDRE D'ACHAT N°2035609 FL : 1436", import_info: "Acompte 50 %" });
  assert.equal(done.clientRef, "ORDRE D'ACHAT N°2035609 FL : 1436");
  assert.equal(done.notes, "Acompte 50 %");
  // Avoir repris : le motif reste dans la note.
  assert.equal(docRefs({ imported: "vosfactures", subject: "", notes: "Motif : erreur de prix" }).notes, "Motif : erreur de prix");
  // Version 2 : rien à relire.
  assert.deepEqual(docRefs({ imported: "vosfactures", import_v: 2, subject: "S", client_ref: "BC 1", payment_terms: "", notes: "", import_info: "Info" }),
    { subject: "S", clientRef: "BC 1", paymentTerms: "", notes: "Info" });
});

test("Documents liés : la chaîne se lit dans les deux sens", () => {
  const quotes = [
    { id: "dv1", data: { number: "DV-1", invoice_id: "fa2" } },
    { id: "bl1", data: { number: "BL-1", doc_type: "delivery", source_id: "dv1" } },
  ];
  const invoices = [
    { id: "fa1", data: { number: "FA-1", quote_id: "dv1", deposit: true } },
    { id: "fa2", data: { number: "FA-2" } },
  ];
  const credit_notes = [{ id: "av1", data: { number: "AV-1", invoice_id: "fa2" } }];
  const all = { quotes, invoices, credit_notes };
  assert.deepEqual(relatedDocs("quotes", quotes[0], all).map((r) => `${r.relation} ${r.id}`), ["A donné bl1", "Acompte fa1", "Facturé par fa2"]);
  // La facture reprise ne porte pas le lien : il est retrouvé depuis le devis.
  assert.deepEqual(relatedDocs("invoices", invoices[1], all).map((r) => `${r.relation} ${r.id}`), ["Issue de dv1", "Corrigée par av1"]);
  assert.deepEqual(relatedDocs("invoices", invoices[0], all).map((r) => r.id), ["dv1"]);
  assert.deepEqual(relatedDocs("credit_notes", credit_notes[0], all).map((r) => r.id), ["fa2"]);
  assert.deepEqual(relatedDocs("quotes", quotes[1], all).map((r) => `${r.relation} ${r.id}`), ["Établi d'après dv1"]);
});
