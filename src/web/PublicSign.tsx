/**
 * Page publique de signature : le client ouvre le lien reçu, lit le devis, le télécharge
 * et le signe en ligne, sans compte. Elle ne charge ni la session ni la base locale.
 */
import { useEffect, useState } from "react";
import { SignaturePad } from "./SignaturePad.tsx";
import { computeTotals, docTaxes, lineNet, type InvoiceLine } from "../shared/invoice.ts";
import { decimalsOf, formatMoney } from "../shared/currency.ts";
import { docRefs, docTitle, isDepositLine, isSection } from "../shared/documents.ts";
import { docColor } from "../shared/branding.ts";
import { signatureLine, signatureOf } from "../shared/signature.ts";
import type { PublicDoc } from "../shared/publicDoc.ts";
import { downloadFile, makePdfFile } from "./pdfActions.ts";

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const frDate = (v: unknown) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(v));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : str(v);
};

const LOCK_TEXT: Record<string, string> = {
  expired: "Ce devis a dépassé sa date de validité. Demandez un devis à jour pour le signer.",
  refused: "Ce devis a été refusé. Si c'est une erreur, contactez l'entreprise pour en recevoir un nouveau.",
  closed: "Ce document a déjà été traité. Il ne peut plus être signé en ligne.",
};

