/**
 * Comptabilité générale SYSCOHADA révisé.
 *
 * Les écritures ne sont pas saisies : elles sont déduites des opérations
 * (factures, avoirs, encaissements, dépenses validés) à chaque calcul, sur
 * l'appareil. Une seule source de vérité, aucune double saisie, et les états
 * restent disponibles hors ligne. Seules les opérations diverses (OD) sont saisies.
 */
import type { InvoiceLine } from "./invoice.ts";

/** Ligne minimale d'une table synchronisée (même forme que SyncRecord). */
export interface Rec {
  id: string;
  data: Record<string, unknown>;
}

/** Extrait du plan comptable SYSCOHADA révisé, complété des sous-comptes de trésorerie usuels. */
export const CHART: Record<string, string> = {
  "101": "Capital social",
  "111": "Réserve légale",
  "121": "Report à nouveau créditeur",
  "129": "Report à nouveau débiteur",
  "131": "Résultat net : bénéfice",
  "139": "Résultat net : perte",
  "162": "Emprunts auprès des établissements de crédit",
  "213": "Logiciels",
  "244": "Matériel et mobilier",
  "245": "Matériel de transport",
  "31": "Marchandises",
  "401": "Fournisseurs",
  "411": "Clients",
  "419": "Clients, avances reçues",
  "421": "Personnel, rémunérations dues",
  "431": "Sécurité sociale",
  "4431": "État, TVA facturée sur ventes",
  "4441": "État, TVA due",
  "4449": "État, crédit de TVA à reporter",
  "4452": "État, TVA récupérable sur achats",
  "4454": "État, TVA récupérable sur services extérieurs",
  "447": "État, impôts retenus à la source",
  "471": "Comptes d'attente",
  "521": "Banques",
  "5215": "Airtel Money",
  "5216": "Moov Money",
  "571": "Caisse",
  "585": "Virements de fonds",
  "601": "Achats de marchandises",
  "6042": "Matières combustibles",
  "6047": "Fournitures de bureau",
  "605": "Autres achats (eau, électricité)",
  "618": "Autres frais de transport",
  "622": "Locations et charges locatives",
  "624": "Entretien, réparations et maintenance",
  "625": "Primes d'assurance",
  "627": "Publicité, publications, relations publiques",
  "628": "Frais de télécommunications",
  "631": "Frais bancaires",
  "632": "Rémunérations d'intermédiaires et de conseils",
  "641": "Impôts et taxes directs",
  "658": "Charges diverses",
  "661": "Rémunérations directes versées au personnel",
  "664": "Charges sociales",
  "671": "Intérêts des emprunts",
  "701": "Ventes de marchandises",
  "706": "Services vendus",
  "707": "Produits accessoires",
  "758": "Produits divers",
};

export function accountLabel(account: string): string {
  if (CHART[account]) return CHART[account];
  // Remonte au compte parent connu : 6011 → 601.
  for (let n = account.length - 1; n >= 2; n--) {
    const parent = CHART[account.slice(0, n)];
    if (parent) return parent;
  }
  return `Compte ${account}`;
}

/** Catégories de dépenses et leur compte de charges. */
export const EXPENSE_CATEGORIES: Record<string, { label: string; account: string; vatAccount: string }> = {
  goods: { label: "Achats de marchandises", account: "601", vatAccount: "4452" },
  supplies: { label: "Fournitures et petit matériel", account: "6047", vatAccount: "4452" },
  fuel: { label: "Carburant", account: "6042", vatAccount: "4452" },
  transport: { label: "Transport et déplacements", account: "618", vatAccount: "4454" },
  rent: { label: "Loyer", account: "622", vatAccount: "4454" },
  utilities: { label: "Eau et électricité", account: "605", vatAccount: "4452" },
  telecom: { label: "Téléphone et internet", account: "628", vatAccount: "4454" },
  maintenance: { label: "Entretien et réparations", account: "624", vatAccount: "4454" },
  insurance: { label: "Assurances", account: "625", vatAccount: "4454" },
  advertising: { label: "Publicité", account: "627", vatAccount: "4454" },
  fees: { label: "Honoraires", account: "632", vatAccount: "4454" },
  bank: { label: "Frais bancaires", account: "631", vatAccount: "4454" },
  taxes: { label: "Impôts et taxes", account: "641", vatAccount: "4454" },
  other: { label: "Autres charges", account: "658", vatAccount: "4454" },
};

