import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVfImport, checkVfHeader, stableHash, vfDate } from "../src/shared/vosfactures.ts";
import { computeTotals, docTaxes, unfreezeLine, type InvoiceLine } from "../src/shared/invoice.ts";
import { checkChange, checkPermission, type Change } from "../src/shared/sync.ts";
import { parseCsv } from "../src/shared/csv.ts";
import { encodeHlc } from "../src/shared/hlc.ts";

/** En-tête de l'export « Documents » de VosFactures (intitulés en double compris). */
export const VF_HEADER = "N°,N° ,Type,Nom,Département vendeur,SIREN du vendeur,Etat,Date de création,Date de vente,Date limite de règlement,Nom,N° FISCAL,N°,N° et nom de rue,Code postal,Ville,Pays,Description additionnelle,Adresse(s) Email,Téléphone,Tél. portable,Total HT,TVA,Total TTC,Total HT XAF,TVA XAF,Total TTC XAF,Mode de règlement,Date de paiement,Montant payé,À payer,Devise,Objet,Escompte en cas de paiement anticipé (%),Taux annuel de pénalité en cas de non paiement,Indemnité forfaitaire de recouvrement,Utilisateur,Facturé,Nom du vendeur,N° de commande,Destinataire,Catégorie,Informations spécifiques ,Réf/code client,Colonne additionnelle,Notes privées,Date d'envoi,Document corrigé,Motif de l'avoir,Type dernière relance,Date dernière relance,Facture d'avoir,Document annulé,Type de TVA,Produit,Qté,PU HT,PU TTC,Taux de TVA,Montant TVA,Total HT,Total TTC,Ligne,Réf.,Unité,Description ,Contenu colonne additionnelle,TVA achat,Prix d'achat TTC,Catégorie,Document lié à,Motif d’exonération";

const cell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
type Line = { label: string; qty: number; pu: number; rate: string; vat: number; net: number; kind?: string; unit?: string; desc?: string; linked?: string };
interface Doc {
  number: string; type: string; state: string; date: string; due?: string; client: string; nif?: string; city?: string; seller?: string;
  net: number; vat: number; gross: number; method?: string; paidOn?: string; paid?: number; subject?: string; corrected?: string; cancelled?: boolean; lines: Line[];
}
/** Une ligne d'export, colonnes à leur position. */
export function vfRow(d: Doc): string {
  const r: (string | number)[] = new Array(54).fill("");
  Object.assign(r, {
    0: 1, 1: d.number, 2: d.type, 3: "SARL", 4: d.seller ?? "ACME", 5: "123 A", 6: d.state, 7: d.date, 9: d.due ?? "", 10: d.client, 11: d.nif ?? "", 15: d.city ?? "Libreville", 16: "GA",
    21: d.net, 22: d.vat, 23: d.gross, 24: d.net, 25: d.vat, 26: d.gross, 27: d.method ?? "Virement bancaire", 28: d.paidOn ?? "", 29: d.paid ?? 0, 30: d.gross - (d.paid ?? 0),
    31: "XAF", 32: d.subject ?? "", 36: "acme", 37: "Non", 47: d.corrected ?? "", 51: "Non", 52: d.cancelled ? "Oui" : "Non",
  });
  for (const l of d.lines) {
    r.push(l.label, l.qty, l.pu, 0, l.rate, l.vat, l.net, l.net + l.vat, l.kind ?? "", "", l.unit ?? "", l.desc ?? "", "", 0, 0, "", l.linked ?? "", "");
  }
  return r.map(cell).join(",");
}
export const vfFile = (docs: Doc[]) => [VF_HEADER, ...docs.map(vfRow)].join("\r\n") + "\r\n";