export function PublicSign({ api }: { api: string }) {
  const [view, setView] = useState<PublicDoc | null>(null);
  const [state, setState] = useState<"loading" | "gone" | "offline" | "ready">("loading");
  const [name, setName] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [justSigned, setJustSigned] = useState(false);
  const [declining, setDeclining] = useState(false);

  useEffect(() => {
    fetch(api, { headers: { accept: "application/json" } })
      .then(async (r) => {
        if (!r.ok) return setState(r.status === 404 ? "gone" : "offline");
        setView(await r.json());
        setState("ready");
      })
      .catch(() => setState("offline"));
  }, [api]);

  useEffect(() => {
    if (view) document.title = `${docTitle("quotes", view.doc)} ${str(view.doc.number)} · ${str(view.company.name)}`;
  }, [view]);

  if (state !== "ready" || !view) {
    return (
      <main className="pub-page">
        <section className="pub-card pub-state" role="status">
          {state === "loading" && <p>Ouverture du document…</p>}
          {state === "gone" && <><h1>Ce lien n'est plus valable</h1><p>Le document a été retiré ou le lien a changé. Demandez un nouveau lien à l'entreprise qui vous l'a envoyé.</p></>}
          {state === "offline" && <><h1>Le document n'a pas pu être ouvert</h1><p>Vérifiez votre connexion, puis rechargez la page.</p></>}
        </section>
      </main>
    );
  }

  const { doc, client, company } = view;
  const currency = str(doc.currency) || "XAF";
  const decimals = decimalsOf(currency);
  const fm = (n: number) => formatMoney(n, currency);
  const lines = ((doc.lines as InvoiceLine[]) ?? []).filter((l) => !isDepositLine(l));
  const totals = computeTotals(lines, decimals, docTaxes(doc));
  const refs = docRefs(doc);
  const title = `${docTitle("quotes", doc)} ${str(doc.number)}`;
  const sig = signatureOf(doc);
  const accent = docColor(company);

  async function download() {
    setBusy(true);
    try {
      downloadFile(await makePdfFile({ kind: "quotes", doc, client, company }));
    } catch {
      setError("Le PDF n'a pas pu être préparé. Réessayez.");
    } finally {
      setBusy(false);
    }
  }

  async function sign(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return setError("Indiquez votre prénom et votre nom.");
    if (!image) return setError("La signature manque : signez dans le cadre.");
    if (!agree) return setError("Cochez la case pour donner votre accord.");
    setBusy(true);
    setError("");
    try {
      const r = await fetch(api, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.trim(), image }) });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        setError(data?.error ? `${str(data.error).charAt(0).toUpperCase()}${str(data.error).slice(1)}.` : "La signature n'a pas pu être enregistrée. Réessayez.");
        return;
      }
      setView({ ...view!, doc: { ...doc, ...data.doc }, locked: data.locked });
      setJustSigned(true);
      window.scrollTo(0, 0);
    } catch {
      setError("Connexion interrompue : la signature n'est pas partie. Réessayez.");
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(api, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decline: true }) });
      const data = await r.json().catch(() => null);
      if (!r.ok) return setError("Votre réponse n'a pas pu être enregistrée. Réessayez.");
      setView({ ...view!, doc: { ...doc, ...data.doc }, locked: data.locked });
      window.scrollTo(0, 0);
    } catch {
      setError("Connexion interrompue : votre réponse n'est pas partie. Réessayez.");
    } finally {
      setBusy(false);
    }
  }

  const companyName = str(company.name);
  const identity = [str(company.address), str(company.city), str(company.phone), str(company.nif) && `NIF ${str(company.nif)}`].filter(Boolean).join(" · ");
  const phone = str(company.phone).replace(/[^\d+]/g, "");

  return (
    <main className="pub-page" style={{ "--pub-accent": accent } as React.CSSProperties}>
      <header className="pub-head">
        <div className="pub-sender">
          {str(company.logo).startsWith("data:image/") && <img src={str(company.logo)} alt="" />}
          <div><strong>{companyName}</strong>{identity && <span>{identity}</span>}</div>
        </div>
        {!sig && <button onClick={download} disabled={busy}>Télécharger le PDF</button>}
      </header>
      <p className="pub-intro">{title} envoyé par <strong>{companyName}</strong>{str(client.name) ? <> à <strong>{str(client.name)}</strong></> : null}.</p>

      {sig && (
        <section className="pub-card pub-done" role="status" data-testid="pub-signed">
          <h2>{justSigned ? "Merci, votre accord est enregistré" : "Ce document est signé"}</h2>
          <p>{signatureLine(sig, frDate)}.{justSigned ? ` ${companyName} en est informé et vous recontactera pour la suite.` : ""}</p>
          <img src={sig.image} alt={`Signature de ${sig.name}`} />
          <button className="primary" onClick={download} disabled={busy}>Télécharger le devis signé</button>
        </section>
      )}
      {!sig && view.locked && <section className="pub-card pub-warn" role="status"><p>{LOCK_TEXT[view.locked] ?? LOCK_TEXT.closed}</p></section>}

      <section className="pub-card">
        <div className="pub-title">
          <div>
            <h1>{title}</h1>
            <p className="muted">{str(company.name)} · émis le {frDate(doc.date)}{doc.valid_until ? ` · valable jusqu'au ${frDate(doc.valid_until)}` : ""}</p>
          </div>
          <div className="pub-amount"><span>Montant TTC</span><strong className="mono" data-testid="pub-total">{fm(totals.withholding ? totals.payable : totals.gross)}</strong></div>
        </div>
        <dl className="pub-meta">
          <div><dt>Destinataire</dt><dd>{str(client.name) || "—"}</dd></div>
          {refs.subject && <div><dt>Objet</dt><dd>{refs.subject}</dd></div>}
          {refs.clientRef && <div><dt>Votre référence</dt><dd>{refs.clientRef}</dd></div>}
          {refs.paymentTerms && <div><dt>Conditions de règlement</dt><dd>{refs.paymentTerms}</dd></div>}
        </dl>

        <table className="pub-lines">
          <thead><tr><th>Désignation</th><th className="right">Qté</th><th className="right">Prix unitaire HT</th><th className="right">Montant HT</th></tr></thead>
          <tbody>
            {lines.map((l, i) => isSection(l) ? (
              <tr key={i} className="pub-section"><td colSpan={4}>{l.label}</td></tr>
            ) : (
              <tr key={i}>
                <td>{l.label}{l.description ? <span className="pub-desc">{l.description}</span> : null}
                  <span className="pub-mobile mono">{l.qty}{l.unit ? ` ${l.unit}` : ""} × {fm(l.unitPrice)}{l.discount ? ` · remise ${l.discount} %` : ""}</span></td>
                <td className="right mono pub-wide">{l.qty}{l.unit ? ` ${l.unit}` : ""}</td>
                <td className="right mono pub-wide">{fm(l.unitPrice)}{l.discount ? <span className="pub-desc">remise {l.discount} %</span> : null}</td>
                <td className="right mono">{fm(lineNet(l, decimals))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="pub-totals">
          <dt>Total HT</dt><dd className="mono">{fm(totals.net)}</dd>
          <dt>TVA</dt><dd className="mono">{fm(totals.vat)}</dd>
          {totals.css !== 0 && <><dt>CSS</dt><dd className="mono">{fm(totals.css)}</dd></>}
          <dt className="strong">Total TTC</dt><dd className="mono strong">{fm(totals.gross)}</dd>
          {totals.withholding !== 0 && <><dt>Retenue à la source</dt><dd className="mono">-{fm(totals.withholding)}</dd><dt className="strong">Net à payer</dt><dd className="mono strong">{fm(totals.payable)}</dd></>}
        </dl>
        {refs.notes && <p className="pub-notes">{refs.notes}</p>}
      </section>

      {!sig && !view.locked && (
        <form className="pub-card pub-sign" onSubmit={sign} data-testid="pub-sign-form">
          <h2>Signer pour accord</h2>
          <p className="muted">En signant, vous acceptez ce devis de {companyName} pour <strong className="mono">{fm(totals.gross)}</strong> TTC.</p>
          <label className="pub-field"><span>Prénom et nom</span>
            <input value={name} onChange={(e) => { setName(e.target.value); setError(""); }} autoComplete="name" maxLength={120} />
          </label>
          <SignaturePad label="Votre signature" onChange={(img) => { setImage(img); setError(""); }} />
          <label className="sign-agree"><input type="checkbox" checked={agree} onChange={(e) => { setAgree(e.target.checked); setError(""); }} />
            <span>J'ai lu ce document et je l'accepte. Mon nom, la date et l'heure de ma signature sont enregistrés.</span></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary" disabled={busy}>Signer et accepter le devis</button>
          {declining ? (
            <div className="pub-decline" role="group" aria-label="Refuser le devis">
              <p>Refuser ce devis ? {companyName} en sera informé.</p>
              <div><button type="button" onClick={decline} disabled={busy}>Oui, refuser le devis</button><button type="button" className="ghost" onClick={() => setDeclining(false)}>Annuler</button></div>
            </div>
          ) : (
            <p className="pub-alt">Ce devis ne vous convient pas ? <button type="button" className="link" onClick={() => setDeclining(true)}>Refuser le devis</button></p>
          )}
        </form>
      )}

      <footer className="pub-foot">
        <p>Une question sur ce document ? Contactez {companyName}{phone ? <> au <a href={`tel:${phone}`}>{str(company.phone)}</a></> : null}{str(company.email) ? <>{phone ? " ou" : ""} à <a href={`mailto:${str(company.email)}`}>{str(company.email)}</a></> : null}.</p>
        <p className="muted">Document partagé par {companyName} avec Gestia.</p>
      </footer>
    </main>
  );
}
