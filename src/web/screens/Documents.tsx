/**
 * Devis, factures et avoirs : une liste et un éditeur communs.
 * Un document numéroté (devis envoyé, facture ou avoir validé) est figé ;
 * la suite se fait par actions : accepter, convertir, encaisser, créer un avoir.
 */
import { useEffect, useMemo, useState } from "react";
import { formatDate, normalize, text, today, useApp, useSettings, useTable } from "../context.ts";
import {
  addDays, computeTotals, DEFAULT_PAYMENT_DAYS, DEFAULT_VAT_RATE, lineNet, PAYMENT_METHODS, type InvoiceLine,
} from "../../shared/invoice.ts";
import { CURRENCIES, decimalsOf, formatMoney, rateFor } from "../../shared/currency.ts";
import { isNumbered, type DocTable, type SyncRecord } from "../../shared/sync.ts";
import { currencyOf, invoiceSituations, linesOf, QUOTE_LABELS, quoteStatus, rateOf, SITUATION_LABELS, totalsOf, type Situation } from "../ledger.ts";
import { PrintView } from "./PrintView.tsx";

interface DocConfig {
  title: string;
  one: string;
  newLabel: string | null;
  prefix: string;
  numberedStatus: string;
  validateLabel: string;
  confirm: string;
}

export const DOCS: Record<DocTable, DocConfig> = {
  quotes: {
    title: "Devis", one: "Devis", newLabel: "Nouveau devis", prefix: "DV", numberedStatus: "sent",
    validateLabel: "Finaliser le devis", confirm: "Le devis va être numéroté et ne pourra plus être modifié. Continuer ?",
  },
  invoices: {
    title: "Factures", one: "Facture", newLabel: "Nouvelle facture", prefix: "FA", numberedStatus: "validated",
    validateLabel: "Valider la facture", confirm: "Une facture validée ne peut plus être modifiée (toute correction passe par un avoir). Valider ?",
  },
  credit_notes: {
    title: "Avoirs", one: "Avoir", newLabel: null, prefix: "AV", numberedStatus: "validated",
    validateLabel: "Valider l'avoir", confirm: "L'avoir validé sera déduit de la facture et ne pourra plus être modifié. Valider ?",
  },
};

type Filter = "all" | "draft" | "open" | "overdue";

/** Données partagées par la liste et l'éditeur. */
function useSalesData() {
  const invoices = useTable("invoices");
  const payments = useTable("payments");
  const credits = useTable("credit_notes");
  const situations = useMemo(() => invoiceSituations(invoices, payments, credits), [invoices, payments, credits]);
  return { invoices, payments, credits, situations };
}