const DOCS: Doc[] = [
  { number: "DALPHA001", type: "Devis", state: "Accepté", date: "05/01/2020", due: "05/02/2020", client: "ALPHA SA", nif: "111 A", net: 1000000, vat: 180000, gross: 1180000, subject: "Site internet",
    lines: [{ label: "Site internet", qty: 1, pu: 1000000, rate: "18", vat: 180000, net: 1000000, desc: "'- Maquette\r\n'- Développement", linked: "FALPHA001" }] },
  { number: "FALPHA001", type: "Facture", state: "Payé", date: "10/01/2020", due: "10/02/2020", client: "Alpha  SA ", net: 1000000, vat: 180000, gross: 1180000, paid: 1180000, paidOn: "20/01/2020", method: "Chèque",
    lines: [{ label: "Site internet", qty: 1, pu: 1000000, rate: "18", vat: 180000, net: 1000000 }] },
  // Montants avec décimales et prix unitaire arrondi : le total d'origine fait foi.
  { number: "FALPHA002", type: "Facture", state: "Créé", date: "15/03/2020", due: "A la commande", client: "ALPHA SA", net: 450444.41, vat: 81079.99, gross: 531524.4,
    lines: [{ label: "Frais d'agence", qty: 17, pu: 26497, rate: "18", vat: 81079.99, net: 450444.41 }] },
  // Retenue à la source saisie comme une TVA négative.
  { number: "FBETA001", type: "Facture", state: "Payé en partie", date: "04/11/2022", due: "04/12/2022", client: "BETA", net: 1947000, vat: -194700, gross: 1752300, paid: 1000000, paidOn: "10/11/2022",
    lines: [{ label: "Community management", qty: 4, pu: 420750, rate: "-10", vat: -168300, net: 1683000, unit: "mois" }, { label: "Publicité", qty: 4, pu: 66000, rate: "-10", vat: -26400, net: 264000 }] },
  // Facture de solde : lignes de la prestation entière, total diminué de l'acompte.
  { number: "FAGAMMA001", type: "Facture d'acompte", state: "Payé", date: "05/12/2022", due: "05/01/2023", client: "GAMMA", net: 5030000, vat: 905400, gross: 5935400, paid: 5935400, paidOn: "15/12/2022",
    lines: [{ label: "Acompte 50 %", qty: 50, pu: 100600, rate: "18", vat: 905400, net: 5030000 }] },
  { number: "FSGAMMA001", type: "Facture de solde", state: "Créé", date: "23/03/2023", due: "23/04/2023", client: "GAMMA", net: 5030000, vat: 905400, gross: 5935400,
    lines: [{ label: "Solde", qty: 100, pu: 100600, rate: "18", vat: 1810800, net: 10060000 }] },
  // Avoir : ligne avant correction (négative) puis après correction.
  { number: "AALPHA001", type: "Facture d'avoir", state: "Créé", date: "01/04/2020", client: "ALPHA SA", net: -200000, vat: -36000, gross: -236000, corrected: "FALPHA002",
    lines: [{ label: "Frais d'agence", qty: 2, pu: -100000, rate: "18", vat: -36000, net: -200000, kind: "correction_before" }, { label: "Frais d'agence", qty: 2, pu: 0, rate: "18", vat: 0, net: 0, kind: "correction_after" }] },
  { number: "FALPHA003", type: "Facture", state: "Créé", date: "02/05/2023", client: "ALPHA SA", net: 100000, vat: 18000, gross: 118000, cancelled: true,
    lines: [{ label: "Annulée", qty: 1, pu: 100000, rate: "18", vat: 18000, net: 100000 }] },
  { number: "BIALPHA001", type: "Bon d'intervention", state: "Créé", date: "03/05/2023", client: "ALPHA SA", net: 200000, vat: 0, gross: 200000,
    lines: [{ label: "Intervention", qty: 1, pu: 200000, rate: "disabled", vat: 0, net: 200000 }] },
  { number: "DOMEGA001", type: "Devis", state: "Créé", date: "01/06/2023", client: "OMEGA", seller: "AUTRE", net: 10, vat: 0, gross: 10, lines: [{ label: "x", qty: 1, pu: 10, rate: "0", vat: 0, net: 10 }] },
];
export const FILE = vfFile(DOCS);
const totals = (d: Record<string, unknown>) => computeTotals(d.lines as InvoiceLine[], 0, docTaxes(d));

test("VosFactures : en-tête reconnu, dates, empreinte stable", () => {
  assert.equal(checkVfHeader(parseCsv(VF_HEADER)[0]), null);
  assert.match(checkVfHeader(["Nom", "Ville"]) ?? "", /colonne/);
  assert.throws(() => buildVfImport(["Nom;Ville\nA;B\n"]), /non reconnu/);
  assert.equal(vfDate("07/12/2016 14:27"), "2016-12-07");
  assert.equal(vfDate("A la commande"), "");
  assert.equal(stableHash("abc"), stableHash("abc"));
  assert.notEqual(stableHash("abc"), stableHash("abd"));
});

