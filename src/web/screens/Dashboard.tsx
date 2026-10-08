import { useMemo, useState } from "react";
import { formatDate, text, today, useApp, useSyncStatus, useTable } from "../context.ts";
import { formatXaf } from "../../shared/invoice.ts";
import { invoiceSituations, quoteStatus, totalsOf } from "../ledger.ts";

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
      const net = totalsOf(inv).net;
      if (revenue.has(m)) {
        revenue.set(m, revenue.get(m)! + net);
        byClient.set(text(inv.data.client_id), (byClient.get(text(inv.data.client_id)) ?? 0) + net);
      }
    }
    for (const c of credits) {
      if (c.data.status !== "validated") continue;
      const m = text(c.data.date).slice(0, 7);
      const net = totalsOf(c).net;
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
    let overdue = 0;
    const late: { id: string; number: string; client: string; due: number; date: string }[] = [];
    for (const inv of invoices) {
      const s = sit.get(inv.id);
      if (!s || s.status === "draft") continue;
      due += s.due;
      if (s.status === "overdue") {
        overdue += s.due;
        late.push({ id: inv.id, number: text(inv.data.number), client: text(inv.data.client_id), due: s.due, date: text(inv.data.due_date) });
      }
    }
    const collected = payments.filter((p) => text(p.data.date).startsWith(month)).reduce((n, p) => n + Number(p.data.amount ?? 0), 0);
    const openQuotes = quotes.filter((q) => quoteStatus(q) === "sent" || quoteStatus(q) === "accepted");
    const drafts = invoices.filter((i) => i.data.status !== "validated").length;

    return {
      months, revenue, spending, due, overdue, collected, drafts,
      late: late.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5),
      top: [...byClient.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 5),
      revenueMonth: revenue.get(month) ?? 0,
      spendingMonth: spending.get(month) ?? 0,
      openQuotes: openQuotes.length,
      openQuotesAmount: openQuotes.reduce((n, q) => n + totalsOf(q).net, 0),
    };
  }, [invoices, payments, credits, expenses, quotes]);

  const clientName = (id: string) => text(clients.find((c) => c.id === id)?.data.name) || "—";

  const kpis = [
    { label: "Chiffre d'affaires du mois (HT)", value: formatXaf(data.revenueMonth) },
    { label: "Encaissé ce mois", value: formatXaf(data.collected) },
    { label: "Reste à encaisser (TTC)", value: formatXaf(data.due) },
    { label: "Dont en retard", value: formatXaf(data.overdue), tone: data.overdue > 0 ? "danger" : "" },
    { label: "Dépenses du mois (HT)", value: formatXaf(data.spendingMonth) },
    { label: "Devis en attente (HT)", value: `${formatXaf(data.openQuotesAmount)}`, sub: `${data.openQuotes} devis` },
  ];

  return (
    <section>
      <div className="section-head">
        <h2>Tableau de bord</h2>
        <span className="muted small">
          {sync.lastSync ? `Synchronisé à ${new Date(sync.lastSync).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : "Pas encore synchronisé"}
        </span>
      </div>
      <div className="kpis">
        {kpis.map((k) => (
          <div className={`card kpi ${k.tone ?? ""}`} key={k.label}>
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value mono">{k.value}</div>
            {k.sub && <div className="muted small">{k.sub}</div>}
          </div>
        ))}
      </div>

      <RevenueChart months={data.months} revenue={data.revenue} spending={data.spending} />

      <div className="two-cols">
        <div className="card section-card">
          <h3>Factures en retard</h3>
          {data.late.length === 0 ? <p className="muted small">Aucune facture en retard.</p> : (
            <table>
              <tbody>
                {data.late.map((l) => (
                  <tr key={l.id} className="clickable" onClick={() => go("invoices", l.id)}>
                    <td className="mono">{l.number}</td>
                    <td>{clientName(l.client)}</td>
                    <td className="muted small">échue le {formatDate(l.date)}</td>
                    <td className="right mono">{formatXaf(l.due)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card section-card">
          <h3>Meilleurs clients sur 12 mois (HT)</h3>
          {data.top.length === 0 ? <p className="muted small">Pas encore de facture validée.</p> : (
            <table>
              <tbody>
                {data.top.map(([id, n]) => (
                  <tr key={id}><td>{clientName(id)}</td><td className="right mono">{formatXaf(n)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {data.drafts > 0 && (
        <p className="muted small">{data.drafts} facture(s) en brouillon, non comptées dans ces chiffres.</p>
      )}
    </section>
  );
}

/** Chiffre d'affaires et dépenses HT par mois : barres groupées, un seul axe, info-bulle au survol. */
function RevenueChart({ months, revenue, spending }: { months: string[]; revenue: Map<string, number>; spending: Map<string, number> }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const W = 720, H = 240, left = 48, right = 8, top = 12, bottom = 28;
  const plotW = W - left - right, plotH = H - top - bottom;
  const max = Math.max(1, ...months.map((m) => Math.max(revenue.get(m) ?? 0, spending.get(m) ?? 0)));
  // Graduations « rondes » : 1, 2 ou 5 × 10^n.
  const rawStep = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].map((k) => k * pow).find((s) => s >= rawStep)!;
  const ceiling = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(ceiling / step) + 1 }, (_, i) => i * step);
  const y = (v: number) => top + plotH - (Math.max(0, v) / ceiling) * plotH;
  const band = plotW / months.length;
  const barW = Math.min(18, (band - 10) / 2);
  const empty = months.every((m) => !revenue.get(m) && !spending.get(m));

  return (
    <div className="card section-card chart-card">
      <div className="section-head">
        <h3>Chiffre d'affaires et dépenses, 12 derniers mois (HT)</h3>
        <div className="legend">
          <span><i className="swatch s1" /> Chiffre d'affaires</span>
          <span><i className="swatch s2" /> Dépenses</span>
          <button className="ghost small" onClick={() => setAsTable((t) => !t)}>{asTable ? "Voir le graphique" : "Voir le tableau"}</button>
        </div>
      </div>
      {empty ? <p className="muted small">Les chiffres apparaîtront avec vos premières factures et dépenses.</p> : asTable ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Mois</th><th className="right">Chiffre d'affaires</th><th className="right">Dépenses</th><th className="right">Écart</th></tr></thead>
            <tbody>
              {months.map((m) => (
                <tr key={m}>
                  <td>{monthLabel(m)} {m.slice(0, 4)}</td>
                  <td className="right mono">{formatXaf(revenue.get(m) ?? 0)}</td>
                  <td className="right mono">{formatXaf(spending.get(m) ?? 0)}</td>
                  <td className="right mono">{formatXaf((revenue.get(m) ?? 0) - (spending.get(m) ?? 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-wrap">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Chiffre d'affaires et dépenses par mois" onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={left} x2={W - right} y1={y(t)} y2={y(t)} className="grid" />
                <text x={left - 6} y={y(t) + 4} textAnchor="end" className="axis">{compact(t)}</text>
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
              return (
                <g key={m} onMouseEnter={() => setHover(i)}>
                  <rect x={x0} y={top} width={band} height={plotH} className={hover === i ? "hover-band" : "hit"} />
                  {bar(r, cx - barW - 1, "bar s1")}
                  {bar(s, cx + 1, "bar s2")}
                  <text x={cx} y={H - 8} textAnchor="middle" className="axis">{monthLabel(m)}</text>
                </g>
              );
            })}
            <line x1={left} x2={W - right} y1={y(0)} y2={y(0)} className="baseline" />
          </svg>
          {hover !== null && (
            <div className="tooltip" style={{ left: `${((left + (hover + 0.5) * band) / W) * 100}%` }}>
              <strong>{monthLabel(months[hover])} {months[hover].slice(0, 4)}</strong>
              <div><i className="swatch s1" /> {formatXaf(revenue.get(months[hover]) ?? 0)}</div>
              <div><i className="swatch s2" /> {formatXaf(spending.get(months[hover]) ?? 0)}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
