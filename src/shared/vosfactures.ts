/**
 * Reprise de l'historique VosFactures (export CSV « Documents », une ligne par document,
 * les lignes de produits répétées par blocs de 18 colonnes à la suite).
 *
 * Principes :
 *  - le numéro d'origine est conservé tel quel (champ `number`), le document porte
 *    `imported: "vosfactures"` et ne consomme aucun numéro des séries de Gestia ;
 *  - les montants sont ceux du document d'origine, arrondis au franc : chaque ligne porte
 *    son HT et sa TVA figés (`net`, `vat`), le total du document est donc exact ;
 *  - une TVA négative dans VosFactures est une retenue à la source : elle devient la
 *    retenue figée du document (`withholding_amount`), jamais une TVA négative ;
 *  - l'identifiant de chaque ligne créée est calculé à partir du contenu : relancer la
 *    reprise avec les mêmes fichiers ne crée aucun doublon.
 *
 * L'en-tête du fichier porte des intitulés en double (N°, Nom, Total HT, Catégorie) :
 * les colonnes sont lues par position, après contrôle de quelques intitulés repères.
 */
import { parseCsv } from "./csv.ts";
import type { InvoiceLine } from "./invoice.ts";
import type { QuoteType } from "./documents.ts";

export const VF_SOURCE = "vosfactures";

/** Positions des colonnes du document. */
const C = {
  number: 1, type: 2, seller: 4, state: 6, date: 7, saleDate: 8, due: 9,
  client: 10, nif: 11, street: 13, zip: 14, city: 15, country: 16, extra: 17, email: 18, phone: 19, mobile: 20,
  net: 21, vat: 22, gross: 23, method: 27, paidOn: 28, paid: 29, currency: 31, subject: 32,
  sellerName: 38, orderRef: 39, recipient: 40, info: 42, privateNotes: 45, sentAt: 46, corrected: 47, creditReason: 48, cancelled: 52,
  lines: 54,
} as const;
/** Positions dans un bloc de ligne de produit. */
const L = { label: 0, qty: 1, unitPrice: 2, rate: 4, vat: 5, net: 6, kind: 8, unit: 10, description: 11, linked: 16, width: 18 } as const;

/** Intitulés repères : position → début attendu (sans accents, en minuscules). */
const EXPECTED: [number, string][] = [
  [C.type, "type"], [C.state, "etat"], [C.date, "date de creation"], [C.net, "total ht"], [C.gross, "total ttc"],
  [C.paid, "montant paye"], [C.cancelled, "document annule"], [C.lines, "produit"], [C.lines + L.rate, "taux de tva"],
];

const plain = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
const num = (s: string | undefined) => {
  const n = Number(String(s ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const round = (n: number) => Math.round(n + (n >= 0 ? Number.EPSILON : -Number.EPSILON));

/** JJ/MM/AAAA (suivi ou non d'une heure) → AAAA-MM-JJ, sinon chaîne vide. */
export function vfDate(s: string | undefined): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s ?? "").trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}

/** Empreinte stable (FNV-1a, deux passes de 32 bits) : 16 caractères hexadécimaux. */
export function stableHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ (c + i), 0x85ebca6b);
    b ^= b >>> 13;
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return hex(a) + hex(b);
}

export type VfKind = "invoices" | "credit_notes" | "quotes";

interface TypeRule { tbl: VfKind; docType?: QuoteType; deposit?: boolean; balance?: boolean; label: string }

/** Type VosFactures (sans accents, en minuscules) → table et type Gestia. */
const TYPES: Record<string, TypeRule> = {
  "facture": { tbl: "invoices", label: "Factures" },
  "facture d'acompte": { tbl: "invoices", deposit: true, label: "Factures d'acompte" },
  "facture de solde": { tbl: "invoices", balance: true, label: "Factures de solde" },
  "facture d'avoir": { tbl: "credit_notes", label: "Avoirs" },
  "devis": { tbl: "quotes", docType: "quote", label: "Devis" },
  "facture pro forma": { tbl: "quotes", docType: "proforma", label: "Factures pro forma" },
  "bon de commande": { tbl: "quotes", docType: "order", label: "Bons de commande" },
  "bon de livraison": { tbl: "quotes", docType: "delivery", label: "Bons de livraison" },
  "bon d'intervention": { tbl: "quotes", docType: "intervention", label: "Bons d'intervention" },
};