test("VosFactures : documents, clients et encaissements repris avec leurs numéros et montants d'origine", () => {
  const r = buildVfImport([FILE]);
  const by = (n: string) => r.records.find((x) => x.data.number === n)!;
  assert.deepEqual(r.counts, { clients: 4, invoices: 6, credit_notes: 1, quotes: 3, payments: 3, cancelled: 1 });
  assert.deepEqual(r.sellers, { ACME: 9, AUTRE: 1 });
  assert.deepEqual(r.missingYears, ["2021"]);

  // Un seul client « ALPHA SA » malgré la casse et les espaces.
  const alpha = r.records.filter((x) => x.tbl === "clients" && /alpha/i.test(String(x.data.name)));
  assert.equal(alpha.length, 1);
  assert.equal(alpha[0].data.nif, "111 A");
  assert.equal(by("FALPHA001").data.client_id, alpha[0].id);

  // Devis facturé, relié à sa facture ; détail de ligne conservé.
  const quote = by("DALPHA001");
  assert.equal(quote.tbl, "quotes");
  assert.equal(quote.data.status, "invoiced");
  assert.equal(quote.data.invoice_id, by("FALPHA001").id);
  assert.equal((quote.data.lines as InvoiceLine[])[0].description, "- Maquette\n- Développement");
  assert.equal(quote.data.imported, "vosfactures");

  // Facture payée : encaissement daté, par chèque.
  const pay = r.records.find((x) => x.tbl === "payments" && x.data.invoice_id === by("FALPHA001").id)!;
  assert.deepEqual([pay.data.amount, pay.data.date, pay.data.method], [1180000, "2020-01-20", "cheque"]);

  // Décimales : total d'origine arrondi au franc, lignes figées.
  const t2 = totals(by("FALPHA002").data);
  assert.deepEqual([t2.net, t2.vat, t2.payable], [450444, 81080, 531524]);
  assert.equal(by("FALPHA002").data.due_date, "2020-03-15");
  assert.match(String(by("FALPHA002").data.notes), /Règlement : A la commande/);

  // TVA négative = retenue à la source, jamais une TVA négative.
  const beta = by("FBETA001");
  const tb = totals(beta.data);
  assert.deepEqual([tb.net, tb.vat, tb.gross, tb.withholding, tb.payable], [1947000, 0, 1947000, 194700, 1752300]);
  assert.equal(beta.data.withholding_rate, 10);
  assert.ok((beta.data.lines as InvoiceLine[]).every((l) => l.vatRate === 0));

  // Acompte puis solde : chaque facture garde le total qu'elle portait.
  assert.equal(by("FAGAMMA001").data.deposit, true);
  const ts = totals(by("FSGAMMA001").data);
  assert.deepEqual([ts.net, ts.vat, ts.payable], [5030000, 905400, 5935400]);
  assert.equal((by("FSGAMMA001").data.lines as InvoiceLine[])[1].label, "Acompte déjà facturé");

  // Avoir : montants positifs, rattaché à la facture corrigée.
  const credit = by("AALPHA001");
  assert.equal(credit.tbl, "credit_notes");
  assert.deepEqual([totals(credit.data).net, totals(credit.data).gross], [200000, 236000]);
  assert.equal(credit.data.invoice_id, by("FALPHA002").id);
  assert.equal((credit.data.lines as InvoiceLine[]).length, 1);

  // Facture annulée : gardée, hors chiffres. Bon d'intervention : type à part.
  assert.equal(by("FALPHA003").data.status, "cancelled");
  assert.equal(by("BIALPHA001").data.doc_type, "intervention");
  const y2023 = r.years.find((y) => y.year === "2023")!;
  assert.deepEqual([y2023.invoices, y2023.invoicesNet, y2023.due], [1, 5030000, 5935400]);
});

test("VosFactures : relance sans doublon, choix du vendeur, clients déjà présents", () => {
  const a = buildVfImport([FILE]);
  // Même fichier fourni deux fois, ou relancé : mêmes identifiants, rien en double.
  const b = buildVfImport([FILE, FILE]);
  assert.deepEqual(b.records.map((x) => x.id), a.records.map((x) => x.id));
  assert.equal(new Set(a.records.map((x) => `${x.tbl}/${x.id}`)).size, a.records.length);

  const only = buildVfImport([FILE], { sellers: ["ACME"] });
  assert.equal(only.records.some((x) => x.data.number === "DOMEGA001"), false);

  const known = buildVfImport([FILE], { existingClients: [{ id: "cli-existant", name: "Alpha S.A." }] });
  assert.equal(known.records.find((x) => x.data.number === "FALPHA001")!.data.client_id, "cli-existant");
  assert.equal(known.counts.clients, 3);
});

test("Reprise : numéro d'origine accepté pour un document repris, réservé à la direction", () => {
  const r = buildVfImport([FILE]);
  const inv = r.records.find((x) => x.data.number === "FALPHA001")!;
  const c: Change = { id: "op-00000001", tbl: "invoices", row: inv.id, patch: inv.data, hlc: encodeHlc(1, 0, "dev"), device: "dev" };
  assert.equal(checkChange(null, c), null);
  assert.match(checkChange(null, { ...c, patch: { ...inv.data, number: "" } }) ?? "", /numéro d'origine/);
  // Sans marque de reprise, la règle de série continue de s'appliquer.
  const { imported: _i, ...plain } = inv.data;
  assert.match(checkChange(null, { ...c, patch: plain }) ?? "", /numéro de sa série/);
  assert.equal(checkPermission({ userId: "u", role: "admin" }, null, c), null);
  assert.match(checkPermission({ userId: "u", role: "sales" }, null, c) ?? "", /réservée à la direction/);
  // Une fois repris, le document est figé comme tout document numéroté.
  const existing = { tbl: "invoices" as const, id: inv.id, data: inv.data, clocks: {} };
  assert.match(checkChange(existing, { ...c, patch: { lines: [] } }) ?? "", /non modifiable/);
});

test("Ligne figée : montants d'origine, recalcul dès qu'on la libère", () => {
  const l: InvoiceLine = { label: "x", qty: 17, unitPrice: 26497, vatRate: 18, net: 450444, vat: 81080 };
  assert.deepEqual([computeTotals([l]).net, computeTotals([l]).vat], [450444, 81080]);
  const free = unfreezeLine(l);
  assert.deepEqual([computeTotals([free]).net, computeTotals([free]).vat], [450449, 81081]);
});
