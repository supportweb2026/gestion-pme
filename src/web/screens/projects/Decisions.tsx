/**
 * Bloc « À décider » de la liste des projets (lot 3, version minimale du centre de décision) :
 * les validations d'étape demandées sur les projets où la personne décide, puis les retenues
 * devenues facturables. Le portefeuille complet arrive au lot 5.
 */
import { formatDate, text } from "../../context.ts";
import type { DecisionItem } from "../../../shared/projectDecisions.ts";
import type { AlertMode, ProjectAlert } from "../../../shared/projectBudget.ts";
import type { Rec } from "../../../shared/projects.ts";

/** Alerte de tolérance (lot 4) : décision pour qui décide, information pour le responsable du projet. */
export interface AlertItem { alert: ProjectAlert; project: Rec; mode: AlertMode }
import { PIcon } from "../ProjectIcons.tsx";

const since = (iso: string, days: number) =>
  days === 0 ? "aujourd'hui" : `le ${formatDate(iso.slice(0, 10))}, ${days === 1 ? "il y a 1 jour" : `il y a ${days} jours`}`;

export function DecisionsBlock({ items, onOpen, alerts = [], onAlert }: {
  items: DecisionItem[]; onOpen: (projectId: string, stageId: string, review: boolean) => void;
  alerts?: AlertItem[]; onAlert?: (projectId: string, alert: ProjectAlert) => void;
}) {
  if (items.length === 0 && alerts.length === 0) return null;
  const decide = alerts.filter((a) => a.mode === "decide");
  const info = alerts.filter((a) => a.mode === "info");
  const count = items.length + decide.length;
  return (
    <section className="card decide-block" aria-labelledby="decide-title" data-testid="decide-block">
      <div className="card-head">
        <h3 id="decide-title"><PIcon name="diamond" />À décider</h3>
        <span className="muted small">{count ? `${count} ${count > 1 ? "décisions" : "décision"}` : ""}{count && info.length ? " · " : ""}{info.length ? `${info.length} à surveiller` : ""}</span>
      </div>
      <ul>
        {[...decide, ...info].map(({ alert, project, mode }) => (
          <li key={`alert-${project.id}-${alert.key}`} data-testid={mode === "decide" ? "decide-alert" : "info-alert"}>
            <span className={`decide-mark alert ${alert.level}`} aria-hidden="true" />
            <div className="decide-text">
              <strong>{mode === "decide" ? alert.title : `${alert.level === "red" ? "Hors tolérance" : "À surveiller"} : ${alert.title.charAt(0).toLowerCase()}${alert.title.slice(1)}`}</strong>
              <span className="muted small">
                {text(project.data.name)} · {mode === "decide" ? "dépassement de tolérance" : alert.level === "red" ? "en attente de décision" : "dans la tolérance, à suivre"}
                {alert.planRequested ? " · plan de redressement demandé" : ""}
              </span>
            </div>
            <button className={mode === "decide" ? "primary" : ""} onClick={() => onAlert?.(project.id, alert)}>{mode === "decide" ? "Décider" : "Voir le projet"}</button>
          </li>
        ))}
        {items.map((i) => (
          <li key={`${i.kind}-${i.stage.id}`}>
            <span className={`decide-mark ${i.kind}`} aria-hidden="true" />
            <div className="decide-text">
              {i.kind === "review" ? (
                <>
                  <strong>Valider l'étape {text(i.stage.data.name)}</strong>
                  <span className="muted small">
                    {text(i.project.data.name)} · demandée{i.by ? ` par ${i.by}` : ""} {since(i.since, i.days)}
                    {i.note ? ` · ${i.note}` : ""}
                  </span>
                </>
              ) : (
                <>
                  <strong>Facturer la retenue de l'étape {text(i.stage.data.name)}</strong>
                  <span className="muted small">{text(i.project.data.name)} · réserves levées</span>
                </>
              )}
            </div>
            <button className={i.kind === "review" ? "primary" : ""} onClick={() => onOpen(i.project.id, i.stage.id, i.kind === "review")}>
              {i.kind === "review" ? "Examiner" : "Voir l'étape"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
