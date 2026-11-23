/**
 * Espace client en ligne : par un lien secret propre à sa fiche, un client retrouve ses
 * devis en attente, ses factures, ce qu'il reste à régler, et télécharge ses documents.
 * Seuls les documents finalisés et émis dans Gestia y figurent ; l'historique repris d'un
 * autre logiciel n'y est pas, car ses encaissements n'ont pas été repris avec lui.
 */
import { computeTotals, docTaxes, invoiceBalance, type InvoiceLine } from "./invoice.ts";
import { decimalsOf } from "./currency.ts";
import { docTitle, isSlip } from "./documents.ts";
import { isSignToken, signLock, signPath } from "./publicDoc.ts";
import { signatureOf } from "./signature.ts";

type Rec = { id: string; data: Record<string, unknown> };
const str = (v: unknown) => (typeof v === "string" ? v : "");
const live = (r: Rec) => !r.data._deleted && str(r.data.number) !== "" && !r.data.imported;
const totalsOf = (r: Rec) => computeTotals((r.data.lines as InvoiceLine[]) ?? [], decimalsOf(str(r.data.currency) || "XAF"), docTaxes(r.data));

/** Chemin de l'espace client. */
export const portalPath = (companyId: string, clientId: string, token: string) => `/espace/${companyId}/${clientId}/${token}`;
export function parsePortalPath(path: string): { companyId: string; clientId: string; token: string } | null {
  const m = /^\/espace\/([A-Za-z0-9-]{8,64})\/([A-Za-z0-9_-]{3,96})\/([A-Za-z0-9_-]{32})\/?$/.exec(path);
  return m ? { companyId: m[1], clientId: m[2], token: m[3] } : null;
}

export interface PortalQuote {
  id: string; title: string; number: string; date: string; validUntil: string; currency: string; total: number;
  /** « waiting » : attend la réponse du client ; sinon accepté, refusé, facturé ou expiré. */
  state: "waiting" | "accepted" | "refused" | "invoiced" | "expired";
  signed: boolean;
  /** Page de signature, tant que le devis attend une réponse. */
  signPath: string;
}
export interface PortalInvoice {
  id: string; title: string; number: string; date: string; dueDate: string; currency: string;
  total: number; paid: number; due: number;
  state: "paid" | "partial" | "unpaid" | "overdue";
}
export interface Portal {
  quotes: PortalQuote[];
  invoices: PortalInvoice[];
  /** Reste à régler, par devise. */
  due: { currency: string; amount: number; overdue: number }[];
}

/** Ce que le client voit dans son espace : devis chiffrés et factures validées, du plus récent au plus ancien. */
export function buildPortal(input: { companyId: string; quotes: Rec[]; invoices: Rec[]; payments: Rec[]; credits: Rec[]; today: string }): Portal {
  const { companyId, today } = input;
  const byDate = (a: { date: string; number: string }, b: { date: string; number: string }) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number);

  const quotes: PortalQuote[] = input.quotes.filter((q) => live(q) && !isSlip(q.data)).map((q) => {
    const status = str(q.data.status);
    const lock = signLock(q.data, today);
    const state: PortalQuote["state"] = status === "sent" ? (lock === "expired" ? "expired" : "waiting")
      : status === "refused" ? "refused" : status === "invoiced" ? "invoiced" : "accepted";
    const token = q.data.sign_token;
    return {
      id: q.id, title: docTitle("quotes", q.data), number: str(q.data.number), date: str(q.data.date), validUntil: str(q.data.valid_until),
      currency: str(q.data.currency) || "XAF", total: totalsOf(q).gross, state, signed: Boolean(signatureOf(q.data)),
      signPath: state === "waiting" && isSignToken(token) ? signPath(companyId, q.id, token) : "",
    };
  }).sort(byDate);

  const paidBy = new Map<string, number[]>();
  for (const p of input.payments) {
    if (p.data._deleted) continue;
    const id = str(p.data.invoice_id);
    paidBy.set(id, [...(paidBy.get(id) ?? []), Number(p.data.amount ?? 0)]);
  }
  const creditedBy = new Map<string, number[]>();
  for (const c of input.credits) {
    if (c.data._deleted || c.data.status !== "validated") continue;
    const id = str(c.data.invoice_id);
    creditedBy.set(id, [...(creditedBy.get(id) ?? []), totalsOf(c).payable]);
  }
  const invoices: PortalInvoice[] = input.invoices.filter((i) => live(i) && i.data.status === "validated").map((i) => {
    const currency = str(i.data.currency) || "XAF";
    const d = decimalsOf(currency);
    const r = (n: number) => Math.round(n * 10 ** d) / 10 ** d;
    const legacy = Number(i.data.paid_amount ?? 0);
    const b = invoiceBalance(totalsOf(i).payable, [...(paidBy.get(i.id) ?? []), ...(legacy ? [legacy] : [])], creditedBy.get(i.id) ?? []);
    const due = r(b.due);
    const dueDate = str(i.data.due_date);
    return {
      id: i.id, title: docTitle("invoices", i.data), number: str(i.data.number), date: str(i.data.date), dueDate, currency,
      total: r(b.gross), paid: r(b.paid + b.credited), due,
      state: (due === 0 ? "paid" : dueDate && dueDate < today ? "overdue" : b.status === "partial" ? "partial" : "unpaid") as PortalInvoice["state"],
    };
  }).sort(byDate);

  const dueBy = new Map<string, { currency: string; amount: number; overdue: number }>();
  for (const i of invoices) {
    if (i.due <= 0) continue;
    const row = dueBy.get(i.currency) ?? { currency: i.currency, amount: 0, overdue: 0 };
    row.amount += i.due;
    if (i.state === "overdue") row.overdue += i.due;
    dueBy.set(i.currency, row);
  }
  return { quotes, invoices, due: [...dueBy.values()] };
}

/** Un document de l'espace client se télécharge s'il appartient bien à ce client et y figure. */
export function portalDocAllowed(tbl: string, doc: Rec | null | undefined, clientId: string): boolean {
  if (!doc || !live(doc) || doc.data.client_id !== clientId) return false;
  if (tbl === "invoices") return doc.data.status === "validated";
  return tbl === "quotes" && !isSlip(doc.data);
}

/** Champs d'une facture imprimés sur son PDF, en plus de ceux d'un devis. */
export const INVOICE_EXTRA_FIELDS = ["due_date", "quote_number", "deposit", "final_invoice", "efact_number"] as const;
