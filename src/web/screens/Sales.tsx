/**
 * Menu Ventes : les deux écrans qui suivent l'argent après la facture.
 *  - Encaissements : tous les paiements reçus, à filtrer et à totaliser ;
 *  - Relances : les factures qui restent à payer, par ancienneté du retard,
 *    avec celles que le calendrier des relances demande de relancer aujourd'hui.
 */
import { useMemo, useState } from "react";
import { formatDate, normalize, text, today, useApp, useSettings, useTable } from "../context.ts";
import { formatXaf, PAYMENT_METHODS } from "../../shared/invoice.ts";
import { formatMoney } from "../../shared/currency.ts";
import { inPeriod, PERIOD_LABELS, periodRange, type PeriodPreset } from "../../shared/periods.ts";
import { AGE_BUCKETS, ageBucket, daysLate, TONE_LABELS, type AgeBucket } from "../../shared/reminders.ts";
import { currencyOf, invoiceSituations, rateOf } from "../ledger.ts";
import { invoiceReminder, SalesFlow } from "./Documents.tsx";
import { usePaged } from "../Pager.tsx";

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("fr-FR")} ${n > 1 ? many : one}`;

export function Payments() {
  const { go } = useApp();
  const payments = useTable("payments");
  const invoices = useTable("invoices");
  const clients = useTable("clients");
  const [query, setQuery] = useState("");
  const [period, setPeriod] = useState<PeriodPreset>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [method, setMethod] = useState("");
  const [client, setClient] = useState("");

  const index = useMemo(() => {
    const names = new Map(clients.map((c) => [c.id, text(c.data.name)]));
    const byId = new Map(invoices.map((i) => [i.id, i]));
    return payments.map((p) => {
      const inv = byId.get(text(p.data.invoice_id));
      const clientId = text(p.data.client_id) || text(inv?.data.client_id);
      const name = names.get(clientId) || "—";
      const currency = text(p.data.currency) || currencyOf(inv);
      const amount = Number(p.data.amount ?? 0);
      const methodLabel = PAYMENT_METHODS[text(p.data.method)] ?? (text(p.data.method) || "—");
      return {
        p, inv, clientId, name, currency, amount, methodLabel,
        xaf: Math.round(amount * (currency === "XAF" ? 1 : Number(p.data.rate) || rateOf(inv))),
        search: normalize(`${name} ${text(inv?.data.number)} ${text(p.data.reference)} ${methodLabel}`),
      };
    }).sort((a, b) => text(b.p.data.date).localeCompare(text(a.p.data.date)) || text(b.inv?.data.number).localeCompare(text(a.inv?.data.number)));
  }, [payments, invoices, clients]);

  const q = normalize(query.trim());
  const range = periodRange(period, today(), from, to);
  const rows = index.filter((r) =>
    (!q || r.search.includes(q))
    && inPeriod(text(r.p.data.date), range)
    && (!method || text(r.p.data.method) === method)
    && (!client || r.clientId === client));
  const total = rows.reduce((s, r) => s + r.xaf, 0);
  const narrowed = Boolean(q || period !== "all" || method || client);
  const reset = () => { setQuery(""); setPeriod("all"); setFrom(""); setTo(""); setMethod(""); setClient(""); };
  const methods = [...new Set(index.map((r) => text(r.p.data.method)).filter(Boolean))];
  const clientOptions = [...new Map(index.map((r) => [r.clientId, r.name])).entries()].filter(([id]) => id).sort((a, b) => a[1].localeCompare(b[1], "fr"));
  const byMethod = [...rows.reduce((m, r) => m.set(r.methodLabel, (m.get(r.methodLabel) ?? 0) + r.xaf), new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
  const { shown, pager } = usePaged(rows, `${q}|${period}|${from}|${to}|${method}|${client}`);

  return (
    <section>
      <div className="page-head">
        <div>
          <h2>Encaissements</h2>
          <p className="muted small">{payments.length === 0 ? "Tous les paiements reçus de vos clients" : plural(payments.length, "encaissement", "encaissements")}</p>
        </div>
        <div className="quick"><button onClick={() => go("reminders")}>Voir les relances</button></div>
      </div>
      <SalesFlow current="payments" />
      {payments.length === 0 ? (
        <div className="card empty-state">
          <p className="empty-title">Aucun encaissement pour l'instant</p>
          <p className="muted">Un encaissement s'enregistre depuis une facture validée : montant, date, moyen de paiement et référence. Il apparaît ensuite ici.</p>
          <button className="primary" onClick={() => go("invoices")}>Voir les factures</button>
        </div>
      ) : (
        <>
          <div className="toolbar list-filters">
            <input type="search" placeholder="Client, facture ou référence" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Rechercher" />
            <select aria-label="Période" value={period} onChange={(e) => setPeriod(e.target.value as PeriodPreset)}>
              {(Object.keys(PERIOD_LABELS) as PeriodPreset[]).map((p) => <option key={p} value={p}>{PERIOD_LABELS[p]}</option>)}
            </select>
            {period === "custom" && (
              <span className="date-range">
                <input type="date" aria-label="Du" value={from} onChange={(e) => setFrom(e.target.value)} />
                <span className="muted small">au</span>
                <input type="date" aria-label="Au" value={to} onChange={(e) => setTo(e.target.value)} />
              </span>
            )}
            {methods.length > 1 && (
              <select aria-label="Moyen de paiement" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="">Tous les moyens</option>
                {methods.map((m) => <option key={m} value={m}>{PAYMENT_METHODS[m] ?? m}</option>)}
              </select>
            )}
            {clientOptions.length > 1 && (
              <select aria-label="Filtrer par tiers" value={client} onChange={(e) => setClient(e.target.value)}>
                <option value="">Tous les clients</option>
                {clientOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            )}
            {narrowed && <button className="ghost small" onClick={reset}>Tout afficher</button>}
            <p className="list-summary muted small" data-testid="payments-summary" aria-live="polite">
              <strong>{plural(rows.length, "encaissement", "encaissements")}</strong>{narrowed && rows.length !== payments.length ? ` sur ${payments.length.toLocaleString("fr-FR")}` : ""}
              {rows.length > 0 && <> · Total <strong>{formatXaf(total)}</strong></>}
            </p>
          </div>
          {byMethod.length > 1 && (
            <p className="method-split muted small" data-testid="payments-methods">
              {byMethod.map(([label, sum]) => <span key={label}>{label} <strong>{formatXaf(sum)}</strong></span>)}
            </p>
          )}
          {rows.length === 0 ? (
            <div className="card empty-state">
              <p className="empty-title">Aucun encaissement ne correspond</p>
              <p className="muted">Modifiez la recherche ou les filtres.</p>
              <button onClick={reset}>Tout afficher</button>
            </div>
          ) : (
            <div className="card table-wrap">
              <table className="doc-table multi-link">
                <caption className="sr-only">Encaissements</caption>
                <thead>
                  <tr><th>Date</th><th>Client</th><th>Facture</th><th>Moyen</th><th>Référence</th><th className="right">Montant</th></tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.p.id}>
                      <td className="c-date">{formatDate(r.p.data.date)}</td>
                      <td className="c-client">{r.clientId ? <button className="row-link" onClick={() => go("clients", r.clientId)}>{r.name}</button> : r.name}</td>
                      <td className="c-num mono">{r.inv ? <button className="row-link" onClick={() => go("invoices", r.inv!.id)}>{text(r.inv.data.number) || "Facture"}</button> : "—"}</td>
                      <td>{r.methodLabel}</td>
                      <td className="muted">{text(r.p.data.reference) || "—"}</td>
                      <td className="c-total right mono">{formatMoney(r.amount, r.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pager}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** « 12 j », « 5 mois », « 3 ans » : un retard lisible d'un coup d'œil. */
const lateLabel = (days: number) => (days <= 90 ? `${days} j` : days < 730 ? `${Math.floor(days / 30)} mois` : `${Math.floor(days / 365)} ans`);

type LateFilter = "all" | "today" | AgeBucket;

export function Reminders() {
  const { go } = useApp();
  const invoices = useTable("invoices");
  const payments = useTable("payments");
  const credits = useTable("credit_notes");
  const clients = useTable("clients");
  const settings = useSettings();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LateFilter>("all");

  const index = useMemo(() => {
    const names = new Map(clients.map((c) => [c.id, text(c.data.name)]));
    const situations = invoiceSituations(invoices, payments, credits);
    const now = today();
    return invoices.flatMap((inv) => {
      const sit = situations.get(inv.id);
      if (!sit || inv.data.status !== "validated" || !(sit.due > 0)) return [];
      const name = names.get(text(inv.data.client_id)) || "—";
      const late = daysLate(text(inv.data.due_date), now);
      return [{
        inv, name, late, due: sit.due, currency: currencyOf(inv),
        xaf: Math.round(sit.due * sit.rate),
        bucket: ageBucket(late),
        remind: invoiceReminder(inv, sit, settings),
        sent: Number(inv.data.reminders ?? 0),
        search: normalize(`${name} ${text(inv.data.number)}`),
      }];
    }).sort((a, b) => b.late - a.late || b.xaf - a.xaf);
  }, [invoices, payments, credits, clients, settings]);

  const sum = (list: typeof index) => list.reduce((s, r) => s + r.xaf, 0);
  const todo = index.filter((r) => r.remind);
  const lateRows = index.filter((r) => r.late > 0);
  const current = index.filter((r) => r.late <= 0);
  const q = normalize(query.trim());
  const rows = index.filter((r) => (!q || r.search.includes(q)) && (filter === "all" || (filter === "today" ? r.remind !== null : r.bucket === filter)));
  const filters: [LateFilter, string, number][] = [
    ["all", "Tout", 0],
    ["today", "À relancer aujourd'hui", todo.length],
    ...(["d30", "d60", "d90", "older", "current"] as AgeBucket[]).map((b) => [b, AGE_BUCKETS[b], index.filter((r) => r.bucket === b).length] as [LateFilter, string, number]),
  ];
  const { shown, pager } = usePaged(rows, `${q}|${filter}`);

  return (
    <section>
      <div className="page-head">
        <div>
          <h2>Relances</h2>
          <p className="muted small">{index.length === 0 ? "Les factures qui restent à payer, par ancienneté du retard" : `${plural(index.length, "facture", "factures")} à encaisser`}</p>
        </div>
        <div className="quick"><button onClick={() => go("settings")} title="Calendrier des relances : Réglages, onglet Documents">Calendrier des relances</button></div>
      </div>
      {index.length === 0 ? (
        <div className="card empty-state">
          <p className="empty-title">Rien à relancer</p>
          <p className="muted">Toutes vos factures validées sont payées. Dès qu'une facture reste à payer, elle apparaît ici avec son retard et la relance à envoyer.</p>
          <button className="primary" onClick={() => go("invoices")}>Voir les factures</button>
        </div>
      ) : (
        <>
          <div className="kpis">
            <div className={`kpi${todo.length ? " danger" : ""}`}>
              <div className="kpi-label">À relancer aujourd'hui</div>
              <div className="kpi-value" data-testid="reminders-today">{todo.length}</div>
              <div className="kpi-sub">{todo.length ? formatXaf(sum(todo)) : "Aucune relance prévue aujourd'hui"}</div>
            </div>
            <div className={`kpi${lateRows.length ? " danger" : ""}`}>
              <div className="kpi-label">En retard</div>
              <div className="kpi-value" data-testid="reminders-late">{formatXaf(sum(lateRows))}</div>
              <div className="kpi-sub">{lateRows.length ? `${plural(lateRows.length, "facture", "factures")} · retard le plus ancien : ${lateLabel(lateRows[0].late)}` : "Aucun retard"}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Pas encore échu</div>
              <div className="kpi-value">{formatXaf(sum(current))}</div>
              <div className="kpi-sub">{plural(current.length, "facture", "factures")}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Total à encaisser</div>
              <div className="kpi-value">{formatXaf(sum(index))}</div>
              <div className="kpi-sub">{plural(index.length, "facture", "factures")}</div>
            </div>
          </div>
          <div className="toolbar">
            <input type="search" placeholder="Client ou numéro de facture" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Rechercher" />
            <div className="segmented scroll-x" role="group" aria-label="Filtrer par retard">
              {filters.filter(([f, , n]) => f === "all" || f === "today" || n > 0).map(([f, label, n]) => (
                <button key={f} className={filter === f ? "active" : ""} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {label}{n > 0 && <span className="seg-count">{n}</span>}
                </button>
              ))}
            </div>
          </div>
          {rows.length === 0 ? (
            <div className="card empty-state">
              <p className="empty-title">{filter === "today" && !q ? "Aucune relance à envoyer aujourd'hui" : "Aucune facture ne correspond"}</p>
              <p className="muted">{filter === "today" && !q ? "Le calendrier des relances ne demande rien pour aujourd'hui." : "Modifiez la recherche ou le filtre."}</p>
              <button onClick={() => { setQuery(""); setFilter("all"); }}>Tout afficher</button>
            </div>
          ) : (
            <div className="card table-wrap">
              <table className="doc-table multi-link">
                <caption className="sr-only">Factures à encaisser</caption>
                <thead>
                  <tr><th>Facture</th><th>Client</th><th>Échéance</th><th>Retard</th><th>Relances envoyées</th><th className="right">Reste dû</th><th><span className="sr-only">Action</span></th></tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.inv.id}>
                      <td className="c-num mono"><button className="row-link" onClick={() => go("invoices", r.inv.id)}>{text(r.inv.data.number)}</button></td>
                      <td className="c-client">{r.name}</td>
                      <td className={`c-due-date ${r.late > 0 ? "danger-text" : "muted"}`}>{r.inv.data.due_date ? formatDate(r.inv.data.due_date) : "—"}</td>
                      <td>{r.late > 0 ? <span className="badge danger" title={`${r.late.toLocaleString("fr-FR")} jours de retard`}>{lateLabel(r.late)}</span> : <span className="muted">Non échu</span>}</td>
                      <td>
                        {r.sent > 0 ? `${r.sent}, la dernière le ${formatDate(text(r.inv.data.reminded_at).slice(0, 10))}` : <span className="muted">Aucune</span>}
                        {r.remind ? <span className="remind-tag" title={TONE_LABELS[r.remind.tone]}>À relancer · {r.remind.label}</span> : null}
                      </td>
                      <td className="c-total right mono">{formatMoney(r.due, r.currency)}</td>
                      <td className="right"><button className={r.remind ? "primary small" : "small"} onClick={() => go("invoices", r.inv.id)}>{r.late > 0 || r.remind ? "Relancer" : "Ouvrir"}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pager}
            </div>
          )}
        </>
      )}
    </section>
  );
}
