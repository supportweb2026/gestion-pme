/**
 * Comptabilité SYSCOHADA : les écritures sont déduites des factures, avoirs,
 * encaissements et dépenses ; seules les opérations diverses se saisissent.
 * Tous les états se calculent sur l'appareil, donc hors ligne.
 */
import { useMemo, useState } from "react";
import { can, formatDate, text, today, useApp, useSettings, useTable, type Tab } from "../context.ts";
import { formatAmount, formatXaf } from "../../shared/invoice.ts";
import {
  accountLabel, accountLedger, balanceSheet, CHART, clientBalance, entriesToCsv, generateEntries, incomeStatement,
  isBalanced, JOURNALS, trialBalance, vatReturn, type Entry, type EntryLine,
} from "../../shared/accounting.ts";
import type { SyncRecord } from "../../shared/sync.ts";

type View = "journal" | "ledger" | "balance" | "statements" | "vat" | "od" | "closing";
const VIEWS: [View, string][] = [
  ["journal", "Journal"], ["ledger", "Grand livre"], ["balance", "Balance"], ["statements", "Résultat et bilan"],
  ["vat", "TVA"], ["od", "Écritures diverses"], ["closing", "Clôture"],
];

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const lastDay = (y: number, m: number) => iso(new Date(y, m + 1, 0));

/** Périodes usuelles, calculées à partir d'aujourd'hui. */
function presets(): Record<string, { label: string; from: string; to: string }> {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth();
  const q = Math.floor(m / 3) * 3;
  return {
    month: { label: "Ce mois", from: iso(new Date(y, m, 1)), to: lastDay(y, m) },
    lastMonth: { label: "Mois dernier", from: iso(new Date(y, m - 1, 1)), to: lastDay(y, m - 1) },
    quarter: { label: "Ce trimestre", from: iso(new Date(y, q, 1)), to: lastDay(y, q + 2) },
    year: { label: `Exercice ${y}`, from: `${y}-01-01`, to: `${y}-12-31` },
    lastYear: { label: `Exercice ${y - 1}`, from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
  };
}

/** Téléchargement d'un fichier CSV lisible par Excel (BOM UTF-8, point-virgule). */
function download(name: string, csv: string) {
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function useBooks() {
  const invoices = useTable("invoices");
  const credit_notes = useTable("credit_notes");
  const payments = useTable("payments");
  const expenses = useTable("expenses");
  const journal_entries = useTable("journal_entries");
  const articles = useTable("articles");
  const clients = useTable("clients");
  const entries = useMemo(
    () => generateEntries({ invoices, credit_notes, payments, expenses, journal_entries, articles, clients }),
    [invoices, credit_notes, payments, expenses, journal_entries, articles, clients],
  );
  const clientName = (id: string) => text(clients.find((c) => c.id === id)?.data.name) || id;
  return { entries, invoices, credit_notes, journal_entries, clientName };
}

export function Accounting() {
  const [view, setView] = useState<View>("balance");
  const p = presets();
  const [preset, setPreset] = useState("year");
  const [from, setFrom] = useState(p.year.from);
  const [to, setTo] = useState(p.year.to);
  const books = useBooks();
  const settings = useSettings();
  const closedUntil = text(settings.closed_until);

  const choose = (k: string) => {
    setPreset(k);
    if (p[k]) {
      setFrom(p[k].from);
      setTo(p[k].to);
    }
  };

  return (
    <section>
      <div className="section-head">
        <h2>Comptabilité</h2>
        <button onClick={() => download(`ecritures_${from}_${to}.csv`, entriesToCsv(books.entries, from, to, books.clientName))}>
          Exporter les écritures (CSV)
        </button>
      </div>

      <div className="toolbar">
        <select value={preset} onChange={(e) => choose(e.target.value)} aria-label="Période">
          {Object.entries(p).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          <option value="custom">Période personnalisée</option>
        </select>
        <label className="inline">Du <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPreset("custom"); }} /></label>
        <label className="inline">au <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPreset("custom"); }} /></label>
        {closedUntil && <span className="badge">Clôturé jusqu'au {formatDate(closedUntil)}</span>}
      </div>

      <div className="segmented subnav" role="tablist">
        {VIEWS.map(([v, label]) => (
          <button key={v} role="tab" aria-selected={view === v} className={view === v ? "active" : ""} onClick={() => setView(v)}>{label}</button>
        ))}
      </div>

      {view === "journal" && <JournalView entries={books.entries} from={from} to={to} />}
      {view === "ledger" && <LedgerView entries={books.entries} from={from} to={to} />}
      {view === "balance" && <BalanceView entries={books.entries} from={from} to={to} clientName={books.clientName} />}
      {view === "statements" && <StatementsView entries={books.entries} from={from} to={to} />}
      {view === "vat" && <VatView entries={books.entries} from={from} to={to} invoices={books.invoices} credits={books.credit_notes} />}
      {view === "od" && <OdView rows={books.journal_entries} closedUntil={closedUntil} />}
      {view === "closing" && <ClosingView closedUntil={closedUntil} />}
    </section>
  );
}

