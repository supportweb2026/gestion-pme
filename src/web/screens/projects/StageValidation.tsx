/**
 * Projets, lot 3 : validation d'une étape (maquette D-validation-modale) et suivi de la
 * décision dans l'onglet Étapes. Trois issues : Valider l'étape, Valider avec réserves,
 * Arrêter ou mettre en pause. La décision part dans le journal immuable `project_decisions` ;
 * la validation prépare toujours un brouillon de facture de jalon, calculé sur le montant vendu.
 *
 * Rédaction (revue UX) : dire le fait et son effet, sans renvoyer vers une hiérarchie.
 * L'employé voit qu'une étape est validée, jamais un montant.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { formatDate, text, today, useApp, useSettings } from "../../context.ts";
import { formatMoney } from "../../../shared/currency.ts";
import { daysBetween, pct100, stageTasksDone, type StageInfo } from "../../../shared/projectControl.ts";
import {
  approvalOf, DECISION_LABELS, INVOICE_ERRORS, invoiceOfStage, reserveLines, reservesOf, stageInvoice, type BillingData,
} from "../../../shared/projectDecisions.ts";
import { approvalBlocker, canDecide, canRequestReview, decisionsOfStage, teamMemberIdOf, type ProjectContext } from "../../../shared/projectRules.ts";
import { DEFAULT_PAYMENT_DAYS } from "../../../shared/invoice.ts";
import type { SyncRecord } from "../../../shared/sync.ts";
import type { Rec } from "../../../shared/projects.ts";
import { GuardError, sentence } from "../../local/guard.ts";
import { prepareReceipt, ReceiptViewer } from "../../receipts.tsx";
import {
  prepareRetentionInvoice, prepareStageInvoice, recordDecision, reopenStage, resumeProject, validateOnOpen, type Choice,
} from "../../projectInvoices.ts";
import { hoursFr, useGuardedWrite } from "../team.ts";
import { totalsOf } from "../../ledger.ts";
import { PIcon } from "../ProjectIcons.tsx";
import { formatXaf } from "../../../shared/invoice.ts";
import { tolerances, type Forecast } from "../../../shared/projectBudget.ts";

const dm = (iso: unknown) => (typeof iso === "string" && iso ? formatDate(iso).slice(0, 5) : "");
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const errorText = (e: unknown, fallback: string) => (e instanceof GuardError || e instanceof Error ? e.message : fallback);

export interface StageContext {
  project: SyncRecord;
  stages: StageInfo<SyncRecord>[];
  tasks: SyncRecord[];
  entries: SyncRecord[];
  billing: BillingData;
  ctx: ProjectContext;
  amounts: boolean;
  /** Lot 4 : prévisions de coût (budget, réel, coût final estimé) ; seulement si les montants sont visibles. */
  budget?: Forecast;
}

/** Ce que l'appareil sait des droits de la personne sur une étape. */
export function useStageRights(c: StageContext) {
  const { session } = useApp();
  const actor = { userId: session.user.id, role: session.user.role };
  return {
    decide: canDecide(actor, c.project.id, c.ctx),
    request: (stage: SyncRecord) => canRequestReview(actor, stage, c.ctx),
    reopen: ["admin", "director"].includes(session.user.role),
    actor,
  };
}

