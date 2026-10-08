/** Calculs dérivés des données locales : situation des factures, chiffres du tableau de bord. */
import { computeTotals, invoiceBalance, type InvoiceLine } from "../shared/invoice.ts";
import type { SyncRecord } from "../shared/sync.ts";
import { today } from "./context.ts";

export interface Situation {
  net: number;
  vat: number;
  gross: number;
  paid: number;
  credited: number;
  due: number;
  status: "draft" | "unpaid" | "partial" | "paid" | "overdue";
}

export const linesOf = (r: SyncRecord | null | undefined): InvoiceLine[] => ((r?.data.lines as InvoiceLine[]) ?? []);
export const totalsOf = (r: SyncRecord | null | undefined) => computeTotals(linesOf(r));

/** Situation de chaque facture à partir des encaissements et des avoirs validés. */
export function invoiceSituations(invoices: SyncRecord[], payments: SyncRecord[], credits: SyncRecord[]): Map<string, Situation> {
  const paidBy = new Map<string, number[]>();
  for (const p of payments) {
    const id = String(p.data.invoice_id ?? "");
    paidBy.set(id, [...(paidBy.get(id) ?? []), Number(p.data.amount ?? 0)]);
  }
  const creditedBy = new Map<string, number[]>();
  for (const c of credits) {
    if (c.data.status !== "validated") continue;
    const id = String(c.data.invoice_id ?? "");
    creditedBy.set(id, [...(creditedBy.get(id) ?? []), totalsOf(c).gross]);
  }
  const now = today();
  const out = new Map<string, Situation>();
  for (const inv of invoices) {
    const t = totalsOf(inv);
    if (inv.data.status !== "validated") {
      out.set(inv.id, { ...t, paid: 0, credited: 0, due: 0, status: "draft" });
      continue;
    }
    // Compatibilité avec le lot 0, où l'encaissement était un champ de la facture.
    const legacy = Number(inv.data.paid_amount ?? 0);
    const b = invoiceBalance(t.gross, [...(paidBy.get(inv.id) ?? []), ...(legacy ? [legacy] : [])], creditedBy.get(inv.id) ?? []);
    const overdue = b.due > 0 && typeof inv.data.due_date === "string" && inv.data.due_date < now;
    out.set(inv.id, { ...t, paid: b.paid, credited: b.credited, due: b.due, status: overdue ? "overdue" : b.status });
  }
  return out;
}

export const SITUATION_LABELS: Record<Situation["status"], string> = {
  draft: "Brouillon",
  unpaid: "À encaisser",
  partial: "Partielle",
  paid: "Payée",
  overdue: "En retard",
};

export const QUOTE_LABELS: Record<string, string> = {
  draft: "Brouillon",
  sent: "Envoyé",
  accepted: "Accepté",
  refused: "Refusé",
  invoiced: "Facturé",
  expired: "Expiré",
};

export function quoteStatus(q: SyncRecord): string {
  const s = String(q.data.status ?? "draft");
  if (s === "sent" && typeof q.data.valid_until === "string" && q.data.valid_until < today()) return "expired";
  return s;
}
