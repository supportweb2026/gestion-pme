/**
 * Bloc « À décider » de la liste des projets (lot 3, version minimale du centre de décision) :
 * les validations d'étape demandées sur les projets où la personne décide, puis les retenues
 * devenues facturables. Le portefeuille complet arrive au lot 5.
 */
import { formatDate, text } from "../../context.ts";
import type { DecisionItem } from "../../../shared/projectDecisions.ts";
import { PIcon } from "../ProjectIcons.tsx";

const since = (iso: string, days: number) =>
  days === 0 ? "aujourd'hui" : `le ${formatDate(iso.slice(0, 10))}, ${days === 1 ? "il y a 1 jour" : `il y a ${days} jours`}`;

export function DecisionsBlock({ items, onOpen }: { items: DecisionItem[]; onOpen: (projectId: string, stageId: string, review: boolean) => void }) {
  if (items.length === 0) return null;
  return (
    <section className="card decide-block" aria-labelledby="decide-title" data-testid="decide-block">
      <div className="card-head">
        <h3 id="decide-title"><PIcon name="diamond" />À décider</h3>
        <span className="muted small">{items.length} {items.length > 1 ? "décisions" : "décision"}</span>
      </div>
      <ul>
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
