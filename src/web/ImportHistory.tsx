/**
 * Reprise de l'historique d'un autre logiciel de facturation (VosFactures) :
 * on choisit les exports CSV, on contrôle les totaux par année, puis on importe.
 * Relancer la reprise avec les mêmes fichiers n'ajoute rien : ce qui est déjà repris est ignoré.
 */
import { useMemo, useState } from "react";
import { formatDate, text, useApp, useSettings } from "./context.ts";
import { formatAmount } from "../shared/invoice.ts";
import { buildVfImport, type VfImport, type VfRecord } from "../shared/vosfactures.ts";
import type { SyncTable } from "../shared/sync.ts";

const TABLES = ["clients", "quotes", "invoices", "credit_notes", "payments"] as const;
const amount = (n: number) => formatAmount(n, false);

async function readText(file: File): Promise<string> {
  const raw = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return new TextDecoder("windows-1252").decode(raw);
  }
}

type Phase = { step: "idle" } | { step: "writing" | "sending"; done: number; total: number } | { step: "done"; added: number; refused: number };

export function ImportHistory() {
  const { db, sync } = useApp();
  const settings = useSettings();
  const [contents, setContents] = useState<string[] | null>(null);
  const [fileCount, setFileCount] = useState(0);
  const [sellers, setSellers] = useState<string[] | null>(null);
  const [known, setKnown] = useState<{ ids: Set<string>; clients: { id: string; name: string }[] }>({ ids: new Set(), clients: [] });
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ step: "idle" });

  const result = useMemo<VfImport | null>(() => {
    if (!contents) return null;
    try {
      return buildVfImport(contents, { sellers: sellers ?? undefined, existingClients: known.clients });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fichier illisible.");
      return null;
    }
  }, [contents, sellers, known]);

  const fresh: VfRecord[] = useMemo(() => (result ? result.records.filter((r) => !known.ids.has(`${r.tbl}/${r.id}`)) : []), [result, known]);
  const closed = text(settings.closed_until);
  const firstDate = result?.records.reduce((min, r) => {
    const d = text(r.data.date);
    return d && (!min || d < min) ? d : min;
  }, "") ?? "";
  const blockedByClosure = Boolean(closed && firstDate && firstDate <= closed);

  async function loadKnown() {
    const ids = new Set<string>();
    let clients: { id: string; name: string }[] = [];
    for (const tbl of TABLES) {
      const rows = await db.list(tbl);
      for (const r of rows) ids.add(`${tbl}/${r.id}`);
      if (tbl === "clients") clients = rows.map((r) => ({ id: r.id, name: text(r.data.name) }));
    }
    setKnown({ ids, clients });
  }

  async function choose(files: FileList | null) {
    setError(null);
    setPhase({ step: "idle" });
    setContents(null);
    setSellers(null);
    // Copie immédiate : la liste du champ est vidée dès que la sélection est remise à zéro.
    const picked = files ? [...files] : [];
    if (picked.length === 0) return;
    try {
      const texts = await Promise.all(picked.map(readText));
      await loadKnown();
      setFileCount(picked.length);
      setContents(texts);
    } catch {
      setError("Fichier illisible.");
    }
  }

  async function run() {
    if (!result || fresh.length === 0) return;
    setError(null);
    const total = fresh.length;
    try {
      setPhase({ step: "writing", done: 0, total });
      await db.writeMany(fresh.map((r) => ({ tbl: r.tbl as SyncTable, id: r.id, patch: r.data })), (done) => setPhase({ step: "writing", done, total }));
      // Envoi au serveur par paquets, jusqu'à ce que la file soit vide.
      let refused = 0;
      let stalled = 0;
      let left = await db.pendingCount();
      while (left > 0 && stalled < 3) {
        setPhase({ step: "sending", done: Math.max(0, total - left), total });
        await sync.syncNow();
        refused += sync.status.rejected?.length ?? 0;
        const now = await db.pendingCount();
        stalled = now >= left ? stalled + 1 : 0;
        left = now;
      }
      await loadKnown();
      if (left > 0) setError("Tout est enregistré sur cet appareil. L'envoi au serveur se terminera dès que la connexion reviendra.");
      setPhase({ step: "done", added: total, refused });
    } catch (e) {
      setError(e instanceof Error ? e.message : "La reprise a été interrompue. Relancez-la : rien ne sera créé en double.");
      setPhase({ step: "idle" });
    }
  }

  const busy = phase.step === "writing" || phase.step === "sending";
  const sellerNames = result ? Object.keys(result.sellers) : [];
  const picked = sellers ?? sellerNames;
  const c = result?.counts;
  const totals = result?.years.reduce((t, y) => ({
    invoices: t.invoices + y.invoices, net: t.net + y.invoicesNet, payable: t.payable + y.invoicesPayable, paid: t.paid + y.paid, due: t.due + y.due,
    credits: t.credits + y.credits, quotes: t.quotes + y.quotes, others: t.others + y.others,
  }), { invoices: 0, net: 0, payable: 0, paid: 0, due: 0, credits: 0, quotes: 0, others: 0 });

  return (
    <div className="card section-card import-history" aria-label="Reprise d'historique">
      <div className="section-head">
        <h3>Reprise d'historique</h3>
        <label className="button">
          Choisir les fichiers VosFactures
          <input type="file" accept=".csv,text/csv,text/plain" multiple hidden disabled={busy} onChange={(e) => { choose(e.target.files); e.target.value = ""; }} aria-label="Exports CSV VosFactures" />
        </label>
      </div>
      <p className="muted small">
        Reprenez vos devis, factures, avoirs, clients et encaissements depuis les exports CSV de VosFactures (plusieurs fichiers à la fois, un par année par exemple).
        Chaque document garde son numéro et ses montants d'origine ; la numérotation de vos nouvelles factures n'est pas touchée.
      </p>
      {error && <p className="error" role="alert">{error}</p>}

      {result && c && totals && (
        <div className="import-history-preview" data-testid="import-history-preview">
          <p>
            <strong>{fileCount} fichier{fileCount > 1 ? "s" : ""} lu{fileCount > 1 ? "s" : ""}</strong> : {c.invoices} facture{c.invoices > 1 ? "s" : ""}, {c.credit_notes} avoir{c.credit_notes > 1 ? "s" : ""},
            {" "}{c.quotes} devis et bons, {c.clients} nouveau{c.clients > 1 ? "x" : ""} client{c.clients > 1 ? "s" : ""}, {c.payments} encaissement{c.payments > 1 ? "s" : ""}.
            {c.cancelled > 0 && <span className="muted"> {c.cancelled} facture{c.cancelled > 1 ? "s" : ""} annulée{c.cancelled > 1 ? "s" : ""} gardée{c.cancelled > 1 ? "s" : ""} pour mémoire, hors chiffres.</span>}
          </p>
          {sellerNames.length > 1 && (
            <fieldset className="import-history-sellers">
              <legend>Vendeurs trouvés dans les fichiers : cochez ceux à reprendre dans cette entreprise</legend>
              {sellerNames.map((s) => (
                <label key={s} className="check">
                  <input type="checkbox" disabled={busy} checked={picked.includes(s)} onChange={(e) => setSellers(e.target.checked ? [...picked, s] : picked.filter((x) => x !== s))} />
                  {s} <span className="muted">({result.sellers[s]} document{result.sellers[s] > 1 ? "s" : ""})</span>
                </label>
              ))}
            </fieldset>
          )}
          {result.missingYears.length > 0 && (
            <p className="warn-text" data-testid="import-history-missing">
              Aucun document pour {result.missingYears.join(", ")} : il manque sans doute un fichier. Vous pourrez l'ajouter plus tard, sans doublon.
            </p>
          )}
          <div className="table-wrap">
            <table className="import-history-years">
              <caption className="muted small">Contrôle par année, à comparer avec VosFactures (montants en francs CFA)</caption>
              <thead>
                <tr><th>Année</th><th className="right">Factures</th><th className="right">Total HT</th><th className="right">Net à payer</th><th className="right">Encaissé</th><th className="right">Reste dû</th><th className="right">Avoirs</th><th className="right">Devis</th><th className="right">Bons</th></tr>
              </thead>
              <tbody>
                {result.years.map((y) => (
                  <tr key={y.year}>
                    <td>{y.year}</td><td className="right mono">{y.invoices}</td><td className="right mono">{amount(y.invoicesNet)}</td><td className="right mono">{amount(y.invoicesPayable)}</td>
                    <td className="right mono">{amount(y.paid)}</td><td className="right mono">{amount(y.due)}</td><td className="right mono">{y.credits}</td><td className="right mono">{y.quotes}</td><td className="right mono">{y.others}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total</th><th className="right mono">{totals.invoices}</th><th className="right mono">{amount(totals.net)}</th><th className="right mono">{amount(totals.payable)}</th>
                  <th className="right mono">{amount(totals.paid)}</th><th className="right mono">{amount(totals.due)}</th><th className="right mono">{totals.credits}</th><th className="right mono">{totals.quotes}</th><th className="right mono">{totals.others}</th>
                </tr>
              </tfoot>
            </table>
          </div>
          {result.warnings.length > 0 && (
            <details className="small">
              <summary>{result.warnings.length} point{result.warnings.length > 1 ? "s" : ""} à connaître</summary>
              <ul className="plain">{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </details>
          )}
          {blockedByClosure ? (
            <p className="error">La comptabilité est clôturée jusqu'au {formatDate(closed)} et ces fichiers contiennent des documents antérieurs. Rouvrez la période (Comptabilité) avant de reprendre l'historique.</p>
          ) : phase.step === "done" ? (
            <p className="ok-text" data-testid="import-history-done">
              Reprise terminée : {phase.added} élément{phase.added > 1 ? "s" : ""} ajouté{phase.added > 1 ? "s" : ""}.
              {phase.refused > 0 && ` ${phase.refused} refusé${phase.refused > 1 ? "s" : ""} par le serveur.`}
            </p>
          ) : busy ? (
            <p role="status" data-testid="import-history-progress">
              {phase.step === "writing" ? "Enregistrement sur cet appareil" : "Envoi au serveur"} : {phase.done} sur {phase.total}. Gardez cette page ouverte.
            </p>
          ) : fresh.length === 0 ? (
            <p className="ok-text" data-testid="import-history-uptodate">Tout est déjà repris : rien à ajouter.</p>
          ) : (
            <div className="row">
              <button className="primary" onClick={run} data-testid="import-history-run">Reprendre {fresh.length} élément{fresh.length > 1 ? "s" : ""}</button>
              {result.records.length > fresh.length && <span className="muted small">{result.records.length - fresh.length} déjà repris, ignorés.</span>}
              <span className="muted small">Conseil : exportez d'abord une sauvegarde (ci-dessus).</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
