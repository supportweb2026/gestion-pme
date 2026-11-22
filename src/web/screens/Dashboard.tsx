import { useEffect, useMemo, useRef, useState } from "react";
import { COMING_SOON, formatDate, text, today, useApp, useSyncStatus, useTable } from "../context.ts";
import { formatXaf } from "../../shared/invoice.ts";
import { invoiceSituations, netXafOf, quoteStatus } from "../ledger.ts";

const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/** Les 12 derniers mois, du plus ancien au plus récent, au format AAAA-MM. */
function lastMonths(n = 12): string[] {
  const d = new Date();
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}
const monthLabel = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1];

/** Montant compact pour les axes : 1,2 M ; 350 k. */
const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M`
    : n >= 1000 ? `${Math.round(n / 1000)} k` : String(Math.round(n));

/** Indicateurs calculés sur l'appareil, donc disponibles hors ligne. */
export function Dashboard() {
  const { go } = useApp();
  const invoices = useTable("invoices");
  const payments = useTable("payments");
  const credits = useTable("credit_notes");
  const expenses = useTable("expenses");
  const quotes = useTable("quotes");
  const clients = useTable("clients");
  const sync = useSyncStatus();

  const data = useMemo(() => {
    const sit = invoiceSituations(invoices, payments, credits);
    const month = today().slice(0, 7);
    const months = lastMonths();
    const revenue = new Map(months.map((m) => [m, 0]));
    const spending = new Map(months.map((m) => [m, 0]));
    const byClient = new Map<string, number>();

    for (const inv of invoices) {
      if (inv.data.status !== "validated") continue;
      const m = text(inv.data.date).slice(0, 7);
      const net = netXafOf(inv);
      if (revenue.has(m)) {
        revenue.set(m, revenue.get(m)! + net);
        byClient.set(text(inv.data.client_id), (byClient.get(text(inv.data.client_id)) ?? 0) + net);
      }
    }
    for (const c of credits) {
      if (c.data.status !== "validated") continue;
      const m = text(c.data.date).slice(0, 7);
      const net = netXafOf(c);
      if (revenue.has(m)) {
        revenue.set(m, revenue.get(m)! - net);
        byClient.set(text(c.data.client_id), (byClient.get(text(c.data.client_id)) ?? 0) - net);
      }
    }
    for (const e of expenses) {
      if (e.data.status === "rejected" || e.data.status === "pending") continue;
      const m = text(e.data.date).slice(0, 7);
      const ht = Number(e.data.amount ?? 0) / (1 + Number(e.data.vat_rate ?? 0) / 100);
      if (spending.has(m)) spending.set(m, spending.get(m)! + Math.round(ht));
    }

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
    const collected = payments.filter((p) => text(p.data.date).startsWith(month))
      .reduce((n, p) => n + Math.round(Number(p.data.amount ?? 0) * (Number(p.data.rate) || 1)), 0);
    const openQuotes = quotes.filter((q) => quoteStatus(q) === "sent" || quoteStatus(q) === "accepted");
    const drafts = invoices.filter((i) => i.data.status !== "validated").length;

    return {
      months, revenue, spending, due, overdue, collected, drafts,
      lateCount: late.length,
      openCount,
      late: late.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5),
      top: [...byClient.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 5),
      revenueMonth: revenue.get(month) ?? 0,
      spendingMonth: spending.get(month) ?? 0,
      openQuotes: openQuotes.length,
      openQuotesAmount: openQuotes.reduce((n, q) => n + netXafOf(q), 0),
    };
  }, [invoices, payments, credits, expenses, quotes]);

  const clientName = (id: string) => text(clients.find((c) => c.id === id)?.data.name) || "—";

  // Tant que le module Dépenses n'est pas ouvert, le tableau de bord ne parle que des ventes.
  const withExpenses = !COMING_SOON.expenses;
  const synced = sync.lastSync
    ? `Synchronisé à ${new Date(sync.lastSync).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`
    : "Pas encore synchronisé";
  const notLate = Math.max(0, data.due - data.overdue);
  const pct = (n: number) => (data.due > 0 ? Math.max(n > 0 ? 2 : 0, (n / data.due) * 100) : 0);
  const topMax = Math.max(1, ...data.top.map(([, n]) => n));
  const daysLate = (d: string) => Math.max(1, Math.round((Date.parse(today()) - Date.parse(d)) / 86_400_000));

  const side: { label: string; value: number; sub?: string; icon: MiniIcon }[] = [
    { label: "Chiffre d'affaires du mois (HT)", value: data.revenueMonth, sub: monthName(), icon: "trend" },
    { label: "Encaissé ce mois", value: data.collected, sub: "tous modes de règlement", icon: "cash" },
    withExpenses
      ? { label: "Dépenses du mois (HT)", value: data.spendingMonth, icon: "out" }
      : { label: "Devis en attente (HT)", value: data.openQuotesAmount, sub: `${data.openQuotes} devis envoyé${data.openQuotes > 1 ? "s" : ""} ou accepté${data.openQuotes > 1 ? "s" : ""}`, icon: "quote" },
  ];

  return (
    <section>
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

      <div className="kpis three">
        {side.map((k) => (
          <div className="kpi" key={k.label}>
            <div className="kpi-label"><span className="mini-kpi-ico" aria-hidden="true"><MiniIco name={k.icon} /></span>{k.label}</div>
            <div className="kpi-value mono"><Money n={k.value} /></div>
            {k.sub && <div className="kpi-sub">{k.sub}</div>}
          </div>
        ))}
      </div>

      <div className="dash-grid chart-row">
        <div className="chart-col">
          <RevenueChart months={data.months} revenue={data.revenue} spending={withExpenses ? data.spending : null} />
        </div>
        <div className="card section-card top-card">
          <div className="card-head"><h3>Meilleurs clients sur 12 mois (HT)</h3></div>
          {data.top.length === 0 ? <p className="empty-inline">Vos meilleurs clients apparaîtront avec vos premières factures validées.</p> : (
            <ul className="list-rows">
              {data.top.map(([id, n]) => (
                <li key={id}>
                  <span className="grow">
                    <span style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <b>{clientName(id)}</b><span className="mono strong">{formatXaf(n)}</span>
                    </span>
                    <span className="rank-bar" aria-hidden="true"><span style={{ width: `${(n / topMax) * 100}%` }} /></span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {data.drafts > 0 && (
        <p className="list-foot">
          <button className="link" onClick={() => go("invoices")}>{data.drafts} facture{data.drafts > 1 ? "s" : ""} en brouillon</button>, non comptée{data.drafts > 1 ? "s" : ""} dans ces chiffres.
        </p>
      )}
    </section>
  );
}

/** Montant mis en avant : chiffres en gras, devise en retrait. */
function Money({ n }: { n: number }) {
  const s = formatXaf(n);
  return <>{s.replace(/ FCFA$/, "")}<span className="cur">FCFA</span></>;
}

const monthName = () => new Date().toLocaleDateString("fr-FR", { month: "long", year: "numeric" });

type MiniIcon = "trend" | "cash" | "quote" | "out" | "check";
const MINI_PATHS: Record<MiniIcon, string[]> = {
  trend: ["M3 17l6-6 4 4 8-8", "M15 7h6v6"],
  cash: ["M3 7h18v10H3z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M6 10v.01", "M18 14v.01"],
  quote: ["M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z", "M14 3v5h5", "M8.5 13h7", "M8.5 17h4"],
  out: ["M12 3v12", "M7 10l5 5 5-5", "M5 21h14"],
  check: ["M5 12l5 5 9-10"],
};
function MiniIco({ name }: { name: MiniIcon }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {MINI_PATHS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

/**
 * Chiffre d'affaires et dépenses HT par mois : barres, mois en cours en bleu Gestia,
 * info-bulle au survol. Le graphique est dessiné à la taille réelle du conteneur
 * (textes toujours à 11-12 px, sur téléphone comme sur grand écran).
 */
function RevenueChart({ months, revenue, spending: spendingOrNull }: { months: string[]; revenue: Map<string, number>; spending: Map<string, number> | null }) {
  const withSpending = spendingOrNull !== null;
  const spending = spendingOrNull ?? new Map<string, number>();
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const empty = months.every((m) => !revenue.get(m) && !spending.get(m));
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [asTable, empty]);
  const narrow = W < 520;
  const H = narrow ? 190 : 230, left = narrow ? 34 : 44, right = 4, top = 10, bottom = 26;
  const plotW = W - left - right, plotH = H - top - bottom;
  const max = Math.max(1, ...months.map((m) => Math.max(revenue.get(m) ?? 0, spending.get(m) ?? 0)));
  // Graduations « rondes » : 1, 2 ou 5 × 10^n.
  const rawStep = max / 3;
  const pow = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].map((k) => k * pow).find((s) => s >= rawStep)!;
  const ceiling = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(ceiling / step) + 1 }, (_, i) => i * step);
  const y = (v: number) => top + plotH - (Math.max(0, v) / ceiling) * plotH;
  const band = plotW / months.length;
  const barW = withSpending ? Math.min(16, (band - 8) / 2) : Math.min(32, band * 0.56);
  const current = months.length - 1;
  const total = months.reduce((n, m) => n + (revenue.get(m) ?? 0), 0);

  return (
    <div className="card section-card chart-card">
      <div className="card-head">
        <div>
          <h3>{withSpending ? "Chiffre d'affaires et dépenses (HT)" : "Chiffre d'affaires (HT)"}</h3>
          <p className="muted small" style={{ margin: "2px 0 0" }}>12 derniers mois · total <span className="mono">{formatXaf(total)}</span></p>
        </div>
        <div className="legend">
          {withSpending && <span><i className="swatch s1 current" /> Chiffre d'affaires</span>}
          {withSpending && <span><i className="swatch s2" /> Dépenses</span>}
          <button className="small" onClick={() => setAsTable((t) => !t)} aria-pressed={asTable}>{asTable ? "Voir le graphique" : "Voir le tableau"}</button>
        </div>
      </div>
      {empty ? <p className="empty-inline">Les chiffres apparaîtront avec vos premières factures validées.</p> : asTable ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Mois</th><th className="right">Chiffre d'affaires</th>{withSpending && <><th className="right">Dépenses</th><th className="right">Écart</th></>}</tr></thead>
            <tbody>
              {months.map((m) => (
                <tr key={m}>
                  <td>{monthLabel(m)} {m.slice(0, 4)}</td>
                  <td className="right mono">{formatXaf(revenue.get(m) ?? 0)}</td>
                  {withSpending && <td className="right mono">{formatXaf(spending.get(m) ?? 0)}</td>}
                  {withSpending && <td className="right mono">{formatXaf((revenue.get(m) ?? 0) - (spending.get(m) ?? 0))}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-wrap" ref={box}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={withSpending ? "Chiffre d'affaires et dépenses par mois" : "Chiffre d'affaires par mois"} onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                {t > 0 && <line x1={left} x2={W - right} y1={y(t)} y2={y(t)} className="grid" strokeDasharray="3 4" />}
                <text x={left - 8} y={y(t) + 4} textAnchor="end" className="axis">{compact(t)}</text>
              </g>
            ))}
            {months.map((m, i) => {
              const x0 = left + i * band;
              const cx = x0 + band / 2;
              const r = revenue.get(m) ?? 0;
              const s = spending.get(m) ?? 0;
              const bar = (v: number, x: number, cls: string) => {
                const h = Math.max(0, y(0) - y(v));
                if (h <= 0) return null;
                const rr = Math.min(4, h, barW / 2);
                // Coins arrondis en haut seulement, base posée sur l'axe.
                return <path className={cls} d={`M${x} ${y(0)}V${y(v) + rr}Q${x} ${y(v)} ${x + rr} ${y(v)}H${x + barW - rr}Q${x + barW} ${y(v)} ${x + barW} ${y(v) + rr}V${y(0)}Z`} />;
              };
              const cur = i === current || hover === i ? " current" : "";
              return (
                <g key={m} onMouseEnter={() => setHover(i)}>
                  <rect x={x0} y={top} width={band} height={plotH} className={hover === i ? "hover-band" : "hit"} rx={6} />
                  {withSpending ? bar(r, cx - barW - 1, `bar s1${cur}`) : bar(r, cx - barW / 2, `bar s1${cur}`)}
                  {withSpending && bar(s, cx + 1, "bar s2")}
                  {(!narrow || i % 2 === current % 2) && (
                    <text x={cx} y={H - 7} textAnchor="middle" className={`axis${i === current ? " current" : ""}`}>{monthLabel(m)}</text>
                  )}
                </g>
              );
            })}
            <line x1={left} x2={W - right} y1={y(0)} y2={y(0)} className="baseline" />
          </svg>
          {hover !== null && (
            <div className="tooltip" style={{ left: Math.min(W - 80, Math.max(80, left + (hover + 0.5) * band)), top: Math.max(0, y(Math.max(revenue.get(months[hover]) ?? 0, spending.get(months[hover]) ?? 0)) - 58) }}>
              <strong>{monthLabel(months[hover])} {months[hover].slice(0, 4)}</strong>
              <div className="mono">{formatXaf(revenue.get(months[hover]) ?? 0)}</div>
              {withSpending && <div className="mono">Dépenses : {formatXaf(spending.get(months[hover]) ?? 0)}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