const SOURCE_TAB: Record<string, Tab> = { invoices: "invoices", credit_notes: "credit_notes", payments: "invoices", expenses: "expenses" };

function JournalView({ entries, from, to }: { entries: Entry[]; from: string; to: string }) {
  const { go } = useApp();
  const [journal, setJournal] = useState("");
  const list = entries.filter((e) => e.date >= from && e.date <= to && (!journal || e.journal === journal));
  const total = list.reduce((n, e) => n + e.lines.reduce((m, l) => m + l.debit, 0), 0);
  const open = (e: Entry) => {
    const tab = SOURCE_TAB[e.source.tbl];
    if (!tab) return;
    // Un encaissement ouvre sa facture.
    go(tab, e.source.tbl === "expenses" ? undefined : e.source.tbl === "payments" ? undefined : e.source.id);
  };
  return (
    <div className="card table-wrap">
      <div className="card-toolbar">
        <select value={journal} onChange={(e) => setJournal(e.target.value)} aria-label="Journal">
          <option value="">Tous les journaux</option>
          {Object.entries(JOURNALS).map(([k, v]) => <option key={k} value={k}>{k} · {v}</option>)}
        </select>
        <span className="muted small">{list.length} écriture(s) · total {formatXaf(total)}</span>
      </div>
      {list.length === 0 ? <p className="empty">Aucune écriture sur cette période.</p> : (
        <table className="books">
          <thead><tr><th>Date</th><th>Jnl</th><th>Pièce</th><th>Compte</th><th>Libellé</th><th className="right">Débit</th><th className="right">Crédit</th></tr></thead>
          {list.map((e) => (
            <tbody key={e.id} className="entry" onClick={() => open(e)}>
              {e.lines.map((l, i) => (
                <tr key={i}>
                  <td>{i === 0 ? formatDate(e.date) : ""}</td>
                  <td>{i === 0 ? e.journal : ""}</td>
                  <td className="mono">{i === 0 ? e.ref : ""}</td>
                  <td className="mono" title={accountLabel(l.account)}>{l.account}</td>
                  <td>{l.label}</td>
                  <td className="right mono">{formatAmount(l.debit)}</td>
                  <td className="right mono">{formatAmount(l.credit)}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      )}
    </div>
  );
}

function LedgerView({ entries, from, to }: { entries: Entry[]; from: string; to: string }) {
  const accounts = useMemo(() => [...new Set(entries.flatMap((e) => e.lines.map((l) => l.account)))].sort(), [entries]);
  const [account, setAccount] = useState(accounts.includes("411") ? "411" : accounts[0] ?? "");
  const l = account ? accountLedger(entries, account, from, to) : null;
  return (
    <div className="card table-wrap">
      <div className="card-toolbar">
        <select value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Compte">
          {accounts.map((a) => <option key={a} value={a}>{a} · {accountLabel(a)}</option>)}
        </select>
      </div>
      {!l ? <p className="empty">Aucun compte mouvementé.</p> : (
        <table className="books">
          <thead><tr><th>Date</th><th>Jnl</th><th>Pièce</th><th>Libellé</th><th className="right">Débit</th><th className="right">Crédit</th><th className="right">Solde</th></tr></thead>
          <tbody>
            <tr className="muted"><td colSpan={6}>Solde au {formatDate(from)}</td><td className="right mono">{formatAmount(l.opening, false)}</td></tr>
            {l.moves.map((m, i) => (
              <tr key={i}>
                <td>{formatDate(m.date)}</td><td>{m.journal}</td><td className="mono">{m.ref}</td><td>{m.label}</td>
                <td className="right mono">{formatAmount(m.debit)}</td><td className="right mono">{formatAmount(m.credit)}</td>
                <td className="right mono">{formatAmount(m.running, false)}</td>
              </tr>
            ))}
            <tr className="strong-row"><td colSpan={6}>Solde au {formatDate(to)} ({l.closing >= 0 ? "débiteur" : "créditeur"})</td><td className="right mono">{formatAmount(Math.abs(l.closing), false)}</td></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

const CLASSES: Record<string, string> = {
  "1": "Classe 1 · Ressources durables", "2": "Classe 2 · Actif immobilisé", "3": "Classe 3 · Stocks",
  "4": "Classe 4 · Tiers", "5": "Classe 5 · Trésorerie", "6": "Classe 6 · Charges", "7": "Classe 7 · Produits", "8": "Classe 8 · Autres",
};

function BalanceView({ entries, from, to, clientName }: { entries: Entry[]; from: string; to: string; clientName: (id: string) => string }) {
  const [aux, setAux] = useState(false);
  const rows = trialBalance(entries, from, to);
  const totals = rows.reduce((t, r) => ({ debit: t.debit + r.debit, credit: t.credit + r.credit }), { debit: 0, credit: 0 });
  const ok = totals.debit === totals.credit;
  const classes = [...new Set(rows.map((r) => r.account[0]))];
  const exportCsv = () => {
    const lines = ["Compte;Intitulé;Débit;Crédit;Solde débiteur;Solde créditeur",
      ...rows.map((r) => [r.account, r.label, r.debit, r.credit, Math.max(0, r.balance), Math.max(0, -r.balance)].join(";"))];
    download(`balance_${from}_${to}.csv`, lines.join("\r\n"));
  };
  return (
    <div className="card table-wrap">
      <div className="card-toolbar">
        <div className="segmented">
          <button className={!aux ? "active" : ""} onClick={() => setAux(false)}>Balance générale</button>
          <button className={aux ? "active" : ""} onClick={() => setAux(true)}>Balance clients</button>
        </div>
        <span className={`badge ${ok ? "ok" : "danger"}`} data-testid="balance-check">{ok ? "Équilibrée" : "Déséquilibrée"}</span>
        <button className="ghost small" onClick={exportCsv}>Exporter (CSV)</button>
      </div>
      {aux ? (
        <table className="books">
          <thead><tr><th>Client</th><th className="right">Débit</th><th className="right">Crédit</th><th className="right">Solde dû</th></tr></thead>
          <tbody>
            {clientBalance(entries, from, to).sort((a, b) => b.balance - a.balance).map((r) => (
              <tr key={r.aux}><td>{clientName(r.aux)}</td><td className="right mono">{formatAmount(r.debit)}</td><td className="right mono">{formatAmount(r.credit)}</td><td className="right mono">{formatAmount(r.balance, false)}</td></tr>
            ))}
          </tbody>
        </table>
      ) : rows.length === 0 ? <p className="empty">Aucun mouvement sur cette période.</p> : (
        <table className="books">
          <thead>
            <tr><th>Compte</th><th>Intitulé</th><th className="right">Débit</th><th className="right">Crédit</th><th className="right">Solde débiteur</th><th className="right">Solde créditeur</th></tr>
          </thead>
          {classes.map((c) => {
            const rs = rows.filter((r) => r.account[0] === c);
            const sub = rs.reduce((t, r) => ({ d: t.d + r.debit, c: t.c + r.credit }), { d: 0, c: 0 });
            return (
              <tbody key={c}>
                <tr className="class-row"><td colSpan={6}>{CLASSES[c] ?? `Classe ${c}`}</td></tr>
                {rs.map((r) => (
                  <tr key={r.account}>
                    <td className="mono">{r.account}</td><td>{r.label}</td>
                    <td className="right mono">{formatAmount(r.debit)}</td><td className="right mono">{formatAmount(r.credit)}</td>
                    <td className="right mono">{formatAmount(Math.max(0, r.balance))}</td><td className="right mono">{formatAmount(Math.max(0, -r.balance))}</td>
                  </tr>
                ))}
                <tr className="sub-row">
                  <td colSpan={2}>Total classe {c}</td>
                  <td className="right mono">{formatAmount(sub.d, false)}</td><td className="right mono">{formatAmount(sub.c, false)}</td>
                  <td className="right mono">{formatAmount(Math.max(0, sub.d - sub.c))}</td><td className="right mono">{formatAmount(Math.max(0, sub.c - sub.d))}</td>
                </tr>
              </tbody>
            );
          })}
          <tfoot>
            <tr className="strong-row">
              <td colSpan={2}>Total général</td>
              <td className="right mono">{formatAmount(totals.debit, false)}</td><td className="right mono">{formatAmount(totals.credit, false)}</td>
              <td className="right mono">{formatAmount(rows.reduce((n, r) => n + Math.max(0, r.balance), 0), false)}</td>
              <td className="right mono">{formatAmount(rows.reduce((n, r) => n + Math.max(0, -r.balance), 0), false)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

function StatementsView({ entries, from, to }: { entries: Entry[]; from: string; to: string }) {
  const is = incomeStatement(trialBalance(entries, from, to));
  // Le bilan cumule tous les mouvements depuis l'origine jusqu'à la date de fin.
  const bs = balanceSheet(trialBalance(entries, "0000-01-01", to));
  return (
    <div className="two-cols">
      <div className="card section-card">
        <h3>Compte de résultat du {formatDate(from)} au {formatDate(to)}</h3>
        <table className="books">
          <tbody>
            {is.lines.filter((l) => l.amount !== 0).map((l) => (
              <tr key={l.label}><td>{l.label}</td><td className="right mono">{formatAmount(l.amount, false)}</td></tr>
            ))}
            <tr className="sub-row"><td>Chiffre d'affaires</td><td className="right mono">{formatAmount(is.revenue, false)}</td></tr>
            <tr className="sub-row"><td>Marge commerciale</td><td className="right mono">{formatAmount(is.commercialMargin, false)}</td></tr>
            <tr className="sub-row"><td>Valeur ajoutée</td><td className="right mono">{formatAmount(is.valueAdded, false)}</td></tr>
            <tr className="sub-row"><td>Excédent brut d'exploitation</td><td className="right mono">{formatAmount(is.ebitda, false)}</td></tr>
            <tr className="strong-row"><td>Résultat {is.result >= 0 ? "(bénéfice)" : "(perte)"}</td><td className="right mono" data-testid="result">{formatXaf(is.result)}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="card section-card">
        <h3>Bilan au {formatDate(to)}</h3>
        <table className="books">
          <tbody>
            <tr className="class-row"><td colSpan={2}>Actif</td></tr>
            {bs.assets.map((a) => <tr key={a.label}><td>{a.label}</td><td className="right mono">{formatAmount(a.amount, false)}</td></tr>)}
            <tr className="sub-row"><td>Total actif</td><td className="right mono">{formatAmount(bs.totalAssets, false)}</td></tr>
            <tr className="class-row"><td colSpan={2}>Passif</td></tr>
            {bs.liabilities.map((a) => <tr key={a.label}><td>{a.label}</td><td className="right mono">{formatAmount(a.amount, false)}</td></tr>)}
            <tr className="sub-row"><td>Total passif</td><td className="right mono">{formatAmount(bs.totalLiabilities, false)}</td></tr>
          </tbody>
        </table>
        <p className="muted small">
          {bs.totalAssets === bs.totalLiabilities ? "Bilan équilibré." : "Écart actif / passif : vérifiez les écritures diverses."}
          {" "}Pour un premier exercice, saisissez le capital et les soldes d'ouverture en écritures diverses.
        </p>
      </div>
    </div>
  );
}

function VatView({ entries, from, to, invoices, credits }: { entries: Entry[]; from: string; to: string; invoices: SyncRecord[]; credits: SyncRecord[] }) {
  const v = vatReturn(entries, from, to, invoices, credits);
  return (
    <div className="card section-card">
      <h3>Déclaration de TVA du {formatDate(from)} au {formatDate(to)}</h3>
      <table className="books">
        <thead><tr><th>Opérations imposables</th><th className="right">Base HT</th><th className="right">TVA</th></tr></thead>
        <tbody>
          {v.bases.length === 0 && <tr><td colSpan={3} className="muted">Aucune vente sur la période.</td></tr>}
          {v.bases.map((b) => <tr key={b.rate}><td>Ventes au taux de {b.rate} %</td><td className="right mono">{formatAmount(b.base, false)}</td><td className="right mono">{formatAmount(b.vat, false)}</td></tr>)}
          <tr className="sub-row"><td colSpan={2}>TVA collectée (compte 4431)</td><td className="right mono">{formatAmount(v.collected, false)}</td></tr>
          <tr><td colSpan={2}>TVA récupérable sur achats (4452)</td><td className="right mono">{formatAmount(v.deductibleGoods, false)}</td></tr>
          <tr><td colSpan={2}>TVA récupérable sur services (4454)</td><td className="right mono">{formatAmount(v.deductibleServices, false)}</td></tr>
          <tr className="sub-row"><td colSpan={2}>Total TVA déductible</td><td className="right mono">{formatAmount(v.deductible, false)}</td></tr>
          <tr className="strong-row">
            <td colSpan={2}>{v.due > 0 ? "TVA nette à payer" : "Crédit de TVA à reporter"}</td>
            <td className="right mono" data-testid="vat-due">{formatXaf(v.due > 0 ? v.due : v.credit)}</td>
          </tr>
        </tbody>
      </table>
      <p className="muted small">
        Calcul selon le régime des débits (TVA exigible à la facturation). Faites valider le régime applicable à votre
        activité, les éventuelles taxes annexes et le formulaire officiel par votre comptable avant dépôt.
      </p>
    </div>
  );
}

const emptyLine = (): EntryLine => ({ account: "", label: "", debit: 0, credit: 0 });

function OdView({ rows, closedUntil }: { rows: SyncRecord[]; closedUntil: string }) {
  const { db, session } = useApp();
  const allowed = can.keepBooks(session.user.role);
  const [editing, setEditing] = useState<SyncRecord | "new" | null>(null);
  const sorted = [...rows].sort((a, b) => text(b.data.date).localeCompare(text(a.data.date)));
  return (
    <div>
      <div className="card-toolbar">
        <span className="muted small">Capital, soldes d'ouverture, salaires, amortissements, corrections…</span>
        {allowed && <button className="primary" onClick={() => setEditing("new")}>Nouvelle écriture</button>}
      </div>
      {editing && <OdForm key={editing === "new" ? "new" : editing.id} record={editing === "new" ? null : editing} closedUntil={closedUntil} onClose={() => setEditing(null)} />}
      {sorted.length === 0 ? <p className="empty">Aucune écriture diverse.</p> : (
        <div className="card table-wrap">
          <table className="books">
            <thead><tr><th>Date</th><th>Pièce</th><th>Libellé</th><th className="right">Montant</th><th /></tr></thead>
            <tbody>
              {sorted.map((r) => {
                const lines = (r.data.lines as EntryLine[]) ?? [];
                const locked = !!closedUntil && text(r.data.date) <= closedUntil;
                return (
                  <tr key={r.id}>
                    <td>{formatDate(r.data.date)}</td><td className="mono">{text(r.data.ref)}</td><td>{text(r.data.label)}</td>
                    <td className="right mono">{formatAmount(lines.reduce((n, l) => n + Number(l.debit || 0), 0), false)}</td>
                    <td className="right">{allowed && !locked && <button className="ghost small" onClick={() => setEditing(r)}>Modifier</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <datalist id="chart-list">
        {Object.entries(CHART).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </datalist>
    </div>
  );
}

function OdForm({ record, closedUntil, onClose }: { record: SyncRecord | null; closedUntil: string; onClose: () => void }) {
  const { db, session } = useApp();
  const [date, setDate] = useState(text(record?.data.date) || today());
  const [label, setLabel] = useState(text(record?.data.label));
  const [ref, setRef] = useState(text(record?.data.ref));
  const [lines, setLines] = useState<EntryLine[]>(() => ((record?.data.lines as EntryLine[]) ?? [emptyLine(), emptyLine()]).map((l) => ({ ...l })));
  const [error, setError] = useState<string | null>(null);
  const update = (i: number, p: Partial<EntryLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const debit = lines.reduce((n, l) => n + (Number(l.debit) || 0), 0);
  const credit = lines.reduce((n, l) => n + (Number(l.credit) || 0), 0);

  async function save() {
    setError(null);
    const clean = lines.filter((l) => l.account.trim() && (Number(l.debit) || Number(l.credit)))
      .map((l) => ({ account: l.account.trim(), label: l.label.trim(), debit: Math.round(Number(l.debit) || 0), credit: Math.round(Number(l.credit) || 0) }));
    if (!label.trim()) return setError("Indiquez un libellé.");
    if (!isBalanced(clean)) return setError("L'écriture doit être équilibrée : total débit = total crédit.");
    if (closedUntil && date <= closedUntil) return setError(`La période est clôturée jusqu'au ${formatDate(closedUntil)}.`);
    const patch: Record<string, unknown> = { date, label: label.trim(), ref: ref.trim(), journal: "OD", lines: clean };
    if (!record) patch.created_by = session.user.id;
    await db.write("journal_entries", record?.id ?? db.newId("od"), patch);
    onClose();
  }

  async function remove() {
    if (!record || !confirm("Supprimer cette écriture ?")) return;
    await db.remove("journal_entries", record.id);
    onClose();
  }

  return (
    <div className="card section-card">
      <div className="form-grid">
        <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label>Libellé<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Apport en capital" /></label>
        <label>Pièce<input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Référence du justificatif" /></label>
      </div>
      <table className="lines">
        <thead><tr><th>Compte</th><th>Libellé de ligne</th><th className="num">Débit</th><th className="num">Crédit</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <input aria-label="Compte" list="chart-list" value={l.account} onChange={(e) => update(i, { account: e.target.value })} />
                {l.account && <div className="muted small">{accountLabel(l.account.trim())}</div>}
              </td>
              <td><input aria-label="Libellé de ligne" value={l.label} onChange={(e) => update(i, { label: e.target.value })} /></td>
              <td className="num"><input aria-label="Débit" type="number" min="0" value={l.debit || ""} onChange={(e) => update(i, { debit: Number(e.target.value), credit: 0 })} /></td>
              <td className="num"><input aria-label="Crédit" type="number" min="0" value={l.credit || ""} onChange={(e) => update(i, { credit: Number(e.target.value), debit: 0 })} /></td>
              <td><button className="ghost small" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Supprimer la ligne">✕</button></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="strong-row">
            <td colSpan={2}>Totaux {debit === credit && debit > 0 ? "· équilibrée" : debit !== credit ? `· écart ${formatAmount(Math.abs(debit - credit), false)}` : ""}</td>
            <td className="right mono">{formatAmount(debit, false)}</td><td className="right mono">{formatAmount(credit, false)}</td><td />
          </tr>
        </tfoot>
      </table>
      <button className="ghost" onClick={() => setLines((ls) => [...ls, emptyLine()])}>+ Ajouter une ligne</button>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        {record && <button className="ghost danger" onClick={remove}>Supprimer</button>}
        <button className="ghost" onClick={onClose}>Annuler</button>
        <button className="primary" onClick={save}>Enregistrer l'écriture</button>
      </div>
    </div>
  );
}

function ClosingView({ closedUntil }: { closedUntil: string }) {
  const { db, session } = useApp();
  const allowed = can.keepBooks(session.user.role);
  const d = new Date();
  const suggestion = lastDay(d.getFullYear(), d.getMonth() - 1);
  const [date, setDate] = useState(closedUntil && closedUntil > suggestion ? closedUntil : suggestion);

  async function close() {
    if (!confirm(`Clôturer jusqu'au ${formatDate(date)} ? Plus aucune facture, encaissement, dépense ou écriture datée de cette période ne pourra être créé ou modifié.`)) return;
    await db.write("settings", "company", { closed_until: date });
  }
  async function reopen() {
    if (!confirm("Rouvrir toutes les périodes ? À réserver aux corrections exceptionnelles.")) return;
    await db.write("settings", "company", { closed_until: "" });
  }

  return (
    <div className="card section-card">
      <h3>Clôture des périodes</h3>
      <p>
        {closedUntil
          ? <>Les opérations sont verrouillées jusqu'au <strong>{formatDate(closedUntil)}</strong> inclus, sur tous les appareils.</>
          : "Aucune période clôturée."}
      </p>
      <p className="muted small">
        Clôturez chaque mois après la déclaration de TVA, et l'exercice après l'arrêté des comptes : les chiffres
        déclarés ne peuvent plus changer. Le serveur refuse toute modification datée d'une période clôturée.
      </p>
      {allowed ? (
        <div className="form-actions">
          <label className="inline">Clôturer jusqu'au <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          {closedUntil && session.user.role === "admin" && <button className="ghost" onClick={reopen}>Rouvrir</button>}
          <button className="primary" onClick={close}>Clôturer</button>
        </div>
      ) : <p className="muted small">Réservé au comptable et à l'administrateur.</p>}
    </div>
  );
}
