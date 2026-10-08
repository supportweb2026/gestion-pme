/**
 * Import CSV (enregistré depuis Excel ou LibreOffice) : séparateur détecté
 * (point-virgule, virgule ou tabulation), guillemets gérés, colonnes reconnues
 * par leur intitulé, quelle que soit leur position.
 */

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = [";", "\t", ","].map((s) => [s, firstLine.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
}

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Champs reconnus : nom interne → intitulés possibles dans le fichier. */
export const CLIENT_COLUMNS: Record<string, string[]> = {
  name: ["raison sociale", "nom", "client", "societe", "entreprise", "name"],
  phone: ["telephone", "tel", "mobile", "portable", "phone"],
  email: ["email", "e-mail", "mail", "courriel"],
  address: ["adresse", "address", "rue"],
  city: ["ville", "city", "localite"],
  nif: ["nif", "numero fiscal", "identifiant fiscal"],
  rccm: ["rccm", "registre de commerce"],
};

export const ARTICLE_COLUMNS: Record<string, string[]> = {
  label: ["designation", "libelle", "article", "produit", "service", "description", "nom"],
  ref: ["reference", "ref", "code", "sku"],
  price: ["prix", "prix unitaire", "prix ht", "pu", "tarif", "price"],
  vat_rate: ["tva", "taux tva", "vat"],
  unit: ["unite", "unit"],
  kind: ["type", "nature"],
};

/** Associe chaque champ à une colonne du fichier, d'après la ligne d'en-tête. */
export function mapColumns(header: string[], columns: Record<string, string[]>): Record<string, number> {
  const h = header.map(norm);
  const out: Record<string, number> = {};
  for (const [field, names] of Object.entries(columns)) {
    const wanted = names.map(norm);
    let idx = h.findIndex((c) => wanted.includes(c));
    if (idx < 0) idx = h.findIndex((c) => wanted.some((w) => w.length > 2 && c.startsWith(w)));
    if (idx >= 0 && !Object.values(out).includes(idx)) out[field] = idx;
  }
  return out;
}

/** "150 000", "150.000,50", "1 250,5" → nombre. */
export function parseNumber(v: string): number {
  const s = v.replace(/[\s  ]|FCFA|XAF|%/gi, "");
  if (!s) return 0;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  const decimalSep = lastComma > lastDot ? "," : ".";
  const cleaned = decimalSep === "," ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function rowsToClients(rows: string[][]) {
  const [header, ...data] = rows;
  const map = mapColumns(header ?? [], CLIENT_COLUMNS);
  if (map.name === undefined) return { items: [], missing: "colonne « Raison sociale » ou « Nom » introuvable" };
  const items = data
    .map((r) => Object.fromEntries(Object.entries(map).map(([f, i]) => [f, r[i] ?? ""])))
    .filter((c) => c.name);
  return { items, missing: null };
}

export function rowsToArticles(rows: string[][]) {
  const [header, ...data] = rows;
  const map = mapColumns(header ?? [], ARTICLE_COLUMNS);
  if (map.label === undefined) return { items: [], missing: "colonne « Désignation » introuvable" };
  const items = data
    .map((r) => {
      const get = (f: string) => (map[f] === undefined ? "" : r[map[f]] ?? "");
      const vat = get("vat_rate");
      const kind = norm(get("kind"));
      return {
        label: get("label"),
        ref: get("ref"),
        price: Math.round(parseNumber(get("price"))),
        vat_rate: vat === "" ? 18 : parseNumber(vat) <= 1 && parseNumber(vat) > 0 ? parseNumber(vat) * 100 : parseNumber(vat),
        unit: get("unit"),
        kind: kind.startsWith("prod") || kind.startsWith("march") ? "product" : "service",
      };
    })
    .filter((a) => a.label);
  return { items, missing: null };
}

export const CLIENT_TEMPLATE = "Raison sociale;Téléphone;E-mail;Adresse;Ville;NIF;RCCM\r\nExemple SARL;+241 01 00 00 00;contact@exemple.ga;Boulevard Triomphal;Libreville;;\r\n";
export const ARTICLE_TEMPLATE = "Désignation;Référence;Prix HT;TVA;Unité;Type\r\nAudit informatique;AUD-01;150000;18;jour;Service\r\nRouteur Wi-Fi;RTR-02;45000;18;u;Produit\r\n";
