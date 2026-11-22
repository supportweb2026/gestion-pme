/**
 * Tableau de bord des gains : chiffre d'affaires, encaissements, marge, reste dû,
 * avec filtres (période, comparaison, client, article, type, statut, moyen de paiement,
 * commercial, devise, TVA). Tout est calculé sur l'appareil, donc disponible hors ligne.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDate, normalize, text, today, useApp, useTable } from "../context.ts";
import { formatXaf, PAYMENT_METHODS } from "../../shared/invoice.ts";
import { SITUATION_LABELS } from "../ledger.ts";
import {
  articleKeyOf, buildReport, comparePeriod, delta, EMPTY_FILTERS, sellerOf,
  type Breakdown, type DocStatusFilter, type LineKind, type Report, type ReportFilters,
} from "../reports.ts";

type Preset = "month" | "last_month" | "quarter" | "year" | "last_year" | "12m" | "30d" | "custom";
type Compare = "none" | "previous" | "year";
interface Saved extends Omit<ReportFilters, "from" | "to"> { preset: Preset; from: string; to: string; compare: Compare }

const PRESETS: [Preset, string][] = [
  ["month", "Ce mois-ci"], ["last_month", "Mois dernier"], ["30d", "30 derniers jours"], ["quarter", "Ce trimestre"],
  ["year", "Cette année"], ["last_year", "Année dernière"], ["12m", "12 derniers mois"], ["custom", "Période personnalisée"],
];

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Bornes d'une période prédéfinie, à la date du jour. */
export function presetRange(p: Preset, now = new Date()): { from: string; to: string } {
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (p) {
    case "last_month": return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case "30d": return { from: iso(new Date(y, m, now.getDate() - 29)), to: iso(now) };
    case "quarter": { const q = Math.floor(m / 3) * 3; return { from: iso(new Date(y, q, 1)), to: iso(new Date(y, q + 3, 0)) }; }
    case "year": return { from: `${y}-01-01`, to: `${y}-12-31` };
    case "last_year": return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case "12m": return { from: iso(new Date(y, m - 11, 1)), to: iso(new Date(y, m + 1, 0)) };
    default: return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
  }
}

const STORE = "gestia:gains";
function loadSaved(): Saved {
  const base: Saved = { ...EMPTY_FILTERS, preset: "month", ...presetRange("month"), compare: "previous" };
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? "null") as Partial<Saved> | null;
    if (!s) return base;
    const merged = { ...base, ...s };
    // Une période prédéfinie suit la date du jour.
    return merged.preset === "custom" ? merged : { ...merged, ...presetRange(merged.preset) };
  } catch {
    return base;
  }
}

const KIND_LABELS: Record<LineKind, string> = { product: "Produits", service: "Services", free: "Lignes libres" };
const STATUS_LABELS: Record<DocStatusFilter, string> = { paid: "Payée", partial: "Partiellement payée", unpaid: "À encaisser", overdue: "En retard" };
const pct = (n: number | null, digits = 0) => (n === null ? "—" : `${(n * 100).toLocaleString("fr-FR", { maximumFractionDigits: digits })} %`);

