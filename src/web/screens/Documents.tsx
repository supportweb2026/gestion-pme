/**
 * Devis, factures et avoirs : une liste et un éditeur communs.
 * Un document numéroté (devis envoyé, facture ou avoir validé) est figé ;
 * la suite se fait par actions : accepter, convertir, encaisser, créer un avoir.
 */
import { useEffect, useMemo, useState } from "react";
import { can, formatDate, normalize, text, today, useApp, useSettings, useTable } from "../context.ts";
import { ImportHistory } from "../ImportHistory.tsx";
import {
  addDays, computeTotals, DEFAULT_PAYMENT_DAYS, DEFAULT_VAT_RATE, lineNet, PAYMENT_METHODS, unfreezeLine, type InvoiceLine,
} from "../../shared/invoice.ts";
import { CURRENCIES, decimalsOf, formatMoney, rateFor } from "../../shared/currency.ts";
import { isNumbered, type DocTable, type SyncRecord } from "../../shared/sync.ts";
import { reminderDue, reminderSettings, TONE_LABELS, type ReminderDue, type ReminderTone } from "../../shared/reminders.ts";
import { CASH_LIMIT_XAF, fiscalSettings, newDocTaxFields, pct } from "../../shared/taxes.ts";
import { currencyOf, invoiceSituations, linesOf, QUOTE_LABELS, quoteStatus, rateOf, SITUATION_LABELS, totalsOf, type Situation } from "../ledger.ts";
import { PrintView } from "./PrintView.tsx";
import {
  applyGlobalDiscount, deductionLines, depositLines, docTitle, isDepositLine, isSection, percentForAmount,
  QUOTE_TYPES, quoteTypeOf, sectionSubtotals, type QuoteType,
} from "../../shared/documents.ts";
import { QuoteProjectBanner } from "./projects/QuoteProjectBanner.tsx";
import { useValidateOnOpen } from "../projectInvoices.ts";
import { canShareFiles, downloadFile, makePdfFile, shareFile } from "../pdfActions.ts";
import { useStock } from "../stock.ts";
import { defaultNote } from "../../shared/branding.ts";
import { qtyFr } from "../../shared/stock.ts";
import {
  describe, isFinished, nextAfter, RECURRENCE_FREQS, recurrenceOf, type RecurrenceFreq,
} from "../../shared/recurrence.ts";

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

type Filter = "all" | "draft" | "open" | "overdue" | "remind" | "recurring";

/** Facture modèle d'une série encore active. */
export function activeSeries(d: SyncRecord): boolean {
  const rec = recurrenceOf(d.data);
  return !!rec && d.data.status === "validated" && !isFinished(rec, text(d.data.recurrence_next));
}

/** Relance à envoyer aujourd'hui pour une facture validée (calendrier des réglages). */
export function invoiceReminder(inv: SyncRecord, situation: Situation | undefined, settings: Record<string, unknown>): ReminderDue | null {
  if (inv.data.status !== "validated" || !situation) return null;
  const r = reminderDue({
    dueDate: text(inv.data.due_date), amountDue: situation.due, sent: Number(inv.data.reminders ?? 0),
    lastSent: text(inv.data.reminded_at).slice(0, 10) || undefined, today: today(), settings: reminderSettings(settings),
  });
  // Pas de rappel avant échéance pour une facture qui n'a pas encore été envoyée.
  return r && r.days <= 0 && !inv.data.sent_at ? null : r;
}

/** Données partagées par la liste et l'éditeur. */
function useSalesData() {
  const invoices = useTable("invoices");
  const payments = useTable("payments");
  const credits = useTable("credit_notes");
  const situations = useMemo(() => invoiceSituations(invoices, payments, credits), [invoices, payments, credits]);
  return { invoices, payments, credits, situations };
}

