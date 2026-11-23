/**
 * Import standard des devis, factures, avoirs et bons : un tableau (CSV ou Excel) avec
 * une ligne par ligne de document. Les lignes qui portent le même type et le même numéro
 * forment un seul document ; les informations du document (client, date, échéance…) sont
 * lues sur sa première ligne renseignée.
 *
 * Le tableau est converti dans la disposition que lit déjà la reprise d'historique
 * (`buildVfImport`) : mêmes contrôles par année, mêmes identifiants stables, donc
 * relancer l'import avec le même fichier ne crée aucun doublon.
 */
import { mapColumns, parseNumber, parseVat, type ImportField } from "./csv.ts";
import { C, checkVfHeader, EXPECTED, L } from "./vosfactures.ts";

export const DOC_FIELDS: ImportField[] = [
  { key: "type", label: "Type de document", aliases: ["type de document", "type", "document", "nature"] },
  { key: "number", label: "Numéro", required: true, aliases: ["numero", "n", "no", "numero de document", "numero de facture", "numero facture", "reference document", "number", "invoice number", "invoice no"], exclude: /commande|client|nif|rccm|telephone/ },
  { key: "date", label: "Date", required: true, aliases: ["date", "date du document", "date de facture", "date facture", "date d emission", "date de creation", "invoice date"], exclude: /echeance|paiement|reglement|livraison|validite/ },
  { key: "due", label: "Échéance", aliases: ["echeance", "date d echeance", "date limite", "valable jusqu au", "validite", "due date"] },
  { key: "client", label: "Client", required: true, aliases: ["client", "raison sociale", "nom du client", "nom client", "societe", "customer", "customer name", "acheteur"] },
  { key: "nif", label: "NIF du client", aliases: ["nif", "nif client", "nif du client", "numero fiscal"] },
  { key: "address", label: "Adresse du client", aliases: ["adresse", "adresse client", "adresse du client", "rue", "address"] },
  { key: "city", label: "Ville", aliases: ["ville", "city"] },
  { key: "email", label: "E-mail du client", aliases: ["email", "e mail", "mail", "courriel", "email client"] },
  { key: "phone", label: "Téléphone du client", aliases: ["telephone", "tel", "phone", "mobile", "telephone client"] },
  { key: "subject", label: "Objet", aliases: ["objet", "titre", "sujet", "subject"] },
  { key: "orderRef", label: "Référence de commande", aliases: ["reference de commande", "reference commande", "bon de commande client", "ordre d achat", "numero de commande", "po", "po number"] },
  { key: "corrected", label: "Facture corrigée (avoir)", aliases: ["facture corrigee", "facture d origine", "facture concernee", "avoir sur"] },
  { key: "label", label: "Désignation", required: true, aliases: ["designation", "libelle", "produit", "article", "prestation", "description courte", "item", "product"] },
  { key: "description", label: "Description de la ligne", aliases: ["description", "detail", "details", "description de la ligne"] },
  { key: "qty", label: "Quantité", aliases: ["quantite", "qte", "qty", "quantity", "nombre"] },
  { key: "unit", label: "Unité", aliases: ["unite", "unit"] },
  { key: "price", label: "Prix unitaire HT", required: true, aliases: ["prix unitaire ht", "pu ht", "prix unitaire", "prix ht", "pu", "prix", "unit price", "price"], exclude: /ttc|achat|total|montant/ },
  { key: "discount", label: "Remise %", aliases: ["remise", "remise %", "remise en %", "discount"] },
  { key: "vat", label: "Taux de TVA", aliases: ["taux de tva", "tva", "tva %", "taux tva", "vat", "tax rate"], exclude: /montant|total/ },
  { key: "status", label: "Statut", aliases: ["statut", "etat", "status"] },
  { key: "paid", label: "Montant payé", aliases: ["montant paye", "paye", "montant regle", "regle", "encaisse", "montant encaisse", "amount paid", "paid"], exclude: /date|mode|moyen/ },
  { key: "paidOn", label: "Date de paiement", aliases: ["date de paiement", "date paiement", "date de reglement", "paye le", "payment date"] },
  { key: "method", label: "Mode de paiement", aliases: ["mode de paiement", "moyen de paiement", "mode de reglement", "paiement", "payment method"] },
];

