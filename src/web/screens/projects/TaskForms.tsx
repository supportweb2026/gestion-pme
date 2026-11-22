/**
 * Fiche d'une tâche : formulaires de modification (responsable et employé), étiquettes d'une
 * carte et actions dites avec un verbe. Partagés par le tableau du projet et le tableau de
 * toutes les tâches (lot 5).
 */
import { useMemo, useState, type FormEvent } from "react";
import { formatDate, text, useApp, useTable } from "../../context.ts";
import { assigneeOf, matchTeamMember } from "../../../shared/projectControl.ts";
import { teamMemberIdOf } from "../../../shared/projectRules.ts";
import { categoryName, taskCategories, type TaskCategory } from "../../../shared/projectBoard.ts";
import type { SyncRecord } from "../../../shared/sync.ts";
import { useGuardedWrite, useTeam } from "../team.ts";
import { PIcon } from "../ProjectIcons.tsx";

export const PRIORITY: Record<string, string> = { low: "Basse", normal: "Normale", high: "Haute" };
const hoursLabel = (h: number) => `${(Math.round(h * 100) / 100).toLocaleString("fr-FR")} h`;

/** Catégories de tâche de l'entreprise (lot 5), y compris les retirées pour nommer les anciennes tâches. */
export function useCategories(): TaskCategory[] {
  const rows = useTable("task_categories");
  return useMemo(() => taskCategories(rows), [rows]);
}

/**
 * Actions d'une carte, dites avec un verbe plutôt qu'avec des flèches.
 * Qui peut clore passe directement à Terminé ; les autres envoient la tâche « À vérifier ».
 */
export function stepsOf(status: string, canClose: boolean, mine: boolean): { to: string; label: string; main?: boolean }[] {
  switch (status) {
    case "todo": return canClose || mine ? [{ to: "doing", label: "Commencer", main: true }] : [];
    case "doing": return canClose ? [{ to: "done", label: "Terminer", main: true }] : mine ? [{ to: "review", label: "J'ai terminé", main: true }] : [];
    case "review": return canClose ? [{ to: "done", label: "Clore la tâche", main: true }, { to: "doing", label: "Reprendre" }] : mine ? [{ to: "doing", label: "Reprendre" }] : [];
    case "done": return canClose ? [{ to: "doing", label: "Rouvrir" }] : [];
    default: return [];
  }
}


/** Étiquettes d'une carte : étape, priorité de la semaine, livrable, priorité haute. Toujours un mot, pas seulement une couleur. */
export function TaskTags({ task, stage, pinned, category = "", project = "" }: { task: SyncRecord; stage: string; pinned: boolean; category?: string; project?: string }) {
  const done = task.data.status === "done";
  const reserve = task.data.kind === "reserve";
  if (!stage && !pinned && !task.data.deliverable && task.data.priority !== "high" && !reserve && !category && !project) return null;
  return (
    <div className="task-tags">
      {project && <span className="tag project-tag" title="Projet"><PIcon name="folder" />{project}</span>}
      {category && <span className="tag cat-tag" data-testid="task-category">{category}</span>}
      {stage && <span className="tag stage-tag"><PIcon name="diamond" />{stage}</span>}
      {reserve && <span className="tag warn">Réserve</span>}
      {pinned && <span className="tag"><PIcon name="pushpin" />Priorité</span>}
      {task.data.deliverable ? <span className={`tag ${done ? "ok" : "info"}`}>{done ? "Remis au client" : "À remettre au client"}</span> : null}
      {task.data.priority === "high" && !reserve && <span className="tag danger">Priorité haute</span>}
    </div>
  );
}

