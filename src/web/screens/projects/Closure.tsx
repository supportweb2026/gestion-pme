/**
 * Projets, lot 6 : clôture du projet et bilan (CDC §3.17, F17 ; parcours §5.7).
 *
 *  - « Clôturer le projet » : liste de contrôle (points bloquants, points à justifier), facture
 *    de la retenue ou des travaux réalisés d'un projet arrêté, trois questions du bilan, puis la
 *    décision de clôture, tracée et immuable ; le projet passe Terminé et devient consultable seulement.
 *  - Onglet « Bilan » : prévu contre réel (délai, budget par poste, résultat et marge, heures),
 *    montants selon le rôle, et les leçons retenues.
 *  - « Rouvrir le projet » : réservé à la direction, avec le motif (RG17.2).
 * Rédaction (revue UX) : le fait, puis son effet ; des verbes sur les boutons.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { formatDate, text, today, useApp, useSettings } from "../../context.ts";
import { DEFAULT_PAYMENT_DAYS, DEFAULT_VAT_RATE, formatXaf } from "../../../shared/invoice.ts";
import { fiscalSettings, newDocTaxFields } from "../../../shared/taxes.ts";
import type { SyncRecord } from "../../../shared/sync.ts";
import { LESSON_KEYS, LESSON_MAX, type ProjectContext } from "../../../shared/projectRules.ts";
import {
  closureChecklist, closureDecision, closureSnapshot, prorataInvoice, projectReview, type CheckItem, type ClosureData,
} from "../../../shared/projectClosure.ts";
import { stagesOf } from "../../../shared/projectControl.ts";
import { prepareRetentionInvoice } from "../../projectInvoices.ts";
import { guardedWrite, GuardError } from "../../local/guard.ts";
import { PIcon } from "../ProjectIcons.tsx";

const errorText = (e: unknown, fallback: string) => (e instanceof GuardError || e instanceof Error ? e.message : fallback);
const hoursFr = (h: number) => `${(Math.round(h * 100) / 100).toLocaleString("fr-FR")} h`;
const pctFr = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("fr-FR")} %`);
const signedDays = (n: number | null) => (n === null ? "—" : n === 0 ? "à la date prévue" : n > 0 ? `+${n} jour${n > 1 ? "s" : ""}` : `−${-n} jour${n < -1 ? "s" : ""} (en avance)`);
const bare = (n: number) => formatXaf(n).replace(/\s?FCFA$/, "");
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${bare(Math.abs(n))}`;

export const LESSON_LABELS: Record<(typeof LESSON_KEYS)[number], { label: string; hint: string }> = {
  good: { label: "Ce qui a bien marché", hint: "Ex. : réunion de chantier chaque lundi avec le client" },
  change: { label: "Ce qu'on ferait autrement", hint: "Ex. : commander l'éclairage dès le démarrage" },
  next: { label: "À retenir pour le prochain devis", hint: "Ex. : prévoir 10 % d'heures en plus pour les finitions en site occupé" },
};

type Answers = Partial<Record<(typeof LESSON_KEYS)[number], string>>;
const answersOf = (project: SyncRecord): Answers => {
  const a = project.data.closure_answers;
  return a && typeof a === "object" && !Array.isArray(a) ? (a as Answers) : {};
};

function useDialog(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.classList.add("dialog-open");
    return () => { window.removeEventListener("keydown", onKey); document.body.classList.remove("dialog-open"); };
  }, [onClose]);
}

/** Écriture contrôlée avec le contexte complet du projet (étapes et décisions) : mêmes règles que le serveur. */
function useClosureWrite(project: SyncRecord, ctx: ProjectContext) {
  const { db, session } = useApp();
  const closedUntil = String(useSettings().closed_until ?? "");
  return (tbl: Parameters<typeof guardedWrite>[2], id: string, patch: Record<string, unknown>) =>
    guardedWrite(db, { userId: session.user.id, role: session.user.role }, tbl, id, patch, { ctx, closedUntil, actorName: session.user.name });
}

