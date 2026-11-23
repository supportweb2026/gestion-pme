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

/** Un champ de Gestia qu'un fichier peut alimenter : son nom à l'écran et les intitulés de colonne reconnus. */
export interface ImportField {
  key: string;
  label: string;
  aliases: string[];
  required?: boolean;
  /** Intitulés à ne pas prendre pour ce champ (un prix d'achat n'est pas un prix de vente). */
  exclude?: RegExp;
}

export const CLIENT_FIELDS: ImportField[] = [
  { key: "name", label: "Raison sociale", required: true, aliases: ["raison sociale", "nom", "client", "societe", "entreprise", "name", "company"] },
  { key: "phone", label: "Téléphone", aliases: ["telephone", "tel", "mobile", "portable", "phone"] },
  { key: "email", label: "E-mail", aliases: ["email", "e-mail", "mail", "courriel", "adresse email", "adresses email"], exclude: /^adresse$/ },
  { key: "address", label: "Adresse", aliases: ["adresse", "address", "rue", "n et nom de rue"], exclude: /mail/ },
  { key: "city", label: "Ville", aliases: ["ville", "city", "localite"] },
  { key: "nif", label: "NIF", aliases: ["nif", "numero fiscal", "n fiscal", "identifiant fiscal", "tax id"] },
  { key: "rccm", label: "RCCM", aliases: ["rccm", "registre de commerce", "rc"] },
];

export const ARTICLE_FIELDS: ImportField[] = [
  { key: "label", label: "Désignation", required: true, aliases: ["designation", "libelle", "nom", "article", "produit", "service", "name", "title", "titre"] },
  { key: "ref", label: "Référence", aliases: ["reference", "ref", "code", "sku", "code article"], exclude: /fournisseur|client|postal/ },
  { key: "description", label: "Description", aliases: ["description", "detail", "details", "descriptif"] },
  { key: "price", label: "Prix de vente HT", aliases: ["prix ht", "pu ht", "prix unitaire ht", "prix de vente ht", "prix de vente", "prix unitaire", "prix", "pu", "tarif", "price"], exclude: /achat|ttc|revient/ },
  { key: "price_ttc", label: "Prix de vente TTC", aliases: ["prix ttc", "pu ttc", "prix unitaire ttc", "prix de vente ttc"], exclude: /achat/ },
  { key: "cost", label: "Prix d'achat HT", aliases: ["prix d'achat ht", "prix d'achat", "prix achat", "cout", "cout unitaire", "cout d'achat", "prix de revient", "cost"], exclude: /ttc/ },
  { key: "vat_rate", label: "TVA", aliases: ["tva", "taux tva", "taux de tva", "vat"], exclude: /achat|montant/ },
  { key: "unit", label: "Unité", aliases: ["unite", "unit", "unite de mesure"] },
  { key: "kind", label: "Type (produit ou service)", aliases: ["type", "nature", "categorie"] },
];

/**
 * Associe chaque champ à une colonne du fichier, d'après la ligne d'en-tête.
 * Un intitulé exact passe avant un intitulé approchant ; entre deux colonnes de même
 * intitulé (deux « TVA »), celle qui contient le plus de valeurs l'emporte.
 */