/** Moyen de paiement → compte et journal de trésorerie. */
export const TREASURY: Record<string, { account: string; journal: string }> = {
  cash: { account: "571", journal: "CA" },
  transfer: { account: "521", journal: "BQ" },
  cheque: { account: "521", journal: "BQ" },
  card: { account: "521", journal: "BQ" },
  airtel: { account: "5215", journal: "MM" },
  moov: { account: "5216", journal: "MM" },
};

export const JOURNALS: Record<string, string> = {
  VE: "Ventes",
  CA: "Caisse",
  BQ: "Banque",
  MM: "Mobile money",
  OD: "Opérations diverses",
};

export interface EntryLine {
  account: string;
  /** Compte auxiliaire (client) pour le lettrage et la balance auxiliaire. */
  aux?: string;
  label: string;
  debit: number;
  credit: number;
}

export interface Entry {
  /** Identifiant stable : table d'origine + identifiant de la ligne. */
  id: string;
  journal: string;
  date: string;
  ref: string;
  label: string;
  source: { tbl: string; id: string };
  lines: EntryLine[];
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const num = (v: unknown) => Number(v ?? 0) || 0;

/** Montants HT et TVA par compte de produit, arrondis ligne par ligne comme sur la facture. */
function salesSplit(lines: InvoiceLine[], productIds: Set<string>) {
  const byAccount = new Map<string, number>();
  let vat = 0;
  for (const l of lines) {
    const net = Math.round(l.qty * l.unitPrice);
    const account = l.articleId && productIds.has(l.articleId) ? "701" : "706";
    byAccount.set(account, (byAccount.get(account) ?? 0) + net);
    vat += Math.round((net * l.vatRate) / 100);
  }
  return { byAccount, vat };
}

export interface LedgerInput {
  invoices: Rec[];
  credit_notes: Rec[];
  payments: Rec[];
  expenses: Rec[];
  journal_entries: Rec[];
  articles: Rec[];
  clients: Rec[];
}

/** Toutes les écritures, triées par date puis par pièce. */
export function generateEntries(input: LedgerInput): Entry[] {
  const products = new Set(input.articles.filter((a) => a.data.kind === "product").map((a) => a.id));
  const clientName = new Map(input.clients.map((c) => [c.id, str(c.data.name)]));
  const invoiceById = new Map(input.invoices.map((i) => [i.id, i]));
  const entries: Entry[] = [];

  const sale = (r: Rec, tbl: "invoices" | "credit_notes", sign: 1 | -1) => {
    if (r.data.status !== "validated") return;
    const lines = (r.data.lines as InvoiceLine[]) ?? [];
    const { byAccount, vat } = salesSplit(lines, products);
    const net = [...byAccount.values()].reduce((a, b) => a + b, 0);
    const gross = net + vat;
    if (gross === 0) return;
    const client = str(r.data.client_id);
    const name = clientName.get(client) ?? "Client";
    const kind = sign === 1 ? "Facture" : "Avoir";
    const label = `${kind} ${str(r.data.number)} ${name}`;
    // Une facture : débit client, crédit produits et TVA. Un avoir : l'inverse.
    const dc = (amount: number, debitSide: boolean) =>
      (debitSide === (sign === 1)) ? { debit: amount, credit: 0 } : { debit: 0, credit: amount };
    const out: EntryLine[] = [{ account: "411", aux: client, label, ...dc(gross, true) }];
    for (const [account, amount] of byAccount) if (amount) out.push({ account, label, ...dc(amount, false) });
    if (vat) out.push({ account: "4431", label, ...dc(vat, false) });
    entries.push({ id: `${tbl}/${r.id}`, journal: "VE", date: str(r.data.date), ref: str(r.data.number), label, source: { tbl, id: r.id }, lines: out });
  };
  input.invoices.forEach((r) => sale(r, "invoices", 1));
  input.credit_notes.forEach((r) => sale(r, "credit_notes", -1));

  for (const p of input.payments) {
    const amount = Math.round(num(p.data.amount));
    if (amount <= 0) continue;
    const t = TREASURY[str(p.data.method)] ?? TREASURY.cash;
    const inv = invoiceById.get(str(p.data.invoice_id));
    const client = str(p.data.client_id || inv?.data.client_id);
    const ref = str(inv?.data.number);
    const label = `Règlement ${ref} ${clientName.get(client) ?? ""}`.trim();
    entries.push({
      id: `payments/${p.id}`, journal: t.journal, date: str(p.data.date), ref, label, source: { tbl: "payments", id: p.id },
      lines: [
        { account: t.account, label, debit: amount, credit: 0 },
        { account: "411", aux: client, label, debit: 0, credit: amount },
      ],
    });
  }

  for (const e of input.expenses) {
    if (e.data.status === "pending" || e.data.status === "rejected") continue;
    const gross = Math.round(num(e.data.amount));
    if (gross <= 0) continue;
    const cat = EXPENSE_CATEGORIES[str(e.data.category)] ?? EXPENSE_CATEGORIES.other;
    const rate = num(e.data.vat_rate);
    const net = rate ? Math.round(gross / (1 + rate / 100)) : gross;
    const vat = gross - net;
    const t = TREASURY[str(e.data.method)] ?? TREASURY.cash;
    const label = [str(e.data.supplier), str(e.data.description)].filter(Boolean).join(" · ") || cat.label;
    const lines: EntryLine[] = [{ account: cat.account, label, debit: net, credit: 0 }];
    if (vat) lines.push({ account: cat.vatAccount, label, debit: vat, credit: 0 });
    lines.push({ account: t.account, label, debit: 0, credit: gross });
    entries.push({ id: `expenses/${e.id}`, journal: t.journal, date: str(e.data.date), ref: str(e.data.reference), label, source: { tbl: "expenses", id: e.id }, lines });
  }

  for (const j of input.journal_entries) {
    const lines = ((j.data.lines as EntryLine[]) ?? [])
      .map((l) => ({ account: str(l.account).trim(), label: str(l.label) || str(j.data.label), debit: Math.round(num(l.debit)), credit: Math.round(num(l.credit)) }))
      .filter((l) => l.account && (l.debit || l.credit));
    if (lines.length === 0) continue;
    entries.push({
      id: `journal_entries/${j.id}`, journal: str(j.data.journal) || "OD", date: str(j.data.date), ref: str(j.data.ref),
      label: str(j.data.label), source: { tbl: "journal_entries", id: j.id }, lines,
    });
  }

  return entries.sort((a, b) => a.date.localeCompare(b.date) || a.journal.localeCompare(b.journal) || a.ref.localeCompare(b.ref));
}

export function isBalanced(lines: { debit: number; credit: number }[]): boolean {
  const d = lines.reduce((n, l) => n + l.debit, 0);
  const c = lines.reduce((n, l) => n + l.credit, 0);
  return d === c && d > 0;
}

export const inPeriod = (date: string, from: string, to: string) => date >= from && date <= to;

export interface BalanceRow {
  account: string;
  label: string;
  debit: number;
  credit: number;
  /** Solde : positif = débiteur, négatif = créditeur. */
  balance: number;
}

/** Balance générale sur une période (mouvements et soldes par compte). */
export function trialBalance(entries: Entry[], from: string, to: string): BalanceRow[] {
  const rows = new Map<string, BalanceRow>();
  for (const e of entries) {
    if (!inPeriod(e.date, from, to)) continue;
    for (const l of e.lines) {
      const r = rows.get(l.account) ?? { account: l.account, label: accountLabel(l.account), debit: 0, credit: 0, balance: 0 };
      r.debit += l.debit;
      r.credit += l.credit;
      r.balance = r.debit - r.credit;
      rows.set(l.account, r);
    }
  }
  return [...rows.values()].sort((a, b) => a.account.localeCompare(b.account));
}

/** Balance auxiliaire des clients (compte 411 ventilé par client). */
export function clientBalance(entries: Entry[], from: string, to: string) {
  const rows = new Map<string, { aux: string; debit: number; credit: number; balance: number }>();
  for (const e of entries) {
    if (!inPeriod(e.date, from, to)) continue;
    for (const l of e.lines) {
      if (l.account !== "411" || !l.aux) continue;
      const r = rows.get(l.aux) ?? { aux: l.aux, debit: 0, credit: 0, balance: 0 };
      r.debit += l.debit;
      r.credit += l.credit;
      r.balance = r.debit - r.credit;
      rows.set(l.aux, r);
    }
  }
  return [...rows.values()];
}

/** Mouvements d'un compte avec solde progressif (grand livre). */
export function accountLedger(entries: Entry[], account: string, from: string, to: string) {
  let opening = 0;
  const moves: { date: string; journal: string; ref: string; label: string; debit: number; credit: number; running: number; source: Entry["source"] }[] = [];
  for (const e of entries) {
    for (const l of e.lines) {
      if (l.account !== account) continue;
      if (e.date < from) opening += l.debit - l.credit;
      else if (e.date <= to) moves.push({ date: e.date, journal: e.journal, ref: e.ref, label: l.label, debit: l.debit, credit: l.credit, running: 0, source: e.source });
    }
  }
  let running = opening;
  for (const m of moves) m.running = running += m.debit - m.credit;
  return { opening, moves, closing: running };
}

const sumWhere = (rows: BalanceRow[], test: (account: string) => boolean, sign: 1 | -1) =>
  rows.filter((r) => test(r.account)).reduce((n, r) => n + sign * r.balance, 0);
const starts = (...prefixes: string[]) => (a: string) => prefixes.some((p) => a.startsWith(p));

/** Compte de résultat et soldes intermédiaires de gestion (SYSCOHADA). */
export function incomeStatement(rows: BalanceRow[]) {
  const products = (p: string) => sumWhere(rows, starts(p), -1);
  const charges = (p: string) => sumWhere(rows, starts(p), 1);
  const goodsSales = products("701");
  const services = products("706") + products("707");
  const revenue = products("70");
  const otherIncome = products("75");
  const goodsPurchases = charges("601") + charges("6031");
  const otherPurchases = charges("60") - goodsPurchases;
  const transport = charges("61");
  const external = charges("62") + charges("63");
  const taxes = charges("64");
  const otherCharges = charges("65");
  const staff = charges("66");
  const financial = charges("67") - products("77");
  const totalIncome = products("7");
  const totalCharges = charges("6");
  const commercialMargin = goodsSales - goodsPurchases;
  const valueAdded = revenue + otherIncome - goodsPurchases - otherPurchases - transport - external - taxes - otherCharges;
  const ebitda = valueAdded - staff;
  return {
    lines: [
      { label: "Ventes de marchandises", amount: goodsSales },
      { label: "Services vendus et produits accessoires", amount: services },
      { label: "Autres produits", amount: otherIncome },
      { label: "Achats de marchandises", amount: -goodsPurchases },
      { label: "Autres achats", amount: -otherPurchases },
      { label: "Transports", amount: -transport },
      { label: "Services extérieurs", amount: -external },
      { label: "Impôts et taxes", amount: -taxes },
      { label: "Autres charges", amount: -otherCharges },
      { label: "Charges de personnel", amount: -staff },
      { label: "Résultat financier", amount: -financial },
    ],
    revenue,
    commercialMargin,
    valueAdded,
    ebitda,
    result: totalIncome - totalCharges,
  };
}

/**
 * Bilan à une date : soldes cumulés depuis l'origine. Chaque compte de tiers
 * ou de trésorerie va à l'actif s'il est débiteur, au passif s'il est créditeur.
 */
export function balanceSheet(rows: BalanceRow[]) {
  const result = incomeStatement(rows).result;
  const pick = (test: (a: string) => boolean, side: "debit" | "credit") =>
    rows.filter((r) => test(r.account) && (side === "debit" ? r.balance > 0 : r.balance < 0))
      .reduce((n, r) => n + Math.abs(r.balance), 0);
  const fixed = sumWhere(rows, starts("2"), 1);
  const stocks = sumWhere(rows, starts("3"), 1);
  const receivables = pick(starts("4"), "debit");
  const cash = pick(starts("5"), "debit");
  const equity = -sumWhere(rows, starts("1"), 1) + result;
  const debts = pick(starts("4"), "credit");
  const overdraft = pick(starts("5"), "credit");
  const assets = [
    { label: "Actif immobilisé", amount: fixed },
    { label: "Stocks", amount: stocks },
    { label: "Créances (clients, État, autres)", amount: receivables },
    { label: "Trésorerie (banque, caisse, mobile money)", amount: cash },
  ];
  const liabilities = [
    { label: "Capitaux propres (dont résultat de l'exercice)", amount: equity },
    { label: "Dettes (fournisseurs, État, autres)", amount: debts },
    { label: "Trésorerie passive (découverts)", amount: overdraft },
  ];
  const totalAssets = assets.reduce((n, a) => n + a.amount, 0);
  const totalLiabilities = liabilities.reduce((n, a) => n + a.amount, 0);
  return { assets, liabilities, totalAssets, totalLiabilities, result };
}

/** Déclaration de TVA d'une période (régime des débits : TVA due à la facturation). */
export function vatReturn(entries: Entry[], from: string, to: string, invoices: Rec[], credits: Rec[]) {
  const rows = trialBalance(entries, from, to);
  const collected = -sumWhere(rows, (a) => a === "4431", 1);
  const deductibleGoods = sumWhere(rows, (a) => a === "4452", 1);
  const deductibleServices = sumWhere(rows, (a) => a === "4454", 1);
  const deductible = deductibleGoods + deductibleServices;
  // Bases imposables par taux, à partir des lignes des factures et avoirs validés.
  const bases = new Map<number, { base: number; vat: number }>();
  const add = (r: Rec, sign: 1 | -1) => {
    if (r.data.status !== "validated" || !inPeriod(str(r.data.date), from, to)) return;
    for (const l of (r.data.lines as InvoiceLine[]) ?? []) {
      const net = Math.round(l.qty * l.unitPrice);
      const b = bases.get(l.vatRate) ?? { base: 0, vat: 0 };
      b.base += sign * net;
      b.vat += sign * Math.round((net * l.vatRate) / 100);
      bases.set(l.vatRate, b);
    }
  };
  invoices.forEach((r) => add(r, 1));
  credits.forEach((r) => add(r, -1));
  const net = collected - deductible;
  return {
    bases: [...bases.entries()].sort((a, b) => b[0] - a[0]).map(([rate, v]) => ({ rate, ...v })),
    collected,
    deductibleGoods,
    deductibleServices,
    deductible,
    due: Math.max(0, net),
    credit: Math.max(0, -net),
  };
}

/** Export des écritures au format CSV (point-virgule), colonnes inspirées du FEC. */
export function entriesToCsv(entries: Entry[], from: string, to: string, auxName: (id: string) => string): string {
  const head = ["JournalCode", "JournalLib", "EcritureNum", "EcritureDate", "CompteNum", "CompteLib", "CompAuxNum", "CompAuxLib", "PieceRef", "EcritureLib", "Debit", "Credit"];
  const esc = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const out = [head.join(";")];
  let n = 0;
  for (const e of entries) {
    if (!inPeriod(e.date, from, to)) continue;
    n++;
    for (const l of e.lines) {
      out.push([
        e.journal, JOURNALS[e.journal] ?? e.journal, String(n), e.date.replace(/-/g, ""), l.account, accountLabel(l.account),
        l.aux ?? "", l.aux ? auxName(l.aux) : "", e.ref, l.label, String(l.debit), String(l.credit),
      ].map(esc).join(";"));
    }
  }
  return out.join("\r\n");
}
