/**
 * Devis, factures et avoirs : une liste et un éditeur communs.
 * Un document numéroté (devis envoyé, facture ou avoir validé) est figé ;
 * la suite se fait par actions : accepter, convertir, encaisser, créer un avoir.
 */
import { useEffect, useMemo, useState } from "react";
import { can, formatDate, normalize, tabsFor, text, today, useApp, useSettings, useTable, type Tab } from "../context.ts";
import { ImportHistory } from "../ImportHistory.tsx";
import { Pager, readPageSize } from "../Pager.tsx";
import {
  addDays, computeTotals, DEFAULT_PAYMENT_DAYS, DEFAULT_VAT_RATE, formatXaf, lineNet, PAYMENT_METHODS, unfreezeLine, type InvoiceLine,
} from "../../shared/invoice.ts";
import { CURRENCIES, decimalsOf, formatMoney, rateFor } from "../../shared/currency.ts";
import { isNumbered, type DocTable, type SyncRecord } from "../../shared/sync.ts";
import { reminderDue, reminderSettings, TONE_LABELS, type ReminderDue, type ReminderTone } from "../../shared/reminders.ts";
import { CASH_LIMIT_XAF, fiscalSettings, newDocTaxFields, pct } from "../../shared/taxes.ts";
import { currencyOf, invoiceSituations, linesOf, QUOTE_LABELS, quoteStatus, rateOf, SITUATION_LABELS, totalsOf, type Situation } from "../ledger.ts";
import { PrintView } from "./PrintView.tsx";
import { SignDialog } from "./SignDialog.tsx";
import { signatureLine, signatureOf, type Signature } from "../../shared/signature.ts";
import { contactsOf } from "../../shared/contacts.ts";
import { isSignToken, newSignToken, shareable, signPath } from "../../shared/publicDoc.ts";
import {
  applyGlobalDiscount, deductionLines, depositLines, docRefs, docSearchText, docTitle, followUps, invoicesFromSlips, isDepositLine, isSection, isSlip, isSlipType, slipBilling, percentForAmount, SLIP_TEXTS,
  QUOTE_TYPES, quoteTypeOf, relatedDocs, sectionSubtotals, type QuoteType,
} from "../../shared/documents.ts";
import { inPeriod, PERIOD_LABELS, periodRange, type PeriodPreset } from "../../shared/periods.ts";
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

/**
 * Vues du menu Ventes : chaque étape de la vente a son entrée. Plusieurs vues lisent
 * la même table (un bon de commande est rangé avec les devis, un acompte est une facture).
 */
