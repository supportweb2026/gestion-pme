import { useEffect, useState } from "react";
import { formatDate, today, useApp, useTable } from "../context.ts";
import { computeTotals, DEFAULT_VAT_RATE, formatXaf, type InvoiceLine } from "../../shared/invoice.ts";
import type { SyncRecord } from "../../shared/sync.ts";

const STATUS: Record<string, string> = { draft: "Brouillon", validated: "Validée" };
const PAYMENT: Record<string, string> = { unpaid: "Non payée", partial: "Partielle", paid: "Payée" };

export function Invoices() {
  const invoices = useTable("invoices");
  const clients = useTable("clients");
  const [open, setOpen] = useState<string | "new" | null>(null);
  const clientName = (id: unknown) => String(clients.find((c) => c.id === id)?.data.name ?? "—");

  const sorted = [...invoices].sort((a, b) => String(b.data.date ?? "").localeCompare(String(a.data.date ?? "")));

  if (open) {
    const record = open === "new" ? null : invoices.find((i) => i.id === open) ?? null;
    return <InvoiceEditor key={open} record={record} clients={clients} onClose={() => setOpen(null)} />;
  }

  return (
    <section>
      <div className="section-head">
        <h2>Factures</h2>
        <button className="primary" onClick={() => setOpen("new")} disabled={clients.length === 0} title={clients.length === 0 ? "Créez d'abord un client" : undefined}>
          Nouvelle facture
        </button>
      </div>
      {sorted.length === 0 ? (
        <p className="empty">{clients.length === 0 ? "Créez d'abord un client dans l'onglet Clients." : "Aucune facture pour l'instant."}</p>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Numéro</th><th>Date</th><th>Client</th><th>Statut</th><th>Paiement</th><th className="right">Total TTC</th></tr>
            </thead>
            <tbody>
              {sorted.map((inv) => {
                const t = computeTotals((inv.data.lines as InvoiceLine[]) ?? []);
                return (
                  <tr key={inv.id} className="clickable" onClick={() => setOpen(inv.id)}>
                    <td className="mono">{String(inv.data.number ?? "—")}</td>
                    <td>{formatDate(inv.data.date)}</td>
                    <td>{clientName(inv.data.client_id)}</td>
                    <td><span className={`badge ${inv.data.status === "validated" ? "ok" : ""}`}>{STATUS[String(inv.data.status)] ?? "—"}</span></td>
                    <td>{inv.data.status === "validated" ? PAYMENT[String(inv.data.payment_status ?? "unpaid")] : ""}</td>
                    <td className="right mono">{formatXaf(t.gross)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const emptyLine = (): InvoiceLine => ({ label: "", qty: 1, unitPrice: 0, vatRate: DEFAULT_VAT_RATE });

function InvoiceEditor({ record, clients, onClose }: { record: SyncRecord | null; clients: SyncRecord[]; onClose: () => void }) {
  const { db, sync, session } = useApp();
  const [id] = useState(() => record?.id ?? db.newId("inv"));
  const [clientId, setClientId] = useState(String(record?.data.client_id ?? clients[0]?.id ?? ""));
  const [date, setDate] = useState(String(record?.data.date ?? today()));
  const [lines, setLines] = useState<InvoiceLine[]>(() => ((record?.data.lines as InvoiceLine[]) ?? [emptyLine()]).map((l) => ({ ...l })));
  const [payment, setPayment] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [stock, setStock] = useState<number | null>(null);
  const validated = record?.data.status === "validated";
  const totals = computeTotals(lines);

  useEffect(() => {
    sync.availableNumbers().then(setStock);
  }, [sync]);

  const update = (i: number, patch: Partial<InvoiceLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const cleanLines = () => lines.filter((l) => l.label.trim() !== "" || l.unitPrice !== 0);

  async function saveDraft(close = true) {
    const patch: Record<string, unknown> = { client_id: clientId, date, lines: cleanLines(), currency: "XAF" };
    if (!record) Object.assign(patch, { status: "draft", created_by: session.user.id });
    await db.write("invoices", id, patch);
    if (close) onClose();
  }

  async function validate() {
    if (cleanLines().length === 0) {
      setMessage("Ajoutez au moins une ligne avant de valider.");
      return;
    }
    if (!confirm("Une facture validée ne peut plus être modifiée (correction par avoir). Valider ?")) return;
    const number = await sync.takeInvoiceNumber();
    if (!number) {
      setMessage("Aucun numéro de facture en réserve sur cet appareil. Connectez-vous une fois à internet pour en obtenir.");
      return;
    }
    await saveDraft(false);
    await db.write("invoices", id, {
      status: "validated",
      number,
      validated_at: new Date().toISOString(),
      validated_by: session.user.id,
      payment_status: "unpaid",
      paid_amount: 0,
    });
    onClose();
  }

  async function recordPayment() {
    const amount = Math.round(Number(payment.replace(/\s/g, "")));
    if (!Number.isFinite(amount) || amount <= 0) return;
    const paid = Number(record?.data.paid_amount ?? 0) + amount;
    await db.write("invoices", id, {
      paid_amount: paid,
      payment_status: paid >= totals.gross ? "paid" : "partial",
    });
    setPayment("");
  }

  const paid = Number(record?.data.paid_amount ?? 0);

  return (
    <section>
      <div className="section-head">
        <h2>{validated ? `Facture ${record?.data.number}` : record ? "Brouillon de facture" : "Nouvelle facture"}</h2>
        <button className="ghost" onClick={onClose}>Retour à la liste</button>
      </div>

      <div className="card">
        <div className="form-grid">
          <label>
            Client
            <select value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={validated}>
              {clients.map((c) => <option key={c.id} value={c.id}>{String(c.data.name)}</option>)}
            </select>
          </label>
          <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={validated} /></label>
        </div>

        <div className="table-wrap">
          <table className="lines">
            <thead>
              <tr><th>Désignation</th><th className="num">Qté</th><th className="num">Prix unitaire HT</th><th className="num">TVA %</th><th className="right">Montant HT</th>{!validated && <th />}</tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td><input aria-label="Désignation" value={l.label} onChange={(e) => update(i, { label: e.target.value })} disabled={validated} /></td>
                  <td className="num"><input aria-label="Quantité" type="number" min="0" step="any" value={l.qty} onChange={(e) => update(i, { qty: Number(e.target.value) })} disabled={validated} /></td>
                  <td className="num"><input aria-label="Prix unitaire" type="number" min="0" step="1" value={l.unitPrice} onChange={(e) => update(i, { unitPrice: Number(e.target.value) })} disabled={validated} /></td>
                  <td className="num"><input aria-label="TVA" type="number" min="0" step="any" value={l.vatRate} onChange={(e) => update(i, { vatRate: Number(e.target.value) })} disabled={validated} /></td>
                  <td className="right mono">{formatXaf(Math.round(l.qty * l.unitPrice))}</td>
                  {!validated && (
                    <td><button className="ghost small" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Supprimer la ligne">✕</button></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!validated && <button className="ghost" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ Ajouter une ligne</button>}

        <dl className="totals">
          <dt>Total HT</dt><dd className="mono">{formatXaf(totals.net)}</dd>
          <dt>TVA</dt><dd className="mono">{formatXaf(totals.vat)}</dd>
          <dt className="strong">Total TTC</dt><dd className="mono strong" data-testid="total-ttc">{formatXaf(totals.gross)}</dd>
          {validated && (<><dt>Déjà payé</dt><dd className="mono">{formatXaf(paid)}</dd><dt>Reste dû</dt><dd className="mono">{formatXaf(Math.max(0, totals.gross - paid))}</dd></>)}
        </dl>

        {message && <p className="error" role="alert">{message}</p>}

        {validated ? (
          record?.data.payment_status !== "paid" && (
            <div className="form-actions">
              <input aria-label="Montant encaissé" placeholder="Montant encaissé" inputMode="numeric" value={payment} onChange={(e) => setPayment(e.target.value)} />
              <button className="primary" onClick={recordPayment}>Enregistrer l'encaissement</button>
            </div>
          )
        ) : (
          <div className="form-actions">
            <span className="muted small">{stock === null ? "" : `${stock} numéro(s) de facture disponibles hors ligne`}</span>
            <button className="ghost" onClick={() => saveDraft()}>Enregistrer le brouillon</button>
            <button className="primary" onClick={validate}>Valider la facture</button>
          </div>
        )}
      </div>
    </section>
  );
}
