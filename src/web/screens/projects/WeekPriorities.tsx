/**
 * Point de la semaine simple (CDC §3.11) : jusqu'à 7 tâches épinglées comme priorités
 * de la semaine, qui remontent en tête de « Ma journée » des personnes concernées,
 * et un résumé texte à coller dans le groupe WhatsApp de l'équipe. Aucun montant.
 */
import { useState } from "react";
import { formatDate, text, today } from "../../context.ts";
import { assigneeOf, MAX_WEEK_PRIORITIES, weekBounds, weekPriorities, weekSummaryText } from "../../../shared/projectControl.ts";
import type { SyncRecord } from "../../../shared/sync.ts";
import { Initials, PIcon } from "../ProjectIcons.tsx";

const dm = (iso: string) => formatDate(iso).slice(0, 5);
const shortDay = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit" });

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Repli : sélection d'un champ temporaire (anciens navigateurs, contexte non sécurisé).
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export function WeekPriorities({ project, tasks, team, stages, canPinTasks, onUnpin, onOpen }: {
  project: SyncRecord; tasks: SyncRecord[]; team: SyncRecord[]; stages: SyncRecord[]; canPinTasks: boolean;
  onUnpin: (t: SyncRecord) => void; onOpen: (t: SyncRecord) => void;
}) {
  const day = today();
  const { pinned, lastWeek } = weekPriorities(project.id, tasks, day);
  const { monday, sunday } = weekBounds(day);
  const [copied, setCopied] = useState<string | null>(null);
  if (pinned.length === 0 && !canPinTasks) return null;

  async function copy() {
    const ok = await copyText(weekSummaryText(project, tasks, team, day, stages));
    setCopied(ok ? "Résumé copié : collez-le dans le groupe WhatsApp de l'équipe." : "Le résumé n'a pas pu être copié.");
    setTimeout(() => setCopied(null), 5000);
  }

  return (
    <section className="card week-card" aria-label="Priorités de la semaine" data-testid="week-priorities">
      <div className="week-head">
        <h3><PIcon name="pushpin" />Priorités de la semaine</h3>
        <span className="muted small">{dm(monday)} → {dm(sunday)} · {pinned.length} sur {MAX_WEEK_PRIORITIES} au plus</span>
        <span className="week-tools">
          {lastWeek.total > 0 && <span className="small">Semaine dernière : <strong className={lastWeek.done === lastWeek.total ? "ok-text" : ""}>{lastWeek.done} sur {lastWeek.total} tenues</strong></span>}
          {canPinTasks && <button className="small" onClick={copy}><PIcon name="copy" />Copier pour WhatsApp</button>}
        </span>
      </div>
      {copied && <p className="small week-copied" role="status">{copied}</p>}
      {pinned.length === 0 ? (
        <p className="muted small week-empty">Aucune priorité cette semaine. Épinglez jusqu'à {MAX_WEEK_PRIORITIES} tâches avec <PIcon name="pushpin" className="inline-ico" /> sur leur carte : elles passent en tête de « Ma journée » des personnes concernées.</p>
      ) : (
        <ol className="week-list">
          {pinned.map((t) => {
            const who = assigneeOf(t, team);
            const due = text(t.data.due_date);
            const done = t.data.status === "done";
            return (
              <li key={t.id} className={done ? "done" : ""}>
                <button className="week-title" onClick={() => onOpen(t)}>{done && <PIcon name="check" />}{text(t.data.title)}</button>
                <span className="muted small week-meta">
                  {who ? <><Initials name={who.name} />{who.name.split(" ")[0]}</> : "Non attribuée"}
                  {due ? ` · ${shortDay(due)}` : ""}
                  {done ? " · terminée" : ""}
                </span>
                {canPinTasks && <button className="ghost small icon week-unpin" onClick={() => onUnpin(t)} aria-label={`Retirer des priorités : ${text(t.data.title)}`} title="Retirer des priorités"><PIcon name="close" /></button>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