export type DocView = "quotes" | "orders" | "deliveries" | "invoices" | "deposits" | "recurring" | "credit_notes";
interface ViewConfig {
  kind: DocTable; title: string; intro: string; noun: [string, string]; feminine?: boolean;
  /** Types de document de la vue (table des devis) : le premier est celui du bouton principal. */
  types?: QuoteType[];
  /** Bons sans prix : ni montant ni date de validité dans la liste. */
  slips?: boolean;
  /** Documents sans date de validité ni d'échéance. */
  noDue?: boolean;
  match?: (d: SyncRecord) => boolean;
  /** Vue sans bouton « Nouveau » : où se crée ce document. */
  origin?: { text: string; label: string; to: DocView };
}
export const VIEWS: Record<DocView, ViewConfig> = {
  quotes: { kind: "quotes", title: "Devis", intro: "Devis et factures pro forma", noun: ["devis", "devis"], types: ["quote", "proforma"] },
  orders: { kind: "quotes", title: "Commandes", intro: "Bons de commande et bons d'intervention confirmés par vos clients", noun: ["commande", "commandes"], feminine: true, types: ["order", "intervention"], noDue: true },
  deliveries: { kind: "quotes", title: "Livraisons et prestations", intro: "Bons de livraison et de prestation, signés par le client à la réception", noun: ["bon", "bons"], types: ["delivery", "service"], slips: true, noDue: true },
  invoices: { kind: "invoices", title: "Factures", intro: "Factures émises et suivi des encaissements", noun: ["facture", "factures"], feminine: true },
  deposits: {
    kind: "invoices", title: "Acomptes", intro: "Factures d'acompte demandées avant la facture de solde", noun: ["facture d'acompte", "factures d'acompte"], feminine: true,
    match: (d) => Boolean(d.data.deposit),
    origin: { text: "Un acompte se facture depuis un devis finalisé : ouvrez le devis, puis « Facture d'acompte ». Il sera déduit de la facture de solde.", label: "Voir les devis", to: "quotes" },
  },
  recurring: {
    kind: "invoices", title: "Factures récurrentes", intro: "Abonnements, loyers et contrats facturés à date fixe", noun: ["facture récurrente", "factures récurrentes"], feminine: true,
    match: (d) => Boolean(recurrenceOf(d.data)) || Boolean(d.data.recurrence_of),
    origin: { text: "Pour répéter une facture, ouvrez une facture validée puis activez la répétition dans « Facturation récurrente ». Gestia prépare la suivante à chaque échéance.", label: "Voir les factures", to: "invoices" },
  },
  credit_notes: {
    kind: "credit_notes", title: "Avoirs", intro: "Corrections et annulations de factures", noun: ["avoir", "avoirs"],
    origin: { text: "Un avoir corrige ou annule une facture validée : ouvrez la facture, puis « Créer un avoir ». Il est déduit de ce que le client doit.", label: "Voir les factures", to: "invoices" },
  },
};
/** Parcours d'une vente, rappelé en tête des écrans : on voit où l'on est et ce qui vient ensuite. */
const FLOW: { tab: Tab; label: string; hint: string }[] = [
  { tab: "quotes", label: "Devis", hint: "Proposer un prix" },
  { tab: "orders", label: "Commande", hint: "Le client confirme" },
  { tab: "deliveries", label: "Livraison ou prestation", hint: "Le client signe la réception" },
  { tab: "invoices", label: "Facture", hint: "Demander le paiement" },
  { tab: "payments", label: "Encaissement", hint: "Enregistrer le paiement" },
];
export function SalesFlow({ current }: { current: Tab }) {
  const { go, session } = useApp();
  const allowed = tabsFor(session.user.role);
  if (!FLOW.some((s) => s.tab === current)) return null;
  return (
    <ol className="sales-flow" aria-label="Parcours d'une vente">
      {FLOW.filter((s) => allowed.includes(s.tab)).map((s, i) => (
        <li key={s.tab} className={s.tab === current ? "current" : ""}>
          <button type="button" onClick={() => go(s.tab)} aria-current={s.tab === current ? "step" : undefined}>
            <span className="flow-num" aria-hidden="true">{i + 1}</span>
            <span className="flow-text"><strong>{s.label}</strong><span>{s.hint}</span></span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/** Vue du menu où se range un document. */
export function viewOf(kind: DocTable, data: Record<string, unknown> | undefined): DocView {
  if (kind !== "quotes") return kind;
  const t = quoteTypeOf(data);
  return t === "order" || t === "intervention" ? "orders" : t === "delivery" || t === "service" ? "deliveries" : "quotes";
}

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

type SortKey = "date" | "number" | "client" | "due" | "rest" | "total";
interface ListState {
  query: string; filter: Filter; period: PeriodPreset; from: string; to: string;
  client: string; type: "" | QuoteType; sort: SortKey; dir: 1 | -1; page: number;
}
const DEFAULT_LIST: ListState = { query: "", filter: "all", period: "all", from: "", to: "", client: "", type: "", sort: "date", dir: -1, page: 0 };
/** État de chaque liste, gardé tant que l'application reste ouverte : on retrouve sa liste en revenant d'un document. */
const LIST_STATE = new Map<DocView, ListState>();
/** Prépare une liste avant de l'ouvrir (depuis la fiche d'un client, par exemple). */
export function presetList(kind: DocView, patch: Partial<ListState>) {
  LIST_STATE.set(kind, { ...DEFAULT_LIST, ...patch });
}

/** Client à proposer sur le prochain nouveau document (créé depuis la page d'un client). */
let NEW_DOC_TYPE: QuoteType | null = null;
let NEW_DOC_CLIENT = "";
export function presetNewDoc(clientId: string) {
  NEW_DOC_CLIENT = clientId;
}

export function Documents({ view, open, setOpen }: { view: DocView; open: string | null; setOpen: (id: string | null) => void }) {
  const v = VIEWS[view];
  const kind = v.kind;
  const { go, session } = useApp();
  // Reprise d'historique d'un autre logiciel : ouverte depuis la liste, pour la direction.
  const [importing, setImporting] = useState(false);
  const all = useTable(kind);
  const docs = useMemo(() => all.filter((d) => (v.types ? v.types.includes(quoteTypeOf(d.data)) : true) && (v.match ? v.match(d) : true)), [all, v]);
  const clients = useTable("clients");
  const { situations } = useSalesData();
  const listSettings = useSettings();
  const [list, setList] = useState<ListState>(() => LIST_STATE.get(view) ?? DEFAULT_LIST);
  const [pageSize, setPageSize] = useState(readPageSize);
  // Tout changement de filtre ramène à la première page.
  const set = (patch: Partial<ListState>) => setList((l) => {
    const next = { ...l, page: 0, ...patch };
    LIST_STATE.set(view, next);
    return next;
  });
  const cfg = DOCS[kind];

  // Une ligne par document, calculée une fois : la recherche et les filtres restent fluides sur des milliers de documents.
  const index = useMemo(() => {
    const names = new Map(clients.map((c) => [c.id, text(c.data.name)]));
    return docs.map((d) => {
      const client = names.get(text(d.data.client_id)) || "—";
      const st = docStatus(kind, d, situations);
      const sit = situations.get(d.id);
      const delivery = kind === "quotes" && isSlip(d.data);
      const counted = st.key !== "cancelled" && !delivery;
      return {
        d, client, st,
        search: normalize(`${docSearchText(d.data)} ${client}`),
        remind: kind === "invoices" ? invoiceReminder(d, sit, listSettings) : null,
        series: activeSeries(d),
        type: quoteTypeOf(d.data),
        dueDate: text(d.data.due_date ?? d.data.valid_until),
        totalXaf: counted ? Math.round(totalsOf(d).gross * rateOf(d)) : 0,
        restXaf: kind === "invoices" && st.key !== "draft" && st.key !== "cancelled" ? Math.round((sit?.due ?? 0) * (sit?.rate ?? 1)) : 0,
      };
    });
  }, [docs, clients, situations, listSettings, kind]);
  type Row = (typeof index)[number];

  if (open) {
    const record = open === "new" ? null : all.find((d) => d.id === open) ?? null;
    if (open !== "new" && !record) return <p className="empty">Document introuvable sur cet appareil.</p>;
    return <DocEditor key={open} kind={kind} record={record} clients={clients} backLabel={v.title} onClose={() => setOpen(null)} onOpen={setOpen} />;
  }

  const matchesFilter = (r: Row, f: Filter) => {
    const k = r.st.key;
    if (f === "draft") return k === "draft";
    if (f === "open") return ["unpaid", "partial", "overdue", "sent"].includes(k);
    if (f === "overdue") return k === "overdue" || k === "expired";
    if (f === "remind") return r.remind !== null;
    if (f === "recurring") return r.series;
    return true;
  };
  const filters = ([["all", "Tous"], ["draft", "Brouillons"], ["open", kind === "quotes" ? "En attente" : "À encaisser"], ["overdue", kind === "quotes" ? "Expirés" : "En retard"], ["remind", "À relancer"], ["recurring", "Récurrentes"]] as [Filter, string][])
    .filter(([f]) => (kind !== "credit_notes" || f === "all" || f === "draft") && ((f !== "remind" && f !== "recurring") || kind === "invoices"))
    // « Récurrentes » n'apparaît qu'une fois une série créée.
    .filter(([f]) => f !== "recurring" && !(v.noDue && f === "overdue"));
  // Filtre devenu sans objet (dernière série arrêtée) : retour à « Tous ».
  const shownFilter: Filter = filters.some(([f]) => f === list.filter) ? list.filter : "all";

  const q = normalize(list.query.trim());
  const range = periodRange(list.period, today(), list.from, list.to);
  // Recherche, période, client et type d'abord : les compteurs de statut portent sur ce périmètre.
  const scope = index.filter((r) =>
    (!q || r.search.includes(q))
    && inPeriod(text(r.d.data.date), range)
    && (!list.client || r.d.data.client_id === list.client)
    && (!list.type || r.type === list.type));
  const count = (f: Filter) => scope.filter((r) => matchesFilter(r, f)).length;
  const byDate = (a: Row, b: Row) => text(b.d.data.date).localeCompare(text(a.d.data.date)) || text(b.d.data.number).localeCompare(text(a.d.data.number));
  const compare: Record<SortKey, (a: Row, b: Row) => number> = {
    date: () => 0,
    number: (a, b) => text(a.d.data.number).localeCompare(text(b.d.data.number), "fr", { numeric: true }),
    client: (a, b) => a.client.localeCompare(b.client, "fr"),
    due: (a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"),
    rest: (a, b) => a.restXaf - b.restXaf,
    total: (a, b) => a.totalXaf - b.totalXaf,
  };
  const rows = scope
    .filter((r) => matchesFilter(r, shownFilter))
    .sort((a, b) => (list.sort === "date" ? -list.dir * byDate(a, b) : list.dir * compare[list.sort](a, b)) || byDate(a, b));
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(list.page, pages - 1);
  const shown = rows.slice(page * pageSize, (page + 1) * pageSize);
  const totalXaf = rows.reduce((s, r) => s + r.totalXaf, 0);
  const restXaf = rows.reduce((s, r) => s + r.restXaf, 0);

  const clientOptions = [...new Map(index.map((r) => [text(r.d.data.client_id), r.client])).entries()]
    .filter(([id]) => id)
    .sort((a, b) => a[1].localeCompare(b[1], "fr"));
  const newType = v.types?.[0] ?? null;
  const newLabel = v.origin ? null : newType ? QUOTE_TYPES[newType].newLabel : cfg.newLabel;
  const otherTypes = (v.types ?? []).slice(1);
  const startNew = (t: QuoteType | null = newType) => { NEW_DOC_TYPE = t; setOpen("new"); };
  const typesPresent = kind === "quotes" ? (Object.keys(QUOTE_TYPES) as QuoteType[]).filter((t) => index.some((r) => r.type === t)) : [];
  const narrowed = Boolean(q || list.period !== "all" || list.client || list.type || shownFilter !== "all");
  const noClient = clients.length === 0;
  const withDue = kind !== "credit_notes" && !v.noDue;
  const plural = (n: number) => `${n.toLocaleString("fr-FR")} document${n > 1 ? "s" : ""}`;

  const sortBy = (key: SortKey) => set(list.sort === key ? { dir: list.dir === 1 ? -1 : 1 } : { sort: key, dir: key === "number" || key === "client" || key === "due" ? 1 : -1 });
  const th = (k: SortKey, label: string, right = false) => (
    <th key={k} className={right ? "right" : undefined} aria-sort={list.sort === k ? (list.dir === 1 ? "ascending" : "descending") : undefined}>
      <button type="button" className={`th-sort${list.sort === k ? " active" : ""}`} onClick={() => sortBy(k)} title="Trier">
        {label}<span className="th-arrow" aria-hidden="true">{list.sort === k ? (list.dir === 1 ? "↑" : "↓") : "↕"}</span>
      </button>
    </th>
  );

  return (
    <section>
      <div className="page-head">
        <div>
          <h2>{v.title}</h2>
          <p className="muted small">{docs.length === 0 ? v.intro : `${docs.length.toLocaleString("fr-FR")} ${v.noun[docs.length > 1 ? 1 : 0]}`}</p>
        </div>
        {v.origin && <div className="quick"><button onClick={() => go(v.origin!.to)}>{v.origin.label}</button></div>}
        {newLabel && (
          <div className="quick">
            {noClient && !importing && <span className="muted small" id="need-client">Créez d'abord un client.</span>}
            {can.manageCompany(session.user.role) && (
              <button onClick={() => setImporting((v) => !v)} aria-expanded={importing} title="Reprendre les devis, factures, avoirs, clients et encaissements d'un autre logiciel de facturation">
                Importer
              </button>
            )}
            {otherTypes.map((t) => <button key={t} onClick={() => startNew(t)} disabled={noClient}>{QUOTE_TYPES[t].newLabel}</button>)}
            <button className="primary" onClick={() => startNew()} disabled={noClient} aria-describedby={noClient ? "need-client" : undefined}>
              {newLabel}
            </button>
          </div>
        )}
      </div>
      <SalesFlow current={view as Tab} />
      {v.origin && docs.length > 0 && <p className="view-hint">{v.origin.text}</p>}
      {importing && <ImportHistory />}
      <div className="toolbar">
        <label className="sr-only" htmlFor={`search-${kind}`}>Rechercher</label>
        <input id={`search-${kind}`} type="search" placeholder="Numéro, client, objet ou référence" value={list.query} onChange={(e) => set({ query: e.target.value })} aria-label="Rechercher" />
        {docs.length > 0 && (
          <div className="segmented" role="group" aria-label="Filtrer">
            {filters.map(([f, label]) => {
              const n = f === "all" ? 0 : count(f);
              return (
                <button key={f} className={shownFilter === f ? "active" : ""} aria-pressed={shownFilter === f} onClick={() => set({ filter: f })}>
                  {label}{n > 0 && <span className="seg-count">{n}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {docs.length > 0 && (
        <div className="toolbar list-filters">
          <select aria-label="Période" value={list.period} onChange={(e) => set({ period: e.target.value as PeriodPreset })}>
            {(Object.keys(PERIOD_LABELS) as PeriodPreset[]).map((p) => <option key={p} value={p}>{PERIOD_LABELS[p]}</option>)}
          </select>
          {list.period === "custom" && (
            <span className="date-range">
              <input type="date" aria-label="Du" value={list.from} onChange={(e) => set({ from: e.target.value })} />
              <span className="muted small">au</span>
              <input type="date" aria-label="Au" value={list.to} onChange={(e) => set({ to: e.target.value })} />
            </span>
          )}
          {clientOptions.length > 1 && (
            <select aria-label="Filtrer par tiers" value={list.client} onChange={(e) => set({ client: e.target.value })}>
              <option value="">Tous les clients</option>
              {clientOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          )}
          {typesPresent.length > 1 && (
            <select aria-label="Type de document" value={list.type} onChange={(e) => set({ type: e.target.value as "" | QuoteType })}>
              <option value="">Tous les types</option>
              {typesPresent.map((t) => <option key={t} value={t}>{QUOTE_TYPES[t].label}</option>)}
            </select>
          )}
          {narrowed && <button className="ghost small" onClick={() => set({ ...DEFAULT_LIST, sort: list.sort, dir: list.dir })}>Tout afficher</button>}
          <p className="list-summary muted small" data-testid="list-summary" aria-live="polite">
            <strong>{plural(rows.length)}</strong>{narrowed && rows.length !== docs.length ? ` sur ${docs.length.toLocaleString("fr-FR")}` : ""}
            {rows.length > 0 && totalXaf !== 0 && !v.slips && <> · Total TTC <strong>{formatXaf(totalXaf)}</strong></>}
            {kind === "invoices" && restXaf > 0 && <> · Reste dû <strong>{formatXaf(restXaf)}</strong></>}
          </p>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6" /><path d="M9 12h6" /></svg>
          </div>
          <p className="empty-title">
            {noClient ? "Commencez par créer un client"
              : docs.length === 0 ? `Aucun${v.feminine ? "e" : ""} ${v.noun[0]} pour l'instant`
              : "Aucun document ne correspond"}
          </p>
          <p className="muted">
            {noClient ? "Un devis ou une facture est toujours adressé à un client."
              : kind === "credit_notes" && docs.length === 0 ? "Un avoir se crée depuis une facture validée, pour la corriger ou l'annuler."
              : docs.length === 0 && v.origin ? v.origin.text
              : docs.length === 0 ? `Créez votre premi${v.feminine ? "ère" : "er"} ${v.noun[0]} : ${v.feminine ? "elle sera numérotée" : "il sera numéroté"} automatiquement à la validation.`
              : "Modifiez la recherche ou les filtres."}
          </p>
          {noClient ? <button className="primary" onClick={() => go("clients")}>Créer un client</button>
            : docs.length === 0 && v.origin ? <button className="primary" onClick={() => go(v.origin!.to)}>{v.origin.label}</button>
            : docs.length === 0 && newLabel ? <button className="primary" onClick={() => startNew()}>{newLabel}</button>
            : docs.length > 0 ? <button onClick={() => set({ ...DEFAULT_LIST })}>Tout afficher</button> : null}
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="doc-table">
            <caption className="sr-only">{v.title}</caption>
            <thead>
              <tr>
                {th("number", "Numéro")}{th("client", "Client")}{th("date", "Date")}{withDue && th("due", kind === "quotes" ? "Valable jusqu'au" : "Échéance")}<th>Statut</th>
                {kind === "invoices" && th("rest", "Reste dû", true)}
                {!v.slips && th("total", "Total TTC", true)}
              </tr>
            </thead>
            <tbody>
              {shown.map(({ d, client, st, remind, series, dueDate }) => (
                <tr key={d.id} className="clickable">
                  <td className="c-num mono"><button className="row-link" onClick={() => setOpen(d.id)}>{text(d.data.number) || <i className="draft-num">Brouillon</i>}</button>{(kind === "quotes" && quoteTypeOf(d.data) !== "quote") || (d.data.deposit && view !== "deposits") ? <span className="doc-type">{docTitle(kind, d.data)}</span> : null}{kind === "invoices" && (series || d.data.recurrence_of) ? <span className="doc-type recur-tag" title={series ? `Prochaine facture le ${formatDate(d.data.recurrence_next)}` : "Préparée automatiquement"}>{series ? `Récurrente · ${RECURRENCE_FREQS[recurrenceOf(d.data)!.freq].adjective}` : "Récurrente"}</span> : null}</td>
                  <td className="c-client">{client}</td>
                  <td className="c-date">{formatDate(d.data.date)}</td>
                  {withDue && <td className={`c-due-date ${st.key === "overdue" || st.key === "expired" ? "danger-text" : "muted"}`}>{dueDate ? formatDate(dueDate) : "—"}</td>}
                  <td className="c-status"><span className={`badge ${st.tone}`}>{st.label}</span>{remind ? <span className="remind-tag" title={TONE_LABELS[remind.tone]}>À relancer · {remind.label}</span> : null}</td>
                  {kind === "invoices" && <td className="c-due right mono">{st.key === "draft" || st.key === "cancelled" ? "" : formatMoney(situations.get(d.id)?.due ?? 0, currencyOf(d))}</td>}
                  {!v.slips && <td className="c-total right mono">{kind === "quotes" && isSlip(d.data) ? "—" : formatMoney(totalsOf(d).gross, currencyOf(d))}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={page} total={rows.length} size={pageSize} onPage={(p) => set({ page: p })} onSize={(n) => { setPageSize(n); set({ page: 0 }); }} />
        </div>
      )}
    </section>
  );
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
    const slip = SLIP_TEXTS[quoteTypeOf(d.data)];
    if (slip) {
      if (s === "draft") return { label: "Brouillon", tone: "", key: s };
      return s === "accepted" ? { label: slip.done, tone: "ok", key: s } : { label: slip.todo, tone: "info", key: s };
    }
    const tone = s === "accepted" || s === "invoiced" ? "ok" : s === "expired" ? "danger" : s === "sent" ? "info" : "";
    return { label: QUOTE_LABELS[s] ?? s, tone, key: s };
  }
  if (d.data.status === "cancelled") return { label: "Annulé", tone: "", key: "cancelled" };
  const v = d.data.status === "validated";
  return { label: v ? "Validé" : "Brouillon", tone: v ? "ok" : "", key: v ? "validated" : "draft" };
}

const emptyLine = (): InvoiceLine => ({ label: "", qty: 1, unitPrice: 0, vatRate: DEFAULT_VAT_RATE });

function DocEditor({ kind, record, clients, backLabel, onClose, onOpen }: {
  kind: DocTable; backLabel: string; record: SyncRecord | null; clients: SyncRecord[]; onClose: () => void; onOpen: (id: string) => void;
}) {
  const { db, sync, session, go: goTab } = useApp();
  /** Ouvre un document dans l'entrée de menu de son type (un bon de commande sous « Commandes », pas sous « Devis »). */
  const go = (t: Tab, openId?: string, data?: Record<string, unknown>) =>
    goTab(t === "quotes" && openId ? viewOf("quotes", data ?? allQuotes.find((q) => q.id === openId)?.data) : t, openId);
  const cfg = DOCS[kind];
  const settings = useSettings();
  const articles = useTable("articles");
  const { levels: stock } = useStock();
  const { invoices, payments, credits, situations } = useSalesData();
  const paymentDays = Number(settings.payment_days ?? DEFAULT_PAYMENT_DAYS);

  const [id] = useState(() => record?.id ?? db.newId(kind === "quotes" ? "dv" : kind === "invoices" ? "fa" : "av"));
  const [clientId, setClientId] = useState(() => {
    const preset = NEW_DOC_CLIENT;
    NEW_DOC_CLIENT = "";
    return text(record?.data.client_id) || (clients.some((c) => c.id === preset) ? preset : "") || clients[0]?.id || "";
  });
  const [date, setDate] = useState(text(record?.data.date) || today());
  const [dueDate, setDueDate] = useState(text(record?.data.due_date ?? record?.data.valid_until) || addDays(today(), paymentDays));
  const [lines, setLines] = useState<InvoiceLine[]>(() => (record ? linesOf(record) : [emptyLine()]).map((l) => ({ ...l })));
  const [notes, setNotes] = useState(text(record?.data.notes) || (record ? "" : defaultNote(settings, kind)));
  // Note par défaut (Réglages, Apparence) : reprise dès que les réglages sont chargés.
  const presetNote = record ? "" : defaultNote(settings, kind);
  useEffect(() => {
    if (presetNote) setNotes((n) => n || presetNote);
  }, [presetNote]);
  // Références imprimées en tête du document.
  const refs = docRefs(record?.data);
  const [subject, setSubject] = useState(refs.subject);
  const [clientRef, setClientRef] = useState(refs.clientRef);
  const [paymentTerms, setPaymentTerms] = useState(refs.paymentTerms);
  const [showDetail, setShowDetail] = useState(false);
  const allQuotes = useTable("quotes");
  const [currency, setCurrency] = useState(currencyOf(record));
  const [rate, setRate] = useState<number>(() => (record ? rateOf(record) : 1));
  const [projectId, setProjectId] = useState(text(record?.data.project_id));
  const projects = useTable("projects");
  const [message, setMessage] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [docType] = useState<QuoteType>(() => {
    const preset = NEW_DOC_TYPE;
    NEW_DOC_TYPE = null;
    return record ? quoteTypeOf(record.data) : preset ?? "quote";
  });
  const [globalDiscount, setGlobalDiscount] = useState("");
  const fiscal = fiscalSettings(settings);
  const [withholding, setWithholding] = useState(() => ({ rate: Number(record?.data.withholding_rate) || 0, label: text(record?.data.withholding_label) }));
  const qt = QUOTE_TYPES[docType];
  const one = kind === "quotes" ? qt.label : docTitle(kind, record?.data);
  // « isDelivery » : un bon sans prix (livraison ou prestation).
  const isDelivery = kind === "quotes" && isSlipType(docType);
  const slip = SLIP_TEXTS[docType];

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
      // La description de l'article devient le détail de la ligne, sans écraser un détail déjà saisi.
      ...(text(a.data.description) && !lines[i]?.description ? { description: text(a.data.description) } : {}),
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
      subject: subject.trim(), client_ref: clientRef.trim(),
    };
    if (kind !== "credit_notes") p.payment_terms = isDelivery ? "" : paymentTerms.trim();
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
      await db.write(kind, id, {
        status: cfg.numberedStatus, number, validated_at: new Date().toISOString(), validated_by: session.user.id,
        // Devis, pro forma, commande : le lien de signature en ligne est prêt dès la finalisation.
        ...(kind === "quotes" && !isDelivery ? { sign_token: newSignToken() } : {}),
      });
      // Un nouveau document reste ouvert, désormais sous son identifiant.
      if (!record) onOpen(id);
    } finally {
      setBusy(false);
    }
  }

  // Facture de jalon avec « Valider la facture tout de suite » (Projets, lot 3) : même validation, même confirmation.
  useValidateOnOpen(kind === "invoices" && !numbered ? record?.id : undefined, validate);

  /** Signature du client, recueillie sur cet appareil : elle vaut accord (ou réception pour un bon). */
  const [signing, setSigning] = useState(false);
  const signature = kind === "quotes" ? signatureOf(record?.data) : null;
  async function sign(name: string, image: string) {
    const at = new Date().toISOString();
    const sig: Signature = { name, at, image, via: "screen" };
    await db.write("quotes", id, { signature: sig, status: "accepted", decided_at: at });
    setSigning(false);
  }

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

  /** Bon de livraison ou de prestation : peut-on le facturer, ou l'est-il déjà ? */
  const slipBill = isDelivery && record && numbered ? slipBilling(record, { quotes: allQuotes, invoices }) : null;
  /** Devis ou commande déjà facturé au fil de ses bons : le convertir en entier compterait deux fois. */
  const slipInvoices = kind === "quotes" && !isDelivery && record ? invoicesFromSlips(record, { quotes: allQuotes, invoices }) : [];

  /** Facture d'un bon livré : les quantités du bon, les prix, taxes et conditions du document chiffré d'origine. */
  async function slipToInvoice() {
    if (slipBill?.state !== "ready") return;
    const base = slipBill.priced;
    const baseRefs = base ? docRefs(base.data) : null;
    const invId = db.newId("fa");
    await db.write("invoices", invId, {
      status: "draft",
      client_id: record!.data.client_id,
      date: today(),
      due_date: addDays(today(), paymentDays),
      lines: linesOf(record).filter((l) => !isDepositLine(l)),
      ...(base ? taxCopy(base as SyncRecord) : {}),
      notes: baseRefs?.notes ?? "",
      subject: refs.subject, client_ref: refs.clientRef, payment_terms: baseRefs?.paymentTerms ?? "",
      currency: currencyOf(record),
      rate: rateOf(record),
      project_id: text(record!.data.project_id),
      quote_id: id,
      quote_number: record!.data.number,
      created_by: session.user.id,
      created_by_name: session.user.name,
    });
    await db.write("quotes", id, { invoice_id: invId });
    go("invoices", invId);
  }

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
      notes: refs.notes,
      subject: refs.subject, client_ref: refs.clientRef, payment_terms: refs.paymentTerms,
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
      notes: refs.notes,
      subject: refs.subject, client_ref: refs.clientRef, payment_terms: refs.paymentTerms,
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

  /** Suite du document : bon de commande (avec les prix), bon de livraison ou de prestation (sans prix, sans les acomptes). */
  async function createDelivery(type: QuoteType = "delivery") {
    const blId = db.newId(type === "delivery" ? "bl" : "dv");
    const priced = !isSlipType(type);
    await db.write("quotes", blId, {
      status: "draft",
      doc_type: type,
      client_id: record!.data.client_id,
      date: today(),
      valid_until: priced ? addDays(today(), 30) : "",
      ...(priced ? { ...taxCopy(record), payment_terms: refs.paymentTerms } : {}),
      lines: linesOf(record).filter((l) => !isDepositLine(l)),
      currency: currencyOf(record),
      rate: rateOf(record),
      project_id: text(record!.data.project_id),
      source_id: id,
      source_number: record!.data.number,
      subject: refs.subject, client_ref: refs.clientRef,
      notes: priced ? refs.notes : `${SLIP_TEXTS[type]!.note}${record!.data.number ? ` selon ${docTitle(kind, record!.data).toLowerCase()} ${text(record!.data.number)}` : ""}`,
      created_by: session.user.id,
      created_by_name: session.user.name,
    });
    // Un bon de commande tiré d'un devis envoyé vaut accord du client.
    if (type === "order" && kind === "quotes" && record!.data.status === "sent") await db.write("quotes", id, { status: "accepted", decided_at: new Date().toISOString() });
    go("quotes", blId, { doc_type: type });
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
      subject: refs.subject, client_ref: refs.clientRef,
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
      notes: (numbered ? refs.notes : notes).trim(),
      subject: subject.trim(), client_ref: clientRef.trim(), payment_terms: paymentTerms.trim(),
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
  const related = record && numbered ? relatedDocs(kind, record, { quotes: allQuotes, invoices, credit_notes: credits }) : [];

  const head = (
    <div className="page-head doc-head">
      <div>
        <button className="link back-link" onClick={onClose}>← {backLabel}</button>
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
      </div>
    </div>
  );

  // Liens en phrase sur un brouillon ; un document numéroté les montre dans « Documents liés ».
  const links = (
    <>
      {kind === "credit_notes" && sourceInvoice && !numbered && (
        <p className="muted small">
          Sur la facture <button className="link" onClick={() => go("invoices", sourceInvoice.id)}>{text(sourceInvoice.data.number)}</button>
        </p>
      )}
      {kind === "invoices" && record?.data.quote_id && !numbered ? (
        <p className="muted small">
          {originPhrase(text(record.data.quote_number))} <button className="link" onClick={() => go("quotes", text(record.data.quote_id))}>{text(record.data.quote_number)}</button>
        </p>
      ) : null}
      {record?.data.imported ? <p className="muted small" data-testid="doc-imported">Document repris de votre historique, tel qu'il a été émis.</p> : null}
      {kind === "invoices" && record?.data.recurrence_of && !numbered ? (
        <p className="muted small recur-origin">
          {numbered ? "Facture récurrente, d'après" : "Préparée automatiquement d'après la facture récurrente"} <button className="link" onClick={() => go("invoices", text(record.data.recurrence_of))}>{text(record.data.recurrence_number)}</button>
          {numbered ? "" : ". Vérifiez les quantités et les mentions de période, puis validez-la."}
        </p>
      ) : null}
      {kind === "quotes" && record?.data.source_id && !numbered ? (
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
                {refs.subject && <div className="fact-wide" data-testid="doc-subject"><dt>Objet</dt><dd>{refs.subject}</dd></div>}
                {refs.clientRef && <div className="fact-wide" data-testid="doc-client-ref"><dt>Référence de commande</dt><dd className="pre-line">{refs.clientRef}</dd></div>}
                {refs.paymentTerms && <div className="fact-wide" data-testid="doc-terms"><dt>Conditions de règlement</dt><dd>{refs.paymentTerms}</dd></div>}
              </dl>
              {lines.some((l) => l.description && l.description.split("\n").length > 3) && (
                <button className="link small detail-toggle" onClick={() => setShowDetail((v) => !v)} aria-expanded={showDetail}>
                  {showDetail ? "Réduire le détail des lignes" : "Afficher tout le détail des lignes"}
                </button>
              )}
              <div className="lines-wrap">
                <table className={`lines readonly${showDetail ? " full-detail" : ""}`}>
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
                  {(numbered ? refs.notes : notes) && (<><div className="aside-label">Note imprimée sur le document</div><p className="pre-line">{numbered ? refs.notes : notes}</p></>)}
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
                    {isDelivery && <><div className="aside-label">{slip?.count}</div><div className="aside-amount mono">{billable().length}</div></>}
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
                          <>
                            <button className="primary" onClick={() => setQuoteStatus("accepted")}>{slip?.mark}</button>
                            <button onClick={() => setSigning(true)}>Faire signer ici, sur cet écran</button>
                          </>
                        ) : <p className="status-line ok">{slip?.confirmed}</p>}
                        {slipBill?.state === "invoiced" && (
                          <button onClick={() => go("invoices", slipBill.invoice.id)}>Voir la facture</button>
                        )}
                      </div>
                    )}
                    {kind === "quotes" && !isDelivery && (
                      <div className="aside-actions" style={{ marginTop: 16 }}>
                        {stageBilled && <p className="hint">Ce devis est facturé étape par étape depuis son projet.</p>}
                        {slipInvoices.length > 0 && (
                          <p className="hint" data-testid="billed-by-slips">
                            Déjà facturé au fil des livraisons ({slipInvoices.map((i, n) => (
                              <span key={i.id}>{n ? ", " : ""}<button className="link inline" onClick={() => go("invoices", i.id)}>{text(i.data.number) || "facture en brouillon"}</button></span>
                            ))}). Le reste se facture depuis chaque bon livré.
                          </p>
                        )}
                        {!stageBilled && !slipInvoices.length && ["sent", "accepted"].includes(text(record!.data.status)) && (
                          <button className={record!.data.status === "sent" ? undefined : "primary"} onClick={quoteToInvoice}>{deposits.length ? "Facture de solde" : "Convertir en facture"}</button>
                        )}
                        {draftDeposits.length > 0 && <p className="hint">Un acompte en brouillon n'est pas déduit : validez-le d'abord.</p>}
                        {!stageBilled && !slipInvoices.length && ["sent", "accepted"].includes(text(record!.data.status)) && <DepositForm onCreate={createDeposit} currency={currency} />}
                        {record!.data.invoice_id ? (
                          <button onClick={() => go("invoices", text(record!.data.invoice_id))}>Voir la facture</button>
                        ) : null}
                      </div>
                    )}
                  </>
                )}
              </div>
              {kind === "quotes" && !isDelivery && record!.data.status === "sent" && (
                <div className="card aside-actions" data-testid="agreement">
                  <h3>Obtenir l'accord du client</h3>
                  {share.canSign && (
                    <button className="primary" onClick={share.copySignLink} data-testid="sign-link">
                      <SendIco name="link" />{share.copied ? "Lien copié" : share.signUrl ? "Copier le lien de signature" : "Créer le lien de signature"}
                    </button>
                  )}
                  <button onClick={() => setSigning(true)}>Faire signer ici, sur cet écran</button>
                  <button onClick={() => setQuoteStatus("accepted")}>Marquer accepté sans signature</button>
                  <button onClick={() => setQuoteStatus("refused")}>Marquer refusé</button>
                  {share.canSign && (
                    <p className="hint">{share.signUrl
                      ? <>Avec le lien, le client lit le document et le signe depuis son téléphone, sans compte. Dès qu'il signe, le document passe à « Accepté ». Les boutons WhatsApp et E-mail incluent déjà ce lien. <button className="link inline" onClick={share.disableSignLink}>Désactiver le lien</button></>
                      : "Avec le lien, le client lit le document et le signe depuis son téléphone, sans compte."}</p>
                  )}
                </div>
              )}
              {signature && (
                <div className="card signed-card" data-testid="signed-card">
                  <h3>{isDelivery ? slip?.received : "Bon pour accord"}</h3>
                  <img src={signature.image} alt={`Signature de ${signature.name}`} />
                  <p>{signatureLine(signature, formatDate)}</p>
                  <p className="signed-via">{signature.via === "link" ? `Signature en ligne, par le lien envoyé au client${signature.ip ? ` (adresse ${signature.ip})` : ""}.` : "Signature recueillie sur place, sur l'écran."}</p>
                </div>
              )}
              {related.length > 0 && (
                <div className="card related-card" data-testid="related-docs">
                  <h3>Documents liés</h3>
                  <ul className="related-list">
                    {related.map((r) => {
                      const d = (r.tbl === "quotes" ? allQuotes : r.tbl === "invoices" ? invoices : credits).find((x) => x.id === r.id)!;
                      return (
                        <li key={`${r.tbl}/${r.id}`}>
                          <span className="rel-kind">{r.relation}</span>
                          <button className="link" onClick={() => go(r.tbl, r.id)}>{docTitle(r.tbl, d.data)} {text(d.data.number) || "(brouillon)"}</button>
                          <span className="rel-meta">{formatDate(d.data.date)}{r.tbl === "quotes" && isSlip(d.data) ? "" : <> · <span className="mono">{formatMoney(totalsOf(d).gross, currencyOf(d))}</span></>}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {slipBill && slipBill.state !== "invoiced" && (
                <div className="card aside-actions next-steps" data-testid="next-steps">
                  <h3>Étape suivante</h3>
                  {slipBill.state === "deposit" ? (
                    <>
                      <p className="hint">Un acompte a été facturé sur {docTitle("quotes", slipBill.origin.data).toLowerCase()} {text(slipBill.origin.data.number)} : la facture de solde se crée depuis ce document, pour que l'acompte soit déduit.</p>
                      <button onClick={() => go("quotes", slipBill.origin.id)}>Ouvrir {text(slipBill.origin.data.number)}</button>
                    </>
                  ) : record!.data.status === "accepted" ? (
                    <>
                      <button className="primary" onClick={slipToInvoice}>Créer la facture</button>
                      <p className="hint">{slipBill.priced
                        ? `La facture reprend les quantités de ce bon et les prix d'origine (${docTitle("quotes", slipBill.priced.data).toLowerCase()} ${text(slipBill.priced.data.number)}).`
                        : "La facture reprend les lignes de ce bon. Il n'a pas de prix : vous les complétez sur la facture avant de la valider."}</p>
                    </>
                  ) : (
                    <p className="hint">{slip?.mark} ce bon, puis créez sa facture ici.</p>
                  )}
                </div>
              )}
              {followUps(kind, record?.data).length > 0 && (
                <div className="card aside-actions next-steps" data-testid="next-steps">
                  <h3>Étape suivante</h3>
                  {followUps(kind, record?.data).map((t) => (
                    <button key={t} onClick={() => createDelivery(t)}>Créer le {QUOTE_TYPES[t].label.toLowerCase()}</button>
                  ))}
                  <p className="hint">Le nouveau document reprend les lignes de celui-ci et lui reste lié.</p>
                </div>
              )}
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
                <p className="hint">Le message est prérempli{share.reminder ? " avec le montant restant dû" : ""}. {canShare ? "« Partager le PDF » joint la facture au message." : "Le PDF se télécharge en haut de la page."}</p>
                {share.error && <p className="error" role="alert">{share.error}</p>}
              </div>
              {kind === "invoices" && !record!.data.deposit && !record!.data.final_invoice && <RecurrenceCard invoice={record!} invoices={invoices} />}
              {kind === "invoices" && <EfactCard invoice={record!} />}
            </aside>
          )}
        </div>
        {signing && record && (
          <SignDialog
            doc={`${docTitle(kind, record.data)} ${text(record.data.number)}`}
            client={text(client?.data.name)}
            amount={isDelivery ? undefined : `${fm(totals.gross)} TTC`}
            mode={isDelivery ? "receive" : "accept"}
            defaultName={contactsOf(client?.data)[0]?.name ?? ""}
            confirmText={isDelivery ? `En signant, le client confirme : « ${slip?.received} ».` : "En signant, le client donne son bon pour accord sur ce document et son montant."}
            onSign={sign}
            onClose={() => setSigning(false)}
          />
        )}
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

        <div className="doc-fields doc-fields-refs">
          <label className="wide">Objet
            <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder="Ex. Maintenance du site, 2ᵉ trimestre" />
          </label>
          <label>Référence de commande
            <input value={clientRef} onChange={(e) => setClientRef(e.target.value)} maxLength={300} placeholder="Bon de commande, ordre d'achat ou lettre de commande reçu" />
          </label>
          {kind !== "credit_notes" && !isDelivery && (
            <label>Conditions de règlement
              <input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} maxLength={200} placeholder="Ex. 50 % à la commande, solde à la livraison" />
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
                    {l.description !== undefined
                      ? <textarea className="line-desc" autoFocus={l.description === ""} aria-label="Détail de la ligne" rows={Math.min(8, Math.max(2, l.description.split("\n").length))} placeholder="Détail affiché sous la désignation" value={l.description} onChange={(e) => update(i, { description: e.target.value })} onBlur={() => l.description === "" && update(i, { description: undefined })} />
                      : <button type="button" className="link small add-detail" onClick={() => update(i, { description: "" })}>+ Détail</button>}
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
            <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Précisions imprimées en bas du document" />
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
  const { db, session } = useApp();
  const settings = useSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const company = text(settings.name);
  // Lien de signature en ligne : devis, pro forma ou commande finalisé, en attente de la réponse du client.
  const canSign = kind === "quotes" && shareable(record?.data) && record?.data.status === "sent";
  const token = record?.data.sign_token;
  const signUrl = canSign && isSignToken(token) ? `${location.origin}${signPath(session.company.id, record!.id, token)}` : "";
  async function copySignLink() {
    if (!record || !canSign) return;
    setError(null);
    let url = signUrl;
    if (!url) {
      const fresh = newSignToken();
      await db.write("quotes", record.id, { sign_token: fresh });
      url = `${location.origin}${signPath(session.company.id, record.id, fresh)}`;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 4000);
    } catch {
      setError(`Copie impossible sur cet appareil. Voici le lien : ${url}`);
    }
  }
  /** Retire le lien : celui déjà envoyé ne s'ouvre plus. */
  const disableSignLink = () => record && db.write("quotes", record.id, { sign_token: "" });
  const number = text(record?.data.number);
  const due = situation?.due;
  // Relance : étape du calendrier atteinte, ou facture échue (relance manuelle hors calendrier).
  const reminder = kind === "invoices" && (!!nextReminder || situation?.status === "overdue");
  const tone: ReminderTone = nextReminder?.tone ?? "friendly";
  const message = documentMessage({ kind, number, client: text(client?.data.name), company, gross, due, currency, dueDate: text(record?.data.due_date), validUntil: text(record?.data.valid_until), reminder, tone, title: docTitle(kind, record?.data), signUrl });

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

  return { pdf, wa, mail, markSent, reminder, tone, busy, error, canSign, signUrl, copySignLink, disableSignLink, copied };
}

function SendIco({ name }: { name: "wa" | "mail" | "share" | "link" }) {
  const d = name === "wa"
    ? ["M3.5 20.5l1.3-4.3A8.5 8.5 0 1 1 8 19.3z", "M9 9.5c.3 2.2 2.3 4.3 4.6 4.7l1.1-1.1 1.8.8-.3 1.6c-3.6.4-7.6-3.4-7.3-7.2l1.6-.3.8 1.8z"]
    : name === "mail" ? ["M3 6h18v12H3z", "m3 7 9 6 9-6"]
    : name === "link" ? ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"]
    : ["M12 3v13", "m7 8 5-5 5 5", "M5 14v6h14v-6"];
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
  /** Lien de signature en ligne, pour un devis en attente de réponse. */
  signUrl?: string;
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
    if (p.signUrl) lines.push(`Vous pouvez le consulter et le signer en ligne : ${p.signUrl}`);
  }
  lines.push("Cordialement,", p.company);
  return lines.filter(Boolean).join("\n");
}

/** « Issue du devis », « Issue de la pro forma »… selon la série du document d'origine. */
function originPhrase(number: string): string {
  const prefix = number.split("-")[0];
  if (prefix === "PF") return "Issue de la pro forma";
  if (prefix === "BC") return "Issue du bon de commande";
  if (prefix === "BL") return "Issue du bon de livraison";
  if (prefix === "BP") return "Issue du bon de prestation";
  if (prefix === "BI") return "Issue du bon d'intervention";
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
