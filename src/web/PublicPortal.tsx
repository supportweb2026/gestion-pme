/**
 * Espace client en ligne : par le lien de sa fiche, le client retrouve ses devis en
 * attente, ses factures, ce qu'il reste à régler, et télécharge ses documents. Sans compte.
 */
import { useEffect, useState } from "react";
import { formatMoney } from "../shared/currency.ts";
import { docColor } from "../shared/branding.ts";
import type { Portal, PortalInvoice, PortalQuote } from "../shared/portal.ts";
import { downloadFile, makePdfFile } from "./pdfActions.ts";

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const frDate = (v: unknown) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(v));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : str(v);
};

type View = Portal & { company: Record<string, unknown>; client: Record<string, unknown> };

const INVOICE_STATE: Record<PortalInvoice["state"], [string, string]> = {
  paid: ["Payée", "ok"], partial: ["Payée en partie", "warn"], unpaid: ["À régler", "info"], overdue: ["En retard", "danger"],
};
const QUOTE_STATE: Record<PortalQuote["state"], [string, string]> = {
  waiting: ["En attente de votre réponse", "info"], accepted: ["Accepté", "ok"], refused: ["Refusé", ""], invoiced: ["Facturé", "ok"], expired: ["Expiré", ""],
};

export function PublicPortal({ api }: { api: string }) {
  const [view, setView] = useState<View | null>(null);
  const [state, setState] = useState<"loading" | "gone" | "offline" | "ready">("loading");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

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
    if (view) document.title = `Espace client · ${str(view.company.name)}`;
  }, [view]);

  if (state !== "ready" || !view) {
    return (
      <main className="pub-page">
        <section className="pub-card pub-state" role="status">
          {state === "loading" && <p>Ouverture de votre espace…</p>}
          {state === "gone" && <><h1>Ce lien n'est plus valable</h1><p>L'accès a été retiré ou le lien a changé. Demandez un nouveau lien à l'entreprise qui vous l'a envoyé.</p></>}
          {state === "offline" && <><h1>Votre espace n'a pas pu être ouvert</h1><p>Vérifiez votre connexion, puis rechargez la page.</p></>}
        </section>
      </main>
    );
  }

  const { company, client } = view;
  const companyName = str(company.name);
  const identity = [str(company.address), str(company.city), str(company.phone), str(company.nif) && `NIF ${str(company.nif)}`].filter(Boolean).join(" · ");
  const phone = str(company.phone).replace(/[^\d+]/g, "");
  const waiting = view.quotes.filter((q) => q.state === "waiting");
  const otherQuotes = view.quotes.filter((q) => q.state !== "waiting");
  const payInfo = [str(company.bank), str(company.mobile_money)].filter(Boolean);

  async function download(tbl: "quotes" | "invoices", id: string) {
    setBusy(id);
    setError("");
    try {
      const r = await fetch(`${api}/${tbl}/${id}`, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error();
      const d = await r.json();
      downloadFile(await makePdfFile({ kind: tbl, doc: d.doc, client: d.client, company: d.company, situation: d.situation }));
    } catch {
      setError("Le document n'a pas pu être téléchargé. Réessayez.");
    } finally {
      setBusy("");
    }
  }

  return (
    <main className="pub-page" style={{ "--pub-accent": docColor(company) } as React.CSSProperties}>
      <header className="pub-head">
        <div className="pub-sender">
          {str(company.logo).startsWith("data:image/") && <img src={str(company.logo)} alt="" />}
          <div><strong>{companyName}</strong>{identity && <span>{identity}</span>}</div>
        </div>
      </header>
      <div>
        <h1 className="portal-title">Espace client de {str(client.name) || "votre entreprise"}</h1>
        <p className="pub-intro">Vos devis et vos factures chez <strong>{companyName}</strong>, à jour en permanence.</p>
      </div>

      <section className="portal-kpis" aria-label="Votre situation">
        <div className="pub-card" data-testid="portal-due">
          <span>Reste à régler</span>
          {view.due.length === 0 ? <strong className="mono">{formatMoney(0, "XAF")}</strong>
            : view.due.map((d) => <strong key={d.currency} className="mono">{formatMoney(d.amount, d.currency)}</strong>)}
          {view.due.some((d) => d.overdue > 0)
            ? <small className="danger-text">dont {view.due.filter((d) => d.overdue > 0).map((d) => formatMoney(d.overdue, d.currency)).join(" et ")} en retard</small>
            : <small>{view.due.length ? "Aucune facture en retard" : "Vous êtes à jour"}</small>}
        </div>
        <div className="pub-card">
          <span>Devis en attente</span>
          <strong className="mono">{waiting.length}</strong>
          <small>{waiting.length ? "Votre réponse est attendue" : "Aucun devis à valider"}</small>
        </div>
      </section>
      {error && <p className="error" role="alert">{error}</p>}

      {waiting.length > 0 && (
        <section className="pub-card" data-testid="portal-waiting">
          <h2>Devis en attente de votre réponse</h2>
          <ul className="portal-list">
            {waiting.map((q) => (
              <li key={q.id}>
                <div><strong>{q.title} {q.number}</strong><span>du {frDate(q.date)}{q.validUntil ? ` · valable jusqu'au ${frDate(q.validUntil)}` : ""}</span></div>
                <span className="mono portal-amount">{formatMoney(q.total, q.currency)}</span>
                {q.signPath ? <a className="button primary" href={q.signPath}>Lire et signer</a>
                  : <button onClick={() => download("quotes", q.id)} disabled={busy === q.id}>Télécharger</button>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="pub-card" data-testid="portal-invoices">
        <h2>Factures</h2>
        {view.invoices.length === 0 ? <p className="muted">Aucune facture pour l'instant.</p> : (
          <ul className="portal-list">
            {view.invoices.map((i) => (
              <li key={i.id}>
                <div>
                  <strong>{i.title} {i.number}</strong>
                  <span>du {frDate(i.date)}{i.dueDate && i.due > 0 ? ` · à régler avant le ${frDate(i.dueDate)}` : ""}</span>
                  <span className={`badge ${INVOICE_STATE[i.state][1]}`}>{INVOICE_STATE[i.state][0]}</span>
                </div>
                <span className="mono portal-amount">{formatMoney(i.total, i.currency)}{i.due > 0 && i.due < i.total ? <small>reste {formatMoney(i.due, i.currency)}</small> : null}</span>
                <button onClick={() => download("invoices", i.id)} disabled={busy === i.id}>{busy === i.id ? "Préparation…" : "Télécharger"}</button>
              </li>
            ))}
          </ul>
        )}
        {view.due.length > 0 && payInfo.length > 0 && (
          <div className="portal-pay"><strong>Pour régler</strong>{payInfo.map((p) => <p key={p}>{p}</p>)}</div>
        )}
      </section>

      {otherQuotes.length > 0 && (
        <section className="pub-card" data-testid="portal-quotes">
          <h2>Devis et commandes</h2>
          <ul className="portal-list">
            {otherQuotes.map((q) => (
              <li key={q.id}>
                <div>
                  <strong>{q.title} {q.number}</strong>
                  <span>du {frDate(q.date)}{q.signed ? " · signé" : ""}</span>
                  <span className={`badge ${QUOTE_STATE[q.state][1]}`}>{QUOTE_STATE[q.state][0]}</span>
                </div>
                <span className="mono portal-amount">{formatMoney(q.total, q.currency)}</span>
                <button onClick={() => download("quotes", q.id)} disabled={busy === q.id}>{busy === q.id ? "Préparation…" : "Télécharger"}</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="pub-foot">
        <p>Une question ? Contactez {companyName}{phone ? <> au <a href={`tel:${phone}`}>{str(company.phone)}</a></> : null}{str(company.email) ? <>{phone ? " ou" : ""} à <a href={`mailto:${str(company.email)}`}>{str(company.email)}</a></> : null}.</p>
        <p className="muted">Espace partagé par {companyName} avec Gestia. Ce lien vous est personnel : ne le transférez pas.</p>
      </footer>
    </main>
  );
}
