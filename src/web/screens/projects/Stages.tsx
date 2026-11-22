/**
 * Étapes d'un projet (maquette D ; validation et facture de jalon : StageValidation.tsx, lot 3) et frise
 * des étapes, visible sur tous les onglets de la fiche (maquette C).
 * Statuts calculés (À venir, En cours, À valider…), jamais stockés.
 * L'employé voit les étapes, leurs dates et leur avancement, sans part ni montant.
 */
import { useEffect, useState, type FormEvent } from "react";
import { formatDate, text, today, useApp } from "../../context.ts";
import { formatMoney } from "../../../shared/currency.ts";
import { formatXaf } from "../../../shared/invoice.ts";
import {
  assigneeOf, BLOCK_LABELS, billingShareTotal, daysBetween, pct100, STAGE_STATE_LABELS, STAGE_STATE_TONES, stageAmounts, stageTasksDone, type StageInfo,
} from "../../../shared/projectControl.ts";
import type { SyncRecord } from "../../../shared/sync.ts";
import { hoursFr, useGuardedWrite, useTeam } from "../team.ts";
import { Initials, PIcon } from "../ProjectIcons.tsx";
import { StageDecisionPanel, ValidationDialog, type Flash, type StageContext } from "./StageValidation.tsx";
import { invoiceOfStage, type BillingData } from "../../../shared/projectDecisions.ts";
import type { ProjectContext } from "../../../shared/projectRules.ts";
import { tolerances, type Forecast } from "../../../shared/projectBudget.ts";
import type { Choice } from "../../projectInvoices.ts";

const dm = (iso: unknown) => (typeof iso === "string" && iso ? formatDate(iso).slice(0, 5) : "");
const range = (s: SyncRecord) => {
  const a = dm(s.data.start_date);
  const b = dm(s.data.end_date);
  return a && b ? (a === b ? a : `${a} → ${b}`) : a ? `dès le ${a}` : b ? `fin ${b}` : "Dates à définir";
};
const pctLabel = (n: unknown) => `${Number(n || 0).toLocaleString("fr-FR")} %`;
const stageRole = (s: SyncRecord) => (s.data.kind === "start" ? "Démarrage" : "Jalon");

/** Ce qu'affiche la frise à droite du nom de l'étape. */
function stateLine(i: StageInfo<SyncRecord>, day: string): { text: string; tone: string } {
  const s = i.stage;
  if (i.state === "approved" || i.state === "approved_reserves") return { text: `✓ ${STAGE_STATE_LABELS[i.state]}`, tone: "ok" };
  if (i.state === "awaiting") return { text: "À valider", tone: "warn" };
  if (i.state === "stopped") return { text: "Arrêtée", tone: "danger" };
  if (i.state === "paused") return { text: "En pause", tone: "warn" };
  if (stageTasksDone(i)) return { text: "✓ Tâches terminées", tone: "ok" };
  const end = text(s.data.end_date);
  if (end && end < day) return { text: `En retard de ${daysBetween(end, day)} j`, tone: "danger" };
  if (i.state === "active") {
    if (i.deliverables > 0 && i.deliverablesDone === i.deliverables) return { text: "✓ Livrables remis", tone: "ok" };
    return { text: "En cours", tone: "info" };
  }
  const start = text(s.data.start_date);
  return { text: start && start > day ? `Démarre le ${dm(start)}` : "À venir", tone: "" };
}