/** Bandeau de l'étape choisie : demande, attente de décision, décision prise (et sa facture). */
export function StageDecisionPanel({ c, info, onReview, flash, setFlash }: {
  c: StageContext; info: StageInfo<SyncRecord>; onReview: () => void; flash: Flash | null; setFlash: (f: Flash | null) => void;
}) {
  const { db, session, go } = useApp();
  const settings = useSettings();
  const write = useGuardedWrite();
  const rights = useStageRights(c);
  const [asking, setAsking] = useState(false);
  const [later, setLater] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proof, setProof] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = info.stage;
  const name = text(s.data.name);
  const decisions = decisionsOfStage(s.id, c.billing.project_decisions ?? []);
  const last = decisions.at(-1);
  const approval = approvalOf(s.id, c.billing.project_decisions);
  const reserves = reservesOf(s.id, { ...c.billing, tasks: c.tasks });
  const invoice = invoiceOfStage(s.id, "stage", c.billing);
  const day = today();
  const fm = (n: number, cur: string) => formatMoney(n, cur);
  const preview = useMemo(() => (c.amounts ? stageInvoice(c.project, s, c.billing, { decisionId: "", retentionPct: 0, today: day, paymentDays: 30, user: { id: "", name: "" } }) : null), [c.amounts, c.project, s, c.billing, day]);
  const amount = preview && !("error" in preview) ? fm(preview.M, preview.currency) : "";

  async function run(f: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try { await f(); } catch (e) { setError(errorText(e, "L'action n'a pas pu être enregistrée.")); } finally { setBusy(false); }
  }
  const canAsk = rights.request(s) && ["upcoming", "active"].includes(info.state);
  const allDone = stageTasksDone(info) || (info.deliverables > 0 && info.deliverablesDone === info.deliverables);
  const isStart = s.data.kind === "start";

  let body: ReactNode = null;
  if (info.state === "awaiting") {
    const by = text(s.data.review_requested_by_name);
    const note = text(s.data.review_note).trim();
    const since = daysBetween(text(s.data.review_requested_at).slice(0, 10), day);
    body = (
      <div className="val-banner awaiting" data-testid="stage-awaiting">
        <span className="val-ico"><PIcon name="diamond" /></span>
        <div className="val-text">
          <strong>Validation demandée{by ? ` par ${by}` : ""} le {dm(text(s.data.review_requested_at).slice(0, 10))}{since > 0 ? `, il y a ${plural(since, "jour", "jours")}` : ""}.</strong>
          <span>{note ? `${note}. ` : ""}{rights.decide ? `Examinez l'étape : la décision ${amount ? `prépare la facture de jalon de ${amount} HT` : "est enregistrée dans l'historique du projet"}.` : "L'étape figure dans « À décider » jusqu'à la décision."}</span>
        </div>
        <div className="val-actions">
          {rights.request(s) && <button className="ghost" disabled={busy} onClick={() => run(() => write("project_stages", s.id, { review_requested_at: "", review_note: "" }))}>Annuler la demande</button>}
          {rights.decide && <button className="primary" onClick={onReview}><PIcon name="check" />Examiner la validation</button>}
        </div>
      </div>
    );
  } else if (approval) {
    const r = Number(approval.data.retention_pct) || 0;
    const signatory = text(approval.data.client_signatory);
    const proofId = text(approval.data.proof_file_id);
    body = (
      <div className="val-banner done" data-testid="stage-decided">
        <span className="val-ico"><PIcon name="check" /></span>
        <div className="val-text">
          <strong>{approval.data.kind === "stage_approved_with_reserves" ? "Étape validée avec réserves" : "Étape validée"} le {formatDate(text(approval.data.decided_at).slice(0, 10))}{approval.data.decided_by_name ? ` par ${text(approval.data.decided_by_name)}` : ""}.</strong>
          <span>
            {signatory ? `Accord du client : ${signatory}. ` : ""}
            {proofId ? <button className="link" onClick={() => setProof(proofId)}>Voir la preuve de l'accord</button> : null}
          </span>
          {c.amounts && Number(s.data.billing_pct) > 0 && (
            <span className="val-line" data-testid="stage-invoice">
              {invoice ? (
                <>Facture de jalon : <strong>{text(invoice.data.number) || "brouillon"}</strong>, {fm(netOf(invoice), text(invoice.data.currency) || "XAF")} HT{r > 0 ? `, ${r} % retenus` : ""}.{" "}
                  <button className="link" onClick={() => go("invoices", invoice.id)}>Ouvrir la facture</button></>
              ) : preview && "error" in preview && preview.error !== "already_invoiced" ? (
                <>{INVOICE_ERRORS[preview.error]}</>
              ) : (
                <>Aucune facture de jalon pour cette étape.{" "}
                  {rights.decide && <button className="link" disabled={busy} onClick={() => run(async () => {
                    const id = await prepareStageInvoice(write, session, settings, c.project, s, approval, c.billing, day);
                    setFlash({ text: `Brouillon de facture préparé pour l'étape ${name}.`, invoiceId: id });
                  })}>Préparer la facture</button>}</>
              )}
            </span>
          )}
          {reserves && reserves.decision.id === approval.id && reserves.total > 0 && (
            <span className="val-line" data-testid="stage-reserves">
              Réserves : {reserves.done} sur {reserves.total} close{reserves.done > 1 ? "s" : ""}{reserves.lifted ? ", toutes levées" : ""}.
              {c.amounts && reserves.retained > 0 && (
                reserves.retentionInvoice ? <> Retenue facturée : <button className="link" onClick={() => go("invoices", reserves.retentionInvoice!.id)}>{text(reserves.retentionInvoice.data.number) || "brouillon"}</button>.</>
                  : reserves.lifted ? <> La retenue de {fm(reserves.retained, reserves.currency)} HT est facturable.</>
                  : <> Retenue de {fm(reserves.retained, reserves.currency)} HT, facturable à la levée des réserves.</>
              )}
            </span>
          )}
        </div>
        <div className="val-actions">
          {c.amounts && rights.decide && reserves?.lifted && reserves.retained > 0 && !reserves.retentionInvoice && reserves.decision.id === approval.id && (
            <button className="primary" disabled={busy} onClick={() => run(async () => {
              const id = await prepareRetentionInvoice(write, session, settings, c.project, s, { ...c.billing, tasks: c.tasks }, day);
              setFlash({ text: `Brouillon de facture de la retenue préparé (${fm(reserves.retained, reserves.currency)} HT).`, invoiceId: id });
            })}>Préparer la facture de la retenue</button>
          )}
          {rights.reopen && (
            <button className="ghost" disabled={busy} onClick={() => {
              const why = prompt(`Rouvrir l'étape ${name} ? La décision reste dans l'historique et la facture éventuelle est conservée. Motif :`);
              if (why && why.trim()) void run(() => reopenStage(write, db.newId.bind(db), session, c.project, s, why));
            }}>Rouvrir l'étape</button>
          )}
        </div>
      </div>
    );
  } else if (info.state === "paused" || info.state === "stopped") {
    const paused = info.state === "paused";
    body = (
      <div className={`val-banner ${paused ? "awaiting" : "stopped"}`} data-testid="stage-decided">
        <span className="val-ico"><PIcon name={paused ? "clock" : "stop"} /></span>
        <div className="val-text">
          <strong>{paused ? "Projet en pause" : "Projet arrêté"} depuis le {formatDate(text(last?.data.decided_at).slice(0, 10))}{last?.data.decided_by_name ? ` (${text(last.data.decided_by_name)})` : ""}.</strong>
          <span>Motif : {text(last?.data.comment) || "non précisé"}. Aucune facture n'a été préparée.</span>
        </div>
        {paused && rights.decide && (
          <div className="val-actions">
            <button className="primary" disabled={busy} onClick={() => run(() => resumeProject(write, db.newId.bind(db), session, c.project, s, ""))}>Reprendre le projet</button>
          </div>
        )}
      </div>
    );
  } else if (canAsk || (rights.decide && ["upcoming", "active"].includes(info.state))) {
    const ready = allDone || (isStart && info.tasks === 0);
    if (asking) {
      body = <RequestForm stage={s} amount={amount} onCancel={() => setAsking(false)} onDone={() => { setAsking(false); setFlash({ text: `Validation de l'étape ${name} demandée : elle figure dans « À décider ».` }); }} />;
    } else if (ready && !later) {
      body = (
        <div className="val-banner ready" data-testid="stage-ready">
          <span className="val-ico"><PIcon name="diamond" /></span>
          <div className="val-text">
            <strong>{isStart && info.tasks === 0 ? `L'étape ${name} se valide dès la signature du devis.` : info.deliverables > 0 && info.deliverablesDone === info.deliverables ? `Tous les livrables de ${name} sont remis.` : `Toutes les tâches de ${name} sont terminées.`}</strong>
            <span>{rights.decide
              ? `Validez l'étape avec l'accord du client${amount ? ` : la facture de jalon de ${amount} HT sera préparée` : ""}.`
              : `Demandez la validation : l'étape apparaîtra dans « À décider »${amount ? `, et la facture de jalon de ${amount} HT sera préparée à la validation` : ""}.`}</span>
          </div>
          <div className="val-actions">
            <button className="ghost" onClick={() => setLater(true)}>Plus tard</button>
            {rights.decide ? <button className="primary" onClick={onReview}>Valider l'étape</button>
              : <button className="primary" onClick={() => setAsking(true)}>Demander la validation</button>}
          </div>
        </div>
      );
    } else {
      body = (
        <div className="val-quiet">
          {canAsk && <button onClick={() => setAsking(true)}><PIcon name="diamond" />Demander la validation</button>}
          {rights.decide && <button onClick={onReview}><PIcon name="check" />Valider l'étape</button>}
        </div>
      );
    }
  }

  return (
    <>
      {flash && (
        <div className="val-flash" role="status" data-testid="decision-flash">
          <span>{flash.text}</span>
          {flash.invoiceId && <button className="link" onClick={() => go("invoices", flash.invoiceId)}>Ouvrir la facture</button>}
          <button className="ghost small icon" aria-label="Fermer" onClick={() => setFlash(null)}><PIcon name="close" /></button>
        </div>
      )}
      {body}
      {error && <p className="error" role="alert">{error}</p>}
      {decisions.length > 0 && <DecisionLog decisions={decisions} amounts={c.amounts} onProof={setProof} />}
      {proof && <ReceiptViewer id={proof} onClose={() => setProof(null)} title="Preuve de l'accord du client" alt="Preuve de l'accord du client" />}
    </>
  );
}

export interface Flash { text: string; invoiceId?: string }

const netOf = (inv: Rec) => totalsOf(inv as SyncRecord).net;

/** « Demander la validation » : une note facultative (ex. visite avec le client mercredi). */
function RequestForm({ stage, amount, onCancel, onDone }: { stage: SyncRecord; amount: string; onCancel: () => void; onDone: () => void }) {
  const { session } = useApp();
  const write = useGuardedWrite();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await write("project_stages", stage.id, {
        review_requested_at: new Date().toISOString(), review_requested_by: teamMemberIdOf(session.user.id), review_requested_by_name: session.user.name, review_note: note.trim(),
      });
      onDone();
    } catch (err) {
      setError(errorText(err, "La demande n'a pas pu être enregistrée."));
    }
  }
  return (
    <form className="val-banner ready request-form" onSubmit={submit}>
      <span className="val-ico"><PIcon name="diamond" /></span>
      <div className="val-text">
        <strong>Demander la validation de l'étape {text(stage.data.name)}</strong>
        <span>L'étape passe « À valider » et figure dans « À décider »{amount ? `. La facture de jalon de ${amount} HT sera préparée à la validation` : ""}.</span>
        <label className="val-note">Note pour la validation (facultatif)
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex. : visite avec le client mercredi 24/11 à 10 h" maxLength={140} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <div className="val-actions">
        <button type="button" className="ghost" onClick={onCancel}>Annuler</button>
        <button className="primary">Demander la validation</button>
      </div>
    </form>
  );
}