const METHODS: Record<string, string> = { "virement bancaire": "transfer", "virement": "transfer", "cheque": "cheque", "especes": "cash", "carte bancaire": "card" };

export interface VfRecord { tbl: "clients" | VfKind | "payments"; id: string; data: Record<string, unknown> }

export interface VfYearControl {
  year: string;
  /** Factures (acomptes et soldes compris), hors documents annulés. */
  invoices: number;
  invoicesNet: number;
  invoicesVat: number;
  invoicesPayable: number;
  credits: number;
  creditsNet: number;
  paid: number;
  due: number;
  quotes: number;
  others: number;
}

export interface VfImport {
  /** Enregistrements à créer, dans l'ordre : clients, documents, encaissements. */
  records: VfRecord[];
  /** Nombre de documents lus par vendeur (« Département vendeur »). */
  sellers: Record<string, number>;
  counts: { clients: number; invoices: number; credit_notes: number; quotes: number; payments: number; cancelled: number };
  years: VfYearControl[];
  /** Années sans aucun document entre la première et la dernière : un fichier manque sans doute. */
  missingYears: string[];
  /** Documents écartés ou points à vérifier, en clair. */
  warnings: string[];
  /** Écart le plus grand, en francs, entre le total d'origine et le total repris d'un document. */
  maxRounding: number;
}

export interface VfOptions {
  /** Vendeurs à reprendre (tous si absent). */
  sellers?: string[];
  /** Clients déjà présents : nom → identifiant, pour ne pas les créer deux fois. */
  existingClients?: { id: string; name: string }[];
}

/** Champs qu'une nouvelle reprise peut ajouter à un document déjà repris, s'ils y sont encore vides. */
export { IMPORT_COMPLEMENT_FIELDS as VF_COMPLEMENT_FIELDS } from "./sync.ts";

/** Clé de rapprochement d'un nom de client. */
export const clientKey = (name: string) => plain(name).replace(/[^a-z0-9]/g, "");

interface RawLine { label: string; qty: number; unitPrice: number; rate: string; vat: number; net: number; kind: string; unit: string; description: string; linked: string }
interface RawDoc {
  row: string[]; rule: TypeRule; number: string; date: string; seller: string; client: string;
  net: number; vat: number; gross: number; lines: RawLine[]; cancelled: boolean; id: string;
}

/** Vérifie l'en-tête. Retourne la raison du refus, ou null. */
export function checkVfHeader(header: string[]): string | null {
  for (const [pos, start] of EXPECTED) {
    if (!plain(header[pos] ?? "").startsWith(start)) return `colonne ${pos + 1} : « ${start} » attendu, « ${header[pos] ?? ""} » trouvé`;
  }
  return null;
}

/** Répartit `target` entre des parts entières proches de `values` (le reste va à la plus grande). */
function allocate(values: number[], target: number): number[] {
  const out = values.map(round);
  const rest = target - out.reduce((a, b) => a + b, 0);
  if (rest !== 0 && out.length > 0) {
    let k = 0;
    for (let i = 1; i < out.length; i++) if (Math.abs(values[i]) > Math.abs(values[k])) k = i;
    out[k] += rest;
  }
  return out;
}