export function Documents({ kind, open, setOpen }: { kind: DocTable; open: string | null; setOpen: (id: string | null) => void }) {
  const { go, session } = useApp();
  // Reprise d'historique (VosFactures) : ouverte depuis la liste, pour la direction.
  const [importing, setImporting] = useState(false);
  const docs = useTable(kind);
  const clients = useTable("clients");
  const { situations } = useSalesData();
  const listSettings = useSettings();
  const remindOf = (d: SyncRecord) => (kind === "invoices" ? invoiceReminder(d, situations.get(d.id), listSettings) : null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const cfg = DOCS[kind];
  const clientName = (id: unknown) => text(clients.find((c) => c.id === id)?.data.name) || "—";

  if (open) {
    const record = open === "new" ? null : docs.find((d) => d.id === open) ?? null;
    if (open !== "new" && !record) return <p className="empty">Document introuvable sur cet appareil.</p>;
    return <DocEditor key={open} kind={kind} record={record} clients={clients} onClose={() => setOpen(null)} onOpen={setOpen} />;
  }

  const statusOf = (d: SyncRecord) => docStatus(kind, d, situations);

  const q = normalize(query.trim());
  const matchesFilter = (d: SyncRecord, f: Filter) => {
    const k = statusOf(d).key;
    if (f === "draft") return k === "draft";
    if (f === "open") return ["unpaid", "partial", "overdue", "sent"].includes(k);
    if (f === "overdue") return k === "overdue" || k === "expired";
    if (f === "remind") return remindOf(d) !== null;
    if (f === "recurring") return activeSeries(d);
    return true;
  };
  const rows = docs
    .filter((d) => {
      if (q && !normalize(`${text(d.data.number)} ${clientName(d.data.client_id)}`).includes(q)) return false;
      return matchesFilter(d, filter === "recurring" && !docs.some(activeSeries) ? "all" : filter);
    })
    .sort((a, b) => text(b.data.date).localeCompare(text(a.data.date)) || text(b.data.number).localeCompare(text(a.data.number)));
  const filters = ([["all", "Tous"], ["draft", "Brouillons"], ["open", kind === "quotes" ? "En attente" : "À encaisser"], ["overdue", kind === "quotes" ? "Expirés" : "En retard"], ["remind", "À relancer"], ["recurring", "Récurrentes"]] as [Filter, string][])
    .filter(([f]) => (kind !== "credit_notes" || f === "all" || f === "draft") && ((f !== "remind" && f !== "recurring") || kind === "invoices"))
    // « Récurrentes » n'apparaît qu'une fois une série créée.
    .filter(([f]) => f !== "recurring" || docs.some(activeSeries));
  const count = (f: Filter) => docs.filter((d) => matchesFilter(d, f)).length;
  // Filtre devenu sans objet (dernière série arrêtée) : retour à « Tous ».
  const shownFilter: Filter = filters.some(([f]) => f === filter) ? filter : "all";
  const noClient = clients.length === 0;
  const withDue = kind !== "credit_notes";

  return (
    <section>
      <div className="page-head">
        <div>
          <h2>{cfg.title}</h2>
          <p className="muted small">{subtitle(kind, docs.length)}</p>
        </div>
        {cfg.newLabel && (
          <div className="quick">
            {noClient && !importing && <span className="muted small" id="need-client">Créez d'abord un client.</span>}
            {can.manageCompany(session.user.role) && (
              <button onClick={() => setImporting((v) => !v)} aria-expanded={importing} title="Reprendre les devis, factures, avoirs, clients et encaissements d'un autre logiciel (VosFactures)">
                Importer
              </button>
            )}
            <button className="primary" onClick={() => setOpen("new")} disabled={noClient} aria-describedby={noClient ? "need-client" : undefined}>
              {cfg.newLabel}
            </button>
          </div>
        )}
      </div>
      {importing && <ImportHistory />}
      <div className="toolbar">
        <label className="sr-only" htmlFor={`search-${kind}`}>Rechercher</label>
        <input id={`search-${kind}`} type="search" placeholder="Rechercher un numéro ou un client" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Rechercher" />
        {docs.length > 0 && (
          <div className="segmented" role="group" aria-label="Filtrer">
            {filters.map(([f, label]) => {
              const n = f === "all" ? 0 : count(f);
              return (
                <button key={f} className={shownFilter === f ? "active" : ""} aria-pressed={shownFilter === f} onClick={() => setFilter(f)}>
                  {label}{n > 0 && <span className="seg-count">{n}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6" /><path d="M9 12h6" /></svg>
          </div>
          <p className="empty-title">
            {noClient ? "Commencez par créer un client"
              : kind === "credit_notes" && docs.length === 0 ? "Aucun avoir"
              : docs.length === 0 ? `Aucun${kind === "invoices" ? "e" : ""} ${cfg.one.toLowerCase()} pour l'instant`
              : "Aucun document ne correspond"}
          </p>
          <p className="muted">
            {noClient ? "Un devis ou une facture est toujours adressé à un client."
              : kind === "credit_notes" && docs.length === 0 ? "Un avoir se crée depuis une facture validée, pour la corriger ou l'annuler."
              : docs.length === 0 ? `Créez votre premi${kind === "invoices" ? "ère" : "er"} ${cfg.one.toLowerCase()} : ${kind === "invoices" ? "elle sera numérotée" : "il sera numéroté"} automatiquement à la validation.`
              : "Modifiez la recherche ou le filtre."}
          </p>
          {noClient ? <button className="primary" onClick={() => go("clients")}>Créer un client</button>
            : docs.length === 0 && cfg.newLabel ? <button className="primary" onClick={() => setOpen("new")}>{cfg.newLabel}</button> : null}
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="doc-table">
            <caption className="sr-only">{cfg.title}</caption>
            <thead>
              <tr>
                <th>Numéro</th><th>Client</th><th>Date</th>{withDue && <th>{kind === "quotes" ? "Valable jusqu'au" : "Échéance"}</th>}<th>Statut</th>
                {kind === "invoices" && <th className="right">Reste dû</th>}
                <th className="right">Total TTC</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const st = statusOf(d);
                const dueDate = text(d.data.due_date ?? d.data.valid_until);
                return (
                  <tr key={d.id} className="clickable">
                    <td className="c-num mono"><button className="row-link" onClick={() => setOpen(d.id)}>{text(d.data.number) || <i className="draft-num">Brouillon</i>}</button>{(kind === "quotes" && quoteTypeOf(d.data) !== "quote") || d.data.deposit ? <span className="doc-type">{docTitle(kind, d.data)}</span> : null}{kind === "invoices" && (activeSeries(d) || d.data.recurrence_of) ? <span className="doc-type recur-tag" title={activeSeries(d) ? `Prochaine facture le ${formatDate(d.data.recurrence_next)}` : "Préparée automatiquement"}>{activeSeries(d) ? `Récurrente · ${RECURRENCE_FREQS[recurrenceOf(d.data)!.freq].adjective}` : "Récurrente"}</span> : null}</td>
                    <td className="c-client">{clientName(d.data.client_id)}</td>
                    <td className="c-date">{formatDate(d.data.date)}</td>
                    {withDue && <td className={`c-due-date ${st.key === "overdue" || st.key === "expired" ? "danger-text" : "muted"}`}>{dueDate ? formatDate(dueDate) : "—"}</td>}
                    <td className="c-status"><span className={`badge ${st.tone}`}>{st.label}</span>{(() => {
                      const r = remindOf(d);
                      return r ? <span className="remind-tag" title={TONE_LABELS[r.tone]}>À relancer · {r.label}</span> : null;
                    })()}</td>
                    {kind === "invoices" && <td className="c-due right mono">{st.key === "draft" || st.key === "cancelled" ? "" : formatMoney(situations.get(d.id)?.due ?? 0, currencyOf(d))}</td>}
                    <td className="c-total right mono">{kind === "quotes" && quoteTypeOf(d.data) === "delivery" ? "—" : formatMoney(totalsOf(d).gross, currencyOf(d))}</td>
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

function subtitle(kind: DocTable, n: number): string {
  if (n === 0) return kind === "quotes" ? "Devis, factures pro forma, bons de commande et de livraison" : kind === "invoices" ? "Factures émises et suivi des encaissements" : "Corrections et annulations de factures";
  if (kind === "quotes") return `${n} document${n > 1 ? "s" : ""}`;
  const one = kind === "invoices" ? "facture" : "avoir";
  return `${n} ${one}${n > 1 ? "s" : ""}`;
}

/** Statut affiché d'un document, avec sa couleur : gris brouillon, bleu en cours, ambre partiel, vert réglé, rouge en retard. */
export function docStatus(kind: DocTable, d: SyncRecord, situations: Map<string, Situation>): { label: string; tone: string; key: string } {
  if (kind === "invoices") {
    // Facture annulée dans le logiciel d'origine (reprise d'historique) : gardée pour mémoire, hors chiffres.
    if (d.data.status === "cancelled") return { label: "Annulée", tone: "", key: "cancelled" };
    const s = situations.get(d.id)?.status ?? "draft";
    const tone = s === "paid" ? "ok" : s === "overdue" ? "danger" : s === "partial" ? "warn" : s === "unpaid" ? "info" : "";
    return { label: SITUATION_LABELS[s], tone, key: s };
  }
  if (kind === "quotes") {
    const s = quoteStatus(d);
    // Un bon de livraison n'est ni accepté ni facturé : il est livré (ou à livrer).
    if (quoteTypeOf(d.data) === "delivery") {
      if (s === "draft") return { label: "Brouillon", tone: "", key: s };
      return s === "accepted" ? { label: "Livré", tone: "ok", key: s } : { label: "À livrer", tone: "info", key: s };
    }
    const tone = s === "accepted" || s === "invoiced" ? "ok" : s === "expired" ? "danger" : s === "sent" ? "info" : "";
    return { label: QUOTE_LABELS[s] ?? s, tone, key: s };
  }
  if (d.data.status === "cancelled") return { label: "Annulé", tone: "", key: "cancelled" };
  const v = d.data.status === "validated";
  return { label: v ? "Validé" : "Brouillon", tone: v ? "ok" : "", key: v ? "validated" : "draft" };
}

const emptyLine = (): InvoiceLine => ({ label: "", qty: 1, unitPrice: 0, vatRate: DEFAULT_VAT_RATE });

function DocEditor({ kind, record, clients, onClose, onOpen }: {
  kind: DocTable; record: SyncRecord | null; clients: SyncRecord[]; onClose: () => void; onOpen: (id: string) => void;
}) {
  const { db, sync, session, go } = useApp();
  const cfg = DOCS[kind];
  const settings = useSettings();
  const articles = useTable("articles");
  const { levels: stock } = useStock();
  const { invoices, payments, credits, situations } = useSalesData();
  const paymentDays = Number(settings.payment_days ?? DEFAULT_PAYMENT_DAYS);

  const [id] = useState(() => record?.id ?? db.newId(kind === "quotes" ? "dv" : kind === "invoices" ? "fa" : "av"));
  const [clientId, setClientId] = useState(text(record?.data.client_id) || clients[0]?.id || "");
  const [date, setDate] = useState(text(record?.data.date) || today());
  const [dueDate, setDueDate] = useState(text(record?.data.due_date ?? record?.data.valid_until) || addDays(today(), paymentDays));
  const [lines, setLines] = useState<InvoiceLine[]>(() => (record ? linesOf(record) : [emptyLine()]).map((l) => ({ ...l })));
  const [notes, setNotes] = useState(text(record?.data.notes) || (record ? "" : defaultNote(settings, kind)));
  // Note par défaut (Réglages, Apparence) : reprise dès que les réglages sont chargés.
  const presetNote = record ? "" : defaultNote(settings, kind);
  useEffect(() => {
    if (presetNote) setNotes((n) => n || presetNote);
  }, [presetNote]);
  const [currency, setCurrency] = useState(currencyOf(record));
  const [rate, setRate] = useState<number>(() => (record ? rateOf(record) : 1));
  const [projectId, setProjectId] = useState(text(record?.data.project_id));
  const projects = useTable("projects");
  const [message, setMessage] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [docType, setDocType] = useState<QuoteType>(() => quoteTypeOf(record?.data));
  const [globalDiscount, setGlobalDiscount] = useState("");
  const fiscal = fiscalSettings(settings);
  const [withholding, setWithholding] = useState(() => ({ rate: Number(record?.data.withholding_rate) || 0, label: text(record?.data.withholding_label) }));
  const qt = QUOTE_TYPES[docType];
  const one = kind === "quotes" ? qt.label : docTitle(kind, record?.data);
  const isDelivery = kind === "quotes" && docType === "delivery";

  const numbered = isNumbered(record?.data);
  const closedUntil = text(settings.closed_until);
  const locked = !numbered && !!closedUntil && date <= closedUntil && kind !== "quotes";
  const editable = !numbered && !locked;
  const decimals = decimalsOf(currency);
  const fm = (n: number) => formatMoney(n, currency);
  const changeCurrency = (code: string) => {
    setCurrency(code);
    setRate(rateFor(code, settings.rates as Record<string, number> | undefined));
  };
  const client = clients.find((c) => c.id === clientId) ?? null;
  const situation: Situation | undefined = kind === "invoices" && record ? situations.get(record.id) : undefined;
  const sourceInvoice = kind === "credit_notes" ? invoices.find((i) => i.id === record?.data.invoice_id) : undefined;
  // Taxes : figées sur un document émis ; un brouillon suit les réglages du moment,
  // un avoir reprend celles de sa facture, un bon de livraison n'en a pas.
  const taxFields = numbered || kind === "credit_notes"
    ? { css_rate: Number(record?.data.css_rate) || 0, css_on_zero: Boolean(record?.data.css_on_zero) }
    : isDelivery ? { css_rate: 0, css_on_zero: false } : newDocTaxFields(fiscal);
  const withholdingRate = isDelivery ? 0 : withholding.rate;
  // Retenue figée d'un document repris d'un autre logiciel.
  const frozenWithholding = numbered && typeof record?.data.withholding_amount === "number" ? { withholdingAmount: record.data.withholding_amount } : {};
  const totals = computeTotals(lines, decimals, { cssRate: taxFields.css_rate, cssOnZero: taxFields.css_on_zero, withholdingRate, ...frozenWithholding });
  const taxCopy = (r: SyncRecord | null | undefined) => ({
    css_rate: Number(r?.data.css_rate) || 0, css_on_zero: Boolean(r?.data.css_on_zero),
    withholding_rate: Number(r?.data.withholding_rate) || 0, withholding_label: text(r?.data.withholding_label),
  });

  // Pour un nouveau document, l'échéance suit la date.
  useEffect(() => {
    if (!record) setDueDate(addDays(date, kind === "quotes" ? 30 : paymentDays));
  }, [date]);

  // Une ligne modifiée perd ses montants figés (document repris) : elle se recalcule.
  const update = (i: number, patch: Partial<InvoiceLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...unfreezeLine(l), ...patch } : l)));
  const pickArticle = (i: number, label: string) => {
    const a = articles.find((x) => text(x.data.label) === label);
    if (!a) return update(i, { label, articleId: undefined });
    update(i, {
      label,
      articleId: a.id,
      unitPrice: Number(a.data.price ?? 0),
      vatRate: Number(a.data.vat_rate ?? DEFAULT_VAT_RATE),
      unit: text(a.data.unit) || undefined,
      // Prix d'achat du moment, figé sur la ligne pour la marge (converti dans la devise du document).
      cost: a.data.cost === undefined || a.data.cost === null || a.data.cost === ""
        ? undefined
        : Math.round((Number(a.data.cost) / (currency === "XAF" ? 1 : rate || 1)) * 10 ** decimals) / 10 ** decimals,
    });
  };
  const cleanLines = () => lines.filter((l) => (isSection(l) ? l.label.trim() !== "" : l.label.trim() !== "" || l.unitPrice !== 0));
  const billable = () => cleanLines().filter((l) => !isSection(l));

  function contentPatch(): Record<string, unknown> {
    const p: Record<string, unknown> = {
      client_id: clientId, date, lines: cleanLines(), notes: notes.trim(), currency, rate: currency === "XAF" ? 1 : rate, project_id: projectId,
    };
    if (kind === "invoices") p.due_date = dueDate;
    if (kind !== "credit_notes") Object.assign(p, taxFields, { withholding_rate: withholdingRate, withholding_label: withholdingRate ? withholding.label : "" });
    if (kind === "quotes") {
      p.valid_until = isDelivery ? "" : dueDate;
      p.doc_type = docType;
    }
    if (!record) Object.assign(p, { status: "draft", created_by: session.user.id, created_by_name: session.user.name });
    return p;
  }

  async function saveDraft(close = true) {
    await db.write(kind, id, contentPatch());
    if (close) onClose();
  }

  async function validate() {
    setMessage(null);
    if (!clientId) return setMessage("Choisissez un client.");
    if (fiscal.requireClientNif && kind !== "quotes" && client && !client.data.individual && !text(client.data.nif).trim()) {
      return setMessage("Le NIF du client est obligatoire sur une facture : complétez sa fiche (ou cochez « Particulier »).");
    }
    if (billable().length === 0) return setMessage("Ajoutez au moins une ligne.");
    // Seule une déduction d'acompte peut avoir un prix négatif.
    if (billable().some((l) => l.qty <= 0 || (l.unitPrice < 0 && !l.depositInvoiceId))) return setMessage("Vérifiez les quantités et les prix.");
    if (billable().some((l) => (l.discount ?? 0) < 0 || (l.discount ?? 0) > 100)) return setMessage("Une remise doit être comprise entre 0 et 100 %.");
    if (billable().some((l) => l.vatRate < 0 || l.vatRate > 100)) return setMessage("Vérifiez les taux de TVA.");
    if (totals.gross < 0) return setMessage("Le total ne peut pas être négatif : vérifiez les acomptes déduits.");
    if (kind === "credit_notes" && sourceInvoice) {
      const others = credits
        .filter((c) => c.id !== id && c.data.invoice_id === sourceInvoice.id && c.data.status === "validated")
        .reduce((n, c) => n + totalsOf(c).gross, 0);
      const max = totalsOf(sourceInvoice).gross - others;
      if (totals.gross > max) return setMessage(`L'avoir dépasse le montant restant de la facture (${fm(max)}).`);
    }
    if (!confirm(kind === "quotes" && docType !== "quote" ? `${qt.label} : le document va être numéroté et ne pourra plus être modifié. Continuer ?` : cfg.confirm)) return;
    setBusy(true);
    try {
      const number = await sync.takeNumber(kind === "quotes" ? qt.prefix : cfg.prefix);
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

  // Facture de jalon avec « Valider la facture tout de suite » (Projets, lot 3) : même validation, même confirmation.
  useValidateOnOpen(kind === "invoices" && !numbered ? record?.id : undefined, validate);

  async function setQuoteStatus(status: "accepted" | "refused") {
    await db.write("quotes", id, { status, decided_at: new Date().toISOString() });
  }

  /** Factures d'acompte validées rattachées à ce document. */
  const deposits = kind === "quotes" && record
    ? invoices.filter((i) => i.data.quote_id === record.id && i.data.deposit && i.data.status === "validated")
    : [];
  const draftDeposits = kind === "quotes" && record
    ? invoices.filter((i) => i.data.quote_id === record.id && i.data.deposit && i.data.status !== "validated")
    : [];

  /** Devis facturé par étapes depuis son projet : le convertir en entier le facturerait deux fois. */
  const stageBilled = kind === "quotes" && record && text(record.data.project_id)
    ? invoices.some((i) => text(i.data.stage_id) && i.data.project_id === record.data.project_id)
    : false;

  async function quoteToInvoice() {
    const invId = db.newId("fa");
    // Facture de solde : toutes les lignes, moins chaque acompte déjà facturé.
    const deductions = deposits.flatMap((d) => deductionLines({ id: d.id, number: text(d.data.number), date: text(d.data.date), lines: linesOf(d) }));
    await db.write("invoices", invId, {
      status: "draft",
      client_id: record!.data.client_id,
      date: today(),
      due_date: addDays(today(), paymentDays),
      lines: [...linesOf(record).filter((l) => !isDepositLine(l)), ...deductions],
      ...(deposits.length ? { final_invoice: true } : {}),
      withholding_rate: Number(record!.data.withholding_rate) || 0,
      withholding_label: text(record!.data.withholding_label),
      notes: text(record!.data.notes),
      currency: currencyOf(record),
      rate: rateOf(record),
      project_id: text(record!.data.project_id),
      quote_id: id,
      quote_number: record!.data.number,
      created_by: session.user.id,
      created_by_name: session.user.name,
    });
    await db.write("quotes", id, { status: "invoiced", invoice_id: invId, decided_at: new Date().toISOString() });
    go("invoices", invId);
  }

  /** Facture d'acompte : un pourcentage (ou un montant TTC) du document d'origine. */
  async function createDeposit(mode: "percent" | "amount", value: number) {
    const source = linesOf(record);
    const pct = mode === "percent" ? value : percentForAmount(source, value, decimals);
    if (!(pct > 0 && pct <= 100)) return setMessage("L'acompte doit être compris entre 0 et 100 % du document.");
    const invId = db.newId("fa");
    await db.write("invoices", invId, {
      status: "draft",
      deposit: true,
      client_id: record!.data.client_id,
      date: today(),
      due_date: today(),
      lines: depositLines(source, pct, `${one.toLowerCase()} ${text(record!.data.number)}`, decimals),
      withholding_rate: Number(record!.data.withholding_rate) || 0,
      withholding_label: text(record!.data.withholding_label),
      notes: text(record!.data.notes),
      currency: currencyOf(record),
      rate: rateOf(record),
      project_id: text(record!.data.project_id),
      quote_id: id,
      quote_number: record!.data.number,
      created_by: session.user.id,
      created_by_name: session.user.name,
    });
    if (record!.data.status === "sent") await db.write("quotes", id, { status: "accepted", decided_at: new Date().toISOString() });
    go("invoices", invId);
  }

  /** Bon de livraison reprenant les articles du document (sans les acomptes). */
  async function createDelivery() {
    const blId = db.newId("bl");
    await db.write("quotes", blId, {
      status: "draft",
      doc_type: "delivery",
      client_id: record!.data.client_id,
      date: today(),
      valid_until: "",
      lines: linesOf(record).filter((l) => !isDepositLine(l)),
      currency: currencyOf(record),
      rate: rateOf(record),
      project_id: text(record!.data.project_id),
      source_id: id,
      source_number: record!.data.number,
      notes: `Livraison${record!.data.number ? ` selon ${docTitle(kind, record!.data).toLowerCase()} ${text(record!.data.number)}` : ""}`,
      created_by: session.user.id,
      created_by_name: session.user.name,
    });
    go("quotes", blId);
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
      ...taxCopy(record),
      notes: `Avoir sur la facture ${text(record!.data.number)}`,
      created_by: session.user.id,
      created_by_name: session.user.name,
    });
    go("credit_notes", cnId);
  }

  /** Nouveau brouillon reprenant client, lignes, devise et notes, daté du jour. */
  async function duplicate() {
    const newId = db.newId(kind === "quotes" ? "dv" : "fa");
    const patch: Record<string, unknown> = {
      status: "draft",
      client_id: clientId,
      date: today(),
      lines: cleanLines().map(unfreezeLine),
      notes: notes.trim(),
      currency,
      rate: currency === "XAF" ? 1 : rate,
      project_id: projectId,
      withholding_rate: withholdingRate,
      withholding_label: withholdingRate ? withholding.label : "",
      created_by: session.user.id,
      created_by_name: session.user.name,
    };
    if (kind === "invoices") patch.due_date = addDays(today(), paymentDays);
    if (kind === "quotes") {
      patch.doc_type = docType;
      patch.valid_until = isDelivery ? "" : addDays(today(), 30);
    }
    await db.write(kind, newId, patch);
    go(kind, newId);
  }

  async function removeDraft() {
    if (!confirm("Supprimer ce brouillon ?")) return;
    await db.remove(kind, id);
    onClose();
  }

  const title = numbered ? `${one} ${text(record?.data.number)}` : record ? `${one} (brouillon)` : kind === "quotes" ? qt.newLabel : DOCS[kind].newLabel ?? one;
  const linked = kind === "invoices" ? credits.filter((c) => c.data.invoice_id === id) : [];
  const invoicePayments = kind === "invoices" ? payments.filter((p) => p.data.invoice_id === id).sort((a, b) => text(a.data.date).localeCompare(text(b.data.date))) : [];
  const status = record ? docStatus(kind, record, situations) : null;
  const nextReminder = kind === "invoices" && record ? invoiceReminder(record, situation, settings) : null;
  const share = useShare({ kind, record, client, gross: totals.payable, situation, currency, nextReminder });
  const dueLabel = kind === "quotes" ? "Valable jusqu'au" : "Échéance";
  const showDue = kind === "invoices" || (kind === "quotes" && !isDelivery);
  const subtotals = sectionSubtotals(lines, decimals);

  const head = (
    <div className="page-head doc-head">
      <div>
        <button className="link back-link" onClick={onClose}>← {cfg.title}</button>
        <div className="title-row">
          <h2>{title}</h2>
          {status && numbered && <span className={`badge ${status.tone}`}>{status.label}</span>}
        </div>
        {numbered && (
          <p className="doc-meta"><b>{text(client?.data.name) || "—"}</b></p>
        )}
        {numbered && (record!.data.sent_at || record!.data.reminded_at) ? (
          <p className="muted small sent-info" data-testid="sent-info">
            {record!.data.sent_at ? `Envoyé le ${formatDate(text(record!.data.sent_at).slice(0, 10))}` : ""}
            {record!.data.sent_at && record!.data.reminded_at ? " · " : ""}
            {record!.data.reminded_at ? `Relancé ${Number(record!.data.reminders ?? 1)} fois, dernière relance le ${formatDate(text(record!.data.reminded_at).slice(0, 10))}` : ""}
          </p>
        ) : null}
      </div>
      <div className="actions">
        {numbered && <button onClick={() => setPrinting(true)}>Aperçu / imprimer</button>}
        {record && kind !== "credit_notes" && <button onClick={duplicate}>Dupliquer</button>}
        {numbered && <button onClick={() => share.pdf("download")} disabled={share.busy}>Télécharger le PDF</button>}
        {numbered && (kind === "invoices" || (kind === "quotes" && !isDelivery)) && <button onClick={createDelivery}>Bon de livraison</button>}
      </div>
    </div>
  );

  const links = (
    <>
      {kind === "credit_notes" && sourceInvoice && (
        <p className="muted small">
          Sur la facture <button className="link" onClick={() => go("invoices", sourceInvoice.id)}>{text(sourceInvoice.data.number)}</button>
        </p>
      )}
      {kind === "invoices" && record?.data.quote_id ? (
        <p className="muted small">
          {originPhrase(text(record.data.quote_number))} <button className="link" onClick={() => go("quotes", text(record.data.quote_id))}>{text(record.data.quote_number)}</button>
        </p>
      ) : null}
      {record?.data.imported ? <p className="muted small" data-testid="doc-imported">Document repris de VosFactures, tel qu'il a été émis.</p> : null}
      {kind === "invoices" && record?.data.recurrence_of ? (
        <p className="muted small recur-origin">
          {numbered ? "Facture récurrente, d'après" : "Préparée automatiquement d'après la facture récurrente"} <button className="link" onClick={() => go("invoices", text(record.data.recurrence_of))}>{text(record.data.recurrence_number)}</button>
          {numbered ? "" : ". Vérifiez les quantités et les mentions de période, puis validez-la."}
        </p>
      ) : null}
      {kind === "quotes" && record?.data.source_id ? (
        <p className="muted small">
          Établi d'après <button className="link" onClick={() => go(invoices.some((i) => i.id === record.data.source_id) ? "invoices" : "quotes", text(record.data.source_id))}>{text(record.data.source_number)}</button>
        </p>
      ) : null}
    </>
  );

  const totalsList = (
    <dl className="totals">
      {totals.discount > 0 && (<><dt>Remises</dt><dd className="mono" data-testid="discount">-{fm(totals.discount)}</dd></>)}
      <dt>Total HT</dt><dd className="mono" data-testid="total-ht">{fm(totals.net)}</dd>
      <dt>TVA</dt><dd className="mono" data-testid="total-vat">{fm(totals.vat)}</dd>
      {totals.css !== 0 && (<><dt>CSS ({pct(taxFields.css_rate)})</dt><dd className="mono" data-testid="total-css">{fm(totals.css)}</dd></>)}
      <dt className="strong">Total TTC</dt><dd className="mono strong" data-testid="total-ttc">{fm(totals.gross)}</dd>
      {totals.withholding !== 0 && (
        <>
          <dt>Retenue à la source{withholding.label ? ` · ${withholding.label}` : ""} ({pct(withholdingRate)})</dt><dd className="mono" data-testid="total-withholding">-{fm(totals.withholding)}</dd>
          <dt className="strong">Net à payer</dt><dd className="mono strong" data-testid="total-payable">{fm(totals.payable)}</dd>
        </>
      )}
      {currency !== "XAF" && (<><dt>Contre-valeur</dt><dd className="mono muted">{formatMoney(Math.round(totals.gross * rate), "XAF")}</dd></>)}
      {situation && situation.status !== "draft" && (
        <>
          {situation.paid > 0 && (<><dt>Encaissé</dt><dd className="mono">-{fm(situation.paid)}</dd></>)}
          {situation.credited > 0 && (<><dt>Avoirs</dt><dd className="mono">-{fm(situation.credited)}</dd></>)}
          <dt className="strong due">Reste dû</dt><dd className="mono strong due" data-testid="due">{fm(situation.due)}</dd>
        </>
      )}
    </dl>
  );

  // ---------- Document numéroté (ou date en période clôturée) : lecture seule ----------
  if (!editable) {
    const project = projects.find((p) => p.id === (text(record?.data.project_id) || projectId));
    return (
      <section>
        {head}
        {locked && (
          <>
            <p className="notice">Date dans une période clôturée (jusqu'au {formatDate(closedUntil)}) : choisissez une date ultérieure.</p>
            <label className="inline notice-fix">Nouvelle date <input type="date" value={date} min={addDays(closedUntil, 1)} onChange={(e) => setDate(e.target.value)} /></label>
          </>
        )}
        {links}
        {kind === "quotes" && numbered && <QuoteProjectBanner quote={record!} />}
        <div className={`doc-layout${numbered ? "" : " single"}`}>
          <div className="doc-main">
            <div className="card section-card">
              <dl className="doc-facts">
                <div><dt>Client</dt><dd>{text(client?.data.name) || "—"}</dd></div>
                <div><dt>Date</dt><dd>{formatDate(date)}</dd></div>
                {showDue && <div><dt>{dueLabel}</dt><dd>{dueDate ? formatDate(dueDate) : "—"}</dd></div>}
                {!isDelivery && <div><dt>Devise</dt><dd>{currency === "XAF" ? "Franc CFA (XAF)" : `${currency} · 1 ${currency} = ${rate} FCFA`}</dd></div>}
                {project && <div><dt>Projet</dt><dd>{text(project.data.name)}</dd></div>}
              </dl>
              <div className="lines-wrap">
                <table className="lines readonly">
                  <thead>
                    <tr>
                      <th>Désignation</th><th className="num right">Qté</th>
                      {!isDelivery && <><th className="num right">Prix unitaire HT</th><th className="num right">Remise</th><th className="num right">TVA</th><th className="right">Montant HT</th></>}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => isSection(l) ? (
                      <tr key={i} className="section-row">
                        <td colSpan={isDelivery ? 2 : 5}><span className="line-label">{l.label}</span></td>
                        {!isDelivery && <td className="right mono line-total" title="Sous-total HT de la section">{fm(subtotals.get(i) ?? 0)}</td>}
                      </tr>
                    ) : (
                      <tr key={i}>
                        <td>
                          <span className="line-label">{l.label}</span>
                          {l.description && <span className="line-sub line-detail">{l.description}</span>}
                          {!isDelivery && <span className="line-sub lines-mobile-meta mono">{l.qty} × {fm(l.unitPrice)}{l.discount ? ` · remise ${l.discount} %` : ""} · TVA {l.vatRate} %</span>}
                        </td>
                        <td className="num right mono">{l.qty}{l.unit ? ` ${l.unit}` : ""}</td>
                        {!isDelivery && <><td className="num right mono">{fm(l.unitPrice)}</td>
                        <td className="num right mono">{l.discount ? `${l.discount} %` : "—"}</td>
                        <td className="num right mono">{l.vatRate} %</td>
                        <td className="right mono line-total">{fm(lineNet(l, decimals))}</td></>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="doc-bottom">
                <div className="notes">
                  {notes && (<><div className="aside-label">Note imprimée sur le document</div><p className="pre-line">{notes}</p></>)}
                </div>
                {!isDelivery && totalsList}
              </div>
              {numbered && (
                <p className="locked-note">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
                  {kind === "invoices" ? "Facture validée : elle ne peut plus être modifiée. Toute correction passe par un avoir."
                    : kind === "quotes" ? `${qt.label} finalisé : pour le modifier, dupliquez-le en nouveau brouillon.`
                    : "Avoir validé : il est déduit de la facture et ne peut plus être modifié."}
                </p>
              )}
            </div>
            {kind === "invoices" && numbered && situation && (
              <PaymentHistory situation={situation} payments={invoicePayments} credits={linked} onCredit={createCreditNote} />
            )}
          </div>

          {numbered && (
            <aside className="doc-aside" aria-label="Situation et actions">
              <div className="card">
                {kind === "invoices" && situation ? (
                  <InvoiceSummary situation={situation} dueDate={dueDate} invoice={record!} />
                ) : (
                  <>
                    {!isDelivery && <><div className="aside-label">{kind === "quotes" ? `Montant (TTC)` : "Montant de l'avoir (TTC)"}</div>
                    <div className="aside-amount mono">{fm(totals.gross)}</div></>}
                    {isDelivery && <><div className="aside-label">Articles livrés</div><div className="aside-amount mono">{billable().reduce((n, l) => n + l.qty, 0)}</div></>}
                    {kind === "quotes" && showDue && dueDate && <p className="aside-sub">Valable jusqu'au {formatDate(dueDate)}</p>}
                    {kind === "quotes" && deposits.length > 0 && (
                      <ul className="deposit-list" aria-label="Acomptes facturés">
                        {deposits.map((d) => (
                          <li key={d.id}><button className="link" onClick={() => go("invoices", d.id)}>{text(d.data.number)}</button><span className="mono">{formatMoney(totalsOf(d).gross, currencyOf(d))}</span></li>
                        ))}
                      </ul>
                    )}
                    {kind === "quotes" && isDelivery && (
                      <div className="aside-actions" style={{ marginTop: 16 }}>
                        {record!.data.status === "sent" ? (
                          <button className="primary" onClick={() => setQuoteStatus("accepted")}>Marquer livré</button>
                        ) : <p className="status-line ok">Livraison confirmée.</p>}
                      </div>
                    )}
                    {kind === "quotes" && !isDelivery && (
                      <div className="aside-actions" style={{ marginTop: 16 }}>
                        {stageBilled && <p className="hint">Ce devis est facturé étape par étape depuis son projet.</p>}
                        {!stageBilled && ["sent", "accepted"].includes(text(record!.data.status)) && (
                          <button className="primary" onClick={quoteToInvoice}>{deposits.length ? "Facture de solde" : "Convertir en facture"}</button>
                        )}
                        {draftDeposits.length > 0 && <p className="hint">Un acompte en brouillon n'est pas déduit : validez-le d'abord.</p>}
                        {!stageBilled && ["sent", "accepted"].includes(text(record!.data.status)) && <DepositForm onCreate={createDeposit} currency={currency} />}
                        {record!.data.status === "sent" && (
                          <>
                            <button onClick={() => setQuoteStatus("accepted")}>Marquer accepté</button>
                            <button className="ghost" onClick={() => setQuoteStatus("refused")}>Marquer refusé</button>
                          </>
                        )}
                        {record!.data.invoice_id ? (
                          <button onClick={() => go("invoices", text(record!.data.invoice_id))}>Voir la facture</button>
                        ) : null}
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="card aside-actions">
                <h3>{share.reminder ? "Relancer le client" : "Envoyer au client"}</h3>
                {nextReminder && <p className="remind-step"><span className="remind-tag">{nextReminder.label}</span> {TONE_LABELS[nextReminder.tone]} prévue aujourd'hui (Réglages, Documents).</p>}
                <a className="button" href={share.wa} target="_blank" rel="noopener noreferrer" onClick={share.markSent}>
                  <SendIco name="wa" />{share.reminder ? "Relancer par WhatsApp" : "WhatsApp"}
                </a>
                <a className="button" href={share.mail} onClick={share.markSent}>
                  <SendIco name="mail" />{share.reminder ? "Relancer par e-mail" : "E-mail"}
                </a>
                {canShare && (
                  <button onClick={() => share.pdf("share")} disabled={share.busy}>
                    <SendIco name="share" />{share.reminder ? "Relancer (PDF)" : "Partager le PDF"}
                  </button>
                )}
                <p className="hint">Le message est prérempli{share.reminder ? " avec le montant restant dû" : ""}. {canShare ? "« Partager le PDF » joint la facture au message." : "Joignez le PDF téléchargé si besoin."}</p>
                {share.error && <p className="error" role="alert">{share.error}</p>}
              </div>
              {kind === "invoices" && !record!.data.deposit && !record!.data.final_invoice && <RecurrenceCard invoice={record!} invoices={invoices} />}
              {kind === "invoices" && <EfactCard invoice={record!} />}
            </aside>
          )}
        </div>
        {printing && record && (
          <PrintView kind={kind} record={{ ...record, data: { ...record.data, lines } }} client={client} situation={situation} onClose={() => setPrinting(false)} />
        )}
      </section>
    );
  }

  // ---------- Brouillon : éditeur ----------
  return (
    <section>
      {head}
      {links}
      <div className="card editor-card">
        <div className="doc-fields">
          {kind === "quotes" && (
            <label>
              Type de document
              <select value={docType} onChange={(e) => setDocType(e.target.value as QuoteType)}>
                {(Object.keys(QUOTE_TYPES) as QuoteType[]).map((k) => <option key={k} value={k}>{QUOTE_TYPES[k].label}</option>)}
              </select>
            </label>
          )}
          <label>
            Client
            <select value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={kind === "credit_notes"}>
              {clients.map((c) => <option key={c.id} value={c.id}>{text(c.data.name)}</option>)}
            </select>
          </label>
          <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          {showDue && (
            <label>
              {dueLabel}
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </label>
          )}
          {!isDelivery && <label>
            Devise
            <select value={currency} onChange={(e) => changeCurrency(e.target.value)} disabled={kind === "credit_notes"}>
              {Object.values(CURRENCIES).map((c) => <option key={c.code} value={c.code}>{c.code} · {c.label}</option>)}
            </select>
          </label>}
          {currency !== "XAF" && !isDelivery && (
            <label>
              Taux (1 {currency} = … FCFA)
              <input type="number" min="0" step="any" value={rate} onChange={(e) => setRate(Number(e.target.value))}
                disabled={!!CURRENCIES[currency]?.fixedRate || kind === "credit_notes"} />
            </label>
          )}
          {projects.length > 0 && (
            <label>
              Projet
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Aucun</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{text(p.data.name)}</option>)}
              </select>
            </label>
          )}
        </div>

        {kind !== "credit_notes" && !isDelivery && (
          <div className="doc-fields doc-fields-tax">
            <label>
              Retenue à la source
              <select value={withholding.rate ? `${withholding.label}|${withholding.rate}` : ""} onChange={(e) => {
                const [label, r] = e.target.value.split("|");
                setWithholding(e.target.value ? { label, rate: Number(r) } : { label: "", rate: 0 });
              }}>
                <option value="">Aucune</option>
                {[...fiscal.withholdings, ...(withholding.rate && !fiscal.withholdings.some((w) => w.label === withholding.label && w.rate === withholding.rate) ? [withholding] : [])]
                  .map((w) => <option key={`${w.label}|${w.rate}`} value={`${w.label}|${w.rate}`}>{w.label} ({pct(w.rate)})</option>)}
              </select>
            </label>
            {taxFields.css_rate > 0 && <p className="hint">CSS de {pct(taxFields.css_rate)} ajoutée au total (Réglages, Fiscalité).</p>}
          </div>
        )}
        <datalist id="vat-rates">
          {fiscal.vatRates.map((r) => <option key={r} value={r} />)}
        </datalist>
        <datalist id="articles-list">
          {articles.map((a) => <option key={a.id} value={text(a.data.label)} />)}
        </datalist>
        <div className="lines-wrap">
          <table className="lines">
            <thead>
              <tr>
                <th>Désignation</th><th className="num qty right">Qté</th>
                {!isDelivery && <><th className="num right">Prix unitaire HT</th><th className="num pct right">Remise %</th><th className="num pct right">TVA %</th><th className="right">Montant HT</th></>}<th><span className="sr-only">Supprimer</span></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => isSection(l) ? (
                <tr key={i} className="section-row">
                  <td colSpan={isDelivery ? 2 : 5}><input aria-label="Titre de section" className="section-input" placeholder="Titre de section (ex. Lot 1 : fournitures)" value={l.label} onChange={(e) => update(i, { label: e.target.value })} /></td>
                  {!isDelivery && <td className="right mono line-total" title="Sous-total HT de la section">{fm(subtotals.get(i) ?? 0)}</td>}
                  <td className="del">
                    <button className="ghost icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label={`Supprimer la ligne ${i + 1}`}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12" /><path d="M18 6 6 18" /></svg>
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={i}>
                  <td>
                    <input aria-label="Désignation" list="articles-list" placeholder="Article du catalogue ou désignation libre" value={l.label} onChange={(e) => pickArticle(i, e.target.value)} />
                    {kind !== "credit_notes" && l.articleId && stock.has(l.articleId) ? (() => {
                      const left = stock.get(l.articleId)!.qty;
                      return <span className={`stock-hint${l.qty > left ? " danger-text" : ""}`} data-testid="stock-hint">{l.qty > left ? `Stock insuffisant : ${qtyFr(left)} disponible${left > 1 ? "s" : ""}` : `${qtyFr(left)} en stock`}</span>;
                    })() : null}
                  </td>
                  <td className="num qty" data-label="Qté"><input aria-label="Quantité" type="number" min="0" step="any" value={l.qty} onChange={(e) => update(i, { qty: Number(e.target.value) })} /></td>
                  {!isDelivery && <><td className="num" data-label="Prix unitaire HT"><input aria-label="Prix unitaire" type="number" min="0" step={decimals ? "0.01" : "1"} value={l.unitPrice} onChange={(e) => update(i, { unitPrice: Number(e.target.value) })} /></td>
                  <td className="num pct" data-label="Remise %"><input aria-label="Remise" type="number" min="0" max="100" step="any" value={l.discount ?? 0} onChange={(e) => update(i, { discount: Number(e.target.value) || undefined })} /></td>
                  <td className="num pct" data-label="TVA %"><input aria-label="TVA" type="number" min="0" step="any" list="vat-rates" value={l.vatRate} onChange={(e) => update(i, { vatRate: Number(e.target.value) })} /></td>
                  <td className="right mono line-total">{fm(lineNet(l, decimals))}</td></>}
                  <td className="del">
                    <button className="ghost icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label={`Supprimer la ligne ${i + 1}`} disabled={lines.length === 1}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12" /><path d="M18 6 6 18" /></svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="line-tools">
          <button className="ghost add-line" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ Ajouter une ligne</button>
          <button className="ghost add-line" onClick={() => setLines((ls) => {
            const title = { label: "", qty: 0, unitPrice: 0, vatRate: 0, section: true };
            const last = ls[ls.length - 1];
            // Ligne vide en fin de tableau : le titre se place au-dessus d'elle.
            return last && !isSection(last) && !last.label.trim() ? [...ls.slice(0, -1), title, last] : [...ls, title];
          })}>+ Ajouter un titre</button>
          {!isDelivery && <span className="global-discount">
            <label className="inline" htmlFor={`gd-${id}`}>Remise sur toutes les lignes</label>
            <input id={`gd-${id}`} type="number" min="0" max="100" step="any" inputMode="decimal" placeholder="%" value={globalDiscount} onChange={(e) => setGlobalDiscount(e.target.value)} aria-label="Remise globale en %" />
            <button className="small" onClick={() => {
              const p = Number(globalDiscount);
              if (!(p >= 0 && p <= 100)) return setMessage("Une remise doit être comprise entre 0 et 100 %.");
              setLines((ls) => applyGlobalDiscount(ls, p));
              setMessage(null);
            }}>Appliquer</button>
          </span>}
        </div>

        <div className="doc-bottom">
          <label className="notes">
            Note imprimée sur le document
            <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Conditions, références de commande, coordonnées bancaires…" />
          </label>
          {!isDelivery && totalsList}
        </div>

        {message && <p className="error" role="alert">{message}</p>}

        <div className="editor-bar">
          {record && <button className="ghost danger" onClick={removeDraft}>Supprimer</button>}
          {!isDelivery && <span className="total-preview"><small>Total TTC</small><b className="mono">{fm(totals.gross)}</b></span>}
          <button onClick={() => saveDraft()}>Enregistrer le brouillon</button>
          <button className="primary" onClick={validate} disabled={busy}>{kind === "quotes" ? qt.validate : cfg.validateLabel}</button>
        </div>
      </div>
    </section>
  );
}

/** Saisie d'une facture d'acompte : pourcentage du document, ou montant TTC. */
function DepositForm({ onCreate, currency }: { onCreate: (mode: "percent" | "amount", value: number) => void; currency: string }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"percent" | "amount">("percent");
  const [value, setValue] = useState("30");
  if (!open) return <button onClick={() => setOpen(true)}>Facture d'acompte</button>;
  return (
    <form className="aside-form" onSubmit={(e) => { e.preventDefault(); onCreate(mode, Number(value)); }}>
      <h3>Facture d'acompte</h3>
      <div className="row2">
        <label>Calcul
          <select value={mode} onChange={(e) => { setMode(e.target.value as "percent" | "amount"); setValue(""); }}>
            <option value="percent">En % du total</option>
            <option value="amount">Montant TTC</option>
          </select>
        </label>
        <label>{mode === "percent" ? "Pourcentage" : `Montant (${currency === "XAF" ? "FCFA" : currency})`}
          <input type="number" min="0" step="any" required value={value} onChange={(e) => setValue(e.target.value)} aria-label={mode === "percent" ? "Pourcentage d'acompte" : "Montant de l'acompte"} />
        </label>
      </div>
      <p className="hint">La TVA de l'acompte suit celle des lignes. La facture de solde déduira l'acompte.</p>
      <button className="primary">Créer la facture d'acompte</button>
      <button type="button" className="ghost" onClick={() => setOpen(false)}>Annuler</button>
    </form>
  );
}

/** Synthèse d'une facture validée : reste dû, part encaissée, échéance, puis saisie d'un encaissement. */
function InvoiceSummary({ situation, dueDate, invoice }: { situation: Situation; dueDate: string; invoice: SyncRecord }) {
  const fm = (n: number) => formatMoney(n, situation.currency);
  const settled = situation.paid + situation.credited;
  const paidPct = situation.payable > 0 ? Math.min(100, (settled / situation.payable) * 100) : 0;
  const days = dueDate ? Math.round((Date.parse(today()) - Date.parse(dueDate)) / 86_400_000) : 0;
  const tone = situation.status === "paid" ? "ok" : situation.status === "overdue" ? "danger" : "";
  return (
    <>
      <div className="aside-label">Reste dû</div>
      <div className={`aside-amount mono ${tone}`}>{fm(situation.due)}</div>
      <p className="aside-sub">sur <span className="mono">{fm(situation.payable)}</span> {situation.withholding ? "net à payer (après retenue à la source)" : "TTC"}</p>
      <div className="progress-line" role="img" aria-label={`${Math.round(paidPct)} % réglé`}><span style={{ width: `${paidPct}%` }} /></div>
      <p className="aside-sub"><span className="mono">{fm(settled)}</span> réglé{situation.credited > 0 ? " (encaissements et avoirs)" : ""}</p>
      {situation.status === "paid" ? (
        <p className="status-line ok">Facture réglée intégralement.</p>
      ) : situation.status === "overdue" ? (
        <p className="status-line danger">Échue depuis {days} jour{days > 1 ? "s" : ""}.</p>
      ) : dueDate ? (
        <p className="status-line info">{days < 0 ? `À régler dans ${-days} jour${-days > 1 ? "s" : ""}, le ${formatDate(dueDate)}.` : `Échéance le ${formatDate(dueDate)}.`}</p>
      ) : null}
      {situation.due > 0 && <PaymentForm invoice={invoice} situation={situation} />}
    </>
  );
}

function PaymentForm({ invoice, situation }: { invoice: SyncRecord; situation: Situation }) {
  const { db, session } = useApp();
  const settings = useSettings();
  const [amount, setAmount] = useState("");
  // Au-delà de 500 000 FCFA, les espèces ne sont plus admises (LF 2026) : virement par défaut.
  const [method, setMethod] = useState(() => situation.due * situation.rate >= CASH_LIMIT_XAF ? "transfer" : "cash");
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
    if (!Number.isFinite(value) || value <= 0) return setError("Saisissez un montant supérieur à 0.");
    if (method === "cash" && value * (currency === "XAF" ? 1 : rate) >= CASH_LIMIT_XAF
      && !confirm("Au Gabon, un paiement de 500 000 FCFA ou plus doit passer par virement ou mobile money. Enregistrer quand même en espèces ?")) return;
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
      created_by_name: session.user.name,
    });
    setAmount("");
    setReference("");
  }

  return (
    <div className="aside-form" id="encaissement">
      <h3>Enregistrer un encaissement</h3>
      <label>Montant encaissé<input inputMode="decimal" placeholder={fm(situation.due)} value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <p className="hint">Laissez vide pour solder la facture.</p>
      <div className="row2">
        <label>
          Mode
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      </div>
      {currency !== "XAF" && (
        <label>Taux du jour<input type="number" step="any" min="0" value={rate} disabled={fixed} onChange={(e) => setRate(Number(e.target.value))} /></label>
      )}
      <label>Référence<input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="N° de transaction, de chèque…" /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" onClick={add}>Enregistrer l'encaissement</button>
    </div>
  );
}

function PaymentHistory({ situation, payments, credits, onCredit }: {
  situation: Situation; payments: SyncRecord[]; credits: SyncRecord[]; onCredit: () => void;
}) {
  const { db, go } = useApp();
  const fm = (n: number) => formatMoney(n, situation.currency);
  async function cancel(p: SyncRecord) {
    if (!confirm(`Annuler l'encaissement de ${fm(Number(p.data.amount))} ?`)) return;
    await db.remove("payments", p.id);
  }
  return (
    <div className="card section-card">
      <div className="card-head"><h3>Encaissements</h3></div>
      {payments.length === 0 ? (
        <p className="muted small">Aucun encaissement pour l'instant.</p>
      ) : (
        <table className="pay-list">
          <tbody>
            {payments.map((p) => (
              <tr key={p.id}>
                <td className="nowrap">{formatDate(p.data.date)}</td>
                <td>
                  {PAYMENT_METHODS[text(p.data.method)] ?? text(p.data.method)}
                  {text(p.data.reference) && <span className="line-sub">{text(p.data.reference)}</span>}
                </td>
                <td className="right mono strong">{fm(Number(p.data.amount))}</td>
                <td className="right"><button className="ghost small" onClick={() => cancel(p)}>Annuler</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="card-sub">
        <div className="card-head">
          <h3>Avoirs</h3>
          {situation.due > 0 && <button className="small" onClick={onCredit}>Créer un avoir</button>}
        </div>
        {credits.length === 0 ? <p className="muted small">Aucun avoir sur cette facture.</p> : (
          <ul className="plain">
            {credits.map((c) => (
              <li key={c.id}>
                <button className="link" onClick={() => go("credit_notes", c.id)}>{text(c.data.number) || "Brouillon d'avoir"}</button>
                {" · "}<span className="mono">{fm(totalsOf(c).gross)}</span>{c.data.status !== "validated" && " (non validé)"}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Envoi du document : PDF téléchargé ou partagé en pièce jointe (téléphone),
 * message WhatsApp ou e-mail prérempli. Une facture en retard donne un message
 * de relance, et la relance est notée sur la facture.
 */
function useShare({ kind, record, client, gross, situation, currency, nextReminder }: {
  kind: DocTable; record: SyncRecord | null; client: SyncRecord | null; gross: number; situation?: Situation; currency: string; nextReminder?: ReminderDue | null;
}) {
  const { db } = useApp();
  const settings = useSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const company = text(settings.name);
  const number = text(record?.data.number);
  const due = situation?.due;
  // Relance : étape du calendrier atteinte, ou facture échue (relance manuelle hors calendrier).
  const reminder = kind === "invoices" && (!!nextReminder || situation?.status === "overdue");
  const tone: ReminderTone = nextReminder?.tone ?? "friendly";
  const message = documentMessage({ kind, number, client: text(client?.data.name), company, gross, due, currency, dueDate: text(record?.data.due_date), validUntil: text(record?.data.valid_until), reminder, tone, title: docTitle(kind, record?.data) });

  // Numéro au format international uniquement (+241…) : sinon WhatsApp laisse choisir le contact.
  const phone = text(client?.data.phone).replace(/[^\d+]/g, "");
  const intl = phone.startsWith("+") ? phone.slice(1) : phone.startsWith("00") ? phone.slice(2) : "";
  const wa = `https://wa.me/${intl}?text=${encodeURIComponent(message)}`;
  const docName = docTitle(kind, record?.data);
  const subject = `${reminder ? (tone === "courtesy" ? "Rappel : " : tone === "final" ? "Dernière relance : " : "Relance : ") : ""}${docName} ${number}${company ? ` - ${company}` : ""}`;
  const mail = `mailto:${encodeURIComponent(text(client?.data.email))}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;

  // On garde la date du premier envoi ; chaque relance est comptée.
  const markSent = () => {
    if (!record) return;
    if (reminder) {
      void db.write(kind, record.id, { reminded_at: new Date().toISOString(), reminders: Number(record.data.reminders ?? 0) + 1 });
    } else if (!record.data.sent_at) {
      void db.write(kind, record.id, { sent_at: new Date().toISOString() });
    }
  };

  async function pdf(mode: "download" | "share") {
    if (!record) return;
    setError(null);
    setBusy(true);
    try {
      const file = await makePdfFile({ kind, doc: record.data, client: client?.data ?? null, company: settings, situation });
      if (mode === "download") return downloadFile(file);
      if (await shareFile(file, subject, message)) markSent();
    } catch (e) {
      setError(`Le PDF n'a pas pu être créé (${e instanceof Error ? e.message : String(e)}). Réessayez.`);
    } finally {
      setBusy(false);
    }
  }

  return { pdf, wa, mail, markSent, reminder, tone, busy, error };
}

function SendIco({ name }: { name: "wa" | "mail" | "share" }) {
  const d = name === "wa"
    ? ["M3.5 20.5l1.3-4.3A8.5 8.5 0 1 1 8 19.3z", "M9 9.5c.3 2.2 2.3 4.3 4.6 4.7l1.1-1.1 1.8.8-.3 1.6c-3.6.4-7.6-3.4-7.3-7.2l1.6-.3.8 1.8z"]
    : name === "mail" ? ["M3 6h18v12H3z", "m3 7 9 6 9-6"] : ["M12 3v13", "m7 8 5-5 5 5", "M5 14v6h14v-6"];
  return (
    <svg className="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.map((x) => <path key={x} d={x} />)}
    </svg>
  );
}

const canShare = canShareFiles();

/** Message d'accompagnement d'un document, ou de relance d'une facture échue. */
export function documentMessage(p: {
  kind: DocTable; number: string; client: string; company: string; gross: number; due?: number; currency: string;
  dueDate?: string; validUntil?: string; reminder?: boolean; tone?: ReminderTone; title?: string;
}): string {
  const lines = [`Bonjour${p.client ? ` ${p.client}` : ""},`];
  const amount = p.due !== undefined ? formatMoney(p.due, p.currency) : "";
  const ignore = "Si le paiement a déjà été effectué, merci de ne pas tenir compte de ce message.";
  if (p.reminder && p.due !== undefined && p.tone === "courtesy") {
    lines.push(
      `Pour rappel, notre facture ${p.number} de ${amount} arrive à échéance${p.dueDate ? ` le ${formatDate(p.dueDate)}` : ""}.`,
      "Merci de prévoir son règlement. Nous restons à votre disposition pour toute question.",
    );
  } else if (p.reminder && p.due !== undefined && (p.tone === "firm" || p.tone === "final")) {
    lines.push(
      `Malgré nos précédents messages, notre facture ${p.number}${p.dueDate ? ` échue le ${formatDate(p.dueDate)}` : ""} reste impayée pour ${amount}.`,
      p.tone === "final"
        ? "Sans règlement ou nouvelle de votre part sous 8 jours, nous serons contraints d'engager les démarches de recouvrement."
        : "Merci de procéder au règlement dans les meilleurs délais, ou de nous indiquer la date prévue.",
      ignore,
    );
  } else if (p.reminder && p.due !== undefined) {
    lines.push(
      `Sauf erreur de notre part, notre facture ${p.number}${p.dueDate ? ` échue le ${formatDate(p.dueDate)}` : ""} reste à régler pour ${amount}.`,
      `Merci de bien vouloir procéder au règlement, ou de nous indiquer la date prévue. ${ignore}`,
    );
  } else {
    const what = `notre ${(p.title ?? (p.kind === "quotes" ? "Devis" : p.kind === "credit_notes" ? "Avoir" : "Facture")).toLowerCase()}`;
    if (p.title === "Bon de livraison") lines.push(`Veuillez trouver ${what} ${p.number}.`);
    else lines.push(`Veuillez trouver ${what} ${p.number} d'un montant de ${formatMoney(p.gross, p.currency)}.`);
    if (p.kind === "invoices" && p.due !== undefined && p.due > 0) {
      lines.push(`Reste à régler : ${formatMoney(p.due, p.currency)}${p.dueDate ? `, échéance le ${formatDate(p.dueDate)}` : ""}.`);
    }
    if (p.kind === "quotes" && p.validUntil) lines.push(`Offre valable jusqu'au ${formatDate(p.validUntil)}.`);
  }
  lines.push("Cordialement,", p.company);
  return lines.filter(Boolean).join("\n");
}

/** « Issue du devis », « Issue de la pro forma »… selon la série du document d'origine. */
function originPhrase(number: string): string {
  const prefix = number.split("-")[0];
  if (prefix === "PF") return "Issue de la pro forma";
  if (prefix === "BC") return "Issue du bon de commande";
  return "Issue du devis";
}

/**
 * Facture électronique normalisée (E-Fact, DGI) : tant que Gestia n'est pas homologué,
 * la facture est validée sur le portail de la DGI et son numéro de validation est reporté ici,
 * puis imprimé sur le PDF. Seul champ modifiable après validation (avec le suivi d'envoi).
 */
function EfactCard({ invoice }: { invoice: SyncRecord }) {
  const { db } = useApp();
  const current = text(invoice.data.efact_number);
  const [value, setValue] = useState(current);
  const [saved, setSaved] = useState(false);
  useEffect(() => setValue(current), [current]);
  return (
    <form className="card aside-actions" onSubmit={async (e) => {
      e.preventDefault();
      await db.write("invoices", invoice.id, { efact_number: value.trim(), efact_status: value.trim() ? "validated" : "" });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    }}>
      <h3>E-Fact (DGI)</h3>
      <label>N° de validation de la facture normalisée<input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Numéro attribué par la DGI" /></label>
      <p className="hint">Reporté sur le PDF. À renseigner une fois la facture validée sur le dispositif E-Fact.</p>
      <div className="form-actions">
        {saved && <span className="ok-text">Enregistré</span>}
        <button disabled={value.trim() === current}>Enregistrer</button>
      </div>
    </form>
  );
}

/**
 * Répéter une facture validée : abonnement, loyer, maintenance. Gestia prépare un
 * brouillon à chaque échéance (à vérifier puis valider) ; la série s'arrête à tout moment.
 */
function RecurrenceCard({ invoice, invoices }: { invoice: SyncRecord; invoices: SyncRecord[] }) {
  const { db, go } = useApp();
  const rec = recurrenceOf(invoice.data);
  const next = text(invoice.data.recurrence_next);
  const running = !!rec && !isFinished(rec, next);
  const [editing, setEditing] = useState(false);
  const [freq, setFreq] = useState<RecurrenceFreq>(rec?.freq ?? "monthly");
  const date = text(invoice.data.date);
  const proposed = (f: RecurrenceFreq) => {
    const day = Number(date.slice(8, 10)) || 1;
    let d = nextAfter({ freq: f, day }, date);
    while (d < today()) d = nextAfter({ freq: f, day }, d);
    return d;
  };
  const [first, setFirst] = useState(running ? next : proposed(freq));
  const [until, setUntil] = useState(rec?.until ?? "");
  const [error, setError] = useState<string | null>(null);
  const made = invoices
    .filter((i) => i.data.recurrence_of === invoice.id)
    .sort((a, b) => text(b.data.date).localeCompare(text(a.data.date)));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!first) return setError("Indiquez la date de la prochaine facture.");
    if (first < today()) return setError("La prochaine facture ne peut pas être dans le passé.");
    if (until && until < first) return setError("La fin doit venir après la prochaine facture.");
    const day = Number(first.slice(8, 10)) || 1;
    await db.write("invoices", invoice.id, { recurrence: { freq, day, until, active: true }, recurrence_next: first });
    setEditing(false);
  }

  async function stop() {
    if (!confirm("Arrêter la répétition ? Les factures déjà préparées sont conservées.")) return;
    await db.write("invoices", invoice.id, { recurrence: { ...rec!, active: false } });
  }

  const form = (
    <form onSubmit={save} className="recur-form">
      <label>Fréquence
        <select value={freq} onChange={(e) => { const f = e.target.value as RecurrenceFreq; setFreq(f); if (!running) setFirst(proposed(f)); }}>
          {(Object.keys(RECURRENCE_FREQS) as RecurrenceFreq[]).map((f) => <option key={f} value={f}>{RECURRENCE_FREQS[f].label}</option>)}
        </select>
      </label>
      <label>Prochaine facture le<input type="date" value={first} min={today()} onChange={(e) => setFirst(e.target.value)} /></label>
      <label>Fin de la série (facultatif)<input type="date" value={until} min={first} onChange={(e) => setUntil(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        {running && <button type="button" className="ghost" onClick={() => setEditing(false)}>Annuler</button>}
        <button className="primary">{running ? "Enregistrer la répétition" : "Activer la répétition"}</button>
      </div>
    </form>
  );

  return (
    <div className="card aside-actions recurrence-card">
      <h3>Facturation récurrente</h3>
      {running && !editing ? (
        <>
          <p className="recur-status" data-testid="recur-status">
            Répétée {describe(rec!)}{rec!.until ? `, jusqu'au ${formatDate(rec!.until)}` : ""}.<br />
            <b>Prochaine facture le {formatDate(next)}</b>
          </p>
          <p className="hint">Un brouillon identique est préparé à chaque échéance, daté du jour prévu. Il apparaît dans Brouillons : vérifiez-le, puis validez-le.</p>
          <div className="form-actions">
            <button onClick={() => { setFreq(rec!.freq); setFirst(next); setUntil(rec!.until); setEditing(true); }}>Modifier la répétition</button>
            <button className="ghost" onClick={stop}>Arrêter la répétition</button>
          </div>
        </>
      ) : editing || !rec ? (
        <>
          {!editing && <p className="hint">Pour un abonnement, un loyer ou un contrat de maintenance : Gestia prépare la même facture à chaque échéance, il ne reste qu'à la valider.</p>}
          {form}
        </>
      ) : (
        <>
          <p className="hint">{rec.active ? "Série terminée" : "Répétition arrêtée"}{made.length ? ` après ${made.length} facture${made.length > 1 ? "s" : ""}` : ""}.</p>
          <button onClick={() => { setFirst(proposed(rec.freq)); setUntil(""); setEditing(true); }}>Reprendre la répétition</button>
        </>
      )}
      {made.length > 0 && (
        <ul className="deposit-list recur-list" aria-label="Factures de la série">
          {made.slice(0, 4).map((i) => (
            <li key={i.id}>
              <button className="link" onClick={() => go("invoices", i.id)}>{text(i.data.number) || `Brouillon du ${formatDate(i.data.date)}`}</button>
              <span className="mono">{formatMoney(totalsOf(i).gross, currencyOf(i))}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