/** Historique des décisions de l'étape (journal immuable). */
function DecisionLog({ decisions, amounts, onProof }: { decisions: Rec[]; amounts: boolean; onProof: (id: string) => void }) {
  return (
    <div className="card section-card decision-log" data-testid="decision-log">
      <div className="card-head"><h3>Historique des décisions</h3><span className="muted small">{plural(decisions.length, "décision", "décisions")}</span></div>
      <ol>
        {[...decisions].reverse().map((d) => {
          const reserves = reserveLines(text(d.data.reserves));
          const r = Number(d.data.retention_pct) || 0;
          return (
            <li key={d.id}>
              <span className={`dot ${String(d.data.kind).startsWith("stage_approved") ? "ok" : d.data.kind === "project_stopped" ? "danger" : "warn"}`} aria-hidden="true" />
              <div>
                <strong>{DECISION_LABELS[text(d.data.kind)] ?? text(d.data.kind)}</strong>
                <span className="muted small"> · {formatDate(text(d.data.decided_at).slice(0, 10))}{d.data.decided_by_name ? ` · ${text(d.data.decided_by_name)}` : ""}</span>
                {d.data.client_signatory ? <p className="small">Accord du client : {text(d.data.client_signatory)}{d.data.proof_file_id ? <> · <button className="link" onClick={() => onProof(text(d.data.proof_file_id))}>preuve</button></> : null}</p> : d.data.proof_file_id ? <p className="small"><button className="link" onClick={() => onProof(text(d.data.proof_file_id))}>Preuve de l'accord</button></p> : null}
                {d.data.comment ? <p className="small">Motif : {text(d.data.comment)}</p> : null}
                {reserves.length > 0 && <p className="small">{plural(reserves.length, "réserve", "réserves")} : {reserves.join(" ; ")}{amounts && r > 0 ? ` · retenue de ${r} %` : ""}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Écran de validation (téléphone et ordinateur) : un résumé, trois issues, l'accord du client
 * et sa preuve, la facture de jalon qui sera préparée.
 */
export function ValidationDialog({ c, info, onClose, onDone, initialChoice = "approve" }: { c: StageContext; info: StageInfo<SyncRecord>; onClose: () => void; onDone: (f: Flash) => void; initialChoice?: Choice }) {
  const { db, session, go } = useApp();
  const settings = useSettings();
  const write = useGuardedWrite();
  const s = info.stage;
  const name = text(s.data.name);
  const day = today();
  const idx = c.stages.findIndex((x) => x.stage.id === s.id);
  const next = c.stages.slice(idx + 1).find((x) => x.state !== "stopped");
  const [choice, setChoice] = useState<Choice>(initialChoice === "stop" ? "pause" : initialChoice);
  const [reserves, setReserves] = useState("");
  const [retain, setRetain] = useState(false);
  const [retention, setRetention] = useState(String(Number(c.billing.project_finance?.find((f) => f.id === `fin-${c.project.id}`)?.data.retention_default_pct) || 5));
  const [stopKind, setStopKind] = useState<"pause" | "stop">(initialChoice === "stop" ? "stop" : "pause");
  const [comment, setComment] = useState("");
  const [signatory, setSignatory] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [validateNow, setValidateNow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    document.body.classList.add("dialog-open");
    return () => { window.removeEventListener("keydown", onKey); document.body.classList.remove("dialog-open"); };
  }, [onClose, busy]);

  const approving = choice === "approve" || choice === "reserves";
  const blocker = approvalBlocker(s.id, c.stages.map((i) => i.stage), c.billing.project_decisions ?? []);
  const r = choice === "reserves" && retain ? Math.max(0, Math.min(100, Number(retention.replace(",", ".")) || 0)) : 0;
  const plan = c.amounts ? stageInvoice(c.project, s, c.billing, { decisionId: "", retentionPct: r, today: day, paymentDays: Number(settings.payment_days ?? DEFAULT_PAYMENT_DAYS), user: { id: "", name: "" } }) : null;
  const fm = (n: number) => formatMoney(n, plan && !("error" in plan) ? plan.currency : "XAF");
  const fmBare = (n: number) => fm(n).replace(/\s?FCFA$/, "");

  const own = c.tasks.filter((t) => t.data.stage_id === s.id);
  const openTasks = own.filter((t) => t.data.status !== "done");
  const hours = c.entries.filter((e) => own.some((t) => t.id === e.data.task_id)).reduce((n, e) => n + (Number(e.data.hours) || 0), 0);
  const end = text(s.data.end_date);
  const late = end && end < day ? daysBetween(end, day) : 0;
  const asked = text(s.data.review_requested_at).slice(0, 10);
  const target = next ? text(next.stage.data.name) : "Levée des réserves";
  const reserveCount = reserveLines(reserves).length;
  const primary = choice === "approve" ? "Valider l'étape" : choice === "reserves" ? "Valider avec réserves" : stopKind === "pause" ? "Mettre le projet en pause" : "Arrêter le projet";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (approving && blocker) return setError(sentence(blocker));
    if (choice === "reserves" && reserveCount === 0) return setError("Indiquez au moins une réserve, une par ligne.");
    const decisionChoice: Choice = approving ? choice : stopKind;
    if (!approving && !comment.trim()) return setError(stopKind === "pause" ? "Indiquez le motif de la pause." : "Indiquez le motif de l'arrêt.");
    if (!approving && stopKind === "stop" && !confirm(`Arrêter le projet ${text(c.project.data.name)} ? Il passe « Annulé » et aucune facture n'est préparée.`)) return;
    setBusy(true);
    try {
      let proofFileId = "";
      if (approving && file) {
        const blob = await prepareReceipt(file);
        proofFileId = db.newId("pv");
        await db.putFile(proofFileId, blob, false);
      }
      const res = await recordDecision(write, db.newId.bind(db), session, settings, c.project, s, { ...c.billing, tasks: c.tasks }, {
        choice: decisionChoice, reserves, retentionPct: r, comment, signatory, proofFileId,
        snapshot: { progress: pct100(info.progress), sold: plan && !("error" in plan) ? plan.V : undefined },
      }, day);
      const parts: string[] = [];
      if (decisionChoice === "approve") parts.push(`Étape ${name} validée.`);
      else if (decisionChoice === "reserves") parts.push(`Étape ${name} validée avec réserves : ${plural(res.reserveTasks, "tâche de réserve ajoutée", "tâches de réserve ajoutées")} à l'étape ${res.reserveStage}.`);
      else parts.push(decisionChoice === "pause" ? `Projet mis en pause. Aucune facture n'est préparée.` : `Projet arrêté. Aucune facture n'est préparée.`);
      if (res.invoiceId && plan && !("error" in plan)) parts.push(`Brouillon de facture de jalon préparé : ${fm(plan.net)} HT.`);
      if (res.invoiceNote) parts.push(res.invoiceNote);
      onDone({ text: parts.join(" "), invoiceId: res.invoiceId ?? undefined });
      if (res.invoiceId && validateNow) {
        validateOnOpen(res.invoiceId);
        go("invoices", res.invoiceId);
      }
    } catch (err) {
      setError(errorText(err, "La décision n'a pas pu être enregistrée."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="val-backdrop" onClick={() => !busy && onClose()} aria-hidden="true" />
      <form className="val-dialog" role="dialog" aria-modal="true" aria-labelledby="val-title" onSubmit={submit}>
        <header className="val-head">
          <div>
            <h3 id="val-title">{initialChoice === "pause" || initialChoice === "stop" ? "Mettre en pause ou arrêter le projet" : `Valider l'étape ${name}`}</h3>
            <p className="muted small">
              {text(c.project.data.name)}
              {asked ? ` · demandée${s.data.review_requested_by_name ? ` par ${text(s.data.review_requested_by_name)}` : ""} le ${dm(asked)}` : ""}
              {text(s.data.review_note).trim() ? ` · ${text(s.data.review_note).trim()}` : ""}
            </p>
          </div>
          <button type="button" className="ghost icon" onClick={onClose} aria-label="Fermer"><PIcon name="close" /></button>
        </header>

        <div className="val-body">
          <dl className="val-summary" aria-label="Résumé de l'étape">
            <div>
              <dt>À remettre au client</dt>
              <dd className={info.deliverables && info.deliverablesDone === info.deliverables ? "ok-text" : ""}>{info.deliverables ? `${info.deliverablesDone} sur ${info.deliverables}` : "Aucun livrable"}</dd>
              <dd className="muted small">{info.deliverables ? (info.deliverablesDone === info.deliverables ? "tous remis" : `${info.deliverables - info.deliverablesDone} à remettre`) : "pas de tâche à remettre"}</dd>
            </div>
            <div>
              <dt>Tâches de l'étape</dt>
              <dd className={openTasks.length ? "warn-text" : "ok-text"}>{own.length ? `${own.length - openTasks.length} sur ${own.length}` : "Aucune tâche"}</dd>
              <dd className="muted small">{openTasks.length ? `${plural(openTasks.length, "encore ouverte", "encore ouvertes")}` : own.length ? "toutes terminées" : "étape sans tâche"}</dd>
            </div>
            <div>
              <dt>Temps passé</dt>
              <dd>{hoursFr(hours)}</dd>
              <dd className="muted small">avancement {pct100(info.progress)} %</dd>
            </div>
            <div>
              <dt>Délai</dt>
              <dd className={late ? "danger-text" : "ok-text"}>{!end ? "Non daté" : late ? `En retard de ${late} j` : "À l'heure"}</dd>
              <dd className="muted small">{end ? `fin prévue le ${dm(end)}` : "aucune fin prévue"}</dd>
            </div>
          </dl>
          {c.amounts && c.budget && (() => {
            const sf = c.budget.stages.find((x) => x.stageId === s.id);
            if (!sf) return null;
            const over = sf.deltaPct !== null && sf.deltaPct > 0;
            const tol = tolerances(c.project).budgetPct;
            return (
              <dl className="val-cost" aria-label="Coût de l'étape" data-testid="val-cost">
                <div><dt>Budget de l'étape</dt><dd className="mono">{sf.BP > 0 ? formatXaf(sf.BP) : "—"}</dd>{sf.BP > 0 ? null : <dd className="muted small">pas de budget par étape</dd>}</div>
                <div><dt>Coût réel</dt><dd className="mono">{formatXaf(sf.CR + sf.committed)}</dd>{sf.committed > 0 ? <dd className="muted small">dont {formatXaf(sf.committed)} en attente</dd> : <dd className="muted small">temps et dépenses</dd>}</div>
                <div><dt>Écart</dt><dd className={`mono${over && (sf.deltaPct ?? 0) > tol ? " danger-text" : over ? " warn-text" : sf.deltaPct !== null ? " ok-text" : ""}`}>{sf.deltaPct === null ? "—" : `${sf.deltaPct > 0 ? "+" : ""}${sf.deltaPct} %`}</dd><dd className="muted small">{sf.BP > 0 ? `coût final estimé ${formatXaf(sf.CFE)}` : `projet : ${formatXaf(c.budget.CR)} sur ${c.budget.BP ? formatXaf(c.budget.BP) : "budget non défini"}`}</dd></div>
              </dl>
            );
          })()}
          {openTasks.length > 0 && (
            <p className="small val-open"><strong>Encore ouvert : </strong>{openTasks.slice(0, 5).map((t) => `« ${text(t.data.title)} »`).join(", ")}{openTasks.length > 5 ? ` et ${openTasks.length - 5} autres` : ""}.</p>
          )}

          <fieldset className="val-choices">
            <legend>Votre décision</legend>
            <label className={`val-choice${choice === "approve" ? " on" : ""}`}>
              <input type="radio" name="choice" checked={choice === "approve"} onChange={() => setChoice("approve")} />
              <strong>Valider l'étape</strong>
              <span>{next ? `${text(next.stage.data.name)} démarre` : "Dernière étape"}{c.amounts && plan && !("error" in plan) ? ", la facture de jalon est préparée." : "."}</span>
            </label>
            <label className={`val-choice${choice === "reserves" ? " on" : ""}`}>
              <input type="radio" name="choice" checked={choice === "reserves"} onChange={() => setChoice("reserves")} />
              <strong>Valider avec réserves</strong>
              <span>Chaque réserve devient une tâche de {next ? text(next.stage.data.name) : "l'étape « Levée des réserves »"}.</span>
            </label>
            <label className={`val-choice stop${choice === "pause" ? " on" : ""}`}>
              <input type="radio" name="choice" checked={choice === "pause"} onChange={() => setChoice("pause")} />
              <strong>Arrêter ou mettre en pause</strong>
              <span>Aucune facture. Motif demandé.</span>
            </label>
          </fieldset>

          {approving && blocker && <p className="notice" role="alert">{sentence(blocker)}</p>}

          {choice === "reserves" && (
            <label className="val-field">
              <span>Réserves <span className="muted">(une par ligne, chacune devient une tâche de {target})</span></span>
              <textarea rows={3} value={reserves} onChange={(e) => setReserves(e.target.value)} placeholder={"Ex. : Joint de carrelage fissuré, bureau 2\nPrise électrique non fixée, bureau 5"} aria-label="Réserves" />
            </label>
          )}

          {!approving && (
            <>
              <div className="val-stop" role="radiogroup" aria-label="Arrêter ou mettre en pause">
                <label className="check-line"><input type="radio" name="stop" checked={stopKind === "pause"} onChange={() => setStopKind("pause")} /> Mettre le projet en pause <span className="muted small">(il reprend plus tard)</span></label>
                <label className="check-line"><input type="radio" name="stop" checked={stopKind === "stop"} onChange={() => setStopKind("stop")} /> Arrêter le projet <span className="muted small">(il passe « Annulé »)</span></label>
              </div>
              <label className="val-field">
                <span>Motif</span>
                <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Ex. : le client suspend le chantier jusqu'au déblocage du financement" aria-label="Motif" />
              </label>
            </>
          )}

          {approving && (
            <div className="val-pair">
              <label className="val-field">
                <span>Accord du client donné par</span>
                <input value={signatory} onChange={(e) => setSignatory(e.target.value)} placeholder="Ex. : Nadège Ondo, services généraux" />
              </label>
              <div className="val-field">
                <span id="proof-label">Preuve de l'accord</span>
                <input ref={fileInput} type="file" accept="image/*,application/pdf" className="sr-only" aria-labelledby="proof-label" data-testid="proof-input"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                {file ? (
                  <div className="val-file">
                    <PIcon name={file.type === "application/pdf" ? "doc" : "image"} />
                    <span><strong>{file.name}</strong><span className="muted small">{file.type === "application/pdf" ? "PDF" : "photo"} jointe le {dm(day)}</span></span>
                    <button type="button" className="ghost small" onClick={() => fileInput.current?.click()}>Changer</button>
                  </div>
                ) : (
                  <button type="button" className="val-file empty" onClick={() => fileInput.current?.click()}>
                    <PIcon name="image" /><span>Joindre une photo ou un PDF<span className="muted small">PV signé, bon de réception, courriel ou message</span></span>
                  </button>
                )}
              </div>
            </div>
          )}

          {approving && c.amounts && plan && (
            "error" in plan ? (
              plan.error === "no_share" || plan.error === "time_billing" ? null : <p className="muted small val-noinv">{INVOICE_ERRORS[plan.error]}</p>
            ) : (
              <div className="val-invoice" data-testid="val-invoice">
                <div className="val-invoice-head">
                  <div>
                    <strong>Facture de jalon {name}</strong>
                    <span className="muted small">{plan.pct.toLocaleString("fr-FR")} % {plan.quoteNumber ? `du devis ${plan.quoteNumber}` : "du montant vendu"} ({fm(plan.V)} vendus){plan.last ? ", dernière étape : le reste du montant vendu" : ""}. Calculée sur le montant vendu, pas sur le budget.</span>
                  </div>
                  <div className="val-invoice-amount">
                    <strong className="mono" data-testid="val-invoice-net">{fm(plan.net)}</strong>
                    <span className="muted small">HT{plan.retained > 0 ? ` · ${fmBare(plan.M)} − ${fmBare(plan.retained)} retenus` : ""}</span>
                  </div>
                </div>
                <div className="val-invoice-opts">
                  {choice === "reserves" && (
                    <label className="check-line">
                      <input type="checkbox" checked={retain} onChange={(e) => setRetain(e.target.checked)} />
                      <span><span className="val-retain">Retenir <input className="pct-input" type="number" min="0" max="100" step="1" value={retention} aria-label="Pourcentage retenu" onChange={(e) => { setRetention(e.target.value); setRetain(true); }} /> %</span><span className="muted small">Facturé à la levée des réserves, sur une facture à part.</span></span>
                    </label>
                  )}
                  <label className="check-line">
                    <input type="checkbox" checked={validateNow} onChange={(e) => setValidateNow(e.target.checked)} />
                    <span>Valider la facture tout de suite<span className="muted small">Sinon, le brouillon attend dans Factures. Une facture validée reçoit son numéro et ne se corrige plus que par un avoir.</span></span>
                  </label>
                </div>
              </div>
            )
          )}
          {error && <p className="error" role="alert">{error}</p>}
        </div>

        <footer className="val-foot">
          <p className="muted small">Décision enregistrée à votre nom avec la date. Elle ne pourra plus être modifiée : pour revenir dessus, rouvrez l'étape.</p>
          <div className="val-foot-actions">
            <button type="button" className="ghost" onClick={onClose} disabled={busy}>Annuler</button>
            <button className={`primary${!approving && stopKind === "stop" ? " danger" : ""}`} disabled={busy || (approving && !!blocker)}>{busy ? "Enregistrement…" : primary}</button>
          </div>
        </footer>
      </form>
    </>
  );
}
