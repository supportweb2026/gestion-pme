/**
 * Document imprimable au format A4. « Imprimer / PDF » ouvre la boîte
 * d'impression du navigateur, qui propose « Enregistrer au format PDF » :
 * aucun service externe, fonctionne hors ligne.
 */
import { useEffect, useState } from "react";
import { downloadFile, makePdfFile } from "../pdfActions.ts";
import { formatDate, text, useSettings } from "../context.ts";
import { computeTotals, docTaxes, lineDiscount, lineNet, lineVat, type InvoiceLine } from "../../shared/invoice.ts";
import { amountInWordsWithCurrency, decimalsOf, formatMoney } from "../../shared/currency.ts";
import type { DocTable, SyncRecord } from "../../shared/sync.ts";
import type { Situation } from "../ledger.ts";
import { docArrete, docTitle, isSection, quoteTypeOf } from "../../shared/documents.ts";
import { fiscalMentions, pct } from "../../shared/taxes.ts";
import { docColor, softOf, stampFor, termsFor } from "../../shared/branding.ts";

function Lines({ children }: { children: (string | false | undefined)[] }) {
  return <>{children.filter(Boolean).map((l, i) => <div key={i}>{l}</div>)}</>;
}

export function PrintView({ kind, record, client, situation, onClose }: {
  kind: DocTable; record: SyncRecord; client: SyncRecord | null; situation?: Situation; onClose: () => void;
}) {
  const s = useSettings();
  const lines = (record.data.lines as InvoiceLine[]) ?? [];
  const currency = text(record.data.currency) || "XAF";
  const decimals = decimalsOf(currency);
  const totals = computeTotals(lines, decimals, docTaxes(record.data));
  const formatXaf = (n: number) => formatMoney(n, currency);
  const c = client?.data ?? {};
  const number = text(record.data.number);
  const hasDiscount = lines.some((l) => lineDiscount(l) > 0);
  const title = docTitle(kind, record.data);
  const delivery = kind === "quotes" && quoteTypeOf(record.data) === "delivery";

  // TVA ventilée par taux, comme l'exige une facture.
  const vatByRate = new Map<number, { base: number; vat: number }>();
  for (const l of lines) {
    if (isSection(l)) continue;
    const cur = vatByRate.get(l.vatRate) ?? { base: 0, vat: 0 };
    vatByRate.set(l.vatRate, { base: cur.base + lineNet(l, decimals), vat: cur.vat + lineVat(l, decimals) });
  }

  const [busy, setBusy] = useState(false);
  async function downloadPdf() {
    setBusy(true);
    try {
      downloadFile(await makePdfFile({ kind, doc: record.data, client: client?.data ?? null, company: s, situation }));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const previous = document.title;
    document.title = `${title} ${number}`; // nom proposé pour le fichier PDF
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      document.title = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [kind, number, onClose]);

  return (
    <div className="print-overlay" role="dialog" aria-label={`Aperçu ${title} ${number}`}>
      <div className="print-toolbar">
        <span>Aperçu avant impression</span>
        <button className="primary" onClick={downloadPdf} disabled={busy}>Télécharger le PDF</button>
        <button onClick={() => window.print()}>Imprimer</button>
        <button onClick={onClose}>Fermer</button>
      </div>
      <article className="print-sheet" style={{ "--doc": docColor(s), "--doc-soft": softOf(docColor(s)) } as React.CSSProperties}>
        <header className="ps-head">
          <div className="ps-company">
            {typeof s.logo === "string" && s.logo && <img src={s.logo} alt="" className="ps-logo" />}
            <div className="ps-company-name">{text(s.name)}</div>
            <Lines>{[text(s.address), text(s.city), text(s.phone) && `Tél. ${text(s.phone)}`, text(s.email)]}</Lines>
          </div>
          <div className="ps-title">
            <div className="ps-doc">{title}</div>
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
            {delivery
              ? <tr><th>Désignation</th><th className="r">Quantité</th></tr>
              : <tr><th>Désignation</th><th className="r">Qté</th><th className="r">P.U. HT</th>{hasDiscount && <th className="r">Remise</th>}<th className="r">TVA</th><th className="r">Montant HT</th></tr>}
          </thead>
          <tbody>
            {lines.map((l, i) => isSection(l) ? (
              <tr key={i} className="ps-section"><td colSpan={delivery ? 2 : hasDiscount ? 6 : 5}><strong>{l.label}</strong></td></tr>
            ) : delivery ? (
              <tr key={i}><td>{l.label}</td><td className="r">{l.qty}{l.unit ? ` ${l.unit}` : ""}</td></tr>
            ) : (
              <tr key={i}>
                <td>{l.label}</td>
                <td className="r">{l.qty}{l.unit ? ` ${l.unit}` : ""}</td>
                <td className="r">{formatXaf(l.unitPrice)}</td>
                {hasDiscount && <td className="r">{lineDiscount(l) ? `${lineDiscount(l)} %` : ""}</td>}
                <td className="r">{l.vatRate} %</td>
                <td className="r">{formatXaf(lineNet(l, decimals))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {!delivery && <div className="ps-bottom">
          <div className="ps-words">
            {docArrete(kind, record.data)} à la somme de <strong>{amountInWordsWithCurrency(totals.gross, currency)}</strong> toutes taxes comprises.
            {text(record.data.notes) && <p className="ps-notes">{text(record.data.notes)}</p>}
            {fiscalMentions({
              kind, settings: s, data: record.data,
              hasZeroVat: lines.some((l) => !isSection(l) && !l.deposit && !l.depositInvoiceId && l.vatRate === 0 && lineNet(l, decimals) !== 0),
              payableXaf: Math.round(totals.payable * (currency === "XAF" ? 1 : Number(record.data.rate) || 1)),
            }).map((m) => <p key={m} className="ps-notes">{m}</p>)}
          </div>
          <table className="ps-totals">
            <tbody>
              {totals.discount > 0 && (
                <>
                  <tr><td>Total brut HT</td><td className="r">{formatXaf(totals.net + totals.discount)}</td></tr>
                  <tr><td>Remises</td><td className="r">-{formatXaf(totals.discount)}</td></tr>
                </>
              )}
              <tr><td>Total HT</td><td className="r">{formatXaf(totals.net)}</td></tr>
              {[...vatByRate.entries()].map(([rate, v]) => (
                <tr key={rate}><td>TVA {rate} % sur {formatXaf(v.base)}</td><td className="r">{formatXaf(v.vat)}</td></tr>
              ))}
              {totals.css !== 0 && <tr><td>CSS {pct(Number(record.data.css_rate))}</td><td className="r">{formatXaf(totals.css)}</td></tr>}
              <tr className="ps-strong"><td>Total TTC</td><td className="r">{formatXaf(totals.gross)}</td></tr>
              {totals.withholding !== 0 && (
                <>
                  <tr><td>Retenue à la source {pct(Number(record.data.withholding_rate))}</td><td className="r">-{formatXaf(totals.withholding)}</td></tr>
                  <tr className="ps-strong"><td>Net à payer</td><td className="r">{formatXaf(totals.payable)}</td></tr>
                </>
              )}
              {situation && situation.status !== "draft" && situation.paid + situation.credited > 0 && (
                <>
                  <tr><td>Déjà réglé</td><td className="r">{formatXaf(situation.paid + situation.credited)}</td></tr>
                  <tr className="ps-strong"><td>Reste à payer</td><td className="r">{formatXaf(situation.due)}</td></tr>
                </>
              )}
            </tbody>
          </table>
        </div>}

        {delivery && (
          <section className="ps-sign">
            <div className="ps-label">Reçu par le client</div>
            <div className="muted">Nom, date, signature et cachet</div>
          </section>
        )}

        {!delivery && kind !== "credit_notes" && (text(s.bank) || text(s.mobile_money)) && (
          <section className="ps-pay">
            <div className="ps-label">Règlement</div>
            <Lines>{[text(s.bank) && `Virement : ${text(s.bank)}`, text(s.mobile_money) && `Mobile money : ${text(s.mobile_money)}`]}</Lines>
          </section>
        )}

        {(stampFor(s, kind, delivery) || (kind === "quotes" && !delivery)) && (
          <div className="ps-signs">
            {stampFor(s, kind, delivery) ? (
              <section className="ps-stamp">
                <div className="ps-label">{text(s.name) ? `Pour ${text(s.name)}` : "Cachet et signature"}</div>
                <img src={stampFor(s, kind, delivery)} alt="Cachet et signature" />
              </section>
            ) : <span />}
            {kind === "quotes" && !delivery && (
              <section className="ps-sign">
                <div className="ps-label">Bon pour accord</div>
                <div className="muted">Date, signature et cachet du client</div>
              </section>
            )}
          </div>
        )}

        {termsFor(s, kind, delivery) && (
          <section className="ps-terms">
            <div className="ps-label">Conditions générales</div>
            <p>{termsFor(s, kind, delivery)}</p>
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
