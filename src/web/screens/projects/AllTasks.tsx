/**
 * Projets, lot 5 : tableau de toutes les tâches, tous projets confondus (l'équivalent du
 * tableau Trello « IDO – Pilotage »).
 *
 *  - colonnes À faire, En cours, À vérifier, Terminé ; une tâche bloquée reste dans sa colonne,
 *    en tête, avec un liseré rouge et son motif écrit en toutes lettres ;
 *  - filtres : personne, projet, catégorie, échéance (en retard, cette semaine), bloquées,
 *    archivées, recherche ; gardés sur l'appareil ;
 *  - ajout rapide d'une tâche en choisissant son projet ; déplacement par glisser-déposer
 *    (ordinateur) ou par les boutons de la carte (téléphone) ;
 *  - un employé voit les tâches de ses projets et agit selon les mêmes règles que sur le projet.
 */
import { useEffect, useMemo, useState, type DragEvent, type FormEvent } from "react";
import { formatDate, text, today, useApp, useTable } from "../../context.ts";
import { assigneeOf, BLOCK_LABELS, daysBetween } from "../../../shared/projectControl.ts";
import { canCloseTask, teamMemberIdOf } from "../../../shared/projectRules.ts";
import {
  activeFilters, boardOrder, boardTasks, categoryName, EMPTY_FILTER, isArchived, isLate, visibleProjectIds, type BoardFilter, type DueFilter,
} from "../../../shared/projectBoard.ts";
import { TASK_STATUS } from "../../../shared/projects.ts";
import type { SyncRecord } from "../../../shared/sync.ts";
import { localProjectContext } from "../../local/guard.ts";
import { useGuardedWrite, useTeam } from "../team.ts";
import { Initials, PIcon } from "../ProjectIcons.tsx";
import { stepsOf, TaskTags, useCategories } from "./TaskForms.tsx";
import { TaskPanel } from "./TaskPanel.tsx";

const live = (r: SyncRecord) => !r.data._deleted;
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const lateLabel = (days: number) => (days === 1 ? "En retard d'1 j" : `En retard de ${days} j`);
/** Colonne Terminé : les plus récentes d'abord, les autres sur demande. */
const DONE_SHOWN = 12;

const filterKey = (userId: string) => `gestia:toutes-les-taches:${userId}`;
const lastProjectKey = (userId: string) => `gestia:projet-ajout-rapide:${userId}`;
function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown) {
  try { localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value)); } catch { /* stockage indisponible : le filtre reste en mémoire */ }
}

