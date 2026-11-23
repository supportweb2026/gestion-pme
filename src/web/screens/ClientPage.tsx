/**
 * Page d'un client : tout ce qui le concerne au même endroit. Ses chiffres
 * (facturé, encaissé, reste dû, retard), ses documents, ses encaissements,
 * ses projets et son historique, avec ses coordonnées sur le côté.
 */
import { useMemo, useState } from "react";
import { can, formatDate, text, useApp, useTable } from "../context.ts";
import { formatXaf, PAYMENT_METHODS } from "../../shared/invoice.ts";
import { formatMoney } from "../../shared/currency.ts";
import type { DocTable, SyncRecord } from "../../shared/sync.ts";
import { currencyOf, invoiceSituations, rateOf, totalsOf } from "../ledger.ts";
import { docRefs, docTitle, isSection, quoteTypeOf } from "../../shared/documents.ts";
import { PROJECT_STATUS } from "../../shared/projects.ts";
import { docStatus, presetList, presetNewDoc } from "./Documents.tsx";
import { usePaged } from "../Pager.tsx";

type View = "documents" | "payments" | "projects" | "history";
type DocFilter = "all" | DocTable;
const DOC_FILTERS: [DocFilter, string][] = [["all", "Tous"], ["invoices", "Factures"], ["quotes", "Devis et bons"], ["credit_notes", "Avoirs"]];