export function Documents({ kind, open, setOpen }: { kind: DocTable; open: string | null; setOpen: (id: string | null) => void }) {
  const docs = useTable(kind);
  const clients = useTable("clients");
  const { situations } = useSalesData();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const cfg = DOCS[kind];
  const clientName = (id: unknown) => text(clients.find((c) => c.id === id)?.data.name) || "—";

  if (open) {
    const record = open === "new" ? null : docs.find((d) => d.id === open) ?? null;
    if (open !== "new" && !record) return <p className="empty">Document introuvable sur cet appareil.</p>;
    return <DocEditor key={open} kind={kind} record={record} clients={clients} onClose={() => setOpen(null)} onOpen={setOpen} />;
  }

  const statusOf = (d: SyncRecord): { label: string; tone: string; key: string } => {
    if (kind === "invoices") {
      const s = situations.get(d.id)?.status ?? "draft";
      const tone = s === "paid" ? "ok" : s === "overdue" ? "danger" : s === "draft" ? "" : "warn";
      return { label: SITUATION_LABELS[s], tone, key: s };
    }
    if (kind === "quotes") {
      const s = quoteStatus(d);
      const tone = s === "accepted" || s === "invoiced" ? "ok" : s === "refused" || s === "expired" ? "danger" : s === "sent" ? "warn" : "";
      return { label: QUOTE_LABELS[s] ?? s, tone, key: s };
    }
    const v = d.data.status === "validated";
    return { label: v ? "Validé" : "Brouillon", tone: v ? "ok" : "", key: v ? "validated" : "draft" };
  };

  const q = normalize(query.trim());
  const rows = docs
    .filter((d) => {
      if (q && !normalize(`${text(d.data.number)} ${clientName(d.data.client_id)}`).includes(q)) return false;
      const k = statusOf(d).key;
      if (filter === "draft") return k === "draft";
      if (filter === "open") return ["unpaid", "partial", "overdue", "sent"].includes(k);
      if (filter === "overdue") return k === "overdue" || k === "expired";
      return true;
    })
    .sort((a, b) => text(b.data.date).localeCompare(text(a.data.date)) || text(b.data.number).localeCompare(text(a.data.number)));

  return (
    <section>
      <div className="section-head">
        <h2>{cfg.title}</h2>
        {cfg.newLabel && (
          <button className="primary" onClick={() => setOpen("new")} disabled={clients.length === 0} title={clients.length === 0 ? "Créez d'abord un client" : undefined}>
            {cfg.newLabel}
          </button>
        )}
      </div>
      <div className="toolbar">
        <input type="search" placeholder="Rechercher un numéro ou un client" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Rechercher" />
        <div className="segmented" role="group" aria-label="Filtrer">
          {([["all", "Tous"], ["draft", "Brouillons"], ["open", kind === "quotes" ? "En attente" : "À encaisser"], ["overdue", kind === "quotes" ? "Expirés" : "En retard"]] as [Filter, string][])
            .filter(([f]) => kind !== "credit_notes" || f === "all" || f === "draft")
            .map(([f, label]) => (
              <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>{label}</button>
            ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="empty">
          {clients.length === 0 ? "Créez d'abord un client dans l'onglet Clients."
            : kind === "credit_notes" ? "Aucun avoir. Un avoir se crée depuis une facture validée."
            : docs.length === 0 ? `Aucun ${cfg.one.toLowerCase()} pour l'instant.` : "Aucun résultat pour ce filtre."}
        </p>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Numéro</th><th>Date</th><th>Client</th><th>Statut</th>
                {kind === "invoices" && <th className="right">Reste dû</th>}
                <th className="right">Total TTC</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const st = statusOf(d);
                return (
                  <tr key={d.id} className="clickable" onClick={() => setOpen(d.id)}>
                    <td className="mono">{text(d.data.number) || "—"}</td>
                    <td>{formatDate(d.data.date)}</td>
                    <td>{clientName(d.data.client_id)}</td>
                    <td><span className={`badge ${st.tone}`}>{st.label}</span></td>
                    {kind === "invoices" && <td className="right mono">{st.key === "draft" ? "" : formatMoney(situations.get(d.id)?.due ?? 0, currencyOf(d))}</td>}
                    <td className="right mono">{formatMoney(totalsOf(d).gross, currencyOf(d))}</td>
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

function DocEditor({ kind, record, clients, onClose, onOpen }: {
  kind: DocTable; record: SyncRecord | null; clients: SyncRecord[]; onClose: () => void; onOpen: (id: string) => void;
}) {
  const { db, sync, session, go } = useApp();
  const cfg = DOCS[kind];
  const settings = useSettings();
  const articles = useTable("articles");
  const { invoices, payments, credits, situations } = useSalesData();
  const paymentDays = Number(settings.payment_days ?? DEFAULT_PAYMENT_DAYS);

  const [id] = useState(() => record?.id ?? db.newId(kind === "quotes" ? "dv" : kind === "invoices" ? "fa" : "av"));
  const [clientId, setClientId] = useState(text(record?.data.client_id) || clients[0]?.id || "");
  const [date, setDate] = useState(text(record?.data.date) || today());
  const [dueDate, setDueDate] = useState(text(record?.data.due_date ?? record?.data.valid_until) || addDays(today(), paymentDays));
  const [lines, setLines] = useState<InvoiceLine[]>(() => (record ? linesOf(record) : [emptyLine()]).map((l) => ({ ...l })));
  const [notes, setNotes] = useState(text(record?.data.notes));
  const [currency, setCurrency] = useState(currencyOf(record));
  const [rate, setRate] = useState<number>(() => (record ? rateOf(record) : 1));
  const [projectId, setProjectId] = useState(text(record?.data.project_id));
  const projects = useTable("projects");
  const [message, setMessage] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [busy, setBusy] = useState(false);

  const numbered = isNumbered(record?.data);
  const closedUntil = text(settings.closed_until);
  const locked = !numbered && !!closedUntil && date <= closedUntil && kind !== "quotes";
  const editable = !numbered && !locked;
  const decimals = decimalsOf(currency);
  const totals = computeTotals(lines, decimals);
  const fm = (n: number) => formatMoney(n, currency);
  const changeCurrency = (code: string) => {
    setCurrency(code);
    setRate(rateFor(code, settings.rates as Record<string, number> | undefined));
  };
  const client = clients.find((c) => c.id === clientId) ?? null;
  const situation: Situation | undefined = kind === "invoices" && record ? situations.get(record.id) : undefined;
  const sourceInvoice = kind === "credit_notes" ? invoices.find((i) => i.id === record?.data.invoice_id) : undefined;

  // Pour un nouveau document, l'échéance suit la date.
  useEffect(() => {
    if (!record) setDueDate(addDays(date, kind === "quotes" ? 30 : paymentDays));
  }, [date]);

  const update = (i: number, patch: Partial<InvoiceLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pickArticle = (i: number, label: string) => {
    const a = articles.find((x) => text(x.data.label) === label);
    if (!a) return update(i, { label, articleId: undefined });
    update(i, {
      label,
      articleId: a.id,
      unitPrice: Number(a.data.price ?? 0),
      vatRate: Number(a.data.vat_rate ?? DEFAULT_VAT_RATE),
      unit: text(a.data.unit) || undefined,
    });
  };
  const cleanLines = () => lines.filter((l) => l.label.trim() !== "" || l.unitPrice !== 0);

  function contentPatch(): Record<string, unknown> {
    const p: Record<string, unknown> = {
      client_id: clientId, date, lines: cleanLines(), notes: notes.trim(), currency, rate: currency === "XAF" ? 1 : rate, project_id: projectId,
    };
    if (kind === "invoices") p.due_date = dueDate;
    if (kind === "quotes") p.valid_until = dueDate;
    if (!record) Object.assign(p, { status: "draft", created_by: session.user.id });
    return p;
  }

  async function saveDraft(close = true) {
    await db.write(kind, id, contentPatch());
    if (close) onClose();
  }

  async function validate() {
    setMessage(null);
    if (!clientId) return setMessage("Choisissez un client.");
    if (cleanLines().length === 0) return setMessage("Ajoutez au moins une ligne.");
    if (cleanLines().some((l) => l.qty <= 0 || l.unitPrice < 0)) return setMessage("Vérifiez les quantités et les prix.");
    if (kind === "credit_notes" && sourceInvoice) {
      const others = credits
        .filter((c) => c.id !== id && c.data.invoice_id === sourceInvoice.id && c.data.status === "validated")
        .reduce((n, c) => n + totalsOf(c).gross, 0);
      const max = totalsOf(sourceInvoice).gross - others;
      if (totals.gross > max) return setMessage(`L'avoir dépasse le montant restant de la facture (${fm(max)}).`);
    }
    if (!confirm(cfg.confirm)) return;
    setBusy(true);
    try {
      const number = await sync.takeNumber(cfg.prefix);
      if (!number) {
        return setMessage("Plus de numéro en réserve sur cet appareil. Connectez-vous une fois à internet pour en obtenir.");
      }
      await db.write(kind, id, contentPatch());
      await db.write(kind, id, { status: cfg.numberedStatus, number, validated_at: new Date().toISOString(), validated_by: session.user.id });
      // Un nouveau document reste ouvert, désormais sous son identifiant.
      if (!record) onOpen(id);
    } finally {
      setBusy(false);
    }
  }

  async function setQuoteStatus(status: "accepted" | "refused") {
    await db.write("quotes", id, { status, decided_at: new Date().toISOString() });
  }

  async function quoteToInvoice() {
    const invId = db.newId("fa");
    await db.write("invoices", invId, {
      status: "draft",
      client_id: record!.data.client_id,
      date: today(),
      due_date: addDays(today(), paymentDays),
      lines: linesOf(record),
      notes: text(record!.data.notes),
      currency: currencyOf(record),
      rate: rateOf(record),
      project_id: text(record!.data.project_id),
      quote_id: id,
      quote_number: record!.data.number,
      created_by: session.user.id,
    });
    await db.write("quotes", id, { status: "invoiced", invoice_id: invId, decided_at: new Date().toISOString() });
    go("invoices", invId);
  }

  async function createCreditNote() {
    const cnId = db.newId("av");
    await db.write("credit_notes", cnId, {
      status: "draft",
      client_id: record!.data.client_id,
      date: today(),
      lines: linesOf(record),
      currency: currencyOf(record),
      rate: rateOf(record),
      project_id: text(record!.data.project_id),
      invoice_id: id,
      invoice_number: record!.data.number,
      notes: `Avoir sur la facture ${text(record!.data.number)}`,
      created_by: session.user.id,
    });
    go("credit_notes", cnId);
  }

  async function removeDraft() {
    if (!confirm("Supprimer ce brouillon ?")) return;
    await db.remove(kind, id);
    onClose();
  }

  const title = numbered ? `${cfg.one} ${text(record?.data.number)}` : record ? `${cfg.one} (brouillon)` : DOCS[kind].newLabel ?? cfg.one;
  const linked = kind === "invoices" ? credits.filter((c) => c.data.invoice_id === id) : [];
  const invoicePayments = kind === "invoices" ? payments.filter((p) => p.data.invoice_id === id).sort((a, b) => text(a.data.date).localeCompare(text(b.data.date))) : [];

  return (
    <section>
      <div className="section-head">
        <div>
          <button className="link" onClick={onClose}>← {cfg.title}</button>
          <h2>{title}</h2>
        </div>
        {numbered && (
          <div className="actions">
            <button onClick={() => setPrinting(true)}>Imprimer / PDF</button>
            <ShareButtons kind={kind} record={record!} client={client} gross={totals.gross} due={situation?.due} currency={currency} />
          </div>
        )}
      </div>

      {locked && (
        <p className="notice">Date dans une période clôturée (jusqu'au {formatDate(closedUntil)}) : choisissez une date ultérieure.</p>
      )}
      {locked && (
        <label className="inline notice-fix">Nouvelle date <input type="date" value={date} min={addDays(closedUntil, 1)} onChange={(e) => setDate(e.target.value)} /></label>
      )}
      {kind === "credit_notes" && sourceInvoice && (
        <p className="muted small">
          Sur la facture <button className="link" onClick={() => go("invoices", sourceInvoice.id)}>{text(sourceInvoice.data.number)}</button>
        </p>
      )}
      {kind === "invoices" && record?.data.quote_id ? (
        <p className="muted small">
          Issue du devis <button className="link" onClick={() => go("quotes", text(record.data.quote_id))}>{text(record.data.quote_number)}</button>
        </p>
      ) : null}

      <div className="card">
        <div className="form-grid">
          <label>
            Client
            <select value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={!editable || kind === "credit_notes"}>
              {clients.map((c) => <option key={c.id} value={c.id}>{text(c.data.name)}</option>)}
            </select>
          </label>
          <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={!editable} /></label>
          <label>
            Devise
            <select value={currency} onChange={(e) => changeCurrency(e.target.value)} disabled={!editable || kind === "credit_notes"}>
              {Object.values(CURRENCIES).map((c) => <option key={c.code} value={c.code}>{c.code} · {c.label}</option>)}
            </select>
          </label>
          {currency !== "XAF" && (
            <label>
              Taux (1 {currency} = … FCFA)
              <input type="number" min="0" step="any" value={rate} onChange={(e) => setRate(Number(e.target.value))}
                disabled={!editable || !!CURRENCIES[currency]?.fixedRate || kind === "credit_notes"} />
            </label>
          )}
          {projects.length > 0 && (
            <label>
              Projet
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={!editable}>
                <option value="">Aucun</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{text(p.data.name)}</option>)}
              </select>
            </label>
          )}
          {kind !== "credit_notes" && (
            <label>
              {kind === "quotes" ? "Valable jusqu'au" : "Échéance"}
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={!editable} />
            </label>
          )}
        </div>

        <datalist id="articles-list">
          {articles.map((a) => <option key={a.id} value={text(a.data.label)} />)}
        </datalist>
        <div className="table-wrap">
          <table className="lines">
            <thead>
              <tr>
                <th>Désignation</th><th className="num">Qté</th><th className="num">Prix unitaire HT</th><th className="num">TVA %</th>
                <th className="right">Montant HT</th>{editable && <th />}
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td><input aria-label="Désignation" list="articles-list" value={l.label} onChange={(e) => pickArticle(i, e.target.value)} disabled={!editable} /></td>
                  <td className="num"><input aria-label="Quantité" type="number" min="0" step="any" value={l.qty} onChange={(e) => update(i, { qty: Number(e.target.value) })} disabled={!editable} /></td>
                  <td className="num"><input aria-label="Prix unitaire" type="number" min="0" step={decimals ? "0.01" : "1"} value={l.unitPrice} onChange={(e) => update(i, { unitPrice: Number(e.target.value) })} disabled={!editable} /></td>
                  <td className="num"><input aria-label="TVA" type="number" min="0" step="any" value={l.vatRate} onChange={(e) => update(i, { vatRate: Number(e.target.value) })} disabled={!editable} /></td>
                  <td className="right mono">{fm(lineNet(l, decimals))}</td>
                  {editable && (
                    <td><button className="ghost small" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Supprimer la ligne">✕</button></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editable && <button className="ghost" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ Ajouter une ligne</button>}

        <div className="doc-bottom">
          <label className="notes">
            Notes (imprimées sur le document)
            <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!editable} />
          </label>
          <dl className="totals">
            <dt>Total HT</dt><dd className="mono">{fm(totals.net)}</dd>
            <dt>TVA</dt><dd className="mono">{fm(totals.vat)}</dd>
            <dt className="strong">Total TTC</dt><dd className="mono strong" data-testid="total-ttc">{fm(totals.gross)}</dd>
            {currency !== "XAF" && (<><dt>Contre-valeur</dt><dd className="mono muted">{formatMoney(Math.round(totals.gross * rate), "XAF")}</dd></>)}
            {situation && situation.status !== "draft" && (
              <>
                {situation.paid > 0 && (<><dt>Encaissé</dt><dd className="mono">{fm(situation.paid)}</dd></>)}
                {situation.credited > 0 && (<><dt>Avoirs</dt><dd className="mono">{fm(situation.credited)}</dd></>)}
                <dt className="strong">Reste dû</dt><dd className="mono strong" data-testid="due">{fm(situation.due)}</dd>
              </>
            )}
          </dl>
        </div>

        {message && <p className="error" role="alert">{message}</p>}

        {editable && (
          <div className="form-actions">
            {record && <button className="ghost danger" onClick={removeDraft}>Supprimer</button>}
            <button className="ghost" onClick={() => saveDraft()}>Enregistrer le brouillon</button>
            <button className="primary" onClick={validate} disabled={busy}>{cfg.validateLabel}</button>
          </div>
        )}

        {kind === "quotes" && numbered && (
          <div className="form-actions">
            {record!.data.status === "sent" && (
              <>
                <button className="ghost" onClick={() => setQuoteStatus("refused")}>Marquer refusé</button>
                <button onClick={() => setQuoteStatus("accepted")}>Marquer accepté</button>
              </>
            )}
            {["sent", "accepted"].includes(text(record!.data.status)) && (
              <button className="primary" onClick={quoteToInvoice}>Convertir en facture</button>
            )}
            {record!.data.invoice_id ? (
              <button className="link" onClick={() => go("invoices", text(record!.data.invoice_id))}>Voir la facture</button>
            ) : null}
          </div>
        )}
      </div>

      {kind === "invoices" && numbered && situation && (
        <Payments invoice={record!} situation={situation} payments={invoicePayments} credits={linked} onCredit={createCreditNote} />
      )}

      {printing && record && (
        <PrintView kind={kind} record={{ ...record, data: { ...record.data, lines } }} client={client} situation={situation} onClose={() => setPrinting(false)} />
      )}
    </section>
  );
}

function Payments({ invoice, situation, payments, credits, onCredit }: {
  invoice: SyncRecord; situation: Situation; payments: SyncRecord[]; credits: SyncRecord[]; onCredit: () => void;
}) {
  const { db, session, go } = useApp();
  const settings = useSettings();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const currency = situation.currency;
  const fm = (n: number) => formatMoney(n, currency);
  const fixed = !!CURRENCIES[currency]?.fixedRate;
  const [rate, setRate] = useState<number>(() => rateFor(currency, settings.rates as Record<string, number> | undefined));

  async function add() {
    setError(null);
    const closed = text(settings.closed_until);
    if (closed && date <= closed) return setError(`Période clôturée jusqu'au ${formatDate(closed)} : choisissez une date ultérieure.`);
    const d = decimalsOf(currency);
    const typed = Number((amount || String(situation.due)).replace(/\s/g, "").replace(",", "."));
    const value = Math.round(typed * 10 ** d) / 10 ** d;
    if (!Number.isFinite(value) || value <= 0) return setError("Montant invalide.");
    if (value > situation.due && !confirm(`Le montant dépasse le reste dû (${fm(situation.due)}). Enregistrer quand même ?`)) return;
    await db.write("payments", db.newId("pay"), {
      invoice_id: invoice.id,
      client_id: invoice.data.client_id,
      date,
      amount: value,
      currency,
      rate: currency === "XAF" ? 1 : rate,
      method,
      reference: reference.trim(),
      created_by: session.user.id,
    });
    setAmount("");
    setReference("");
  }

  async function cancel(p: SyncRecord) {
    if (!confirm(`Annuler l'encaissement de ${fm(Number(p.data.amount))} ?`)) return;
    await db.remove("payments", p.id);
  }

  return (
    <div className="card section-card">
      <h3>Encaissements</h3>
      {payments.length === 0 ? (
        <p className="muted small">Aucun encaissement.</p>
      ) : (
        <table>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id}>
                <td>{formatDate(p.data.date)}</td>
                <td>{PAYMENT_METHODS[text(p.data.method)] ?? text(p.data.method)}</td>
                <td className="muted">{text(p.data.reference)}</td>
                <td className="right mono">{fm(Number(p.data.amount))}</td>
                <td className="right"><button className="ghost small" onClick={() => cancel(p)}>Annuler</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {situation.due > 0 && (
        <div className="pay-form">
          <label>Montant<input inputMode="numeric" placeholder={String(situation.due)} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Montant encaissé" /></label>
          <label>
            Mode
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          {currency !== "XAF" && (
            <label>Taux du jour<input type="number" step="any" min="0" value={rate} disabled={fixed} onChange={(e) => setRate(Number(e.target.value))} /></label>
          )}
          <label>Référence<input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="n° de transaction, chèque…" /></label>
          <button className="primary" onClick={add}>Enregistrer l'encaissement</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      <h3>Avoirs</h3>
      {credits.length === 0 ? <p className="muted small">Aucun avoir sur cette facture.</p> : (
        <ul className="plain">
          {credits.map((c) => (
            <li key={c.id}>
              <button className="link" onClick={() => go("credit_notes", c.id)}>{text(c.data.number) || "Brouillon d'avoir"}</button>
              {" · "}{fm(totalsOf(c).gross)}{c.data.status !== "validated" && " (non validé)"}
            </li>
          ))}
        </ul>
      )}
      {situation.due > 0 && <button className="ghost" onClick={onCredit}>Créer un avoir</button>}
    </div>
  );
}

/** Partage par WhatsApp ou e-mail : le message résume le document, le PDF se joint depuis l'impression. */
function ShareButtons({ kind, record, client, gross, due, currency }: {
  kind: DocTable; record: SyncRecord; client: SyncRecord | null; gross: number; due?: number; currency: string;
}) {
  const { db } = useApp();
  const settings = useSettings();
  const company = text(settings.name);
  const number = text(record.data.number);
  const what = kind === "quotes" ? "notre devis" : kind === "credit_notes" ? "notre avoir" : "notre facture";
  const lines = [
    `Bonjour${client ? ` ${text(client.data.name)}` : ""},`,
    `Veuillez trouver ${what} ${number} d'un montant de ${formatMoney(gross, currency)}.`,
  ];
  if (kind === "invoices" && due !== undefined && due > 0) {
    lines.push(`Reste à régler : ${formatMoney(due, currency)}${record.data.due_date ? `, échéance le ${formatDate(record.data.due_date)}` : ""}.`);
  }
  if (kind === "quotes" && record.data.valid_until) lines.push(`Offre valable jusqu'au ${formatDate(record.data.valid_until)}.`);
  lines.push("Cordialement,", company);
  const message = lines.filter(Boolean).join("\n");

  // Numéro au format international uniquement (+241…) : sinon WhatsApp laisse choisir le contact.
  const phone = text(client?.data.phone).replace(/[^\d+]/g, "");
  const intl = phone.startsWith("+") ? phone.slice(1) : phone.startsWith("00") ? phone.slice(2) : "";
  const wa = `https://wa.me/${intl}?text=${encodeURIComponent(message)}`;
  const subject = `${kind === "quotes" ? "Devis" : kind === "credit_notes" ? "Avoir" : "Facture"} ${number}${company ? ` - ${company}` : ""}`;
  const mail = `mailto:${encodeURIComponent(text(client?.data.email))}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;

  // On garde la date du premier envoi.
  const markSent = () => {
    if (!record.data.sent_at) void db.write(kind, record.id, { sent_at: new Date().toISOString() });
  };
  return (
    <>
      <a className="button" href={wa} target="_blank" rel="noopener noreferrer" onClick={markSent}>WhatsApp</a>
      <a className="button" href={mail} onClick={markSent}>E-mail</a>
    </>
  );
}