/** Intitulés du type de document reconnus → type lu par la reprise. */
const TYPE_NAMES: [RegExp, string][] = [
  [/acompte|deposit/, "facture d'acompte"],
  [/avoir|credit/, "facture d'avoir"],
  [/pro ?forma/, "facture pro forma"],
  [/commande|order/, "bon de commande"],
  [/livraison|delivery/, "bon de livraison"],
  [/intervention/, "bon d'intervention"],
  [/prestation/, "bon de prestation"],
  [/devis|quote|estimate|offre/, "devis"],
  [/facture|invoice/, "facture"],
];
const METHOD_NAMES: [RegExp, string][] = [
  [/cheque|check/, "cheque"], [/espece|cash|liquide/, "especes"], [/carte|card/, "carte bancaire"], [/./, "virement"],
];

const plain = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Date d'un tableur vers JJ/MM/AAAA : accepte 23/11/2026, 23-11-2026, 23.11.26,
 * 2026-11-23 et le numéro de jour d'Excel (46349). Chaîne vide si illisible.
 */
export function sheetDate(v: string | undefined): string {
  const s = String(v ?? "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${pad(Number(m[3]))}/${pad(Number(m[2]))}/${m[1]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?!\d)/.exec(s);
  if (m) return `${pad(Number(m[1]))}/${pad(Number(m[2]))}/${m[3].length === 2 ? `20${m[3]}` : m[3]}`;
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86_400_000);
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  }
  return "";
}

export interface StandardRows {
  /** Lignes dans la disposition de la reprise (en-tête compris), prêtes pour `buildVfImport`. */
  rows: string[][];
  /** Colonnes obligatoires que le fichier ne contient pas (libellés à afficher). */
  missing: string[];
  /** Colonnes reconnues : champ → intitulé du fichier. */
  recognized: Record<string, string>;
}

/** Convertit un tableau au format standard. `missing` non vide : rien n'est converti. */
export function standardToRows(sheet: string[][]): StandardRows {
  const header = sheet[0] ?? [];
  const body = sheet.slice(1);
  const map = mapColumns(header, DOC_FIELDS, body);
  const missing = DOC_FIELDS.filter((f) => f.required && map[f.key] === undefined).map((f) => f.label);
  const recognized = Object.fromEntries(Object.entries(map).map(([k, i]) => [k, header[i]]));
  if (missing.length) return { rows: [], missing, recognized };
  const get = (row: string[], key: string) => (map[key] === undefined ? "" : (row[map[key]] ?? "").trim());

  // Documents dans l'ordre du fichier ; une ligne sans numéro continue le document précédent.
  const groups = new Map<string, string[][]>();
  let current = "";
  for (const row of body) {
    const number = get(row, "number");
    if (number) current = `${plain(get(row, "type"))}|${number}`;
    if (!current) continue;
    groups.set(current, [...(groups.get(current) ?? []), row]);
  }

  const width = C.lines + L.width;
  const head = Array.from({ length: width }, () => "");
  for (const [pos, start] of EXPECTED) head[pos] = start;
  const out: string[][] = [head];

  for (const lines of groups.values()) {
    const first = (key: string) => lines.map((r) => get(r, key)).find((v) => v !== "") ?? "";
    const typeName = plain(first("type")) || "facture";
    const type = TYPE_NAMES.find(([re]) => re.test(typeName))?.[1] ?? first("type");
    const credit = type === "facture d'avoir";
    const sign = credit ? -1 : 1;
    const row = Array.from({ length: C.lines }, () => "");
    let net = 0;
    let vat = 0;
    for (const r of lines) {
      const label = get(r, "label");
      const price = Math.abs(parseNumber(get(r, "price")));
      if (!label && !price) continue;
      const qty = Math.abs(parseNumber(get(r, "qty"))) || 1;
      const discount = Math.min(100, Math.max(0, parseNumber(get(r, "discount"))));
      const rate = map.vat === undefined || get(r, "vat") === "" ? 0 : parseVat(get(r, "vat"));
      const lineNet = Math.round(qty * price * (1 - discount / 100) * 100) / 100;
      const lineVat = Math.round(lineNet * rate) / 100;
      net += lineNet;
      vat += lineVat;
      const block = Array.from({ length: L.width }, () => "");
      block[L.label] = label;
      block[L.qty] = String(qty);
      // Avec une remise, le prix unitaire repris est le prix net : le montant de la ligne reste exact.
      block[L.unitPrice] = String(discount ? Math.round((lineNet / qty) * 100) / 100 : price);
      block[L.rate] = String(rate);
      block[L.vat] = String(sign * lineVat);
      block[L.net] = String(sign * lineNet);
      block[L.unit] = get(r, "unit");
      block[L.description] = get(r, "description");
      row.push(...block);
    }
    const status = plain(first("status"));
    row[C.number] = first("number");
    row[C.type] = type;
    row[C.state] = /refus|rejet|declin/.test(status) ? "rejete" : /accept|sign|valide/.test(status) ? "accepte" : /pay|regl|sold|paid/.test(status) && !/impay|non|partiel|unpaid/.test(status) ? "paye" : "";
    row[C.cancelled] = /annul|cancel/.test(status) ? "oui" : "";
    row[C.date] = sheetDate(first("date"));
    row[C.due] = sheetDate(first("due"));
    row[C.client] = first("client");
    row[C.nif] = first("nif");
    row[C.street] = first("address");
    row[C.city] = first("city");
    row[C.email] = first("email");
    row[C.phone] = first("phone");
    row[C.subject] = first("subject");
    row[C.orderRef] = first("orderRef");
    row[C.corrected] = first("corrected");
    row[C.net] = String(sign * net);
    row[C.vat] = String(sign * vat);
    row[C.gross] = String(sign * (net + vat));
    const paid = parseNumber(first("paid"));
    row[C.paid] = paid ? String(paid) : "";
    row[C.paidOn] = sheetDate(first("paidOn"));
    const method = plain(first("method"));
    row[C.method] = method ? METHOD_NAMES.find(([re]) => re.test(method))![1] : "";
    row[C.currency] = "XAF";
    out.push(row);
  }
  return { rows: out, missing: [], recognized };
}