export function AllTasks({ openTask = null, onOpenProject }: { openTask?: string | null; onOpenProject: (projectId: string) => void }) {
  const { db, session } = useApp();
  const tasks = useTable("tasks");
  const projects = useTable("projects");
  const members = useTable("project_members");
  const comments = useTable("task_comments");
  const attachments = useTable("attachments");
  const team = useTeam();
  const categories = useCategories();
  const write = useGuardedWrite();
  const role = session.user.role;
  const me = teamMemberIdOf(session.user.id);
  const employee = role === "employee";
  const day = today();
  const [filter, setFilterState] = useState<BoardFilter>(() => readStored(filterKey(session.user.id), employee ? { ...EMPTY_FILTER, person: me } : EMPTY_FILTER));
  const [showFilters, setShowFilters] = useState(false);
  const [panel, setPanel] = useState<string | null>(openTask);
  const [over, setOver] = useState<string | null>(null);
  const [allDone, setAllDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(() => { try { return localStorage.getItem(lastProjectKey(session.user.id)) ?? ""; } catch { return ""; } });
  const [assignTo, setAssignTo] = useState(employee ? me : "");
  const [category, setCategory] = useState("");
  useEffect(() => { if (openTask) setPanel(openTask); }, [openTask]);

  const setFilter = (f: Partial<BoardFilter>) => setFilterState((prev) => {
    const next = { ...prev, ...f };
    store(filterKey(session.user.id), { ...next, q: "" });
    return next;
  });

  const visible = useMemo(() => visibleProjectIds(role, me, projects, members, tasks), [role, me, projects, members, tasks]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const projectName = (id: string) => text(projectById.get(id)?.data.name);
  const openProjects = projects.filter((p) => live(p) && visible.has(p.id) && !["done", "cancelled"].includes(text(p.data.status)))
    .sort((a, b) => text(a.data.name).localeCompare(text(b.data.name), "fr"));
  const filterProjects = projects.filter((p) => live(p) && visible.has(p.id)).sort((a, b) => text(a.data.name).localeCompare(text(b.data.name), "fr"));
  const target = openProjects.some((p) => p.id === projectId) ? projectId : filter.project && openProjects.some((p) => p.id === filter.project) ? filter.project : "";
  const ctx = localProjectContext(projects, members);
  const canClose = (pid: string) => canCloseTask({ userId: session.user.id, role }, pid, ctx);

  // Personnes des filtres et de l'attribution : l'annuaire actif, et toute personne chargée d'une tâche visible.
  const people = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of team) if (m.data.active !== false) map.set(m.id, text(m.data.name));
    for (const t of tasks) {
      if (!visible.has(text(t.data.project_id))) continue;
      const a = assigneeOf(t, team);
      if (a && !a.legacy) map.set(a.id, a.name);
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], "fr"));
  }, [team, tasks, visible]);

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    const f = new Map<string, number>();
    for (const x of comments) if (live(x)) c.set(text(x.data.task_id), (c.get(text(x.data.task_id)) ?? 0) + 1);
    for (const x of attachments) if (live(x) && x.data.tbl === "tasks") f.set(text(x.data.row_id), (f.get(text(x.data.row_id)) ?? 0) + 1);
    return { comments: c, files: f };
  }, [comments, attachments]);

  const shown = useMemo(() => boardTasks(tasks, visible, filter, day, projectName).sort((a, b) => boardOrder(a, b, day)), [tasks, visible, filter, day, projectById]);
  // Compteurs rapides, sur les tâches visibles non archivées (indépendants des autres filtres).
  const scope = useMemo(() => tasks.filter((t) => live(t) && visible.has(text(t.data.project_id)) && !isArchived(t)), [tasks, visible]);
  const lateCount = scope.filter((t) => isLate(t, day)).length;
  const blockedCount = scope.filter((t) => t.data.blocked && text(t.data.status) !== "done").length;
  const archivedCount = tasks.filter((t) => live(t) && visible.has(text(t.data.project_id)) && isArchived(t)).length;
  const nFilters = activeFilters(filter);

  async function add(e: FormEvent) {
    e.preventDefault();
    const name = title.trim();
    if (!name) return;
    if (!target) return setError("Choisissez le projet de la nouvelle tâche.");
    setError(null);
    setTitle("");
    store(lastProjectKey(session.user.id), target);
    setProjectId(target);
    try {
      await write("tasks", db.newId("tsk"), {
        project_id: target, title: name, status: "todo", priority: "normal", created_by: session.user.id, created_by_name: session.user.name, created_at: new Date().toISOString(),
        ...(assignTo ? { assignee_id: assignTo } : {}),
        ...(category ? { category_id: category } : {}),
      });
    } catch (err) {
      setTitle(name);
      setError(err instanceof Error ? err.message : "La tâche n'a pas pu être ajoutée.");
    }
  }
  async function patch(t: SyncRecord, values: Record<string, unknown>) {
    setError(null);
    try {
      await write("tasks", t.id, values);
    } catch (err) {
      setError(err instanceof Error ? err.message : "La tâche n'a pas pu être modifiée.");
    }
  }
  function move(t: SyncRecord, to: string) {
    const pid = text(t.data.project_id);
    // Qui ne peut pas clore envoie la tâche « À vérifier » plutôt que « Terminé ».
    const status = to === "done" && !canClose(pid) ? "review" : to;
    if ((text(t.data.status) || "todo") === status) return;
    const take = employee && !canClose(pid) && status === "doing" && !t.data.assignee_id ? { assignee_id: me } : {};
    return patch(t, { status, ...take, ...(status === "done" ? { done_at: new Date().toISOString(), blocked: false } : {}) });
  }
  const onDrop = (e: DragEvent, status: string) => {
    e.preventDefault();
    setOver(null);
    const t = tasks.find((x) => x.id === e.dataTransfer.getData("text/plain"));
    if (t) move(t, status);
  };

  const quick = (label: string, active: boolean, onClick: () => void, n?: number, testId?: string) => (
    <button type="button" className={`quick-filter${active ? " on" : ""}`} aria-pressed={active} onClick={onClick} data-testid={testId}>
      {label}{n !== undefined && n > 0 ? <span className="seg-count">{n}</span> : null}
    </button>
  );

  const card = (t: SyncRecord, status: string) => {
    const pid = text(t.data.project_id);
    const due = text(t.data.due_date);
    const late = status !== "done" && due && due < day ? daysBetween(due, day) : 0;
    const person = assigneeOf(t, team);
    const close = canClose(pid);
    const mine = t.data.assignee_id === me || (!t.data.assignee_id && !t.data.assignee);
    const steps = stepsOf(status, close, mine);
    const nc = counts.comments.get(t.id) ?? 0;
    const nf = counts.files.get(t.id) ?? 0;
    return (
      <div key={t.id} className={`task-card board-card${t.data.blocked && status !== "done" ? " blocked" : ""}`} draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", t.id)} data-testid="board-card">
        <button className="task-title" onClick={() => setPanel(t.id)} title="Ouvrir la tâche">{text(t.data.title)}</button>
        <TaskTags task={t} stage="" pinned={false} category={categoryName(t.data.category_id, categories)} project={filter.project ? "" : projectName(pid)} />
        {t.data.blocked && status !== "done" ? (
          <div className="task-blocked"><PIcon name="alert" />Bloquée : {BLOCK_LABELS[text(t.data.blocked_reason)] ?? "motif non précisé"}{t.data.blocked_note ? ` (${text(t.data.blocked_note)})` : ""}</div>
        ) : null}
        <div className="task-foot">
          {person ? (
            <span className={`task-who${person.legacy ? " legacy" : ""}`} title={person.legacy ? "Nom saisi avant l'annuaire" : undefined}><Initials name={person.name} />{person.name}</span>
          ) : <span className="task-who none">Non attribuée</span>}
          <span className="task-facts">
            {late > 0 ? <span className="danger-text strong">{lateLabel(late)}</span> : due ? <span title="Échéance">{formatDate(due).slice(0, 5)}</span> : null}
            {nc > 0 && <span className="fact-ico" title={plural(nc, "commentaire", "commentaires")}><PIcon name="chat" />{nc}</span>}
            {nf > 0 && <span className="fact-ico" title={plural(nf, "pièce jointe ou lien", "pièces jointes ou liens")}><PIcon name="clip" />{nf}</span>}
          </span>
        </div>
        {(steps.length > 0 || (!!t.data.blocked && status !== "done" && (close || mine))) && (
          <div className="task-move">
            {t.data.blocked && status !== "done" && (close || mine) ? <button className="ghost small" onClick={() => patch(t, { blocked: false, blocked_reason: "", blocked_note: "" })}>Débloquer</button> : null}
            {steps.map((s) => <button key={s.to} className={`small${s.main ? "" : " ghost"}`} onClick={() => move(t, s.to)}>{s.label}</button>)}
          </div>
        )}
      </div>
    );
  };

  const noProject = openProjects.length === 0;
  return (
    <div className="all-tasks">
      <form className="kanban-add board-add" onSubmit={add} aria-label="Ajouter une tâche">
        <input placeholder="Titre de la nouvelle tâche" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Nouvelle tâche" disabled={noProject} />
        <select value={target} onChange={(e) => setProjectId(e.target.value)} aria-label="Projet de la tâche" disabled={noProject}>
          <option value="">{noProject ? "Aucun projet ouvert" : "Choisir le projet"}</option>
          {openProjects.map((p) => <option key={p.id} value={p.id}>{text(p.data.name)}</option>)}
        </select>
        <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} aria-label="Attribuer à" disabled={noProject}>
          {employee && <option value={me}>À moi</option>}
          <option value="">Non attribuée</option>
          {!employee && people.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Catégorie de la tâche" disabled={noProject}>
          <option value="">Sans catégorie</option>
          {categories.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="primary" disabled={!title.trim() || noProject}>Ajouter la tâche</button>
      </form>

      <div className="board-bar">
        <div className="board-quick" role="group" aria-label="Filtres rapides">
          {quick("Mes tâches", filter.person === me, () => setFilter({ person: filter.person === me ? "" : me }))}
          {quick("En retard", filter.due === "late", () => setFilter({ due: filter.due === "late" ? "" : "late", archived: false }), lateCount, "quick-late")}
          {quick("Cette semaine", filter.due === "week", () => setFilter({ due: filter.due === "week" ? "" : "week" }))}
          {quick("Bloquées", filter.blocked, () => setFilter({ blocked: !filter.blocked, archived: false }), blockedCount, "quick-blocked")}
          {quick("Archivées", filter.archived, () => setFilter({ archived: !filter.archived, blocked: false, due: filter.due === "late" ? "" : filter.due }), archivedCount, "quick-archived")}
        </div>
        <button type="button" className={`ghost board-filter-toggle${nFilters ? " on" : ""}`} aria-expanded={showFilters} onClick={() => setShowFilters((x) => !x)}>
          <PIcon name="filter" />Filtres{nFilters ? <span className="seg-count">{nFilters}</span> : null}
        </button>
      </div>
      <div className={`board-filters${showFilters ? " open" : ""}`} role="group" aria-label="Filtrer les tâches">
        <input type="search" placeholder="Rechercher une tâche ou un projet" value={filter.q} onChange={(e) => setFilter({ q: e.target.value })} aria-label="Rechercher une tâche" />
        <select value={filter.person} onChange={(e) => setFilter({ person: e.target.value })} aria-label="Filtrer par personne">
          <option value="">Toutes les personnes</option>
          <option value={me}>Mes tâches</option>
          <option value="none">Non attribuées</option>
          {people.filter(([id]) => id !== me).map(([id, n]) => <option key={id} value={id}>{n}</option>)}
        </select>
        <select value={filter.project} onChange={(e) => setFilter({ project: e.target.value })} aria-label="Filtrer par projet">
          <option value="">Tous les projets</option>
          {filterProjects.map((p) => <option key={p.id} value={p.id}>{text(p.data.name)}</option>)}
        </select>
        <select value={filter.category} onChange={(e) => setFilter({ category: e.target.value })} aria-label="Filtrer par catégorie">
          <option value="">Toutes les catégories</option>
          {categories.filter((c) => c.active || c.id === filter.category).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          <option value="none">Sans catégorie</option>
        </select>
        <select value={filter.due} onChange={(e) => setFilter({ due: e.target.value as DueFilter })} aria-label="Filtrer par échéance">
          <option value="">Toutes les échéances</option>
          <option value="late">En retard</option>
          <option value="week">Échéance cette semaine</option>
        </select>
        {nFilters > 0 && <button type="button" className="link small" onClick={() => setFilter({ ...EMPTY_FILTER })}>Effacer les filtres</button>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="muted small board-summary" data-testid="board-summary">
        {filter.archived ? plural(shown.length, "tâche archivée", "tâches archivées") : plural(shown.length, "tâche", "tâches")}
        {nFilters > 0 ? " avec ces filtres" : ""}
        {!filter.archived && lateCount > 0 ? ` · ${plural(lateCount, "en retard", "en retard")}` : ""}
        {!filter.archived && blockedCount > 0 ? ` · ${plural(blockedCount, "bloquée", "bloquées")}` : ""}
      </p>

      {noProject && tasks.length === 0 ? (
        <div className="card empty-state">
          <span className="empty-ico" aria-hidden="true"><PIcon name="board" /></span>
          <h3 className="empty-title">Aucune tâche pour l'instant</h3>
          <p className="muted">Toutes les tâches de vos projets apparaîtront ici. Créez d'abord un projet, par exemple un projet interne pour vos actions de pilotage.</p>
        </div>
      ) : filter.archived ? (
        shown.length === 0 ? (
          <div className="card empty-state"><h3 className="empty-title">Aucune tâche archivée</h3><p className="muted">Une tâche terminée s'archive depuis sa fiche : elle quitte le tableau et se retrouve ici.</p></div>
        ) : (
          <ul className="archived-list" data-testid="archived-list">
            {shown.map((t) => (
              <li key={t.id}>
                <button className="link" onClick={() => setPanel(t.id)}>{text(t.data.title)}</button>
                <span className="muted small">{[projectName(text(t.data.project_id)), categoryName(t.data.category_id, categories), t.data.archived_at ? `archivée le ${formatDate(text(t.data.archived_at).slice(0, 10))}` : ""].filter(Boolean).join(" · ")}</span>
                {canClose(text(t.data.project_id)) && <button className="ghost small" onClick={() => patch(t, { archived: false })}>Sortir des archives</button>}
              </li>
            ))}
          </ul>
        )
      ) : shown.length === 0 && nFilters > 0 ? (
        <div className="card empty-state">
          <h3 className="empty-title">Aucune tâche ne correspond</h3>
          <p className="muted">Changez ou effacez les filtres pour revoir toutes les tâches.</p>
          <button onClick={() => setFilter({ ...EMPTY_FILTER })}>Effacer les filtres</button>
        </div>
      ) : (
        <div className="kanban board" data-testid="board">
          {TASK_STATUS.map(([status, label]) => {
            const all = shown.filter((t) => (text(t.data.status) || "todo") === status);
            const col = status === "done"
              ? [...all].sort((a, b) => text(b.data.done_at).localeCompare(text(a.data.done_at)))
              : all;
            const cut = status === "done" && !allDone ? col.slice(0, DONE_SHOWN) : col;
            const blocked = all.filter((t) => t.data.blocked && status !== "done").length;
            return (
              <div key={status} className={`kanban-col ${over === status ? "over" : ""}${col.length === 0 ? " is-empty" : ""}`} data-testid={`board-col-${status}`}
                onDragOver={(e) => { e.preventDefault(); setOver(status); }} onDragLeave={() => setOver(null)} onDrop={(e) => onDrop(e, status)}>
                <div className="kanban-head">
                  <span>{label}{status === "review" ? <span className="kanban-sub">closes après vérification</span> : blocked > 0 ? <span className="kanban-sub danger-text">{plural(blocked, "bloquée", "bloquées")}</span> : null}</span>
                  <span className="kanban-count">{col.length}</span>
                </div>
                {col.length === 0 && <p className="kanban-none">Aucune tâche</p>}
                {cut.map((t) => card(t, status))}
                {col.length > cut.length && <button className="link small" onClick={() => setAllDone(true)}>Afficher les {col.length - cut.length} autres</button>}
              </div>
            );
          })}
        </div>
      )}
      {panel && <TaskPanel taskId={panel} onClose={() => setPanel(null)} onOpenProject={(pid) => { setPanel(null); onOpenProject(pid); }} />}
    </div>
  );
}
