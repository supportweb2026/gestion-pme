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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARTICLE_EXPORT_FIELDS, ARTICLE_FIELDS, ARTICLE_TEMPLATE, mapColumns, parseVat, planImport, toCsv } from "../src/shared/csv.ts";
import { readXlsx } from "../src/shared/xlsx.ts";

test("articles : export d'un autre logiciel (PU HT, deux colonnes TVA, description, prix d'achat vide)", () => {
  const csv = [
    " ,ID,Nom,Référence,TVA,Prix d'achat HT,Prix d'achat TTC,TVA,PU H.T.,PU T.T.C.,Disponibilité,Description ,Réf. (fournisseur),Champ additionnel,Unité,Frais de livraison",
    "1,11,Maintenance,DEV001,,,,18,60000.0,70800.0,,\"Ligne 1\r\n'- Photos\",,,h,0",
    "2,12,Formation,,,,,disabled,100000.0,100000.0,,,,,FORFAIT,0",
    "3,13,Hébergement,,,,,0,,59000,,,,,unités,0",
  ].join("\n");
  const r = rowsToArticles(parseCsv(csv));
  assert.equal(r.missing, null);
  assert.deepEqual(r.items[0], { label: "Maintenance", ref: "DEV001", price: 60000, vat_rate: 18, unit: "h", kind: "service", description: "Ligne 1\n- Photos" });
  assert.deepEqual(r.items[1], { label: "Formation", ref: "", price: 100000, vat_rate: 0, unit: "forfait", kind: "service" });
  // Sans prix HT, il se déduit du TTC ; l'unité est ramenée à l'écriture courante.
  assert.equal(r.items[2].price, 59000);
  assert.equal(r.items[2].unit, "u");
});

test("colonnes : un prix d'achat n'est jamais pris pour le prix de vente", () => {
  const map = mapColumns(["Produit", "Prix d'achat TTC", "Prix TTC", "Code postal"], ARTICLE_FIELDS);
  assert.deepEqual(map, { label: 0, price_ttc: 2 });
  assert.equal(parseVat("18 %"), 18);
  assert.equal(parseVat("0,18"), 18);
  assert.equal(parseVat("Exonéré"), 0);
  assert.equal(parseVat(""), 18);
});

test("import : ce qui existe est complété sans rien écraser, le reste s'ajoute", () => {
  const existing = [
    { id: "a1", data: { label: "Maintenance", price: 0, vat_rate: 18, unit: "" } },
    { id: "a2", data: { label: "Formation", price: 90000, vat_rate: 18, unit: "jour" } },
  ];
  const plan = planImport([
    { label: "maintenance ", price: 60000, vat_rate: 0, unit: "h", description: "Détail" },
    { label: "Formation", price: 100000, vat_rate: 0, unit: "forfait" },
    { label: "Audit", price: 1 }, { label: "AUDIT", price: 2 },
  ], existing, "label");
  assert.deepEqual(plan.updates, [{ id: "a1", patch: { price: 60000, unit: "h", description: "Détail", vat_rate: 0 } }]);
  assert.deepEqual(plan.fresh, [{ label: "Audit", price: 1 }]);
  assert.equal(plan.same, 2);
});

test("export : mêmes colonnes que le modèle, réimportable tel quel", () => {
  const csv = toCsv(ARTICLE_EXPORT_FIELDS, [{ label: "Câble ; 3 m", ref: "C-3", description: "Ligne 1\nLigne 2", price: 1500, cost: 900, vat_rate: 18, unit: "u", kind: "Produit" }]);
  const back = rowsToArticles(parseCsv(csv));
  assert.deepEqual(back.items[0], { label: "Câble ; 3 m", ref: "C-3", price: 1500, cost: 900, vat_rate: 18, unit: "u", kind: "product", description: "Ligne 1\nLigne 2" });
  assert.equal(rowsToArticles(parseCsv(ARTICLE_TEMPLATE)).items.length, 2);
});

test("Excel : la première feuille d'un .xlsx se lit comme un CSV", async () => {
  const file = readFileSync(join(import.meta.dirname, "fixtures", "articles-exemple.xlsx"));
  const rows = await readXlsx(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer);
  assert.deepEqual(rows[0], ["Nom", "PU H.T.", "TVA", "Unité", "Description"]);
  const r = rowsToArticles(rows);
  assert.deepEqual(r.items[0], { label: "Audit & conseil", ref: "", price: 150000, vat_rate: 18, unit: "jour", kind: "service", description: "Diagnostic du parc" });
  assert.deepEqual(r.items[1], { label: "Routeur Wi-Fi", ref: "", price: 45000, vat_rate: 0, unit: "", kind: "service", description: "Double bande" });
});

import { mergeSheets } from "../src/shared/csv.ts";
import { pageNumbers } from "../src/shared/paging.ts";

test("plusieurs fichiers : colonnes alignées par intitulé, colonnes en plus ajoutées", () => {
  const merged = mergeSheets([
    [["Nom", "TVA", "PU H.T.", "TVA"], ["A", "", "100", "18"]],
    [["PU H.T.", "Nom", "Unité"], ["200", "B", "h"]],
    [],
  ]);
  assert.deepEqual(merged, [["Nom", "TVA", "PU H.T.", "TVA", "Unité"], ["A", "", "100", "18", ""], ["B", "", "200", "", "h"]]);
  const r = rowsToArticles(merged);
  assert.deepEqual(r.items.map((i) => [i.label, i.price, i.unit]), [["A", 100, ""], ["B", 200, "h"]]);
});

test("pages : première, dernière et voisines, avec des points de suspension", () => {
  assert.deepEqual(pageNumbers(0, 3), [0, 1, 2]);
  assert.deepEqual(pageNumbers(0, 30), [0, 1, "gap", 28, 29]);
  assert.deepEqual(pageNumbers(9, 30), [0, 1, "gap", 8, 9, 10, "gap", 28, 29]);
  assert.deepEqual(pageNumbers(3, 30), [0, 1, 2, 3, 4, "gap", 28, 29]);
});
