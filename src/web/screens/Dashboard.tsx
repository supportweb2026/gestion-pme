import { useMemo } from "react";
import { formatDate, text, today, useApp, useSettings, useSyncStatus, useTable } from "../context.ts";
import { formatXaf } from "../../shared/invoice.ts";
import { forecast, monthlyTarget, targetProgress } from "../../shared/treasury.ts";
import { invoiceSituations, netXafOf, quoteStatus, rateOf, totalsOf } from "../ledger.ts";
import { buildReport, EMPTY_FILTERS } from "../reports.ts";
import { Gains } from "./Gains.tsx";

/**
 * Tableau de bord unique.
 *  1. « À traiter » : ce qui demande une action aujourd'hui (argent à encaisser, retards,
 *     devis sans réponse, brouillons), avec l'objectif du mois s'il est fixé. Indépendant de la période.
 *  1 bis. « Trésorerie à venir » : entrées et sorties attendues à 30, 60 et 90 jours.
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
  const orders = useTable("purchase_orders");
  const articles = useTable("articles");
  const settings = useSettings();
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
    const drafts = invoices.filter((i) => i.data.status !== "validated" && i.data.status !== "cancelled").length;
    return {
      due, overdue, drafts,
      lateCount: late.length,
      openCount,
      late: late.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4),
      openQuotes: openQuotes.length,
      openQuotesAmount: openQuotes.reduce((n, q) => n + netXafOf(q), 0),
    };
  }, [invoices, payments, credits, quotes]);

  // Trésorerie à venir : reste dû à échéance, séries récurrentes, commandes fournisseurs.
  const cash = useMemo(() => {
    const sit = invoiceSituations(invoices, payments, credits);
    const list = invoices.map((rec) => {
      const s = sit.get(rec.id);
      return { rec, due: s ? Math.round(s.due * s.rate) : 0, grossXaf: Math.round(totalsOf(rec).gross * rateOf(rec)) };
    });
    return forecast({ today: today(), invoices: list, orders });
  }, [invoices, payments, credits, orders]);

  // Objectif du mois : chiffre d'affaires HT du mois (avoirs déduits), comme dans « Performance ».
  const target = monthlyTarget(settings);
  const progress = useMemo(() => {
    if (target <= 0) return null;
    const t = today();
    const r = buildReport({ invoices, credits, payments, quotes, articles, today: t }, { ...EMPTY_FILTERS, from: `${t.slice(0, 7)}-01`, to: t });
    return targetProgress(target, Math.round(r.kpis.revenue), t);
  }, [target, invoices, credits, payments, quotes, articles]);
  const monthName = new Date(`${today()}T12:00:00Z`).toLocaleDateString("fr-FR", { month: "long", timeZone: "UTC" });
  const hasCash = cash.buckets.some((b) => b.inflow || b.recurring || b.outflow);

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

      {progress && (
        <div className="target-line" data-testid="target">
          <div className="target-text">
            <span>Objectif de {monthName} : <b className="mono">{formatXaf(progress.achieved).replace(/ FCFA$/, "")}</b> / <span className="mono">{formatXaf(progress.target)}</span> HT</span>
            <span className={`mono ${progress.onTrack ? "ok-text" : "muted"}`}>{Math.round(progress.ratio * 100)} %</span>
          </div>
          <div className="split-bar" role="progressbar" aria-label={`Objectif de ${monthName}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(progress.ratio * 100))}>
            {progress.achieved > 0 && <span className="soon" style={{ width: `${Math.min(100, Math.max(2, progress.ratio * 100))}%` }} />}
          </div>
        </div>
      )}

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

      <h3 className="section-title">Trésorerie à venir</h3>
      <div className="card cash-card" role="region" aria-label="Trésorerie à venir">
        {!hasCash ? (
          <p className="empty-inline">Aucune échéance de facture ni commande fournisseur dans les 90 prochains jours.</p>
        ) : (
          <>
            <div className="cash-cols">
              {cash.buckets.map((b) => (
                <dl key={b.days} className="cash-col" data-testid={`cash-${b.days}`}>
                  <div className="cash-head">D'ici {b.days} jours</div>
                  <div><dt>Entrées</dt><dd className="mono">{formatXaf(b.inflow + b.recurring)}</dd></div>
                  <div><dt>Sorties</dt><dd className="mono">{b.outflow ? `− ${formatXaf(b.outflow)}` : formatXaf(0)}</dd></div>
                  <div className="cash-net"><dt>Solde prévu</dt><dd className={`mono ${b.net < 0 ? "danger-text" : ""}`}>{formatXaf(b.net)}</dd></div>
                </dl>
              ))}
            </div>
            <p className="muted small cash-note">
              Entrées : reste dû des factures à leur échéance{cash.buckets.some((b) => b.recurring) ? " et prochaines factures récurrentes" : ""}. Sorties : commandes fournisseurs en cours, à leur livraison prévue.
              {cash.overdue > 0 && <> Les {formatXaf(cash.overdue)} en retard ne sont pas comptés.</>}
            </p>
          </>
        )}
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

