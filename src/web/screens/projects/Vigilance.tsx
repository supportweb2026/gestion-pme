/**
 * Projets, lot 6 : points de vigilance (CDC §3.14, F14). Onglet « Vigilance » de la fiche
 * projet, affiché dès le premier point (RG14.3), et fenêtre d'ajout ou de modification.
 *
 * Un point : ce qui peut mal tourner, sa probabilité et son impact (faible, moyen, fort), la
 * parade et son échéance, la personne qui s'en occupe, son état. « C'est arrivé » en fait un
 * problème et crée la tâche « Traiter : … » pour son responsable (RG14.2, CA6.2).
 * Aucun montant : l'écran est le même pour tous les rôles ; l'employé suit les points dont il
 * est responsable ou qu'il a signalés, et peut en signaler un nouveau.
 */
import { useEffect, useState, type FormEvent } from "react";
import { formatDate, text, today, useApp, useTable } from "../../context.ts";
import type { SyncRecord } from "../../../shared/sync.ts";
import { leadsProject, teamMemberIdOf, type ProjectContext } from "../../../shared/projectRules.ts";
import {
  IMPACT_LABELS, isIssue, levelOfScore, needsResponse, occurredPlan, PROBABILITY_LABELS, responseLate, WATCH_LEVEL_LABELS, WATCH_STATUS_LABELS,
  watchLevel, watchPointsOf, watchScore, watchStatus, watchSuggestions, WATCH_RESPONSE_MAX, WATCH_TITLE_MAX, type WatchLevel,
} from "../../../shared/projectWatch.ts";
import { STAGE_STATE_LABELS, type StageInfo } from "../../../shared/projectControl.ts";
import { GuardError } from "../../local/guard.ts";
import { useGuardedWrite, useTeam } from "../team.ts";
import { Initials, PIcon } from "../ProjectIcons.tsx";

const LEVEL_TONES: Record<WatchLevel, string> = { high: "danger", medium: "warn", low: "" };
const STATUS_TONES: Record<string, string> = { open: "info", controlled: "ok", occurred: "danger", closed: "" };
const errorText = (e: unknown, fallback: string) => (e instanceof GuardError || e instanceof Error ? e.message : fallback);
const ddmm = (iso: string) => formatDate(iso).slice(0, 5);

/** Qui peut modifier ce point : hors employé, tout rôle qui écrit ; l'employé, ses points (même règle que le serveur). */
function canEditPoint(p: SyncRecord, userId: string, role: string, leads: boolean): boolean {
  if (role !== "employee" || leads) return true;
  return text(p.data.owner_id) === teamMemberIdOf(userId) || text(p.data.created_by) === userId;
}