/** Frise des étapes, sous l'en-tête de la fiche. */
export function StageStrip({ stages, showPct, onPick }: { stages: StageInfo<SyncRecord>[]; showPct: boolean; onPick?: (id: string) => void }) {
  const day = today();
  if (stages.length === 0) return null;
  return (
    <div className="card stage-strip" role="list" aria-label="Frise des étapes" style={{ ["--n" as string]: stages.length }}>
      {stages.map((i) => {
        const line = stateLine(i, day);
        const done = i.state === "approved" || i.state === "approved_reserves";
        return (
          <button key={i.stage.id} role="listitem" className={`strip-stage ${i.state}`} onClick={() => onPick?.(i.stage.id)}
            aria-label={`${text(i.stage.data.name)} : ${STAGE_STATE_LABELS[i.state]}, ${pct100(i.progress)} %`}>
            <span className="strip-top">
              <strong>{text(i.stage.data.name)}</strong>
              <span className={`strip-state ${line.tone}`}>{line.text}</span>
            </span>
            <span className="strip-bar">
              <span className="strip-track"><span style={{ width: `${pct100(i.progress)}%` }} /></span>
              <span className={`strip-diamond${done ? " done" : i.state === "awaiting" ? " awaiting" : i.state === "active" ? " active" : ""}`} aria-hidden="true" />
            </span>
            <span className="strip-foot muted small">
              {range(i.stage)}{showPct && Number(i.stage.data.billing_pct) > 0 ? ` · ${pctLabel(i.stage.data.billing_pct)}` : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Onglet Étapes : cartes, livrables de l'étape choisie, réglages de l'étape. */
export function StagesTab({ project, stages, tasks, entries, sold, amounts, canEdit, selected, onSelect, managerId, billing, ctx, review, onReviewDone, budget, reviewChoice, readOnly = false, onWatch }: {
  project: SyncRecord; stages: StageInfo<SyncRecord>[]; tasks: SyncRecord[]; entries: SyncRecord[];
  sold: { V: number; currency: string; source: string }; amounts: boolean; canEdit: boolean;
  selected: string | null; onSelect: (id: string | null) => void; managerId: string;
  billing: BillingData; ctx: ProjectContext; review?: string | null; onReviewDone?: () => void;
  /** Lot 4 : prévisions de coût (montants visibles seulement). */
  budget?: Forecast;
  /** Ouverture depuis la carte de décision : « pause » pré-choisit Arrêter ou mettre en pause. */
  reviewChoice?: Choice;
  /** Lot 6 : projet clôturé, consultation seule (ni validation, ni modification). */
  readOnly?: boolean;
  /** Lot 6 : « Ajouter un point de vigilance », tant que le projet n'en a aucun (RG14.3). */
  onWatch?: () => void;
}) {
  const { db, session } = useApp();
  const write = useGuardedWrite();
  const team = useTeam();
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(review ?? null);
  // Ouverture demandée alors que l'onglet est déjà affiché (pause depuis la carte de décision).
  useEffect(() => { if (review) setDeciding(review); }, [review]);
  const [flash, setFlash] = useState<Flash | null>(null);
  const c: StageContext = { project, stages, tasks, entries, billing, ctx, amounts, ...(amounts && budget ? { budget } : {}) };
  const day = today();
  const records = stages.map((i) => i.stage);
  const share = billingShareTotal(records);
  const anyPct = records.some((s) => Number(s.data.billing_pct) > 0);
  const amountsBy = stageAmounts(sold.V, records);
  const fm = (n: number) => (sold.currency === "XAF" ? formatXaf(n) : formatMoney(n, sold.currency));
  const current = stages.find((i) => i.stage.id === (deciding ?? selected))
    ?? stages.find((i) => i.state === "awaiting" || i.state === "active" || i.state === "paused")
    ?? stages.find((i) => i.state === "upcoming")
    ?? stages[0];

  async function addStage() {
    setError(null);
    const id = db.newId("stg");
    const rank = Math.max(0, ...records.map((s) => Number(s.data.rank) || 0)) + 1;
    const owner = team.find((m) => m.id === managerId);
    try {
      await write("project_stages", id, {
        project_id: project.id, name: `Étape ${stages.length + 1}`, rank, kind: "normal", billing_pct: 0,
        owner_id: owner?.id ?? "", owner_name: owner ? text(owner.data.name) : "", created_by: session.user.id, created_at: new Date().toISOString(),
      });
      onSelect(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ajout impossible.");
    }
  }

  if (stages.length === 0) {
    return (
      <div className="card empty-invite">
        <PIcon name="diamond" />
        <div>
          <strong>Découper ce projet en étapes</strong>
          <p className="muted small">Chaque étape a un responsable, des dates et ses livrables. L'avancement du projet devient pondéré par étape.</p>
        </div>
        {canEdit && <button className="primary" onClick={addStage}>Ajouter une étape</button>}
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  const own = current ? tasks.filter((t) => t.data.stage_id === current.stage.id) : [];
  const deliverables = own.filter((t) => t.data.deliverable);
  const open = own.filter((t) => !t.data.deliverable && t.data.status !== "done");
  const taskIds = new Set(own.map((t) => t.id));
  const hours = entries.filter((e) => taskIds.has(String(e.data.task_id))).reduce((n, e) => n + (Number(e.data.hours) || 0), 0);
  const estimated = own.reduce((n, t) => n + (Number(t.data.estimate_hours) || 0), 0);

  return (
    <div className="stages-tab">
      <div className="stages-head">
        <h3>{stages.length} étape{stages.length > 1 ? "s" : ""}{amounts && anyPct ? `, ${pctLabel(share)} du montant vendu` : ""}</h3>
        <span className="stages-head-actions">
          {onWatch && <button className="ghost" onClick={onWatch} data-testid="add-watch-from-stages"><PIcon name="alert" />Ajouter un point de vigilance</button>}
          {canEdit && <button onClick={addStage}><PIcon name="plus" />Ajouter une étape</button>}
        </span>
      </div>
      <p className="stages-note small">Une étape avance avec ses tâches terminées, pondérées par leurs estimations. Elle plafonne à 95 % tant qu'elle n'est pas validée.</p>
      {amounts && anyPct && Math.abs(share - 100) > 1e-9 && (
        <p className="notice warn-note" role="status">Les étapes facturent {pctLabel(share)} du montant vendu : ajustez les parts pour arriver à 100 %.</p>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      <div className="stage-cards" role="list">
        {stages.map((i) => {
          const s = i.stage;
          const owner = text(s.data.owner_name) || text(team.find((m) => m.id === s.data.owner_id)?.data.name);
          const end = text(s.data.end_date);
          const late = end && end < day && !["approved", "approved_reserves", "stopped"].includes(i.state) && !stageTasksDone(i) ? daysBetween(end, day) : 0;
          const on = current?.stage.id === s.id;
          return (
            <button key={s.id} role="listitem" className={`stage-card${on ? " on" : ""}`} onClick={() => onSelect(s.id)} aria-pressed={on} data-testid={`stage-${text(s.data.name)}`}>
              <span className="stage-card-head">
                <strong>{text(s.data.name)}</strong>
                <span className={`badge ${STAGE_STATE_TONES[i.state]}`}>{STAGE_STATE_LABELS[i.state]}</span>
              </span>
              <span className="stage-owner">{owner ? <><Initials name={owner} />{owner}</> : <span className="muted">Responsable à choisir</span>}</span>
              <span className="muted small">{range(s)}{late ? <span className="danger-text strong"> · en retard de {late} j</span> : end === day ? " · fin aujourd'hui" : ""}</span>
              <span className="stage-progress">
                <span className="stage-progress-label"><span className="muted">Avancement</span><strong className="mono">{pct100(i.progress)} %</strong></span>
                <span className="strip-track"><span style={{ width: `${pct100(i.progress)}%` }} /></span>
                <span className="muted small">{i.tasks ? `${i.tasks} tâche${i.tasks > 1 ? "s" : ""}` : "Aucune tâche"}{i.deliverables ? ` · ${i.deliverablesDone}/${i.deliverables} livrable${i.deliverables > 1 ? "s" : ""} remis` : ""}</span>
              </span>
              {amounts && Number(s.data.billing_pct) > 0 && (
                <span className="stage-money">
                  <span className="muted">{stageRole(s)} {pctLabel(s.data.billing_pct)}{(() => {
                    const inv = invoiceOfStage(s.id, "stage", billing);
                    return inv ? <span className={inv.data.number ? "ok-text" : "warn-text"}> · {inv.data.number ? "facturé" : "facture en brouillon"}</span> : null;
                  })()}</span>
                  <strong className="mono">{sold.V > 0 ? fm(amountsBy.get(s.id) ?? 0).replace(/\s?FCFA$/, "") : "—"}</strong>
                </span>
              )}
            </button>
          );
        })}
      </div>

      {current && !readOnly && (
        <div className="stage-decision" key={current.stage.id}>
          <StageDecisionPanel c={c} info={current} flash={flash} setFlash={setFlash} onReview={() => setDeciding(current.stage.id)} />
        </div>
      )}
      {deciding && stages.find((i) => i.stage.id === deciding) && (
        <ValidationDialog c={c} info={stages.find((i) => i.stage.id === deciding)!} initialChoice={deciding === review ? reviewChoice : undefined}
          onClose={() => { setDeciding(null); onReviewDone?.(); }}
          onDone={(f) => { onSelect(deciding); setDeciding(null); setFlash(f); onReviewDone?.(); }} />
      )}

      {current && (
        <div className="stage-detail">
          <div className="card section-card">
            <div className="card-head">
              <h3>{text(current.stage.data.name)} : à remettre au client</h3>
              {deliverables.length > 0 && <span className="muted small">{deliverables.filter((t) => t.data.status === "done").length} sur {deliverables.length} terminées</span>}
            </div>
            {deliverables.length === 0 ? (
              <p className="muted small">Aucun livrable dans cette étape. Ouvrez une tâche et cochez « Livrable à remettre » : elle apparaîtra ici.</p>
            ) : (
              <ul className="deliverables">
                {deliverables.map((t) => {
                  const done = t.data.status === "done";
                  const who = assigneeOf(t, team)?.name;
                  return (
                    <li key={t.id} className={done ? "done" : ""}>
                      <span className={`check${done ? " on" : ""}`} aria-hidden="true">{done && <PIcon name="check" />}</span>
                      <span>
                        <strong>{text(t.data.title)}</strong>
                        <span className="muted small">{[who, done ? (t.data.done_at ? `terminé le ${dm(text(t.data.done_at).slice(0, 10))}` : "terminé") : "à faire"].filter(Boolean).join(" · ")}</span>
                      </span>
                      <span className="sr-only">{done ? "Remis" : "Pas encore remis"}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {open.length > 0 && (
              <p className="stage-open small">
                <strong>{current && (current.state === "approved" || current.state === "approved_reserves") ? "Tâches restées ouvertes à la validation : " : "Encore ouvert dans l'étape : "}</strong>
                {open.slice(0, 6).map((t, k) => (
                  <span key={t.id}>{k ? ", " : ""}« {text(t.data.title)} »{t.data.blocked ? ` (bloqué : ${BLOCK_LABELS[text(t.data.blocked_reason)]?.toLowerCase() ?? "motif non précisé"})` : t.data.status === "review" ? " (à valider)" : t.data.status === "doing" ? " (en cours)" : ""}</span>
                ))}
                {open.length > 6 ? ` et ${open.length - 6} autre(s)` : ""}.
              </p>
            )}
            <dl className="stage-facts">
              <div><dt>Heures passées</dt><dd className="mono">{hoursFr(hours)}{estimated ? <span className="muted"> / {hoursFr(estimated)} estimées</span> : null}</dd></div>
              <div><dt>Avancement prévu à date</dt><dd className="mono">{current.planned === null ? "—" : `${pct100(current.planned)} %`}</dd></div>
              {amounts && budget && (() => {
                const sf = budget.stages.find((x) => x.stageId === current.stage.id);
                if (!sf || (sf.BP <= 0 && sf.CR + sf.committed <= 0)) return null;
                const tol = tolerances(project).budgetPct;
                return (
                  <div data-testid="stage-cost"><dt>Coût réel / budget</dt><dd className="mono">{formatXaf(sf.CR + sf.committed)}{sf.BP > 0 ? <span className="muted"> / {formatXaf(sf.BP)}</span> : <span className="muted"> · pas de budget d'étape</span>}{sf.deltaPct !== null && sf.deltaPct >= tol / 2 ? <span className={sf.deltaPct > tol ? "danger-text" : "warn-text"}> · estimé {sf.deltaPct > 0 ? "+" : ""}{sf.deltaPct} %</span> : null}</dd></div>
                );
              })()}
            </dl>
          </div>
          {canEdit ? <StageForm key={current.stage.id} info={current} amounts={amounts} stages={records} tasks={tasks} onRemoved={() => onSelect(null)} /> : (
            <div className="card section-card">
              <h3>L'étape</h3>
              <dl className="stage-facts">
                <div><dt>Responsable</dt><dd>{text(current.stage.data.owner_name) || "—"}</dd></div>
                <div><dt>Dates prévues</dt><dd>{range(current.stage)}</dd></div>
                <div><dt>Statut</dt><dd>{STAGE_STATE_LABELS[current.state]}</dd></div>
              </dl>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Réglages d'une étape : nom, responsable (annuaire), dates, part du vendu, ordre. */
function StageForm({ info, amounts, stages, tasks, onRemoved }: { info: StageInfo<SyncRecord>; amounts: boolean; stages: SyncRecord[]; tasks: SyncRecord[]; onRemoved: () => void }) {
  const write = useGuardedWrite();
  const team = useTeam().filter((m) => m.data.active !== false || m.id === info.stage.data.owner_id);
  const s = info.stage;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const idx = stages.findIndex((x) => x.id === s.id);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const owner = team.find((m) => m.id === f.owner_id);
    const values: Record<string, unknown> = {
      name: f.name.trim(), owner_id: f.owner_id, owner_name: owner ? text(owner.data.name) : "", start_date: f.start_date, end_date: f.end_date,
      ...(amounts ? { billing_pct: Math.max(0, Math.min(100, Number(String(f.billing_pct).replace(",", ".")) || 0)) } : {}),
    };
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if ((s.data[k] ?? "") !== v) patch[k] = v;
    setError(null);
    try {
      if (Object.keys(patch).length) await write("project_stages", s.id, patch);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Enregistrement impossible.");
    }
  }
  async function swap(d: -1 | 1) {
    const other = stages[idx + d];
    if (!other) return;
    const a = Number(s.data.rank) || idx + 1;
    const b = Number(other.data.rank) || idx + 1 + d;
    await write("project_stages", s.id, { rank: a === b ? b + d * 0.5 : b });
    await write("project_stages", other.id, { rank: a });
  }
  async function remove() {
    const n = tasks.filter((t) => t.data.stage_id === s.id).length;
    if (!confirm(n ? `Supprimer l'étape « ${text(s.data.name)} » ? Ses ${n} tâche(s) passent « Sans étape ».` : `Supprimer l'étape « ${text(s.data.name)} » ?`)) return;
    try {
      for (const t of tasks.filter((x) => x.data.stage_id === s.id)) await write("tasks", t.id, { stage_id: "" });
      await write("project_stages", s.id, { _deleted: true });
      onRemoved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Suppression impossible.");
    }
  }
  return (
    <form className="card section-card stage-form" onSubmit={save}>
      <div className="card-head">
        <h3>L'étape</h3>
        <span className="row-tools">
          <button type="button" className="ghost small icon" disabled={idx <= 0} onClick={() => swap(-1)} aria-label="Avancer l'étape dans l'ordre"><PIcon name="arrowUp" /></button>
          <button type="button" className="ghost small icon" disabled={idx >= stages.length - 1} onClick={() => swap(1)} aria-label="Reculer l'étape dans l'ordre"><PIcon name="arrowDown" /></button>
        </span>
      </div>
      <label>Nom de l'étape<input name="name" required defaultValue={text(s.data.name)} /></label>
      <label>
        Responsable de l'étape
        <select name="owner_id" key={team.length} defaultValue={text(s.data.owner_id)}>
          <option value="">À choisir</option>
          {team.map((m) => <option key={m.id} value={m.id}>{text(m.data.name)}</option>)}
        </select>
      </label>
      <div className="form-pair">
        <label>Début prévu<input type="date" name="start_date" defaultValue={text(s.data.start_date)} /></label>
        <label>Fin prévue de l'étape<input type="date" name="end_date" defaultValue={text(s.data.end_date)} /></label>
      </div>
      {amounts && <label>Part du vendu (%)<input name="billing_pct" type="number" min="0" max="100" step="1" defaultValue={Number(s.data.billing_pct) || ""} placeholder="0" /></label>}
      {info.state === "upcoming" && (
        <button type="button" onClick={() => write("project_stages", s.id, { started_at: new Date().toISOString() }).catch((e) => setError(e.message))}>
          <PIcon name="play" />Démarrer l'étape
        </button>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="ghost danger small" onClick={remove}>Supprimer l'étape</button>
        {saved && <span className="success small" role="status">Enregistré</span>}
        <button className="primary">Enregistrer l'étape</button>
      </div>
    </form>
  );
}