function CheckLine({ item, action }: { item: CheckItem; action?: ReactNode }) {
  const state = item.ok ? "ok" : item.blocking ? "blocked" : "warn";
  return (
    <li className={`close-check ${state}`} data-testid={`check-${item.key}`}>
      <span className="close-check-ico" aria-hidden="true"><PIcon name={item.ok ? "check" : "alert"} /></span>
      <span className="close-check-text">
        <strong>{item.label}</strong>
        {item.detail ? <span className="muted small">{item.detail}</span> : null}
        <span className="sr-only">{item.ok ? "Réglé" : item.blocking ? "Bloque la clôture" : "À justifier"}</span>
      </span>
      {action ? <span className="close-check-action">{action}</span> : null}
    </li>
  );
}

export function ClosureDialog({ project, data, ctx, weatherLight, onClose, onDone, onStage }: {
  project: SyncRecord; data: ClosureData; ctx: ProjectContext; weatherLight: string | null;
  onClose: () => void; onDone: (message: string) => void; onStage: (stageId: string) => void;
}) {
  const { db, session } = useApp();
  const settings = useSettings();
  const write = useClosureWrite(project, ctx);
  useDialog(onClose);
  const day = today();
  const list = closureChecklist(project, data, day, { amounts: true, defaultVat: DEFAULT_VAT_RATE });
  const review = projectReview(project, data, day, { amounts: true });
  const [answers, setAnswers] = useState<Answers>(answersOf(project));
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paymentDays = Number(settings.payment_days ?? DEFAULT_PAYMENT_DAYS);

  async function billRetention(stageId: string) {
    setError(null);
    const stage = stagesOf(project.id, data.project_stages).find((s) => s.id === stageId);
    if (!stage) return;
    try {
      await prepareRetentionInvoice((t, id, p) => write(t, id, p), session, settings, project, stage, data, day);
      setNote("Brouillon de la facture de la retenue préparé : validez-le dans Factures.");
    } catch (e) {
      setError(errorText(e, "La facture de la retenue n'a pas pu être préparée."));
    }
  }
  async function billProrata() {
    setError(null);
    const inv = prorataInvoice(project, data, day, { paymentDays, user: { id: session.user.id, name: session.user.name }, taxes: newDocTaxFields(fiscalSettings(settings)), defaultVat: DEFAULT_VAT_RATE });
    if (!inv) return setError("Aucune facture à préparer : ce projet n'a pas de client, ou les travaux réalisés sont déjà facturés.");
    try {
      await write("invoices", inv.id, inv.patch);
      setNote(`Brouillon de la facture des travaux réalisés préparé (${formatXaf(inv.amount)} HT) : validez-le dans Factures.`);
    } catch (e) {
      setError(errorText(e, "La facture n'a pas pu être préparée."));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (list.blocked) return setError("Réglez d'abord les points qui bloquent la clôture.");
    if (list.warnings > 0 && !comment.trim()) return setError("Indiquez pourquoi le projet est clôturé malgré les points signalés.");
    setBusy(true);
    try {
      const now = new Date().toISOString();
      const clean: Answers = {};
      for (const k of LESSON_KEYS) if ((answers[k] ?? "").trim()) clean[k] = (answers[k] ?? "").trim();
      await write("project_decisions", db.newId("dec"), {
        project_id: project.id, kind: "project_closed", ...(comment.trim() ? { comment: comment.trim() } : {}),
        checklist: list.items.map((i) => ({ key: i.key, ok: i.ok, blocking: i.blocking })),
        decided_by: session.user.id, decided_by_name: session.user.name, decided_at: now,
        snapshot: closureSnapshot(project, data, day, weatherLight), created_by: session.user.id, created_at: now,
      });
      await write("projects", project.id, { status: "done", closed_at: now, closed_by: session.user.id, closed_by_name: session.user.name, ...(Object.keys(clean).length ? { closure_answers: clean } : {}) });
      onDone(`Projet clôturé. Il passe Terminé et reste consultable : son bilan est dans l'onglet Bilan.`);
    } catch (err) {
      setError(errorText(err, "La clôture n'a pas pu être enregistrée."));
      setBusy(false);
    }
  }

  const blocking = list.items.filter((i) => i.blocking);
  const others = list.items.filter((i) => !i.blocking);
  const actionOf = (i: CheckItem): ReactNode => {
    if (i.key === "stages" && !i.ok && i.stageId) return <button type="button" className="small" onClick={() => onStage(i.stageId!)}>Voir l'étape</button>;
    if (i.key === "retention" && i.stageId) return <button type="button" className="small" onClick={() => billRetention(i.stageId!)}>Préparer la facture</button>;
    if (i.key === "sold" && !i.ok && list.prorata && list.prorata.amount > 0) return <button type="button" className="small" onClick={billProrata}>Préparer la facture</button>;
    return null;
  };
  const a = review.amounts;

  return (
    <>
      <div className="val-backdrop" onClick={onClose} aria-hidden="true" />
      <form className="val-dialog" role="dialog" aria-modal="true" aria-labelledby="close-title" onSubmit={submit} data-testid="closure-dialog">
        <header className="val-head">
          <div>
            <h3 id="close-title">Clôturer le projet</h3>
            <p className="muted small">{text(project.data.name)}{list.stopped ? " · projet arrêté" : ""}</p>
          </div>
          <button type="button" className="ghost icon" onClick={onClose} aria-label="Fermer"><PIcon name="close" /></button>
        </header>
        <div className="val-body">
          <dl className="val-summary">
            <div><dt>Fin prévue</dt><dd>{review.delay.finalEnd ? formatDate(review.delay.finalEnd) : "—"}</dd><dd className="small muted">{review.delay.finalEnd ? signedDays(review.delay.gapFinal) : "pas de date"}</dd></div>
            <div><dt>Heures passées</dt><dd className="mono">{hoursFr(review.hours.spent)}</dd><dd className="small muted">{review.hours.estimated ? `sur ${hoursFr(review.hours.estimated)} estimées` : "aucune estimation"}</dd></div>
            <div><dt>Coût réel</dt><dd className="mono">{a ? bare(a.actual) : "—"}</dd><dd className="small muted">{a && a.budgetRevised > 0 ? `budget ${bare(a.budgetRevised)} (${a.gapPct !== null && a.gapPct > 0 ? "+" : ""}${pctFr(a.gapPct)})` : "pas de budget"}</dd></div>
            <div><dt>Marge réelle</dt><dd className={`mono${a && a.marginReal < 0 ? " danger-text" : ""}`}>{a && a.invoiced > 0 ? bare(a.marginReal) : "—"}</dd><dd className="small muted">{a && a.marginRealPct !== null ? `${pctFr(a.marginRealPct)} du facturé` : "rien de facturé"}</dd></div>
          </dl>

          <section aria-labelledby="close-block">
            <h4 id="close-block" className="close-sub">Avant de clôturer</h4>
            <ul className="close-checks">{blocking.map((i) => <CheckLine key={i.key} item={i} action={actionOf(i)} />)}</ul>
          </section>
          {others.length > 0 && (
            <section aria-labelledby="close-warn">
              <h4 id="close-warn" className="close-sub">À vérifier</h4>
              <ul className="close-checks">{others.map((i) => <CheckLine key={`${i.key}-${i.stageId ?? ""}`} item={i} action={actionOf(i)} />)}</ul>
            </section>
          )}
          {note && <p className="notice success-note" role="status">{note}</p>}
          {list.warnings > 0 && !list.blocked && (
            <label className="val-field">
              <span>Pourquoi clôturer malgré les points à vérifier ?</span>
              <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Ex. : le reste à facturer est abandonné d'un commun accord avec le client" />
            </label>
          )}

          {!list.blocked && (
            <fieldset className="close-lessons">
              <legend>Bilan : trois questions (facultatives)</legend>
              {LESSON_KEYS.map((k) => (
                <label key={k} className="val-field">
                  <span>{LESSON_LABELS[k].label}</span>
                  <textarea rows={2} maxLength={LESSON_MAX} value={answers[k] ?? ""} onChange={(e) => setAnswers((x) => ({ ...x, [k]: e.target.value }))} placeholder={LESSON_LABELS[k].hint} />
                </label>
              ))}
            </fieldset>
          )}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="val-foot">
          <p className="muted small">{list.blocked
            ? "La clôture attend les points marqués ci-dessus."
            : "Une fois clôturé, le projet passe Terminé : plus de temps ni de tâche ; dépenses et factures restent rattachables par la comptabilité."}</p>
          <div className="val-foot-actions">
            <button type="button" className="ghost" onClick={onClose}>Annuler</button>
            <button className="primary" disabled={list.blocked || busy} data-testid="confirm-closure">Clôturer le projet</button>
          </div>
        </footer>
      </form>
    </>
  );
}

/** Réouverture d'un projet clôturé : direction seulement, motif obligatoire (RG17.2). */
export function ReopenDialog({ project, ctx, onClose, onDone }: { project: SyncRecord; ctx: ProjectContext; onClose: () => void; onDone: (m: string) => void }) {
  const { db, session } = useApp();
  const write = useClosureWrite(project, ctx);
  useDialog(onClose);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!comment.trim()) return setError("Indiquez le motif de la réouverture.");
    try {
      const now = new Date().toISOString();
      await write("project_decisions", db.newId("dec"), {
        project_id: project.id, kind: "project_reopened", comment: comment.trim(),
        decided_by: session.user.id, decided_by_name: session.user.name, decided_at: now, created_by: session.user.id, created_at: now,
      });
      await write("projects", project.id, { status: "active" });
      onDone("Projet rouvert : la réouverture est enregistrée dans l'historique du projet.");
    } catch (err) {
      setError(errorText(err, "La réouverture n'a pas pu être enregistrée."));
    }
  }
  return (
    <>
      <div className="val-backdrop" onClick={onClose} aria-hidden="true" />
      <form className="val-dialog narrow" role="dialog" aria-modal="true" aria-labelledby="reopen-title" onSubmit={submit}>
        <header className="val-head">
          <div><h3 id="reopen-title">Rouvrir le projet</h3><p className="muted small">{text(project.data.name)}</p></div>
          <button type="button" className="ghost icon" onClick={onClose} aria-label="Fermer"><PIcon name="close" /></button>
        </header>
        <div className="val-body">
          <label className="val-field"><span>Motif</span><textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Ex. : le client signale un défaut couvert par le devis" /></label>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="val-foot">
          <p className="muted small">Le projet repasse En cours. La clôture et ce motif restent dans l'historique.</p>
          <div className="val-foot-actions"><button type="button" className="ghost" onClick={onClose}>Annuler</button><button className="primary">Rouvrir le projet</button></div>
        </footer>
      </form>
    </>
  );
}