export function VigilanceTab({ project, stages, members, ctx, readOnly, adding, onAdding, onOpenTask }: {
  project: SyncRecord; stages: StageInfo<SyncRecord>[]; members: SyncRecord[]; ctx: ProjectContext; readOnly: boolean;
  /** Fenêtre d'ajout ouverte depuis un autre onglet (« Ajouter un point de vigilance »). */
  adding: boolean; onAdding: (open: boolean) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const { db, session } = useApp();
  const write = useGuardedWrite();
  const team = useTeam();
  const all = useTable("watch_points");
  const tasks = useTable("tasks");
  const points = watchPointsOf(project.id, all);
  const day = today();
  const [editing, setEditing] = useState<SyncRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const role = session.user.role;
  const leads = leadsProject({ userId: session.user.id, role }, project.id, ctx);
  const nameOf = (id: unknown) => text(team.find((m) => m.id === id)?.data.name);

  async function occurred(p: SyncRecord) {
    setError(null);
    const existingTask = tasks.find((t) => t.id === text(p.data.issue_task_id)) ?? null;
    const plan = occurredPlan(p, { userId: session.user.id, now: new Date().toISOString(), today: day, assignOthers: role !== "employee" || leads, existingTask });
    try {
      if (plan.task) await write("tasks", plan.task.id, plan.task.patch);
      await write("watch_points", p.id, plan.point);
      const who = nameOf(plan.task?.patch.assignee_id ?? existingTask?.data.assignee_id);
      setFlash(plan.task && !existingTask
        ? `C'est noté : la tâche « Traiter : ${text(p.data.title)} » est créée${who ? ` pour ${who}` : ", à attribuer"}. La météo du projet reste « À redresser » jusqu'à la clôture du problème.`
        : "Le problème est rouvert ; sa tâche est de nouveau à faire.");
    } catch (e) {
      setError(errorText(e, "Le point de vigilance n'a pas pu être modifié."));
    }
  }
  async function setStatus(p: SyncRecord, status: string, message: string) {
    setError(null);
    try {
      await write("watch_points", p.id, { status, ...(status === "closed" ? { closed_at: new Date().toISOString(), closed_by: session.user.id } : {}) });
      setFlash(message);
    } catch (e) {
      setError(errorText(e, "Le point de vigilance n'a pas pu être modifié."));
    }
  }

  const alerting = points.filter((p) => needsResponse(p, day));
  const issues = points.filter(isIssue);

  return (
    <div className="watch-tab" data-testid="vigilance-tab">
      <div className="stages-head">
        <h3>{points.length} point{points.length > 1 ? "s" : ""} de vigilance{issues.length ? <span className="badge danger watch-head-badge">{issues.length} problème{issues.length > 1 ? "s" : ""} ouvert{issues.length > 1 ? "s" : ""}</span> : null}</h3>
        {!readOnly && <button className="primary" onClick={() => onAdding(true)}><PIcon name="plus" />Ajouter un point de vigilance</button>}
      </div>
      <p className="stages-note small">Notez ce qui peut mal tourner et ce que vous faites pour l'éviter. Un point fort (probabilité × impact de 6 ou plus) sans parade, ou dont la parade est en retard, fait passer la météo du projet à « À redresser ».</p>
      {alerting.length > 0 && !readOnly && (
        <p className="notice" role="status" data-testid="watch-alert">
          {alerting.length === 1 ? `Le point « ${text(alerting[0].data.title)} » est fort ` : `${alerting.length} points forts sont ouverts `}
          {alerting.every((p) => text(p.data.response).trim()) ? "et leur parade est en retard : mettez-la à jour." : `sans parade à jour : indiquez ce que vous faites pour ${alerting.length === 1 ? "l'éviter" : "les éviter"}.`}
        </p>
      )}
      {flash && <p className="notice success-note" role="status" data-testid="watch-flash">{flash}<button className="link small" onClick={() => setFlash(null)}>Fermer</button></p>}
      {error && <p className="error" role="alert">{error}</p>}

      {points.length === 0 ? (
        <div className="card empty-state">
          <span className="empty-ico" aria-hidden="true"><PIcon name="alert" /></span>
          <h3 className="empty-title">Aucun point de vigilance</h3>
          <p className="muted">Un retard de livraison, une pluie, un accès client qui tarde : notez-le en 20 secondes, avec la personne qui s'en occupe.</p>
        </div>
      ) : (
        <ul className="watch-list" role="list">
          {points.map((p) => {
            const st = watchStatus(p);
            const level = watchLevel(p);
            const score = watchScore(p);
            const late = responseLate(p, day);
            const response = text(p.data.response).trim();
            const due = text(p.data.response_due);
            const owner = nameOf(p.data.owner_id) || text(p.data.owner_name);
            const task = tasks.find((t) => t.id === text(p.data.issue_task_id) && !t.data._deleted);
            const stage = stages.find((i) => i.stage.id === p.data.stage_id);
            const mine = !readOnly && canEditPoint(p, session.user.id, role, leads);
            return (
              <li key={p.id} className={`card watch-card ${st}${needsResponse(p, day) ? " alerting" : ""}`} data-testid={`watch-${text(p.data.title)}`}>
                <div className="watch-card-head">
                  <div className="watch-title">
                    <strong>{text(p.data.title)}</strong>
                    <span className="muted small">
                      Probabilité {PROBABILITY_LABELS[Number(p.data.probability)]?.toLowerCase() ?? "moyenne"} · impact {IMPACT_LABELS[Number(p.data.impact)]?.toLowerCase() ?? "moyen"}
                      {stage ? ` · étape ${text(stage.stage.data.name)}` : ""}
                    </span>
                  </div>
                  <span className="watch-badges">
                    <span className={`badge ${LEVEL_TONES[level]}`} title={`Score ${score} sur 9`}>{WATCH_LEVEL_LABELS[level]} · {score}</span>
                    <span className={`badge ${STATUS_TONES[st]}`}>{WATCH_STATUS_LABELS[st]}</span>
                  </span>
                </div>
                <dl className="watch-facts">
                  <div>
                    <dt>Parade</dt>
                    <dd className={!response && level === "high" && st === "open" ? "danger-text strong" : ""}>{response || "Aucune parade pour l'instant"}</dd>
                  </div>
                  <div>
                    <dt>Échéance de la parade</dt>
                    <dd className={late ? "danger-text strong" : ""}>{due ? `${formatDate(due)}${late ? " · en retard" : ""}` : "—"}</dd>
                  </div>
                  <div>
                    <dt>Responsable</dt>
                    <dd>{owner ? <span className="task-who"><Initials name={owner} />{owner}</span> : <span className="muted">À choisir</span>}</dd>
                  </div>
                </dl>
                {task && (
                  <p className="small watch-task">
                    <PIcon name="list" />Tâche « {text(task.data.title)} » : {task.data.status === "done" ? "terminée" : task.data.status === "doing" ? "en cours" : task.data.status === "review" ? "à vérifier" : "à faire"}
                    {nameOf(task.data.assignee_id) ? `, ${nameOf(task.data.assignee_id)}` : ", à attribuer"}
                    {onOpenTask && <button className="link small" onClick={() => onOpenTask(task.id)}>Voir la tâche</button>}
                  </p>
                )}
                {st === "occurred" && p.data.occurred_at ? <p className="muted small watch-when">Survenu le {ddmm(text(p.data.occurred_at).slice(0, 10))}.</p> : null}
                {mine && (
                  <div className="watch-actions">
                    {(st === "open" || st === "controlled") && <button className="small" onClick={() => occurred(p)}><PIcon name="alert" />C'est arrivé</button>}
                    {st === "open" && <button className="small" onClick={() => setStatus(p, "controlled", `« ${text(p.data.title)} » est maîtrisé : il ne compte plus dans la météo.`)}>Marquer maîtrisé</button>}
                    {st === "occurred" && <button className="small" onClick={() => setStatus(p, "closed", `Problème clos : « ${text(p.data.title)} ».`)}>Clore le problème</button>}
                    {(st === "controlled" || st === "closed") && <button className="ghost small" onClick={() => setStatus(p, "open", `« ${text(p.data.title)} » est de nouveau ouvert.`)}>Rouvrir le point</button>}
                    {st !== "closed" && <button className="ghost small" onClick={() => setEditing(p)}>Modifier</button>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {(adding || editing) && (
        <WatchDialog project={project} point={editing} stages={stages} members={members} points={all}
          onClose={() => { setEditing(null); onAdding(false); }}
          onDone={(m) => { setEditing(null); onAdding(false); setFlash(m); }} newId={() => db.newId("wp")} />
      )}
    </div>
  );
}

function useDialog(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.classList.add("dialog-open");
    return () => { window.removeEventListener("keydown", onKey); document.body.classList.remove("dialog-open"); };
  }, [onClose]);
}

/** Choix sur 3 niveaux, en boutons radio (pas de matrice). */
function Levels({ legend, value, labels, onChange, name }: { legend: string; value: number; labels: Record<number, string>; onChange: (n: number) => void; name: string }) {
  return (
    <fieldset className="watch-levels">
      <legend>{legend}</legend>
      <div className="segmented" role="radiogroup" aria-label={legend}>
        {[1, 2, 3].map((n) => (
          <label key={n} className={value === n ? "active" : ""}>
            <input type="radio" name={name} value={n} checked={value === n} onChange={() => onChange(n)} />{labels[n]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function WatchDialog({ project, point, stages, members, points, onClose, onDone, newId }: {
  project: SyncRecord; point: SyncRecord | null; stages: StageInfo<SyncRecord>[]; members: SyncRecord[]; points: SyncRecord[];
  onClose: () => void; onDone: (message: string) => void; newId: () => string;
}) {
  const { session } = useApp();
  const write = useGuardedWrite();
  const team = useTeam();
  useDialog(onClose);
  const me = teamMemberIdOf(session.user.id);
  const employee = session.user.role === "employee";
  const [title, setTitle] = useState(text(point?.data.title));
  const [probability, setProbability] = useState(Number(point?.data.probability) || 2);
  const [impact, setImpact] = useState(Number(point?.data.impact) || 2);
  const [response, setResponse] = useState(text(point?.data.response));
  const [due, setDue] = useState(text(point?.data.response_due));
  const projectLead = text(members.find((m) => m.data.role === "manager")?.data.team_member_id);
  const [owner, setOwner] = useState(point ? text(point.data.owner_id) : employee ? me : projectLead);
  const [stageId, setStageId] = useState(text(point?.data.stage_id));
  const [error, setError] = useState<string | null>(null);
  const score = probability * impact;
  const level = levelOfScore(score);
  const suggestions = point ? [] : watchSuggestions(project, points).slice(0, 4);
  // Personnes : l'équipe du projet d'abord, puis l'annuaire.
  const inProject = new Set(members.map((m) => text(m.data.team_member_id)));
  const people = [...team.filter((m) => inProject.has(m.id)), ...team.filter((m) => !inProject.has(m.id) && m.data.active !== false)];
  const openStages = stages.filter((i) => !["approved", "approved_reserves", "stopped"].includes(i.state));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const t = title.trim();
    if (!t) return setError("Décrivez ce qui peut mal tourner.");
    const ownerName = text(team.find((m) => m.id === owner)?.data.name);
    const patch: Record<string, unknown> = {
      title: t, probability, impact, response: response.trim(), response_due: due, owner_id: owner, owner_name: ownerName, stage_id: stageId,
    };
    try {
      if (point) {
        await write("watch_points", point.id, patch);
        onDone(`Point de vigilance « ${t} » enregistré.`);
      } else {
        const now = new Date().toISOString();
        await write("watch_points", newId(), {
          ...patch, project_id: project.id, status: "open", rank: Date.now(), created_by: session.user.id, created_by_name: session.user.name, created_at: now,
        });
        onDone(level === "high" && !response.trim()
          ? `Point de vigilance « ${t} » ajouté. Il est fort et sans parade : la météo du projet passe à « À redresser » tant qu'aucune parade n'est indiquée.`
          : `Point de vigilance « ${t} » ajouté.`);
      }
    } catch (err) {
      setError(errorText(err, "Le point de vigilance n'a pas pu être enregistré."));
    }
  }

  return (
    <>
      <div className="val-backdrop" onClick={onClose} aria-hidden="true" />
      <form className="val-dialog narrow" role="dialog" aria-modal="true" aria-labelledby="wp-title" onSubmit={submit} data-testid="watch-dialog">
        <header className="val-head">
          <div><h3 id="wp-title">{point ? "Modifier le point de vigilance" : "Ajouter un point de vigilance"}</h3><p className="muted small">{text(project.data.name)}</p></div>
          <button type="button" className="ghost icon" onClick={onClose} aria-label="Fermer"><PIcon name="close" /></button>
        </header>
        <div className="val-body">
          <label className="val-field">
            <span>Ce qui peut mal tourner</span>
            <input value={title} maxLength={WATCH_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} placeholder="Ex. : le client tarde à fournir les accès au serveur" autoFocus />
          </label>
          {suggestions.length > 0 && !title.trim() && (
            <div className="watch-suggest">
              <span className="muted small">Suggestions :</span>
              {suggestions.map((s) => <button type="button" key={s} className="chip removable" onClick={() => setTitle(s)}>{s}</button>)}
            </div>
          )}
          <div className="val-pair">
            <Levels legend="Probabilité" name="wp-prob" value={probability} labels={PROBABILITY_LABELS} onChange={setProbability} />
            <Levels legend="Impact" name="wp-impact" value={impact} labels={IMPACT_LABELS} onChange={setImpact} />
          </div>
          <p className={`watch-level-line small ${level}`} data-testid="watch-level">
            <span className={`badge ${LEVEL_TONES[level]}`}>{WATCH_LEVEL_LABELS[level]} · {score}</span>
            {level === "high" ? "Point fort : indiquez une parade et son échéance." : level === "medium" ? "Point moyen : à surveiller." : "Point faible."}
          </p>
          <label className="val-field">
            <span>Parade : ce que vous faites pour l'éviter</span>
            <textarea rows={2} maxLength={WATCH_RESPONSE_MAX} value={response} onChange={(e) => setResponse(e.target.value)} placeholder="Ex. : commander chez un second fournisseur si rien n'est livré jeudi" />
          </label>
          <div className="val-pair">
            <label className="val-field"><span>Échéance de la parade</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
            <label className="val-field">
              <span>Responsable</span>
              <select value={owner} onChange={(e) => setOwner(e.target.value)} disabled={employee && !!point && text(point.data.owner_id) !== me && text(point.data.created_by) !== session.user.id}>
                <option value="">À choisir</option>
                {(employee ? people.filter((m) => m.id === me || m.id === owner) : people).map((m) => <option key={m.id} value={m.id}>{text(m.data.name)}</option>)}
              </select>
            </label>
          </div>
          {openStages.length > 0 && (
            <label className="val-field">
              <span>Étape concernée (facultatif)</span>
              <select value={stageId} onChange={(e) => setStageId(e.target.value)}>
                <option value="">Tout le projet</option>
                {openStages.map((i) => <option key={i.stage.id} value={i.stage.id}>{text(i.stage.data.name)} ({STAGE_STATE_LABELS[i.state].toLowerCase()})</option>)}
              </select>
            </label>
          )}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="val-foot">
          <p className="muted small">Aucun montant ici : tout le monde dans l'équipe voit les points de vigilance du projet.</p>
          <div className="val-foot-actions">
            <button type="button" className="ghost" onClick={onClose}>Annuler</button>
            <button className="primary">{point ? "Enregistrer le point" : "Ajouter le point"}</button>
          </div>
        </footer>
      </form>
    </>
  );
}
