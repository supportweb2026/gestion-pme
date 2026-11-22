import test from "node:test";
import assert from "node:assert/strict";
import { defaultNote, docColor, softOf, stampFor, termsFor, tooLight } from "../src/shared/branding.ts";

test("apparence : couleur sûre, teinte claire dérivée, contraste", () => {
  assert.equal(docColor({}), "#0255C6");
  assert.equal(docColor({ doc_color: "#0f7a4d" }), "#0F7A4D");
  assert.equal(docColor({ doc_color: "red" }), "#0255C6");
  assert.equal(softOf("#0255C6"), "#E8F0FA");
  assert.equal(tooLight("#FFE600"), true);
  assert.equal(tooLight("#101D36"), false);
});

test("apparence : cachet, notes par défaut et conditions selon le document", () => {
  const s = { stamp: "data:image/png;base64,AAAA", default_note_invoices: "Merci", default_note_quotes: "Délai 15 j", terms: " CGV " };
  assert.equal(stampFor(s, "invoices", false), s.stamp);
  assert.equal(stampFor(s, "quotes", true), "", "jamais sur un bon de livraison");
  assert.equal(stampFor({ ...s, stamp_on: false }, "invoices", false), "");
  assert.equal(stampFor({ stamp: "javascript:alert(1)" }, "invoices", false), "");
  assert.equal(defaultNote(s, "invoices"), "Merci");
  assert.equal(defaultNote(s, "quotes"), "Délai 15 j");
  assert.equal(defaultNote(s, "credit_notes"), "");
  assert.equal(termsFor(s, "invoices", false), "CGV");
  assert.equal(termsFor(s, "credit_notes", false), "");
  assert.equal(termsFor(s, "quotes", true), "");
});