export function ClientPage({ client, onBack, onEdit }: { client: SyncRecord; onBack: () => void; onEdit: () => void }) {
  const { go, session } = useApp();
  const invoices = useTable("invoices");
  const quotes = useTable("quotes");
  const credits = useTable("credit_notes");
  const payments = useTable("payments");
  const projects = useTable("projects");
  const [view, setView] = useState<View>("documents");
  const [filter, setFilter] = useState<DocFilter>("all");
  const c = client.data;

  const situations = useMemo(() => invoiceSituations(invoices, payments, credits), [invoices, payments, credits]);
  const data = useMemo(() => {
    const mine = (rows: SyncRecord[]) => rows.filter((d) => d.data.client_id === client.id);
    const inv = mine(invoices);
    const docs = [
      ...inv.map((d) => ({ tbl: "invoices" as DocTable, d })),
      ...mine(quotes).map((d) => ({ tbl: "quotes" as DocTable, d })),
      ...mine(credits).map((d) => ({ tbl: "credit_notes" as DocTable, d })),
    ].sort((a, b) => text(b.d.data.date).localeCompare(text(a.d.data.date)) || text(b.d.data.number).localeCompare(text(a.d.data.number)));
    const ids = new Map(inv.map((d) => [d.id, d]));
    const pays = payments.filter((p) => ids.has(text(p.data.invoice_id)))
      .sort((a, b) => text(b.data.date).localeCompare(text(a.data.date)));
    const validated = inv.filter((d) => d.data.status === "validated");
    const sum = (pick: (id: string) => number) => validated.reduce((n, d) => n + pick(d.id), 0);
    const xaf = (id: string, key: "paid" | "due" | "credited") => {
      const s = situations.get(id);
      return s ? Math.round(s[key] * s.rate) : 0;
    };
    const late = validated.filter((d) => situations.get(d.id)?.status === "overdue");
    const pending = mine(quotes).filter((d) => docStatus("quotes", d, situations).key === "sent");
    const year = new Date().getFullYear();
    const billedIn = (y: number) => validated.filter((d) => text(d.data.date).startsWith(String(y))).reduce((n, d) => n + Math.round(totalsOf(d).gross * rateOf(d)), 0);
    return {
      docs, pays, ids,
      billed: validated.reduce((n, d) => n + Math.round(totalsOf(d).gross * rateOf(d)), 0),
      invoiceCount: validated.length,
      paid: sum((id) => xaf(id, "paid")),
      due: sum((id) => xaf(id, "due")),
      late: late.reduce((n, d) => n + xaf(d.id, "due"), 0),
      lateCount: late.length,
      pending,
      pendingXaf: pending.reduce((n, d) => n + Math.round(totalsOf(d).gross * rateOf(d)), 0),
      thisYear: billedIn(year), lastYear: billedIn(year - 1), year,
      since: [...docs].reverse().find((x) => x.d.data.date)?.d.data.date,
      projects: projects.filter((p) => p.data.client_id === client.id).sort((a, b) => text(b.data.start_date).localeCompare(text(a.data.start_date))),
    };
  }, [client.id, invoices, quotes, credits, payments, projects, situations]);

  const shownDocs = data.docs.filter((x) => filter === "all" || x.tbl === filter);
  const docsPaged = usePaged(shownDocs, filter);
  const paysPaged = usePaged(data.pays, "p");
  // Historique : documents et encaissements mêlés, du plus récent au plus ancien.
  const history = useMemo(() => [
    ...data.docs.filter((x) => x.d.data.number).map((x) => ({
      date: text(x.d.data.date), key: x.d.id, tbl: x.tbl as DocTable | null, id: x.d.id,
      what: `${docTitle(x.tbl, x.d.data)} ${text(x.d.data.number)}`, amount: x.tbl === "quotes" && quoteTypeOf(x.d.data) === "delivery" ? "" : formatMoney(totalsOf(x.d).gross, currencyOf(x.d)), tone: x.tbl === "invoices" ? "info" : x.tbl === "credit_notes" ? "warn" : "",
    })),
    ...data.pays.map((p) => {
      const inv = data.ids.get(text(p.data.invoice_id));
      return {
        date: text(p.data.date), key: p.id, tbl: "invoices" as DocTable | null, id: text(p.data.invoice_id),
        what: `Encaissement sur ${text(inv?.data.number)} · ${PAYMENT_METHODS[text(p.data.method)] ?? text(p.data.method)}`, amount: formatMoney(Number(p.data.amount ?? 0), text(p.data.currency) || currencyOf(inv)), tone: "ok",
      };
    }),
  ].sort((a, b) => b.date.localeCompare(a.date)), [data]);
  const histPaged = usePaged(history, "h");

  const canSell = can.manageCompany(session.user.role) || ["sales", "accountant", "project_manager"].includes(session.user.role);
  const create = (tbl: "quotes" | "invoices") => { presetNewDoc(client.id); go(tbl, "new"); };
  const views: [View, string, number][] = [
    ["documents", "Documents", data.docs.length], ["payments", "Encaissements", data.pays.length],
    ["projects", "Projets", data.projects.length], ["history", "Historique", history.length],
  ];
  const contact: [string, string][] = ([
    ["Téléphone", text(c.phone)], ["E-mail", text(c.email)], ["Adresse", [text(c.address), text(c.city)].filter(Boolean).join("\n")],
    ["NIF", text(c.nif)], ["RCCM", text(c.rccm)],
  ] as [string, string][]);
  const initials = text(c.name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

  return (
    <section className="client-page" data-testid="client-sheet">
      <div className="doc-head">
        <div>
          <button className="link back-link" onClick={onBack}>← Clients</button>
          <div className="client-title">
            <span className="client-avatar" aria-hidden="true">{initials || "?"}</span>
            <div>
              <h2>{text(c.name)}</h2>
              <p className="muted small">
                {c.individual ? "Particulier" : "Entreprise"}
                {text(c.city) ? ` · ${text(c.city)}` : ""}
                {data.since ? ` · client depuis ${formatDate(data.since).slice(-4)}` : ""}
              </p>
            </div>
          </div>
        </div>
        <div className="actions">
          <button onClick={onEdit}>Modifier</button>
          {canSell && <button onClick={() => create("quotes")}>Nouveau devis</button>}
          {canSell && <button className="primary" onClick={() => create("invoices")}>Nouvelle facture</button>}
        </div>
      </div>

      <div className="kpis">
        <div className="kpi">
          <div className="kpi-label">Facturé TTC</div>
          <div className="kpi-value">{formatXaf(data.billed)}</div>
          <div className="kpi-sub">{data.invoiceCount} facture{data.invoiceCount > 1 ? "s" : ""} · {formatXaf(data.thisYear)} en {data.year}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Encaissé</div>
          <div className="kpi-value">{formatXaf(data.paid)}</div>
          <div className="kpi-sub">{data.billed > 0 ? `${Math.round((data.paid / data.billed) * 100)} % du facturé` : "Rien de facturé"}</div>
        </div>
        <div className={`kpi${data.late > 0 ? " danger" : ""}`}>
          <div className="kpi-label">Reste dû</div>
          <div className="kpi-value">{formatXaf(data.due)}</div>
          <div className={`kpi-sub${data.late > 0 ? " danger" : ""}`}>{data.late > 0 ? `dont ${formatXaf(data.late)} en retard (${data.lateCount} facture${data.lateCount > 1 ? "s" : ""})` : data.due > 0 ? "Aucun retard" : "À jour"}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Devis en attente</div>
          <div className="kpi-value">{data.pending.length}</div>
          <div className="kpi-sub">{data.pending.length ? formatXaf(data.pendingXaf) : "Aucun devis en cours"}</div>
        </div>
      </div>

      <div className="doc-layout">
        <div className="card client-main">
          <div className="segmented scroll-x" role="tablist" aria-label="Rubriques du client">
            {views.map(([v, label, n]) => (
              <button key={v} role="tab" aria-selected={view === v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
                {label}{n > 0 && <span className="seg-count">{n}</span>}
              </button>
            ))}
          </div>

          {view === "documents" && (data.docs.length === 0 ? <p className="empty">Aucun document pour ce client.</p> : (
            <>
              <div className="client-chips" role="group" aria-label="Type de document">
                {DOC_FILTERS.map(([f, label]) => {
                  const n = f === "all" ? data.docs.length : data.docs.filter((x) => x.tbl === f).length;
                  return n > 0 || f === "all" ? <button key={f} className={`chip${filter === f ? " active" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>{label} · {n}</button> : null;
                })}
                {filter !== "all" && <button className="link small" onClick={() => { presetList(filter, { client: client.id }); go(filter); }}>Ouvrir dans la liste, avec les filtres</button>}
              </div>
              <div className="table-wrap">
                <table className="client-table">
                  <thead><tr><th>Document</th><th>Date</th><th>Objet</th><th>Statut</th><th className="right">Total TTC</th></tr></thead>
                  <tbody>
                    {docsPaged.shown.map(({ tbl, d }) => {
                      const st = docStatus(tbl, d, situations);
                      const delivery = tbl === "quotes" && quoteTypeOf(d.data) === "delivery";
                      const subject = docRefs(d.data).subject || text((d.data.lines as { label?: string; section?: boolean }[] | undefined)?.find((l) => !isSection(l as never))?.label);
                      return (
                        <tr key={d.id}>
                          <td><button className="link-name mono" onClick={() => go(tbl, d.id)}>{text(d.data.number) || "Brouillon"}</button><div className="muted small">{docTitle(tbl, d.data)}<span className="only-narrow"> · {formatDate(d.data.date)}</span></div></td>
                          <td className="muted nowrap">{formatDate(d.data.date)}</td>
                          <td className="client-subject" title={subject}>{subject}</td>
                          <td><span className={`badge ${st.tone}`}>{st.label}</span></td>
                          <td className="right mono nowrap">{delivery ? "—" : formatMoney(totalsOf(d).gross, currencyOf(d))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {docsPaged.pager}
              </div>
            </>
          ))}

          {view === "payments" && (data.pays.length === 0 ? <p className="empty">Aucun encaissement enregistré pour ce client.</p> : (
            <div className="table-wrap">
              <table className="client-table">
                <thead><tr><th>Date</th><th>Facture</th><th>Mode</th><th>Référence</th><th className="right">Montant</th></tr></thead>
                <tbody>
                  {paysPaged.shown.map((p) => {
                    const inv = data.ids.get(text(p.data.invoice_id));
                    return (
                      <tr key={p.id}>
                        <td className="nowrap">{formatDate(p.data.date)}</td>
                        <td><button className="link-name mono" onClick={() => go("invoices", text(p.data.invoice_id))}>{text(inv?.data.number)}</button></td>
                        <td>{PAYMENT_METHODS[text(p.data.method)] ?? text(p.data.method)}</td>
                        <td className="muted">{text(p.data.reference) || "—"}</td>
                        <td className="right mono nowrap">{formatMoney(Number(p.data.amount ?? 0), text(p.data.currency) || currencyOf(inv))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {paysPaged.pager}
            </div>
          ))}

          {view === "projects" && (data.projects.length === 0 ? <p className="empty">Aucun projet pour ce client.</p> : (
            <ul className="client-projects">
              {data.projects.map((p) => (
                <li key={p.id}>
                  <button className="link-name" onClick={() => go("projects", p.id)}>{text(p.data.name)}</button>
                  <span className="muted small">{[p.data.start_date && `début ${formatDate(p.data.start_date)}`, p.data.end_date && `fin prévue ${formatDate(p.data.end_date)}`].filter(Boolean).join(" · ")}</span>
                  <span className="badge">{PROJECT_STATUS[text(p.data.status)] ?? text(p.data.status)}</span>
                </li>
              ))}
            </ul>
          ))}

          {view === "history" && (history.length === 0 ? <p className="empty">Rien pour l'instant.</p> : (
            <>
              <ol className="client-history">
                {histPaged.shown.map((h) => (
                  <li key={h.key}>
                    <span className={`dot ${h.tone}`} aria-hidden="true" />
                    <span className="muted small nowrap">{formatDate(h.date)}</span>
                    <button className="link-name" onClick={() => h.tbl && go(h.tbl, h.id)}>{h.what}</button>
                    <span className="mono nowrap">{h.amount}</span>
                  </li>
                ))}
              </ol>
              {histPaged.pager}
            </>
          ))}
        </div>

        <aside className="doc-aside">
          <div className="card">
            <div className="aside-label">Coordonnées</div>
            <dl className="client-contact">
              {contact.map(([label, value]) => (
                <div key={label}><dt>{label}</dt><dd className={value ? "" : "muted"}>{value || "Non renseigné"}</dd></div>
              ))}
            </dl>
            {contact.some(([, v]) => !v) && <button className="link small" onClick={onEdit}>Compléter la fiche</button>}
          </div>
          {(data.thisYear > 0 || data.lastYear > 0) && (
            <div className="card">
              <div className="aside-label">Facturé par année</div>
              <dl className="client-contact">
                <div><dt>{data.year}</dt><dd className="mono">{formatXaf(data.thisYear)}</dd></div>
                <div><dt>{data.year - 1}</dt><dd className="mono">{formatXaf(data.lastYear)}</dd></div>
              </dl>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