function readLines(row: string[]): RawLine[] {
  const out: RawLine[] = [];
  for (let i = C.lines; i + L.net < row.length; i += L.width) {
    const b = row.slice(i, i + L.width);
    if (!b.some((x) => x && x.trim() !== "")) continue;
    out.push({
      label: (b[L.label] ?? "").trim(), qty: num(b[L.qty]), unitPrice: num(b[L.unitPrice]), rate: (b[L.rate] ?? "").trim(),
      vat: num(b[L.vat]), net: num(b[L.net]), kind: (b[L.kind] ?? "").trim(), unit: (b[L.unit] ?? "").trim(),
      description: (b[L.description] ?? "").replace(/\r\n?/g, "\n").replace(/^'-/gm, "-").trim(), linked: (b[L.linked] ?? "").trim(),
    });
  }
  return out;
}

/**
 * Lit un ou plusieurs exports et prépare les enregistrements Gestia.
 * `files` : contenu texte de chaque fichier CSV.
 */
export function buildVfImport(files: string[], options: VfOptions = {}): VfImport {
  const warnings: string[] = [];
  const sellers: Record<string, number> = {};
  const docs: RawDoc[] = [];
  const seenRows = new Set<string>();
  const usedIds = new Map<string, number>();
  const unknownTypes = new Map<string, number>();
  const currencies = new Map<string, number>();

  files.forEach((content, f) => {
    // Accents recomposés (NFC) : certains exports les donnent en deux caractères, illisibles dans le PDF.
    const rows = parseCsv(content.normalize("NFC"));
    if (rows.length === 0) return;
    const bad = checkVfHeader(rows[0]);
    if (bad) throw new Error(`Fichier ${f + 1} non reconnu comme un export de documents VosFactures (${bad}).`);
    for (const row of rows.slice(1)) {
      // Le même document exporté dans deux fichiers n'est repris qu'une fois.
      const signature = row.slice(1).join("\u0001");
      if (seenRows.has(signature)) continue;
      seenRows.add(signature);
      const seller = (row[C.seller] ?? "").trim() || "(sans vendeur)";
      sellers[seller] = (sellers[seller] ?? 0) + 1;
      if (options.sellers && !options.sellers.includes(seller)) continue;
      const typeName = plain(row[C.type] ?? "").replace(/’/g, "'");
      const rule = TYPES[typeName];
      if (!rule) {
        unknownTypes.set(row[C.type] ?? "", (unknownTypes.get(row[C.type] ?? "") ?? 0) + 1);
        continue;
      }
      const currency = (row[C.currency] ?? "").trim() || "XAF";
      if (currency !== "XAF") {
        currencies.set(currency, (currencies.get(currency) ?? 0) + 1);
        continue;
      }
      const number = (row[C.number] ?? "").trim();
      const date = vfDate(row[C.date]);
      if (!number || !date) {
        warnings.push(`Document sans numéro ou sans date ignoré (${row[C.type]} ${number || "?"}).`);
        continue;
      }
      const client = (row[C.client] ?? "").trim();
      const key = [typeName, number, date, clientKey(client), row[C.gross]].join("|");
      const n = usedIds.get(key) ?? 0;
      usedIds.set(key, n + 1);
      const prefix = rule.tbl === "invoices" ? "fac" : rule.tbl === "credit_notes" ? "av" : "dev";
      docs.push({
        row, rule, number, date, seller, client,
        net: num(row[C.net]), vat: num(row[C.vat]), gross: num(row[C.gross]), lines: readLines(row),
        cancelled: plain(row[C.cancelled] ?? "") === "oui", id: `${prefix}-vf-${stableHash(n ? `${key}|${n}` : key)}`,
      });
    }
  });
  for (const [t, n] of unknownTypes) warnings.push(`${n} document(s) de type « ${t} » non repris (type inconnu de Gestia).`);
  for (const [c, n] of currencies) warnings.push(`${n} document(s) en ${c} non repris (seuls les documents en francs CFA le sont).`);

  // Clients : un par nom (rapproché sans casse, accents ni ponctuation), fiche la plus récente et la plus complète.
  const known = new Map((options.existingClients ?? []).map((c) => [clientKey(c.name), c.id]));
  const clientIds = new Map<string, string>();
  const clientData = new Map<string, Record<string, unknown>>();
  for (const d of [...docs].sort((a, b) => a.date.localeCompare(b.date))) {
    const k = clientKey(d.client) || "clientinconnu";
    if (known.has(k)) {
      clientIds.set(k, known.get(k)!);
      continue;
    }
    clientIds.set(k, `cli-vf-${stableHash(k)}`);
    const r = d.row;
    const fresh: Record<string, unknown> = {
      name: d.client.replace(/\s+/g, " ") || "Client inconnu",
      nif: (r[C.nif] ?? "").trim(),
      address: [(r[C.street] ?? "").trim(), (r[C.zip] ?? "").trim() && `BP ${(r[C.zip] ?? "").trim().replace(/^BP\s*/i, "")}`].filter(Boolean).join(", "),
      city: (r[C.city] ?? "").trim(),
      country: (r[C.country] ?? "").trim(),
      email: (r[C.email] ?? "").trim(),
      phone: (r[C.phone] ?? "").trim() || (r[C.mobile] ?? "").trim(),
    };
    const prev = clientData.get(k) ?? {};
    // La fiche la plus récente l'emporte, sans effacer un champ renseigné par un champ vide.
    const merged: Record<string, unknown> = { ...prev };
    for (const [f, v] of Object.entries(fresh)) if (v !== "" || !(f in merged)) merged[f] = v;
    clientData.set(k, merged);
  }

  const byNumber = new Map<string, RawDoc[]>();
  for (const d of docs) byNumber.set(d.number, [...(byNumber.get(d.number) ?? []), d]);
  /** Document d'une table donnée portant ce numéro, le plus proche en date. */
  const find = (number: string, tbl: VfKind, near: string, after = false): RawDoc | null => {
    const c = (byNumber.get(number.trim()) ?? []).filter((d) => d.rule.tbl === tbl && !d.cancelled && (!after || d.date >= near));
    if (c.length === 0) return null;
    const gap = (d: RawDoc) => Math.abs(Date.parse(d.date) - Date.parse(near));
    return c.reduce((best, d) => (gap(d) < gap(best) ? d : best));
  };

  const documents: VfRecord[] = [];
  const payments: VfRecord[] = [];
  const years = new Map<string, VfYearControl>();
  const yearOf = (y: string) => {
    if (!years.has(y)) years.set(y, { year: y, invoices: 0, invoicesNet: 0, invoicesVat: 0, invoicesPayable: 0, credits: 0, creditsNet: 0, paid: 0, due: 0, quotes: 0, others: 0 });
    return years.get(y)!;
  };
  const counts = { clients: clientData.size, invoices: 0, credit_notes: 0, quotes: 0, payments: 0, cancelled: 0 };
  let maxRounding = 0;

  for (const d of docs) {
    const r = d.row;
    const credit = d.rule.tbl === "credit_notes";
    const sign = credit ? -1 : 1;
    // Montants du document, en francs entiers. Net à payer = TTC d'origine.
    const N = round(sign * d.net);
    const P = round(sign * d.gross);
    maxRounding = Math.max(maxRounding, Math.abs(sign * d.gross - P), Math.abs(sign * d.net - N));

    // Avoir : VosFactures donne la ligne avant et après correction ; on garde la différence.
    let raw = d.lines;
    if (credit) {
      const merged: RawLine[] = [];
      for (const l of raw) {
        const last = merged[merged.length - 1];
        if (l.kind === "correction_after" && last && last.kind === "correction_before") {
          last.net += l.net;
          last.vat += l.vat;
          if (l.net !== 0) { last.qty = 1; last.unitPrice = last.net; }
          last.kind = "merged";
        } else merged.push({ ...l });
      }
      raw = merged.filter((l) => l.net !== 0 || l.vat !== 0).map((l) => ({ ...l, net: -l.net, vat: -l.vat, unitPrice: Math.abs(l.unitPrice), qty: Math.abs(l.qty) || 1 }));
    }
    // Facture de solde : les lignes reprennent la prestation entière, le total déduit l'acompte.
    const sumNet = raw.reduce((a, l) => a + l.net, 0);
    if (!credit && raw.length > 0 && Math.abs(sumNet - d.net) > 1 && sumNet > d.net) {
      const sumVat = raw.reduce((a, l) => a + l.vat, 0);
      const main = raw.reduce((best, l) => (Math.abs(l.net) > Math.abs(best.net) ? l : best));
      raw = [...raw, { label: "Acompte déjà facturé", qty: 1, unitPrice: d.net - sumNet, rate: main.rate, vat: d.vat - sumVat, net: d.net - sumNet, kind: "", unit: "", description: "", linked: "" }];
    }

    // Une TVA négative est une retenue à la source opérée par le client.
    const withheld = raw.map((l) => (l.vat < 0 && l.net > 0 ? -l.vat : 0));
    const taxed = raw.map((l, i) => (withheld[i] !== 0 ? 0 : l.vat));
    const hasWithholding = withheld.some((w) => w !== 0);
    const hasVat = taxed.some((v) => v !== 0);
    // Net à payer = HT + TVA − retenue. Sans retenue, la TVA est l'écart TTC − HT ; avec retenue,
    // la TVA est celle des lignes taxées et la retenue absorbe l'arrondi.
    const V = hasWithholding ? round(taxed.reduce((a, b) => a + b, 0)) : hasVat ? P - N : 0;
    const withholding = N + V - P;
    const nets = allocate(raw.map((l) => l.net), N);
    const vats = hasVat ? allocate(taxed, V) : taxed.map(() => 0);

    const lines: InvoiceLine[] = raw.map((l, i) => {
      const qty = l.qty || 1;
      const rate = withheld[i] !== 0 || vats[i] === 0 ? 0 : Math.abs(num(l.rate)) || (nets[i] ? Math.round((vats[i] / nets[i]) * 1000) / 10 : 0);
      const line: InvoiceLine = {
        label: l.label || "(sans désignation)", qty,
        // Le prix unitaire d'origine est gardé s'il redonne le montant ; sinon il est recalculé.
        unitPrice: Math.abs(qty * l.unitPrice - l.net) <= 1 ? l.unitPrice : Math.round((l.net / qty) * 100) / 100,
        vatRate: rate, net: nets[i], vat: vats[i],
      };
      if (l.unit) line.unit = l.unit;
      if (l.description) line.description = l.description;
      return line;
    });

    const state = plain(r[C.state] ?? "");
    const dueDate = vfDate(r[C.due]);
    const terms = dueDate ? "" : (r[C.due] ?? "").trim();
    const subject = (r[C.subject] ?? "").trim();
    const extra = (r[C.extra] ?? "").replace(/\r\n?/g, "\n").trim();
    // Références remises à leur place : la « description additionnelle » et le « destinataire » de
    // VosFactures portent la référence de commande du client (ordre d'achat, lettre de commande…).
    const clean = (v: string | undefined) => (v ?? "").replace(/\r\n?/g, "\n").replace(/^'\s?/gm, "").trim();
    const orderRef = (r[C.orderRef] ?? "").trim();
    const recipient = clean(r[C.recipient]);
    const clientRef = [extra, recipient !== extra && recipient, orderRef && `Commande n° ${orderRef}`].filter(Boolean).join("\n");
    const info = clean(r[C.info]);
    const notes = "";
    const data: Record<string, unknown> = {
      number: d.number, date: d.date, client_id: clientIds.get(clientKey(d.client) || "clientinconnu"),
      lines, currency: "XAF", rate: 1, notes, subject, client_ref: clientRef, payment_terms: terms, import_info: info,
      seller_name: (r[C.sellerName] ?? "").trim(), project_id: "",
      imported: VF_SOURCE, import_v: 2, import_type: (r[C.type] ?? "").trim(), import_seller: d.seller,
      created_by_name: "Reprise VosFactures",
    };
    const sent = vfDate(r[C.sentAt]);
    if (sent) data.sent_at = `${sent}T12:00:00.000Z`;
    if ((r[C.privateNotes] ?? "").trim()) data.private_notes = (r[C.privateNotes] ?? "").trim();
    if (withholding !== 0) {
      const rates = new Set(raw.filter((_, i) => withheld[i] !== 0).map((l) => Math.abs(num(l.rate))));
      const uniform = rates.size === 1 && withheld.every((w) => w !== 0) ? [...rates][0] : 0;
      Object.assign(data, {
        withholding_amount: withholding,
        withholding_rate: uniform || (N ? Math.round((withholding / N) * 10000) / 100 : 0),
        withholding_label: "",
      });
    }
    const y = yearOf(d.date.slice(0, 4));

    if (d.rule.tbl === "quotes") {
      const linked = [...new Set(d.lines.flatMap((l) => l.linked.split(",").map((x) => x.trim())).filter(Boolean))];
      const invoice = linked.map((n) => find(n, "invoices", d.date, true)).find(Boolean) ?? null;
      let status = state === "rejete" ? "refused" : state === "accepte" || state.startsWith("paye") ? "accepted" : "sent";
      if (d.rule.docType === "quote" || d.rule.docType === "proforma") {
        if (invoice && status !== "refused") status = "invoiced";
      } else {
        // Un bon repris est un bon passé : livré, exécuté.
        status = "accepted";
      }
      if (d.cancelled) status = "refused";
      Object.assign(data, {
        status, doc_type: d.rule.docType,
        // Sans date de validité, un devis ancien resterait « en cours » pour toujours.
        valid_until: d.rule.docType === "delivery" ? "" : dueDate || addDaysIso(d.date, 30),
      });
      if (invoice && status === "invoiced") data.invoice_id = invoice.id;
      counts.quotes++;
      if (d.rule.docType === "quote") y.quotes++; else y.others++;
    } else if (credit) {
      const source = find(r[C.corrected] ?? "", "invoices", d.date);
      Object.assign(data, { status: "validated", invoice_number: (r[C.corrected] ?? "").trim() });
      if (source) data.invoice_id = source.id;
      else if ((r[C.corrected] ?? "").trim()) warnings.push(`Avoir ${d.number} : la facture corrigée ${(r[C.corrected] ?? "").trim()} n'est pas dans les fichiers.`);
      if ((r[C.creditReason] ?? "").trim()) data.notes = [notes, `Motif : ${(r[C.creditReason] ?? "").trim()}`].filter(Boolean).join("\n");
      if (d.cancelled) data.status = "cancelled";
      counts.credit_notes++;
      if (!d.cancelled) { y.credits++; y.creditsNet += N; }
    } else {
      Object.assign(data, { status: d.cancelled ? "cancelled" : "validated", due_date: dueDate || d.date });
      if (d.rule.deposit) data.deposit = true;
      counts.invoices++;
      if (d.cancelled) counts.cancelled++;
      else {
        // Encaissement : montant payé d'origine ; une facture « Payée » sans montant est soldée.
        let paid = round(num(r[C.paid]));
        if (state === "paye" && paid <= 0) paid = P;
        if (state === "paye" && Math.abs(paid - P) <= 1) paid = P;
        paid = Math.max(0, Math.min(paid, Math.max(P, 0)));
        if (paid > 0) {
          payments.push({
            tbl: "payments", id: `pay-vf-${d.id.slice(7)}`,
            data: {
              invoice_id: d.id, client_id: data.client_id, date: vfDate(r[C.paidOn]) || d.date, amount: paid, currency: "XAF", rate: 1,
              method: METHODS[plain(r[C.method] ?? "")] ?? "transfer", reference: "", imported: VF_SOURCE, created_by_name: "Reprise VosFactures",
            },
          });
          counts.payments++;
        }
        y.invoices++;
        y.invoicesNet += N;
        y.invoicesVat += hasVat ? V : 0;
        y.invoicesPayable += P;
        y.paid += paid;
        y.due += Math.max(0, P - paid);
      }
    }
    documents.push({ tbl: d.rule.tbl, id: d.id, data });
  }

  const list = [...years.values()].sort((a, b) => a.year.localeCompare(b.year));
  const missingYears: string[] = [];
  if (list.length > 1) {
    for (let y = Number(list[0].year) + 1; y < Number(list[list.length - 1].year); y++) if (!years.has(String(y))) missingYears.push(String(y));
  }
  const clients: VfRecord[] = [...clientData].map(([k, data]) => ({ tbl: "clients", id: clientIds.get(k)!, data: { ...data, imported: VF_SOURCE } }));
  return { records: [...clients, ...documents, ...payments], sellers, counts, years: list, missingYears, warnings, maxRounding };
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
