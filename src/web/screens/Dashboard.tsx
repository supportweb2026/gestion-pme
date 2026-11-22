import { useMemo } from "react";
import { formatDate, text, today, useApp, useSyncStatus, useTable } from "../context.ts";
import { formatXaf } from "../../shared/invoice.ts";
import { invoiceSituations, netXafOf, quoteStatus } from "../ledger.ts";
import { Gains } from "./Gains.tsx";

/**
 * Tableau de bord unique.
 *  1. « À traiter » : ce qui demande une action aujourd'hui (argent à encaisser, retards,
 *     devis sans réponse, brouillons). Indépendant de la période.
 *  2. « Performance » : chiffre d'affaires, encaissements, marge et devis sur une période
 *     choisie, avec comparaison ; l'analyse détaillée (filtres, répartitions, export) se déplie.
 * Tout est calculé sur l'appareil, donc disponible hors ligne.
 */
export function Dashboard() {
  const { go } = useApp();
  const invoices = useTable("invoices");
  const payments = useTable("payments");
  const credits = useTable("credit_notes");
  const quotes = useTable("quotes");
  const clients = useTable("clients");
  const sync = useSyncStatus();

  const data = useMemo(() => {
    const sit = invoiceSituations(invoices, payments, credits);
    let due = 0;
    let openCount = 0;
    let overdue = 0;
    const late: { id: string; number: string; client: string; due: number; date: string }[] = [];
    for (const inv of invoices) {
      const s = sit.get(inv.id);
      if (!s || s.status === "draft") continue;
      // Les factures en devise sont ramenées en francs CFA au taux du document.
      const dueXaf = Math.round(s.due * s.rate);
      due += dueXaf;
      if (s.due > 0) openCount++;
      if (s.status === "overdue") {
        overdue += dueXaf;
        late.push({ id: inv.id, number: text(inv.data.number), client: text(inv.data.client_id), due: dueXaf, date: text(inv.data.due_date) });
      }
    }
    const openQuotes = quotes.filter((q) => quoteStatus(q) === "sent");
    const drafts = invoices.filter((i) => i.data.status !== "validated").length;
    return {
      due, overdue, drafts,
      lateCount: late.length,
      openCount,
      late: late.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4),
      openQuotes: openQuotes.length,
      openQuotesAmount: openQuotes.reduce((n, q) => n + netXafOf(q), 0),
    };
  }, [invoices, payments, credits, quotes]);

  const clientName = (id: string) => text(clients.find((c) => c.id === id)?.data.name) || "—";
  const synced = sync.lastSync
    ? `Synchronisé à ${new Date(sync.lastSync).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`
    : "Pas encore synchronisé";
  const notLate = Math.max(0, data.due - data.overdue);
  const pct = (n: number) => (data.due > 0 ? Math.max(n > 0 ? 2 : 0, (n / data.due) * 100) : 0);
  const daysLate = (d: string) => Math.max(1, Math.round((Date.parse(today()) - Date.parse(d)) / 86_400_000));

  return (
    <section className="dashboard">
      <div className="page-head">
        <div>
          <h2>Tableau de bord</h2>
          <p className="muted small">{synced}</p>
        </div>
        <div className="quick">
          <button onClick={() => go("quotes", "new")}>Nouveau devis</button>
          <button className="primary" onClick={() => go("invoices", "new")}>Nouvelle facture</button>
        </div>
      </div>

      <h3 className="section-title">À traiter</h3>
      <div className="dash-grid">
        <div className="card receivable">
          <div className="receivable-head">
            <div>
              <div className="kpi-label">Reste à encaisser (TTC)</div>
              <div className="receivable-amount mono"><Money n={data.due} /></div>
              <p className="receivable-note">{data.openCount} facture{data.openCount > 1 ? "s" : ""} à encaisser{data.lateCount > 0 ? `, dont ${data.lateCount} en retard` : ""}</p>
            </div>
            <button className="small" onClick={() => go("invoices")}>Voir les factures</button>
          </div>
          <div className="split-bar" role="img" aria-label={`${formatXaf(data.overdue)} en retard, ${formatXaf(notLate)} pas encore échus`}>
            {data.overdue > 0 && <span className="late" style={{ width: `${pct(data.overdue)}%` }} />}
            {notLate > 0 && <span className="soon" style={{ width: `${pct(notLate)}%` }} />}
          </div>
          <dl className="split-legend">
            <div>
              <dt><i style={{ background: "var(--danger)" }} />En retard</dt>
              <dd className={`mono ${data.overdue > 0 ? "danger-text" : ""}`}>{formatXaf(data.overdue)}</dd>
            </div>
            <div>
              <dt><i style={{ background: "var(--accent)" }} />Pas encore échu</dt>
              <dd className="mono">{formatXaf(notLate)}</dd>
            </div>
          </dl>
          {(data.openQuotes > 0 || data.drafts > 0) && (
            <ul className="todo-links">
              {data.openQuotes > 0 && (
                <li><button className="link" onClick={() => go("quotes")}>{data.openQuotes} devis envoyé{data.openQuotes > 1 ? "s" : ""} sans réponse</button> <span className="muted mono">{formatXaf(data.openQuotesAmount)} HT</span></li>
              )}
              {data.drafts > 0 && (
                <li><button className="link" onClick={() => go("invoices")}>{data.drafts} facture{data.drafts > 1 ? "s" : ""} en brouillon</button> <span className="muted">à valider, non comptée{data.drafts > 1 ? "s" : ""} dans les chiffres</span></li>
              )}
            </ul>
          )}
        </div>
        <div className="card late-card">
          <div className="card-head">
            <h3>Factures en retard</h3>
            {data.late.length > 0 && <span className="badge danger">{data.lateCount}</span>}
          </div>
          {data.late.length === 0 ? (
            <p className="empty-inline"><span className="ok-ico" aria-hidden="true"><MiniIco name="check" /></span>Aucune facture en retard : vos clients sont à jour.</p>
          ) : (
            <ul className="list-rows">
              {data.late.map((l) => (
                <li key={l.id}>
                  <button className="row-link" onClick={() => go("invoices", l.id)}>
                    <span className="grow">
                      <b>{clientName(l.client)}</b>
                      <small><span className="mono">{l.number}</span> · échue le {formatDate(l.date)}</small>
                    </span>
                    <span className="grow" style={{ flex: "none", alignItems: "flex-end" }}>
                      <b className="mono">{formatXaf(l.due)}</b>
                      <small className="danger-text">{daysLate(l.date)} j de retard</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <Gains />
    </section>
  );
}

/** Montant mis en avant : chiffres en gras, devise en retrait. */
function Money({ n }: { n: number }) {
  const s = formatXaf(n);
  return <>{s.replace(/ FCFA$/, "")}<span className="cur">FCFA</span></>;
}

type MiniIcon = "check";
const MINI_PATHS: Record<MiniIcon, string[]> = {
  check: ["M5 12l5 5 9-10"],
};
function MiniIco({ name }: { name: MiniIcon }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {MINI_PATHS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

