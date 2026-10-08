/**
 * Document imprimable au format A4. « Imprimer / PDF » ouvre la boîte
 * d'impression du navigateur, qui propose « Enregistrer au format PDF » :
 * aucun service externe, fonctionne hors ligne.
 */
import { useEffect } from "react";
import { formatDate, text, useSettings } from "../context.ts";
import { amountInWords, computeTotals, formatXaf, type InvoiceLine } from "../../shared/invoice.ts";
import type { DocTable, SyncRecord } from "../../shared/sync.ts";
import type { Situation } from "../ledger.ts";

const TITLES: Record<DocTable, string> = { invoices: "Facture", quotes: "Devis", credit_notes: "Avoir" };
const ARRETE: Record<DocTable, string> = {
  invoices: "Arrêtée la présente facture",
  quotes: "Arrêté le présent devis",
  credit_notes: "Arrêté le présent avoir",
};

function Lines({ children }: { children: (string | false | undefined)[] }) {
  return <>{children.filter(Boolean).map((l, i) => <div key={i}>{l}</div>)}</>;
}

export function PrintView({ kind, record, client, situation, onClose }: {
  kind: DocTable; record: SyncRecord; client: SyncRecord | null; situation?: Situation; onClose: () => void;
}) {
  const s = useSettings();
  const lines = (record.data.lines as InvoiceLine[]) ?? [];
  const totals = computeTotals(lines);
  const c = client?.data ?? {};
  const number = text(record.data.number);

  // TVA ventilée par taux, comme l'exige une facture.
  const vatByRate = new Map<number, { base: number; vat: number }>();
  for (const l of lines) {
    const base = Math.round(l.qty * l.unitPrice);
    const cur = vatByRate.get(l.vatRate) ?? { base: 0, vat: 0 };
    vatByRate.set(l.vatRate, { base: cur.base + base, vat: cur.vat + Math.round((base * l.vatRate) / 100) });
  }

  useEffect(() => {
    const previous = document.title;
    document.title = `${TITLES[kind]} ${number}`; // nom proposé pour le fichier PDF
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      document.title = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [kind, number, onClose]);

  return (
    <div className="print-overlay" role="dialog" aria-label={`Aperçu ${TITLES[kind]} ${number}`}>
      <div className="print-toolbar">
        <span>Aperçu avant impression</span>
        <button className="primary" onClick={() => window.print()}>Imprimer / enregistrer en PDF</button>
        <button onClick={onClose}>Fermer</button>
      </div>
      <article className="print-sheet">
        <header className="ps-head">
          <div className="ps-company">
            {typeof s.logo === "string" && s.logo && <img src={s.logo} alt="" className="ps-logo" />}
            <div className="ps-company-name">{text(s.name)}</div>
            <Lines>{[text(s.address), text(s.city), text(s.phone) && `Tél. ${text(s.phone)}`, text(s.email)]}</Lines>
          </div>
          <div className="ps-title">
            <div className="ps-doc">{TITLES[kind]}</div>
            <div className="ps-number">N° {number}</div>
            <div>Date : {formatDate(record.data.date)}</div>
            {kind === "invoices" && record.data.due_date ? <div>Échéance : {formatDate(record.data.due_date)}</div> : null}
            {kind === "quotes" && record.data.valid_until ? <div>Valable jusqu'au {formatDate(record.data.valid_until)}</div> : null}
            {kind === "credit_notes" && record.data.invoice_number ? <div>Sur facture {text(record.data.invoice_number)}</div> : null}
            {kind === "invoices" && record.data.quote_number ? <div>Réf. devis {text(record.data.quote_number)}</div> : null}
          </div>
        </header>

        <section className="ps-client">
          <div className="ps-label">{kind === "quotes" ? "Destinataire" : "Facturé à"}</div>
          <div className="ps-client-name">{text(c.name)}</div>
          <Lines>{[text(c.address), text(c.city), text(c.nif) && `NIF : ${text(c.nif)}`, text(c.rccm) && `RCCM : ${text(c.rccm)}`]}</Lines>
        </section>

        <table className="ps-lines">
          <thead>
            <tr><th>Désignation</th><th className="r">Qté</th><th className="r">P.U. HT</th><th className="r">TVA</th><th className="r">Montant HT</th></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>{l.label}</td>
                <td className="r">{l.qty}{l.unit ? ` ${l.unit}` : ""}</td>
                <td className="r">{formatXaf(l.unitPrice)}</td>
                <td className="r">{l.vatRate} %</td>
                <td className="r">{formatXaf(Math.round(l.qty * l.unitPrice))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="ps-bottom">
          <div className="ps-words">
            {ARRETE[kind]} à la somme de <strong>{amountInWords(totals.gross)} francs CFA</strong> toutes taxes comprises.
            {text(record.data.notes) && <p className="ps-notes">{text(record.data.notes)}</p>}
          </div>
          <table className="ps-totals">
            <tbody>
              <tr><td>Total HT</td><td className="r">{formatXaf(totals.net)}</td></tr>
              {[...vatByRate.entries()].map(([rate, v]) => (
                <tr key={rate}><td>TVA {rate} % sur {formatXaf(v.base)}</td><td className="r">{formatXaf(v.vat)}</td></tr>
              ))}
              <tr className="ps-strong"><td>Total TTC</td><td className="r">{formatXaf(totals.gross)}</td></tr>
              {situation && situation.status !== "draft" && situation.paid + situation.credited > 0 && (
                <>
                  <tr><td>Déjà réglé</td><td className="r">{formatXaf(situation.paid + situation.credited)}</td></tr>
                  <tr className="ps-strong"><td>Reste à payer</td><td className="r">{formatXaf(situation.due)}</td></tr>
                </>
              )}
            </tbody>
          </table>
        </div>

        {kind !== "credit_notes" && (text(s.bank) || text(s.mobile_money)) && (
          <section className="ps-pay">
            <div className="ps-label">Règlement</div>
            <Lines>{[text(s.bank) && `Virement : ${text(s.bank)}`, text(s.mobile_money) && `Mobile money : ${text(s.mobile_money)}`]}</Lines>
          </section>
        )}

        {kind === "quotes" && (
          <section className="ps-sign">
            <div className="ps-label">Bon pour accord</div>
            <div className="muted">Date, signature et cachet du client</div>
          </section>
        )}

        <footer className="ps-foot">
          {[text(s.name), text(s.legal_form), text(s.capital) && `Capital ${text(s.capital)}`, text(s.nif) && `NIF ${text(s.nif)}`, text(s.rccm) && `RCCM ${text(s.rccm)}`]
            .filter(Boolean).join(" · ")}
          {text(s.footer) && <div>{text(s.footer)}</div>}
        </footer>
      </article>
    </div>
  );
}