/** Onglet Bilan : prévu contre réel, montants selon le rôle, leçons retenues. */
export function ReviewTab({ project, data, amounts, canEditLessons, ctx }: { project: SyncRecord; data: ClosureData; amounts: boolean; canEditLessons: boolean; ctx: ProjectContext }) {
  const write = useClosureWrite(project, ctx);
  const day = today();
  const r = projectReview(project, data, day, { amounts });
  const saved = answersOf(project);
  const [answers, setAnswers] = useState<Answers>(saved);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closing = closureDecision(project.id, data.project_decisions);
  const a = r.amounts;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const clean: Answers = {};
    for (const k of LESSON_KEYS) clean[k] = (answers[k] ?? "").trim();
    try {
      await write("projects", project.id, { closure_answers: clean });
      setEditing(false);
      setMessage("Bilan enregistré.");
    } catch (err) {
      setError(errorText(err, "Le bilan n'a pas pu être enregistré."));
    }
  }

  return (
    <div className="review-tab" data-testid="review-tab">
      <p className="notice info-note" role="status">
        {r.closed ? <>Projet clôturé le {formatDate(r.closedAt)}{r.closedBy ? ` par ${r.closedBy}` : ""}.</> : <>Bilan provisoire au {formatDate(day)} : le projet n'est pas encore clôturé.</>}
        {r.stopped ? <> Projet arrêté le {formatDate(r.stopped.at)}{r.stopped.comment ? ` : ${r.stopped.comment}` : ""}.</> : null}
        {closing && text(closing.data.comment) ? <> Motif de la clôture : {text(closing.data.comment)}</> : null}
      </p>

      <div className="review-grid">
        <section className="card section-card" aria-labelledby="rv-delay">
          <h3 id="rv-delay">Délai</h3>
          <dl className="review-facts">
            <div><dt>Début</dt><dd>{r.delay.start ? formatDate(r.delay.start) : "—"}</dd></div>
            <div><dt>Fin prévue au départ</dt><dd>{r.delay.initialEnd ? formatDate(r.delay.initialEnd) : "—"}</dd></div>
            {r.delay.revisions > 0 && <div><dt>Fin prévue révisée</dt><dd>{formatDate(r.delay.finalEnd)} <span className="muted small">({r.delay.revisions} révision{r.delay.revisions > 1 ? "s" : ""})</span></dd></div>}
            <div><dt>{r.closed ? "Fin réelle" : "Aujourd'hui"}</dt><dd>{formatDate(r.delay.actualEnd)}</dd></div>
            <div><dt>Écart</dt><dd className={r.delay.gapInitial !== null && r.delay.gapInitial > 0 ? "warn-text strong" : ""} data-testid="review-delay">{r.delay.initialEnd ? signedDays(r.delay.gapInitial) : "pas de fin prévue"}{r.delay.revisions > 0 && r.delay.gapFinal !== null ? <span className="muted small"> · {signedDays(r.delay.gapFinal)} sur la date révisée</span> : null}</dd></div>
          </dl>
        </section>

        <section className="card section-card" aria-labelledby="rv-hours">
          <h3 id="rv-hours">Heures</h3>
          <p className="review-big"><span className="mono">{hoursFr(r.hours.spent)}</span> <span className="muted small">passées{r.hours.estimated ? ` sur ${hoursFr(r.hours.estimated)} estimées` : ""}</span></p>
          <p className="muted small">{r.tasks.done} tâche{r.tasks.done > 1 ? "s" : ""} terminée{r.tasks.done > 1 ? "s" : ""} sur {r.tasks.total}{r.watch.total ? ` · ${r.watch.total} point${r.watch.total > 1 ? "s" : ""} de vigilance, dont ${r.watch.occurred} survenu${r.watch.occurred > 1 ? "s" : ""}` : ""}.</p>
          {r.hours.byPerson.length > 0 && (
            <ul className="review-people">
              {r.hours.byPerson.map((p) => <li key={p.id || p.name}><span>{p.name}</span><span className="mono">{hoursFr(p.spent)}</span></li>)}
            </ul>
          )}
        </section>
      </div>

      {r.hours.byStage.length > 0 && (
        <section className="card section-card" aria-labelledby="rv-stages">
          <h3 id="rv-stages">Heures par étape</h3>
          <div className="table-wrap">
            <table className="review-table">
              <thead><tr><th>Étape</th><th className="right">Estimées</th><th className="right">Passées</th><th className="right">Écart</th></tr></thead>
              <tbody>
                {r.hours.byStage.map((s) => (
                  <tr key={s.id || s.name}><td>{s.name}</td><td className="right mono">{hoursFr(s.estimated)}</td><td className="right mono">{hoursFr(s.spent)}</td>
                    <td className={`right mono${s.estimated > 0 && s.spent > s.estimated * 1.1 ? " warn-text" : ""}`}>{s.estimated > 0 ? `${s.spent >= s.estimated ? "+" : "−"}${hoursFr(Math.abs(s.spent - s.estimated))}` : "—"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {a && (
        <>
          <section className="card section-card" aria-labelledby="rv-budget" data-testid="review-budget">
            <h3 id="rv-budget">Budget par poste</h3>
            {a.budgetInitial === 0 && a.budgetRevised === 0 && a.actual === 0 ? <p className="muted">Aucun budget prévu et aucun coût enregistré sur ce projet.</p> : <>
            <div className="table-wrap">
              <table className="review-table">
                <thead><tr><th>Poste</th><th className="right">Prévu au départ</th>{a.revisions > 0 && <th className="right">Prévu révisé</th>}<th className="right">Réel</th><th className="right">Écart</th></tr></thead>
                <tbody>
                  {a.byPoste.filter((x) => x.initial || x.revised || x.actual).map((x) => (
                    <tr key={x.poste}>
                      <td>{x.label}</td><td className="right mono">{bare(x.initial)}</td>{a.revisions > 0 && <td className="right mono">{bare(x.revised)}</td>}<td className="right mono">{bare(x.actual)}</td>
                      <td className={`right mono${x.gap > 0 ? " danger-text" : x.gap < 0 ? " ok-text" : ""}`}>{signed(x.gap)}{x.gapPct !== null ? <span className="muted small"> ({x.gapPct > 0 ? "+" : ""}{x.gapPct} %)</span> : null}</td>
                    </tr>
                  ))}
                  <tr className="total">
                    <td>Total</td><td className="right mono">{bare(a.budgetInitial)}</td>{a.revisions > 0 && <td className="right mono">{bare(a.budgetRevised)}</td>}<td className="right mono">{bare(a.actual)}</td>
                    <td className={`right mono${a.gap > 0 ? " danger-text" : ""}`}>{signed(a.gap)}{a.gapPct !== null ? <span className="muted small"> ({a.gapPct > 0 ? "+" : ""}{a.gapPct} %)</span> : null}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="muted small">Montants HT en FCFA. L'écart compare le réel au budget {a.revisions > 0 ? "révisé" : "prévu"}.</p></>}
          </section>
          <section className="card section-card" aria-labelledby="rv-result" data-testid="review-result">
            <h3 id="rv-result">Résultat</h3>
            <dl className="review-facts cols">
              <div><dt>Vendu</dt><dd className="mono">{formatXaf(a.sold)}</dd></div>
              <div><dt>Facturé</dt><dd className="mono">{formatXaf(a.invoiced)}</dd></div>
              <div><dt>Encaissé</dt><dd className="mono">{formatXaf(a.collected)}</dd></div>
              <div><dt>Coût réel</dt><dd className="mono">{formatXaf(a.actual)}</dd></div>
              <div><dt>Marge réelle</dt><dd className={`mono strong${a.marginReal < 0 ? " danger-text" : ""}`}>{a.invoiced > 0 ? <>{formatXaf(a.marginReal)}<span className="muted small"> · {pctFr(a.marginRealPct)} du facturé</span></> : <>—<span className="muted small"> · rien de facturé</span></>}</dd></div>
              <div><dt>Marge prévue au départ</dt><dd className="mono">{a.marginPlannedPct !== null ? `${formatXaf(a.marginPlanned)} · ${pctFr(a.marginPlannedPct)}` : "—"}</dd></div>
            </dl>
          </section>
        </>
      )}

      <section className="card section-card" aria-labelledby="rv-lessons" data-testid="review-lessons">
        <div className="card-head">
          <h3 id="rv-lessons">Leçons du projet</h3>
          {canEditLessons && !editing && <button className="small" onClick={() => { setAnswers(answersOf(project)); setEditing(true); setMessage(null); }}><PIcon name="edit" />Modifier le bilan</button>}
        </div>
        {editing ? (
          <form onSubmit={save} className="close-lessons">
            {LESSON_KEYS.map((k) => (
              <label key={k} className="val-field">
                <span>{LESSON_LABELS[k].label}</span>
                <textarea rows={2} maxLength={LESSON_MAX} value={answers[k] ?? ""} onChange={(e) => setAnswers((x) => ({ ...x, [k]: e.target.value }))} placeholder={LESSON_LABELS[k].hint} />
              </label>
            ))}
            {error && <p className="error" role="alert">{error}</p>}
            <div className="pm-note-actions"><button type="button" className="ghost" onClick={() => setEditing(false)}>Annuler</button><button className="primary">Enregistrer le bilan</button></div>
          </form>
        ) : LESSON_KEYS.some((k) => (saved[k] ?? "").trim()) ? (
          <dl className="review-lessons">
            {LESSON_KEYS.filter((k) => (saved[k] ?? "").trim()).map((k) => <div key={k}><dt>{LESSON_LABELS[k].label}</dt><dd>{saved[k]}</dd></div>)}
          </dl>
        ) : (
          <p className="muted small">Aucune leçon notée pour l'instant.{canEditLessons ? " Notez ce qui a bien marché et ce qu'il faut retenir pour le prochain devis." : ""}</p>
        )}
        {message && <p className="success small" role="status">{message}</p>}
      </section>
    </div>
  );
}
