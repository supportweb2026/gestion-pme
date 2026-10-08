import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseNumber, rowsToArticles, rowsToClients } from "../src/shared/csv.ts";

test("CSV : séparateur point-virgule, guillemets, BOM, lignes vides", () => {
  const rows = parseCsv('﻿Nom;Ville\r\n"Total; Gabon";Port-Gentil\r\n\r\n"Dit ""Le Chef""";Libreville\n');
  assert.deepEqual(rows, [["Nom", "Ville"], ["Total; Gabon", "Port-Gentil"], ['Dit "Le Chef"', "Libreville"]]);
  assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
});

test("Nombres au format français et anglais", () => {
  assert.equal(parseNumber("150 000"), 150000);
  assert.equal(parseNumber("1.250.000,50"), 1250000.5);
  assert.equal(parseNumber("1,250,000.50"), 1250000.5);
  assert.equal(parseNumber("18 %"), 18);
  assert.equal(parseNumber("45 000 FCFA"), 45000);
});

test("Clients : colonnes reconnues quel que soit l'ordre et l'intitulé", () => {
  const r = rowsToClients(parseCsv("Ville;Téléphone;Raison sociale;N° NIF\nLibreville;077 00 00 00;Sodepsi;123\n;;;\n"));
  assert.equal(r.missing, null);
  assert.deepEqual(r.items, [{ city: "Libreville", phone: "077 00 00 00", name: "Sodepsi" }]);
  assert.ok(rowsToClients(parseCsv("Ville\nX")).missing);
});

test("Articles : prix, TVA (18 ou 0,18), type produit / service", () => {
  const r = rowsToArticles(parseCsv("Désignation;Prix HT;TVA;Type\nRouteur;45 000;0,18;Produit\nAudit;150000;;Prestation\n"));
  assert.deepEqual(r.items.map((a) => [a.label, a.price, a.vat_rate, a.kind]), [["Routeur", 45000, 18, "product"], ["Audit", 150000, 18, "service"]]);
});