export function Gains() {
  const { go, session } = useApp();
  const invoices = useTable("invoices");
  const credits = useTable("credit_notes");
  const payments = useTable("payments");
  const quotes = useTable("quotes");
  const articles = useTable("articles");
  const clients = useTable("clients");
  const [f, setF] = useState<Saved>(loadSaved);
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify(f)); } catch { /* stockage indisponible */ }
  }, [f]);

  const input = useMemo(() => ({ invoices, credits, payments, quotes, articles, today: today() }), [invoices, credits, payments, quotes, articles]);
  const report = useMemo(() => buildReport(input, f), [input, f]);
  const previous = useMemo(() => (f.compare === "none" ? null : buildReport(input, { ...f, ...comparePeriod(f.from, f.to, f.compare) })), [input, f]);

  // Libellés : clients, articles, commerciaux (nom noté sur les documents).
  const clientName = (id: string) => text(clients.find((c) => c.id === id)?.data.name) || "Client supprimé";
  const sellers = useMemo(() => {
    const m = new Map<string, string>([[session.user.id, session.user.name]]);
    for (const d of [...invoices, ...quotes, ...credits]) {
      const id = sellerOf(d);
      if (!m.has(id)) m.set(id, text(d.data.created_by_name) || (id === "inconnu" ? "Non renseigné" : `Utilisateur ${id.slice(-4)}`));
    }
    return m;
  }, [invoices, quotes, credits, session]);
  const sellerName = (id: string) => sellers.get(id) ?? "Non renseigné";
  const articleOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of articles) m.set(`a:${a.id}`, text(a.data.label));
    for (const d of [...invoices, ...credits]) {
      if (d.data.status !== "validated") continue;
      for (const l of (d.data.lines as { label: string; articleId?: string }[] | undefined) ?? []) {
        const k = articleKeyOf(l as never);
        if (!m.has(k) && l.label?.trim()) m.set(k, l.label.trim());
      }
    }
    return [...m.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "fr"));
  }, [articles, invoices, credits]);
  const vatOptions = useMemo(() => {
    const rates = new Set<number>([18]);
    for (const d of invoices) for (const l of (d.data.lines as { vatRate: number }[] | undefined) ?? []) rates.add(Number(l.vatRate) || 0);
    return [...rates].sort((a, b) => b - a).map((r) => ({ value: String(r), label: `${r} %` }));
  }, [invoices]);
  const currencyOptions = useMemo(() => {
    const set = new Set<string>(["XAF"]);
    for (const d of invoices) set.add(text(d.data.currency) || "XAF");
    return [...set].map((c) => ({ value: c, label: c === "XAF" ? "FCFA" : c }));
  }, [invoices]);

  const set = (patch: Partial<Saved>) => setF((old) => ({ ...old, ...patch }));
  const setPreset = (p: Preset) => set(p === "custom" ? { preset: p } : { preset: p, ...presetRange(p) });

  const dims: { key: keyof typeof EMPTY_FILTERS; label: string; options: { value: string; label: string }[]; numeric?: boolean }[] = [
    { key: "clients", label: "Client", options: clients.map((c) => ({ value: c.id, label: text(c.data.name) })).sort((a, b) => a.label.localeCompare(b.label, "fr")) },
    { key: "articles", label: "Produit ou service", options: articleOptions },
    { key: "kinds", label: "Type", options: (Object.keys(KIND_LABELS) as LineKind[]).map((k) => ({ value: k, label: KIND_LABELS[k] })) },
    { key: "statuses", label: "Statut", options: (Object.keys(STATUS_LABELS) as DocStatusFilter[]).map((k) => ({ value: k, label: STATUS_LABELS[k] })) },
    { key: "methods", label: "Moyen de paiement", options: Object.entries(PAYMENT_METHODS).map(([value, label]) => ({ value, label })) },
    { key: "sellers", label: "Commercial", options: [...sellers.entries()].map(([value, label]) => ({ value, label })) },
    { key: "currencies", label: "Devise", options: currencyOptions },
    { key: "vatRates", label: "Taux de TVA", options: vatOptions, numeric: true },
  ];
  const valuesOf = (k: keyof typeof EMPTY_FILTERS) => (f[k] as (string | number)[]).map(String);
  const setValues = (k: keyof typeof EMPTY_FILTERS, values: string[], numeric?: boolean) => set({ [k]: numeric ? values.map(Number) : values } as Partial<Saved>);
  const active = dims.flatMap((d) => valuesOf(d.key).map((v) => ({ dim: d, value: v, label: d.options.find((o) => o.value === v)?.label ?? v })));
  const toggle = (k: keyof typeof EMPTY_FILTERS, value: string, numeric?: boolean) => {
    const cur = valuesOf(k);
    setValues(k, cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value], numeric);
  };

  const k = report.kpis;
  const p = previous?.kpis;
  const cmpLabel = f.compare === "year" ? "vs N-1" : "vs période préc.";
  const range = `${formatDate(f.from)} au ${formatDate(f.to)}`;

  function exportCsv() {
    const head = ["Numéro", "Date", "Échéance", "Client", "Commercial", "Devise", "CA HT (FCFA)", "Total TTC (FCFA)", "Encaissé (FCFA)", "Reste dû (FCFA)", "Statut"];
    const rows = report.documents.map((d) => [d.number, d.date, d.dueDate, clientName(d.clientId), sellerName(d.seller), d.currency, d.revenue, d.gross, d.collected, d.due, SITUATION_LABELS[d.status]]);
    const lineHead = ["Document", "Date", "Client", "Commercial", "Désignation", "Type", "Quantité", "CA HT (FCFA)", "TVA (FCFA)", "Coût d'achat (FCFA)", "Marge (FCFA)"];
    const lineRows = report.lines.map((l) => [l.number, l.date, clientName(l.clientId), sellerName(l.seller), l.label, KIND_LABELS[l.kind], l.qty, l.net, l.vat, l.cost ?? "", l.cost === null ? "" : l.net - l.cost]);
    const cell = (v: unknown) => {
      const s = String(v ?? "");
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [`Gains du ${range}`, "", head, ...rows, "", "Détail des lignes", lineHead, ...lineRows]
      .map((r) => (Array.isArray(r) ? r.map(cell).join(";") : r)).join("\r\n");
    const file = new File(["﻿" + csv], `gains-${f.from}-au-${f.to}.csv`, { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return (
    <section className="gains">
      <div className="page-head">
        <div>
          <h2>Tableau de bord des gains</h2>
          <p className="muted small">Du {range} · calculé sur cet appareil, même hors ligne</p>
        </div>
        <div className="quick">
          <button onClick={exportCsv} disabled={report.documents.length === 0}>Exporter (CSV)</button>
        </div>
      </div>

      <div className="filter-bar" role="group" aria-label="Filtres du tableau de bord">
        <label className="field-inline">
          <span>Période</span>
          <select value={f.preset} onChange={(e) => setPreset(e.target.value as Preset)} aria-label="Période">
            {PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {f.preset === "custom" && (
          <>
            <label className="field-inline"><span>Du</span><input type="date" value={f.from} max={f.to} onChange={(e) => e.target.value && set({ from: e.target.value })} aria-label="Du" /></label>
            <label className="field-inline"><span>Au</span><input type="date" value={f.to} min={f.from} onChange={(e) => e.target.value && set({ to: e.target.value })} aria-label="Au" /></label>
          </>
        )}
        <label className="field-inline">
          <span>Comparer à</span>
          <select value={f.compare} onChange={(e) => set({ compare: e.target.value as Compare })} aria-label="Comparer à">
            <option value="previous">Période précédente</option>
            <option value="year">Même période l'an dernier</option>
            <option value="none">Pas de comparaison</option>
          </select>
        </label>
        <button className={showFilters ? "active" : ""} aria-expanded={showFilters} onClick={() => setShowFilters((s) => !s)}>
          Plus de filtres{active.length > 0 && <span className="seg-count">{active.length}</span>}
        </button>
      </div>

      {showFilters && (
        <div className="card filter-panel">
          {dims.map((d) => (
            <MultiSelect key={d.key} label={d.label} options={d.options} values={valuesOf(d.key)} onChange={(v) => setValues(d.key, v, d.numeric)} />
          ))}
        </div>
      )}

      {active.length > 0 && (
        <div className="chips active-filters" aria-label="Filtres actifs">
          {active.map((a) => (
            <button key={`${a.dim.key}-${a.value}`} className="chip removable" onClick={() => toggle(a.dim.key, a.value, a.dim.numeric)} aria-label={`Retirer le filtre ${a.dim.label} : ${a.label}`}>
              <span className="muted">{a.dim.label} :</span> {a.label} <span aria-hidden="true">×</span>
            </button>
          ))}
          <button className="link small" onClick={() => set({ ...EMPTY_FILTERS })}>Tout effacer</button>
        </div>
      )}

      <div className="kpis gains-kpis">
        <Kpi testId="kpi-ca" label="Chiffre d'affaires HT" value={k.revenue} prev={p?.revenue} cmp={cmpLabel}
          sub={`${formatXaf(k.revenueGross)} TTC · TVA ${formatXaf(k.vat)}`} />
        <Kpi testId="kpi-encaisse" label="Encaissé" value={k.collected} prev={p?.collected} cmp={cmpLabel}
          sub={report.byMethod[0] ? `surtout ${report.byMethod[0].label}` : "aucun encaissement"} />
        <Kpi testId="kpi-marge" label="Marge brute HT" value={k.margin} prev={p?.margin} cmp={cmpLabel}
          sub={k.marginRate === null ? "Renseignez les prix d'achat des articles" : `Taux de marge ${pct(k.marginRate, 1)}${k.marginCoverage < 0.999 ? ` · sur ${pct(k.marginCoverage)} du CA` : ""}`} />
        <Kpi testId="kpi-du" label="Reste à encaisser (TTC)" value={k.due} tone={k.overdue > 0 ? "danger" : undefined}
          sub={k.overdue > 0 ? `dont ${formatXaf(k.overdue)} en retard` : "aucun retard"} subTone={k.overdue > 0 ? "danger" : undefined} />
      </div>
      <div className="kpis gains-kpis small-kpis">
        <MiniKpi label="Factures validées" value={String(k.invoiceCount)} prev={p?.invoiceCount} now={k.invoiceCount} />
        <MiniKpi label="Panier moyen HT" value={formatXaf(k.averageBasket)} prev={p?.averageBasket} now={k.averageBasket} />
        <MiniKpi label="Clients facturés" value={`${k.activeClients}${k.newClients ? ` · ${k.newClients} nouveau${k.newClients > 1 ? "x" : ""}` : ""}`} prev={p?.activeClients} now={k.activeClients} />
        <MiniKpi label="Délai moyen de paiement" value={k.paymentDelay === null ? "—" : `${k.paymentDelay} j`} />
        <MiniKpi label="Devis signés" value={`${k.quotesSigned} / ${k.quotesSent}`} hint={k.quotesSigned ? `${formatXaf(k.quotesSignedAmount)} HT` : undefined} />
        <MiniKpi label="Taux de transformation" value={pct(k.conversion)} />
        <MiniKpi label="Avoirs" value={formatXaf(k.credits)} />
      </div>

      <TrendChart report={report} />

      <div className="dash-grid gains-grid">
        <BreakdownCard report={report} clientName={clientName} sellerName={sellerName} onPick={(dim, value) => { toggle(dim, value); }} />
        <AgingCard aging={report.aging} onOpen={() => go("invoices")} />
      </div>

      <div className="card table-wrap section-card">
        <div className="card-head table-head"><h3>Factures de la période</h3><span className="muted small">{report.documents.length} facture{report.documents.length > 1 ? "s" : ""}</span></div>
        {report.documents.length === 0 ? <p className="empty">Aucune facture validée ne correspond à ces filtres.</p> : (
          <table className="gains-docs">
            <thead><tr><th>Numéro</th><th>Date</th><th>Client</th><th>Commercial</th><th className="right">CA HT</th><th className="right">Encaissé</th><th className="right">Reste dû</th><th>Statut</th></tr></thead>
            <tbody>
              {report.documents.slice(0, 200).map((d) => (
                <tr key={d.id} className="clickable">
                  <td className="g-num"><button className="row-link mono" onClick={() => go("invoices", d.id)}>{d.number}</button></td>
                  <td className="g-date">{formatDate(d.date)}</td>
                  <td className="g-client">{clientName(d.clientId)}</td>
                  <td className="g-seller muted">{sellerName(d.seller)}</td>
                  <td className="g-ca right mono" data-label="CA HT">{formatXaf(d.revenue)}</td>
                  <td className="g-paid right mono" data-label="Encaissé">{formatXaf(d.collected)}</td>
                  <td className={`g-due right mono${d.status === "overdue" ? " danger-text" : ""}`} data-label="Reste dû">{formatXaf(d.due)}</td>
                  <td className="g-status"><span className={`badge ${d.status === "paid" ? "ok" : d.status === "overdue" ? "danger" : d.status === "partial" ? "warn" : "info"}`}>{SITUATION_LABELS[d.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="list-foot">Chiffre d'affaires : factures validées moins avoirs validés, datés dans la période, en FCFA au taux de chaque document. Encaissé : encaissements datés dans la période. Brouillons exclus.</p>
    </section>
  );
}

function Delta({ now, prev, cmp }: { now: number; prev?: number; cmp?: string }) {
  if (prev === undefined) return null;
  const d = delta(now, prev);
  if (d === null) return <span className="delta flat">{now ? "nouveau" : "="} <span className="muted">{cmp}</span></span>;
  const up = d >= 0;
  return (
    <span className={`delta ${Math.abs(d) < 0.005 ? "flat" : up ? "up" : "down"}`} title={`Avant : ${formatXaf(prev)}`}>
      {up ? "▲" : "▼"} {Math.abs(d * 100).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} % {cmp && <span className="muted">{cmp}</span>}
    </span>
  );
}

function Kpi({ label, value, prev, cmp, sub, tone, subTone, testId }: { label: string; value: number; prev?: number; cmp?: string; sub?: string; tone?: "danger"; subTone?: "danger"; testId?: string }) {
  const s = formatXaf(value);
  return (
    <div className={`kpi${tone ? ` ${tone}` : ""}`} data-testid={testId}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value mono">{s.replace(/ FCFA$/, "")}<span className="cur">FCFA</span></div>
      <Delta now={value} prev={prev} cmp={cmp} />
      {sub && <div className={`kpi-sub${subTone ? ` ${subTone}` : ""}`}>{sub}</div>}
    </div>
  );
}

function MiniKpi({ label, value, hint, prev, now }: { label: string; value: string; hint?: string; prev?: number; now?: number }) {
  return (
    <div className="kpi mini">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value mono">{value}</div>
      {hint && <div className="kpi-sub">{hint}</div>}
      {now !== undefined && prev ? <Delta now={now} prev={prev} /> : null}
    </div>
  );
}

/** Liste déroulante à choix multiples, avec recherche ; se ferme au clic extérieur ou sur Échap. */
function MultiSelect({ label, options, values, onChange }: { label: string; options: { value: string; label: string }[]; values: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("focusin", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("focusin", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const shown = options.filter((o) => !q || normalize(o.label).includes(normalize(q)));
  const summary = values.length === 0 ? "Tous" : values.length === 1 ? options.find((o) => o.value === values[0])?.label ?? "1 choisi" : `${values.length} choisis`;
  return (
    <div className={`ms${open ? " open" : ""}`} ref={ref}>
      <button type="button" className="ms-toggle" aria-expanded={open} aria-label={`${label} : ${summary}`} onClick={() => setOpen((o) => !o)}>
        <span className="ms-label">{label}</span><span className="ms-value">{summary}</span>
      </button>
      {open && (
        <div className="ms-pop">
          {options.length > 8 && <input type="search" placeholder="Rechercher" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Rechercher : ${label}`} autoFocus />}
          {options.length === 0 && <p className="muted small">Aucune valeur pour l'instant.</p>}
          <ul>
            {shown.map((o) => (
              <li key={o.value}>
                <label className="check">
                  <input type="checkbox" checked={values.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...values, o.value] : values.filter((v) => v !== o.value))} />
                  <span>{o.label}</span>
                </label>
              </li>
            ))}
          </ul>
          {values.length > 0 && <button className="link small" onClick={() => onChange([])}>Effacer</button>}
        </div>
      )}
    </div>
  );
}

type Dim = "clients" | "articles" | "sellers" | "methods" | "vatRates";
const TABS: { key: Dim; label: string; field: keyof Report }[] = [
  { key: "clients", label: "Clients", field: "byClient" },
  { key: "articles", label: "Produits et services", field: "byArticle" },
  { key: "sellers", label: "Commerciaux", field: "bySeller" },
  { key: "methods", label: "Moyens de paiement", field: "byMethod" },
  { key: "vatRates", label: "TVA", field: "byVat" },
];

/** Répartition du CA (ou des encaissements) par dimension ; un clic filtre tout le tableau de bord. */
function BreakdownCard({ report, clientName, sellerName, onPick }: { report: Report; clientName: (id: string) => string; sellerName: (id: string) => string; onPick: (dim: Dim, value: string) => void }) {
  const [tab, setTab] = useState<Dim>("clients");
  const t = TABS.find((x) => x.key === tab)!;
  const rows = (report[t.field] as Breakdown[]).slice(0, 15);
  const byMoney = tab === "methods";
  const val = (b: Breakdown) => (byMoney ? b.collected : b.revenue);
  const max = Math.max(1, ...rows.map(val));
  const total = (report[t.field] as Breakdown[]).reduce((n, b) => n + val(b), 0);
  const name = (b: Breakdown) => (tab === "clients" ? clientName(b.key) : tab === "sellers" ? sellerName(b.key) : b.label);
  return (
    <div className="card section-card breakdown">
      <div className="card-head">
        <h3>Répartition {byMoney ? "des encaissements" : "du chiffre d'affaires"}</h3>
      </div>
      <div className="segmented scroll-x" role="tablist" aria-label="Répartir par">
        {TABS.map((x) => <button key={x.key} role="tab" aria-selected={tab === x.key} className={tab === x.key ? "active" : ""} onClick={() => setTab(x.key)}>{x.label}</button>)}
      </div>
      {rows.length === 0 ? <p className="empty-inline">Rien sur cette période.</p> : (
        <table className="breakdown-table">
          <thead>
            <tr>
              <th>{t.label}</th>
              <th className="right">{byMoney ? "Encaissé" : "CA HT"}</th>
              <th className="right hide-sm">Part</th>
              {!byMoney && <th className="right hide-sm">Marge</th>}
              {tab === "articles" && <th className="right hide-sm">Qté</th>}
              {(tab === "clients" || tab === "sellers") && <th className="right hide-sm">Reste dû</th>}
              {byMoney && <th className="right">Opérations</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.key} className="clickable">
                <td>
                  <button className="row-link plain" onClick={() => onPick(tab, b.key)} title="Filtrer sur cette valeur">{name(b)}</button>
                  <span className="rank-bar" aria-hidden="true"><span style={{ width: `${Math.max(0, (val(b) / max) * 100)}%` }} /></span>
                </td>
                <td className="right mono">{formatXaf(val(b))}</td>
                <td className="right mono hide-sm">{total > 0 ? pct(val(b) / total) : "—"}</td>
                {!byMoney && <td className="right mono hide-sm">{b.margin === null ? "—" : `${formatXaf(b.margin)}${b.revenue > 0 ? ` (${pct(b.margin / b.revenue)})` : ""}`}</td>}
                {tab === "articles" && <td className="right mono hide-sm">{b.qty.toLocaleString("fr-FR")}</td>}
                {(tab === "clients" || tab === "sellers") && <td className={`right mono hide-sm${b.due > 0 ? " strong" : ""}`}>{formatXaf(b.due)}</td>}
                {byMoney && <td className="right mono">{b.count}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small" style={{ margin: "10px 0 0" }}>Cliquez une ligne pour filtrer tout le tableau de bord.</p>
    </div>
  );
}

function AgingCard({ aging, onOpen }: { aging: Report["aging"]; onOpen: () => void }) {
  const total = aging.reduce((n, a) => n + a.amount, 0);
  const max = Math.max(1, ...aging.map((a) => a.amount));
  return (
    <div className="card section-card aging">
      <div className="card-head">
        <h3>Balance âgée des impayés</h3>
        <button className="small" onClick={onOpen}>Voir les factures</button>
      </div>
      <p className="muted small" style={{ marginTop: -6 }}>Reste dû TTC aujourd'hui, par retard après échéance · total <span className="mono">{formatXaf(total)}</span></p>
      <ul className="list-rows">
        {aging.map((a, i) => (
          <li key={a.key}>
            <span className="grow">
              <span style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <span>{a.label} <span className="muted small">· {a.count} facture{a.count > 1 ? "s" : ""}</span></span>
                <b className={`mono${i >= 2 && a.amount > 0 ? " danger-text" : ""}`}>{formatXaf(a.amount)}</b>
              </span>
              <span className={`rank-bar${i >= 1 ? " late" : ""}`} aria-hidden="true"><span style={{ width: `${(a.amount / max) * 100}%` }} /></span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const compact = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1_000_000 ? `${(a / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M` : a >= 1000 ? `${Math.round(a / 1000)} k` : String(Math.round(a));
  return n < 0 ? `-${s}` : s;
};

/** Évolution : CA HT et encaissé (même unité, un seul axe), barres groupées, info-bulle, vue tableau. */
function TrendChart({ report }: { report: Report }) {
  const pts = report.series;
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(900);
  const empty = pts.every((p) => !p.revenue && !p.collected);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [asTable, empty]);
  const narrow = W < 560;
  const H = narrow ? 200 : 240, left = narrow ? 38 : 48, right = 4, top = 10, bottom = 26;
  const plotW = W - left - right, plotH = H - top - bottom;
  const maxV = Math.max(1, ...pts.map((p) => Math.max(p.revenue, p.collected)));
  const minV = Math.min(0, ...pts.map((p) => p.revenue));
  const rawStep = (maxV - minV) / 3;
  const pow = 10 ** Math.floor(Math.log10(rawStep || 1));
  const step = [1, 2, 5, 10].map((k) => k * pow).find((s) => s >= rawStep)!;
  const ceil = Math.ceil(maxV / step) * step;
  const floor = Math.floor(minV / step) * step;
  const ticks: number[] = [];
  for (let t = floor; t <= ceil + 1e-9; t += step) ticks.push(t);
  const y = (v: number) => top + plotH - ((v - floor) / (ceil - floor || 1)) * plotH;
  const band = plotW / pts.length;
  const barW = Math.max(2, Math.min(14, (band - 6) / 2));
  const every = Math.ceil(pts.length / (narrow ? 6 : 12));
  const unit = report.granularity === "day" ? "par jour" : report.granularity === "week" ? "par semaine" : "par mois";
  const bar = (v: number, x: number, cls: string) => {
    if (!v) return null;
    const y0 = y(0), y1 = y(v);
    const h = Math.abs(y0 - y1);
    const rr = Math.min(4, h, barW / 2);
    if (v < 0) return <rect className={cls} x={x} y={y0} width={barW} height={h} />;
    return <path className={cls} d={`M${x} ${y0}V${y1 + rr}Q${x} ${y1} ${x + rr} ${y1}H${x + barW - rr}Q${x + barW} ${y1} ${x + barW} ${y1 + rr}V${y0}Z`} />;
  };
  return (
    <div className="card section-card chart-card">
      <div className="card-head">
        <div>
          <h3>Évolution {unit}</h3>
          <p className="muted small" style={{ margin: "2px 0 0" }}>Chiffre d'affaires HT et encaissements, en FCFA</p>
        </div>
        <div className="legend">
          <span><i className="swatch s1 current" /> Chiffre d'affaires HT</span>
          <span><i className="swatch s2" /> Encaissé</span>
          <button className="small" onClick={() => setAsTable((t) => !t)} aria-pressed={asTable}>{asTable ? "Voir le graphique" : "Voir le tableau"}</button>
        </div>
      </div>
      {empty ? <p className="empty-inline">Aucune vente ni encaissement sur cette période.</p> : asTable ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Période</th><th className="right">CA HT</th><th className="right">Encaissé</th><th className="right">Marge connue</th></tr></thead>
            <tbody>
              {pts.filter((p) => p.revenue || p.collected).map((p) => (
                <tr key={p.key}><td>{p.label}</td><td className="right mono">{formatXaf(p.revenue)}</td><td className="right mono">{formatXaf(p.collected)}</td><td className="right mono">{formatXaf(p.margin)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-wrap" ref={box}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Chiffre d'affaires et encaissements ${unit}`} onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                {t !== 0 && <line x1={left} x2={W - right} y1={y(t)} y2={y(t)} className="grid" strokeDasharray="3 4" />}
                <text x={left - 8} y={y(t) + 4} textAnchor="end" className="axis">{compact(t)}</text>
              </g>
            ))}
            {pts.map((p, i) => {
              const x0 = left + i * band;
              const cx = x0 + band / 2;
              return (
                <g key={p.key} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1}>
                  <rect x={x0} y={top} width={band} height={plotH} className={hover === i ? "hover-band" : "hit"} rx={4} />
                  {bar(p.revenue, cx - barW - 1, "bar s1 current")}
                  {bar(p.collected, cx + 1, "bar s2")}
                  {i % every === 0 && <text x={cx} y={H - 7} textAnchor="middle" className="axis">{p.label}</text>}
                </g>
              );
            })}
            <line x1={left} x2={W - right} y1={y(0)} y2={y(0)} className="baseline" />
          </svg>
          {hover !== null && (
            <div className="tooltip" style={{ left: Math.min(W - 90, Math.max(90, left + (hover + 0.5) * band)), top: Math.max(0, y(Math.max(pts[hover].revenue, pts[hover].collected)) - 70) }}>
              <strong>{pts[hover].label}</strong>
              <div className="mono"><i className="tt-key s1" />{formatXaf(pts[hover].revenue)} <span className="tt-sub">CA HT</span></div>
              <div className="mono"><i className="tt-key s2" />{formatXaf(pts[hover].collected)} <span className="tt-sub">encaissé</span></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