/** Lignes d'un fichier d'historique, quel que soit son format reconnu. Lève une erreur lisible sinon. */
export function historyRows(sheet: string[][], fileName = "Le fichier"): string[][] {
  if (sheet.length === 0) return [];
  if (!checkVfHeader(sheet[0])) return sheet;
  const std = standardToRows(sheet);
  if (std.missing.length) {
    throw new Error(`${fileName} : ${std.missing.length > 1 ? "colonnes introuvables" : "colonne introuvable"} (${std.missing.join(", ")}). Téléchargez le modèle pour voir les colonnes attendues.`);
  }
  return std.rows;
}

const TEMPLATE_COLUMNS = ["type", "number", "date", "due", "client", "nif", "address", "city", "email", "phone", "subject", "orderRef", "corrected", "label", "description", "qty", "unit", "price", "discount", "vat", "status", "paid", "paidOn", "method"];
const TEMPLATE_ROWS = [
  ["Devis", "D-0001", "05/01/2026", "04/02/2026", "Exemple SARL", "", "Boulevard Triomphal", "Libreville", "contact@exemple.ga", "+241 01 00 00 00", "Site internet", "", "", "Création du site", "Maquette et intégration", "1", "forfait", "1500000", "", "18", "Accepté", "", "", ""],
  ["Facture", "F-0001", "20/01/2026", "19/02/2026", "Exemple SARL", "", "", "", "", "", "Site internet", "BC 2026-014", "", "Création du site", "Maquette et intégration", "1", "forfait", "1500000", "", "18", "Payée", "1961160", "15/02/2026", "Virement"],
  ["Facture", "F-0001", "", "", "", "", "", "", "", "", "", "", "", "Hébergement", "Un an", "12", "mois", "15000", "10", "18", "", "", "", ""],
  ["Avoir", "A-0001", "01/03/2026", "", "Exemple SARL", "", "", "", "", "", "", "", "F-0001", "Hébergement", "Deux mois remboursés", "2", "mois", "13500", "", "18", "", "", "", ""],
];
/** Fichier modèle (point-virgule, lisible par Excel). */
export const DOC_TEMPLATE = [
  TEMPLATE_COLUMNS.map((k) => DOC_FIELDS.find((f) => f.key === k)!.label),
  ...TEMPLATE_ROWS,
].map((r) => r.map((c) => (/[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(";")).join("\r\n") + "\r\n";