export function mapColumns(header: string[], fields: ImportField[], data: string[][] = []): Record<string, number> {
  const h = header.map(norm);
  const filled = h.map((_, i) => data.reduce((n, r) => n + ((r[i] ?? "") !== "" ? 1 : 0), 0));
  const out: Record<string, number> = {};
  const used = new Set<number>();
  for (const pass of ["exact", "prefix"] as const) {
    for (const f of fields) {
      if (out[f.key] !== undefined) continue;
      const wanted = f.aliases.map(norm);
      const candidates = h
        .map((c, i) => ({ c, i }))
        .filter(({ c, i }) => !used.has(i) && c !== "" && !(f.exclude && f.exclude.test(c))
          && (pass === "exact" ? wanted.includes(c) : wanted.some((w) => w.length > 2 && c.startsWith(w))))
        .sort((x, y) => filled[y.i] - filled[x.i] || x.i - y.i);
      if (candidates.length) {
        out[f.key] = candidates[0].i;
        used.add(candidates[0].i);
      }
    }
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

export type ImportItem = Record<string, string | number>;
type Mapped = { items: ImportItem[]; missing: string | null; map: Record<string, number> };

export function rowsToClients(rows: string[][], mapping?: Record<string, number>): Mapped {
  const [header, ...data] = rows;
  const map = mapping ?? mapColumns(header ?? [], CLIENT_FIELDS, data);
  if (map.name === undefined) return { items: [], missing: "indiquez la colonne qui contient la raison sociale", map };
  const items = data
    .map((r) => Object.fromEntries(Object.entries(map).map(([f, i]) => [f, r[i] ?? ""])))
    .filter((c) => c.name);
  return { items, missing: null, map };
}

/** Unités courantes ramenées à une seule écriture ; toute autre unité est gardée telle quelle. */
const UNIT_ALIASES: Record<string, string> = {
  unite: "u", unites: "u", piece: "u", pieces: "u", pce: "u", heure: "h", heures: "h", j: "jour", jours: "jour",
  m2: "m²", forfait: "forfait", litre: "l", litres: "l",
};
export function cleanUnit(v: string): string {
  const u = v.trim();
  return UNIT_ALIASES[norm(u)] ?? u;
}

/** « 18 », « 18 % », « 0,18 » → 18 ; une mention sans chiffre (« exonéré », « non applicable ») → 0. */
export function parseVat(v: string): number {
  if (v.trim() === "") return 18;
  if (!/\d/.test(v)) return 0;
  const n = parseNumber(v);
  return n > 0 && n <= 1 ? n * 100 : n;
}

export function rowsToArticles(rows: string[][], mapping?: Record<string, number>): Mapped {
  const [header, ...data] = rows;
  const map = mapping ?? mapColumns(header ?? [], ARTICLE_FIELDS, data);
  if (map.label === undefined) return { items: [], missing: "indiquez la colonne qui contient la désignation", map };
  const items = data
    .map((r) => {
      const get = (f: string) => (map[f] === undefined ? "" : r[map[f]] ?? "");
      const vat = parseVat(get("vat_rate"));
      const kind = norm(get("kind"));
      // À défaut de prix HT, il se déduit du prix TTC.
      const ht = parseNumber(get("price"));
      const price = ht > 0 || get("price_ttc") === "" ? ht : parseNumber(get("price_ttc")) / (1 + vat / 100);
      // Retours à la ligne unifiés ; l'apostrophe qu'un tableur pose devant un tiret est retirée.
      const description = get("description").replace(/\r\n?/g, "\n").replace(/^'(?=[-+=@])/gm, "").trim().slice(0, 4000);
      return {
        label: get("label"),
        ref: get("ref"),
        price: Math.round(price),
        ...(get("cost") !== "" ? { cost: Math.round(parseNumber(get("cost"))) } : {}),
        vat_rate: vat,
        unit: cleanUnit(get("unit")),
        kind: kind.startsWith("prod") || kind.startsWith("march") || kind.startsWith("bien") ? "product" : "service",
        ...(description ? { description } : {}),
      } as ImportItem;
    })
    .filter((a) => a.label);
  return { items, missing: null, map };
}

const key = (v: unknown) => String(v ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
const blank = (v: unknown) => v === undefined || v === null || v === "" || v === 0;

/**
 * Compare un fichier à ce qui existe déjà : ce qui est nouveau s'ajoute, ce qui existe
 * est complété (seuls les champs encore vides sont remplis, rien n'est écrasé).
 */
export function planImport(
  items: ImportItem[], existing: { id: string; data: Record<string, unknown> }[], nameField: string,
): { fresh: ImportItem[]; updates: { id: string; patch: ImportItem }[]; same: number } {
  const known = new Map<string, { id: string; data: Record<string, unknown> }[]>();
  for (const e of existing) {
    const k = key(e.data[nameField]);
    known.set(k, [...(known.get(k) ?? []), e]);
  }
  const fresh: ImportItem[] = [];
  const updates = new Map<string, ImportItem>();
  const seen = new Set<string>();
  let same = 0;
  for (const item of items) {
    const k = key(item[nameField]);
    const matches = known.get(k);
    if (!matches) {
      if (seen.has(k)) same++;
      else { seen.add(k); fresh.push(item); }
      continue;
    }
    let touched = false;
    for (const e of matches) {
      if (updates.has(e.id)) continue;
      const patch: ImportItem = {};
      for (const [f, v] of Object.entries(item)) if (f !== nameField && !blank(v) && blank(e.data[f])) patch[f] = v;
      // Un prix qui arrive avec sa TVA : la TVA par défaut posée faute de prix est corrigée avec lui.
      if (patch.price !== undefined && item.vat_rate !== undefined && e.data.vat_rate !== item.vat_rate) patch.vat_rate = item.vat_rate;
      if (Object.keys(patch).length) { updates.set(e.id, patch); touched = true; }
    }
    if (!touched) same++;
  }
  return { fresh, updates: [...updates].map(([id, patch]) => ({ id, patch })), same };
}

const cell = (v: unknown) => {
  const s = String(v ?? "");
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** Fichier CSV (point-virgule, lisible par Excel) aux mêmes colonnes que le modèle : un export se réimporte tel quel. */
export function toCsv(fields: ImportField[], rows: Record<string, unknown>[]): string {
  return [fields.map((f) => f.label), ...rows.map((r) => fields.map((f) => r[f.key]))]
    .map((line) => line.map(cell).join(";")).join("\r\n") + "\r\n";
}
export const ARTICLE_EXPORT_FIELDS = ARTICLE_FIELDS.filter((f) => f.key !== "price_ttc");

export const CLIENT_TEMPLATE = "Raison sociale;Téléphone;E-mail;Adresse;Ville;NIF;RCCM\r\nExemple SARL;+241 01 00 00 00;contact@exemple.ga;Boulevard Triomphal;Libreville;;\r\n";
export const ARTICLE_TEMPLATE = toCsv(ARTICLE_EXPORT_FIELDS, [
  { label: "Audit informatique", ref: "AUD-01", description: "Diagnostic du parc et rapport de recommandations", price: 150000, vat_rate: 18, unit: "jour", kind: "Service" },
  { label: "Routeur Wi-Fi", ref: "RTR-02", price: 45000, cost: 30000, vat_rate: 18, unit: "u", kind: "Produit" },
]);