export function TaskForm({ task, members, stages, onClose, onOpen }: { task: SyncRecord; members: SyncRecord[]; stages: { stage: SyncRecord }[]; onClose: () => void; onOpen?: () => void }) {
  const write = useGuardedWrite();
  const team = useTeam();
  const categories = useCategories();
  const [error, setError] = useState<string | null>(null);
  const legacy = !task.data.assignee_id && task.data.assignee ? text(task.data.assignee) : "";
  const suggestion = legacy ? matchTeamMember(legacy, team) : null;
  const [assignee, setAssignee] = useState(text(task.data.assignee_id));
  // Liste contrôlée : les catégories de l'entreprise arrivent après le premier affichage, une
  // valeur par défaut non contrôlée ferait perdre la catégorie de la tâche à l'enregistrement.
  const [category, setCategory] = useState(text(task.data.category_id));
  // Personnes du projet d'abord, puis le reste de l'annuaire actif.
  const inProject = new Set(members.map((m) => text(m.data.team_member_id)));
  const choices = team.filter((m) => m.data.active !== false || m.id === assignee);
  const ordered = [...choices.filter((m) => inProject.has(m.id)), ...choices.filter((m) => !inProject.has(m.id))];

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const values: Record<string, unknown> = {
      title: f.title, description: f.description, assignee_id: assignee, start_date: f.start_date, due_date: f.due_date,
      estimate_hours: Number(f.estimate_hours) || 0, priority: f.priority, deliverable: f.deliverable === "on", category_id: category,
      ...(stages.length ? { stage_id: f.stage_id ?? "" } : {}),
    };
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if ((task.data[k] ?? "") !== v) patch[k] = v;
    if (task.data.estimate_hours === undefined && values.estimate_hours === 0) delete patch.estimate_hours;
    if (task.data.deliverable === undefined && values.deliverable === false) delete patch.deliverable;
    if (task.data.category_id === undefined && values.category_id === "") delete patch.category_id;
    try {
      if (Object.keys(patch).length) await write("tasks", task.id, patch);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "La tâche n'a pas pu être enregistrée.");
    }
  }
  async function remove() {
    if (!confirm(`Supprimer la tâche « ${text(task.data.title)} » ? Le temps déjà saisi reste sur le projet.`)) return;
    try {
      await write("tasks", task.id, { _deleted: true });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "La tâche n'a pas pu être supprimée.");
    }
  }
  return (
    <form className="task-form" onSubmit={save} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <label>Titre<input name="title" required defaultValue={text(task.data.title)} autoFocus /></label>
      <label>Description<textarea name="description" rows={2} defaultValue={text(task.data.description)} /></label>
      <label>
        Attribuée à
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">{legacy ? `${legacy} (nom saisi avant l'annuaire)` : "Personne pour l'instant"}</option>
          {ordered.map((m) => <option key={m.id} value={m.id}>{text(m.data.name)}{inProject.has(m.id) ? "" : " (pas sur ce projet)"}</option>)}
        </select>
      </label>
      {legacy && !assignee && (
        <p className="legacy-hint small">
          Nom saisi avant l'annuaire : « {legacy} ».{" "}
          {suggestion ? <button type="button" className="link" onClick={() => setAssignee(suggestion.id)}>Choisir {text(suggestion.data.name)}</button> : "Choisissez la personne dans la liste."}
        </p>
      )}
      <div className="task-form-row dates">
        <label>Début<input type="date" name="start_date" defaultValue={text(task.data.start_date)} /></label>
        <label>Échéance<input type="date" name="due_date" defaultValue={text(task.data.due_date)} /></label>
      </div>
      {stages.length > 0 && (
        <label>
          Étape
          <select name="stage_id" defaultValue={text(task.data.stage_id)}>
            <option value="">Sans étape</option>
            {stages.map((i) => <option key={i.stage.id} value={i.stage.id}>{text(i.stage.data.name)}</option>)}
          </select>
        </label>
      )}
      <label>
        Catégorie
        <select name="category_id" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Sans catégorie</option>
          {categories.filter((c) => c.active || c.id === category).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          {category && !categories.some((c) => c.id === category) && <option value={category}>{categoryName(category, categories)}</option>}
        </select>
      </label>
      <div className="task-form-row">
        <label>Estimation (h)<input type="number" min="0" step="0.5" name="estimate_hours" defaultValue={text(task.data.estimate_hours)} /></label>
        <label>
          Priorité
          <select name="priority" defaultValue={text(task.data.priority) || "normal"}>
            {Object.entries(PRIORITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
      </div>
      <label className="inline check-line"><input type="checkbox" name="deliverable" defaultChecked={Boolean(task.data.deliverable)} /> Livrable à remettre</label>
      {task.data.blocked ? (
        <button type="button" className="ghost small" onClick={() => write("tasks", task.id, { blocked: false, blocked_reason: "", blocked_note: "" })}>Débloquer la tâche</button>
      ) : null}
      {error && <p className="error">{error}</p>}
      {onOpen && <button type="button" className="link small task-open-link" onClick={onOpen}>Discussion, pièces jointes et historique</button>}
      <div className="form-actions">
        <button type="button" className="ghost danger small" onClick={remove}>Supprimer</button>
        <button type="button" className="ghost small" onClick={onClose}>Annuler</button>
        <button className="primary small">Enregistrer</button>
      </div>
    </form>
  );
}

/** Ce qu'un employé modifie sur une tâche : la description, et la prendre si elle est libre. */
export function EmployeeTaskForm({ task, onClose, onOpen }: { task: SyncRecord; onClose: () => void; onOpen?: () => void }) {
  const { session } = useApp();
  const write = useGuardedWrite();
  const team = useTeam();
  const [error, setError] = useState<string | null>(null);
  const me = teamMemberIdOf(session.user.id);
  const person = assigneeOf(task, team);
  const due = text(task.data.due_date);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const description = String(new FormData(e.currentTarget).get("description") ?? "");
    try {
      if (description !== text(task.data.description)) await write("tasks", task.id, { description });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "La tâche n'a pas pu être enregistrée.");
    }
  }
  return (
    <form className="task-form" onSubmit={save} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <strong>{text(task.data.title)}</strong>
      <p className="muted small task-form-facts">
        {person ? `Attribuée à ${person.name}` : "Non attribuée"}
        {due ? ` · échéance le ${formatDate(due)}` : ""}
        {task.data.estimate_hours ? ` · ${hoursLabel(Number(task.data.estimate_hours))} estimées` : ""}
      </p>
      <label>Description et remarques<textarea name="description" rows={3} defaultValue={text(task.data.description)} /></label>
      {!task.data.assignee_id && <button type="button" className="small" onClick={() => write("tasks", task.id, { assignee_id: me }).then(onClose, (err) => setError(err.message))}>Prendre cette tâche</button>}
      {error && <p className="error">{error}</p>}
      {onOpen && <button type="button" className="link small task-open-link" onClick={onOpen}>Discussion, pièces jointes et historique</button>}
      <div className="form-actions">
        <button type="button" className="ghost small" onClick={onClose}>Annuler</button>
        <button className="primary small">Enregistrer</button>
      </div>
    </form>
  );
}

