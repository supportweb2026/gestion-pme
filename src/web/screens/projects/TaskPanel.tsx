/**
 * Projets, lot 5 : fiche complète d'une tâche, ouverte depuis le tableau de toutes les tâches,
 * le tableau d'un projet ou « À décider ». Panneau à droite sur ordinateur, plein écran sur
 * téléphone. Tout fonctionne hors ligne.
 *
 *  - en-tête : projet, titre, catégorie en toutes lettres, état, personne, échéance, blocage ;
 *  - actions avec un verbe selon les droits (Commencer, J'ai terminé, Clore la tâche…), blocage,
 *    archivage d'une tâche terminée ;
 *  - discussion : commentaires datés et signés, modifiables 15 minutes par leur auteur ;
 *  - pièces jointes (photo ou PDF, stockage des justificatifs) et liens ;
 *  - historique : créée, déplacée, échéance changée, bloquée, débloquée, personne changée.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { formatDate, text, today, useApp, useTable } from "../../context.ts";
import { assigneeOf, BLOCK_LABELS, daysBetween, stagesOf } from "../../../shared/projectControl.ts";
import { canCloseTask, leadsProject, teamMemberIdOf } from "../../../shared/projectRules.ts";
import {
  attachmentsOf, canEditComment, categoryName, COMMENT_EDIT_MINUTES, commentMinutesLeft, commentsOf, isArchived, LINK_RE, linkLabel, taskHistory,
} from "../../../shared/projectBoard.ts";
import { TASK_STATUS } from "../../../shared/projects.ts";
import type { SyncRecord } from "../../../shared/sync.ts";
import { localProjectContext } from "../../local/guard.ts";
import { prepareReceipt, ReceiptViewer } from "../../receipts.tsx";
import { useGuardedWrite, useTeam } from "../team.ts";
import { Initials, PIcon } from "../ProjectIcons.tsx";
import { EmployeeTaskForm, stepsOf, TaskForm, useCategories } from "./TaskForms.tsx";

const STATUS_LABEL = Object.fromEntries(TASK_STATUS);
const live = (r: SyncRecord) => !r.data._deleted;
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** « le 22/11/2026 à 14 h 05 » ; « aujourd'hui à 14 h 05 ». */
export function stamp(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }).replace(":", " h ");
  const day = d.toLocaleDateString("fr-FR");
  return day === new Date().toLocaleDateString("fr-FR") ? `aujourd'hui à ${hm}` : `le ${day} à ${hm}`;
}

type Section = "comments" | "files" | "history";

export function TaskPanel({ taskId, onClose, onOpenProject }: { taskId: string; onClose: () => void; onOpenProject?: (projectId: string) => void }) {
  const { session } = useApp();
  const tasks = useTable("tasks");
  const projects = useTable("projects");
  const members = useTable("project_members");
  const stages = useTable("project_stages");
  const comments = useTable("task_comments");
  const attachments = useTable("attachments");
  const events = useTable("task_events");
  const team = useTeam();
  const categories = useCategories();
  const write = useGuardedWrite();
  const [section, setSection] = useState<Section>("comments");
  const [editing, setEditing] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !editing) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editing]);
  useEffect(() => { panel.current?.focus(); }, [taskId]);

  const task = tasks.find((t) => t.id === taskId);
  if (!task || !live(task)) {
    return (
      <>
        <div className="tp-backdrop" onClick={onClose} aria-hidden="true" />
        <aside className="task-panel" role="dialog" aria-modal="true" aria-label="Tâche">
          <div className="tp-head"><p className="muted">Cette tâche n'existe plus.</p><button className="ghost icon" onClick={onClose} aria-label="Fermer"><PIcon name="close" /></button></div>
        </aside>
      </>
    );
  }
  const projectId = text(task.data.project_id);
  const project = projects.find((p) => p.id === projectId);
  const actor = { userId: session.user.id, role: session.user.role };
  const ctx = localProjectContext(projects, members);
  const canClose = canCloseTask(actor, projectId, ctx);
  const lead = leadsProject(actor, projectId, ctx);
  const employee = session.user.role === "employee" && !canClose;
  const me = teamMemberIdOf(session.user.id);
  const mine = task.data.assignee_id === me || (!task.data.assignee_id && !task.data.assignee);
  const status = text(task.data.status) || "todo";
  const archived = isArchived(task);
  const steps = archived ? [] : stepsOf(status, canClose, mine);
  const person = assigneeOf(task, team);
  const due = text(task.data.due_date);
  const day = today();
  const late = status !== "done" && due && due < day ? daysBetween(due, day) : 0;
  const category = categoryName(task.data.category_id, categories);
  const projectMembers = members.filter((m) => live(m) && m.data.project_id === projectId);
  const stageList = stagesOf(projectId, stages).map((s) => ({ stage: s }));
  const stageName = text(stages.find((s) => s.id === task.data.stage_id)?.data.name);
  const taskComments = commentsOf(task.id, comments);
  const files = attachmentsOf(task.id, attachments);

  async function act(patch: Record<string, unknown>, message?: string) {
    setError(null);
    try {
      await write("tasks", task!.id, patch);
      if (message) setFlash(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "La tâche n'a pas pu être modifiée.");
    }
  }
  function move(to: string) {
    const take = employee && to === "doing" && !task!.data.assignee_id ? { assignee_id: me } : {};
    return act({ status: to, ...take, ...(to === "done" ? { done_at: new Date().toISOString(), blocked: false } : {}) });
  }
  function block(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBlocking(false);
    return act({ blocked: true, blocked_reason: String(f.get("reason") || "other"), blocked_note: String(f.get("note") ?? "").trim(), blocked_at: new Date().toISOString(), blocked_by: session.user.id });
  }
  const nameOf = (id: string) => (id.startsWith("tm-") ? text(team.find((m) => m.id === id)?.data.name) || "une personne retirée de la liste" : id);
  const userName = (uid: string) => text(team.find((m) => m.id === teamMemberIdOf(uid))?.data.name);

  return (
    <>
      <div className="tp-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="task-panel" role="dialog" aria-modal="true" aria-labelledby="tp-title" ref={panel} tabIndex={-1} data-testid="task-panel">
        <header className="tp-head">
          <div className="tp-head-text">
            {project && (onOpenProject
              ? <button className="link small tp-project" onClick={() => onOpenProject(project.id)}><PIcon name="folder" />{text(project.data.name)}</button>
              : <span className="muted small tp-project"><PIcon name="folder" />{text(project.data.name)}</span>)}
            <h3 id="tp-title">{text(task.data.title)}</h3>
          </div>
          <button className="ghost icon" onClick={onClose} aria-label="Fermer la tâche"><PIcon name="close" /></button>
        </header>

        <div className="tp-body">
          {editing ? (
            <div className="tp-edit">
              {employee
                ? <EmployeeTaskForm task={task} onClose={() => setEditing(false)} />
                : <TaskForm task={task} members={projectMembers} stages={stageList} onClose={() => setEditing(false)} />}
            </div>
          ) : (
            <>
              <dl className="tp-facts">
                <div><dt>État</dt><dd><span className={`tag ${status === "done" ? "ok" : status === "review" ? "warn" : status === "doing" ? "info" : ""}`}>{STATUS_LABEL[status] ?? "À faire"}</span>{archived && <span className="tag">Archivée</span>}</dd></div>
                <div><dt>Catégorie</dt><dd>{category ? <span className="tag cat-tag">{category}</span> : <span className="muted">Sans catégorie</span>}</dd></div>
                <div><dt>Attribuée à</dt><dd>{person ? <span className="task-who"><Initials name={person.name} />{person.name}</span> : <span className="muted">Personne pour l'instant</span>}</dd></div>
                <div><dt>Échéance</dt><dd>{due ? <>{formatDate(due)}{late > 0 && <span className="danger-text strong tp-late">En retard de {plural(late, "jour", "jours")}</span>}</> : <span className="muted">Aucune</span>}</dd></div>
                {stageName && <div><dt>Étape</dt><dd>{stageName}</dd></div>}
              </dl>
              {task.data.blocked && status !== "done" ? (
                <p className="tp-blocked" data-testid="tp-blocked"><PIcon name="alert" /><span><strong>Bloquée : {BLOCK_LABELS[text(task.data.blocked_reason)] ?? "motif non précisé"}</strong>{task.data.blocked_note ? ` (${text(task.data.blocked_note)})` : ""}{task.data.blocked_at ? <span className="muted small"> · depuis {stamp(text(task.data.blocked_at))}</span> : null}</span></p>
              ) : null}
              {text(task.data.description).trim() && <p className="tp-desc">{text(task.data.description)}</p>}

              <div className="tp-actions">
                {steps.map((s) => <button key={s.to} className={s.main ? "primary" : ""} onClick={() => move(s.to)}>{s.label}</button>)}
                {!!task.data.blocked && status !== "done" && (canClose || mine) && <button onClick={() => act({ blocked: false, blocked_reason: "", blocked_note: "" }, "Tâche débloquée.")}>Débloquer</button>}
                {!task.data.blocked && status !== "done" && !archived && (canClose || mine) && !blocking && <button className="ghost" onClick={() => setBlocking(true)}><PIcon name="hand" />Signaler un blocage</button>}
                {status === "done" && canClose && !archived && <button className="ghost" onClick={() => act({ archived: true, archived_at: new Date().toISOString() }, "Tâche archivée : retrouvez-la avec le filtre « Archivées ».")}><PIcon name="archive" />Archiver la tâche</button>}
                {archived && canClose && <button className="ghost" onClick={() => act({ archived: false }, "Tâche sortie des archives.")}>Sortir des archives</button>}
                <button className="ghost" onClick={() => setEditing(true)}><PIcon name="edit" />{employee ? "Ajouter une remarque" : "Modifier la tâche"}</button>
              </div>
              {blocking && (
                <form className="tp-block-form" onSubmit={block}>
                  <label>Motif du blocage
                    <select name="reason" defaultValue="material">{Object.entries(BLOCK_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                  </label>
                  <label>Précision (facultatif)<input name="note" placeholder="Ex. : accès au serveur pas encore fourni" /></label>
                  <div className="form-actions">
                    <button type="button" className="ghost" onClick={() => setBlocking(false)}>Annuler</button>
                    <button className="primary">Signaler le blocage</button>
                  </div>
                </form>
              )}
              {error && <p className="error" role="alert">{error}</p>}
              {flash && <p className="notice success-note" role="status">{flash}<button className="link small" onClick={() => setFlash(null)}>Fermer</button></p>}
            </>
          )}

          <div className="segmented tp-tabs" role="tablist" aria-label="Suivi de la tâche">
            <button role="tab" aria-selected={section === "comments"} className={section === "comments" ? "active" : ""} onClick={() => setSection("comments")}>
              Discussion{taskComments.length ? <span className="seg-count">{taskComments.length}</span> : null}
            </button>
            <button role="tab" aria-selected={section === "files"} className={section === "files" ? "active" : ""} onClick={() => setSection("files")}>
              Pièces jointes{files.length ? <span className="seg-count">{files.length}</span> : null}
            </button>
            <button role="tab" aria-selected={section === "history"} className={section === "history" ? "active" : ""} onClick={() => setSection("history")}>Historique</button>
          </div>
          {section === "comments" && <Discussion task={task} comments={taskComments} />}
          {section === "files" && <Attachments task={task} files={files} canRemoveAll={lead} />}
          {section === "history" && <History lines={taskHistory(task, events, nameOf, userName)} />}
        </div>
      </aside>
    </>
  );
}

/** Discussion : commentaires datés et signés ; l'auteur modifie ou supprime le sien pendant 15 minutes. */
function Discussion({ task, comments }: { task: SyncRecord; comments: SyncRecord[] }) {
  const { db, session } = useApp();
  const write = useGuardedWrite();
  const [body, setBody] = useState("");
  const [edit, setEdit] = useState<{ id: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  // Le délai de modification s'écoule à l'écran : on recalcule toutes les 20 secondes.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(t);
  }, []);
  const list = useRef<HTMLOListElement>(null);
  const count = comments.length;
  useEffect(() => { list.current?.lastElementChild?.scrollIntoView?.({ block: "nearest" }); }, [count]);

  async function publish(e?: FormEvent) {
    e?.preventDefault();
    const value = body.trim();
    if (!value) return;
    setError(null);
    setBody("");
    try {
      await write("task_comments", db.newId("cmt"), {
        task_id: task.id, project_id: text(task.data.project_id), body: value,
        author_id: session.user.id, author_name: session.user.name, created_at: new Date().toISOString(),
      });
      setNow(Date.now());
    } catch (err) {
      setBody(value);
      setError(err instanceof Error ? err.message : "Le commentaire n'a pas pu être publié.");
    }
  }
  async function save(c: SyncRecord) {
    if (!edit) return;
    const value = edit.body.trim();
    if (!value) return setError("Écrivez le commentaire, ou supprimez-le.");
    setError(null);
    try {
      if (value !== text(c.data.body)) await write("task_comments", c.id, { body: value, edited_at: new Date().toISOString() });
      setEdit(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Le commentaire n'a pas pu être modifié.");
    }
  }
  async function remove(c: SyncRecord) {
    if (!confirm("Supprimer ce commentaire ?")) return;
    setError(null);
    try {
      await write("task_comments", c.id, { _deleted: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Le commentaire n'a pas pu être supprimé.");
    }
  }

  return (
    <section className="tp-section" aria-label="Discussion" data-testid="task-discussion">
      {comments.length === 0 ? (
        <p className="muted small tp-empty">Aucun commentaire pour l'instant. Notez ici l'avancement, une question ou une décision : chaque message est daté et signé.</p>
      ) : (
        <ol className="comment-list" ref={list}>
          {comments.map((c) => {
            const editable = canEditComment(c, session.user.id, now);
            const left = commentMinutesLeft(c, now);
            return (
              <li key={c.id} className="comment" data-testid="comment">
                <Initials name={text(c.data.author_name) || "?"} />
                <div className="comment-main">
                  <div className="comment-head">
                    <strong>{text(c.data.author_name) || "Une personne"}</strong>
                    <span className="muted small">{stamp(text(c.data.created_at))}{c.data.edited_at ? " · modifié" : ""}</span>
                  </div>
                  {edit?.id === c.id ? (
                    <div className="comment-edit">
                      <textarea value={edit.body} rows={3} onChange={(e) => setEdit({ id: c.id, body: e.target.value })} aria-label="Modifier le commentaire" autoFocus />
                      <div className="form-actions">
                        <button type="button" className="ghost small" onClick={() => setEdit(null)}>Annuler</button>
                        <button type="button" className="primary small" onClick={() => save(c)}>Enregistrer</button>
                      </div>
                    </div>
                  ) : (
                    <p className="comment-body">{text(c.data.body)}</p>
                  )}
                  {editable && edit?.id !== c.id && (
                    <div className="comment-tools">
                      <button className="link small" onClick={() => setEdit({ id: c.id, body: text(c.data.body) })}>Modifier</button>
                      <button className="link small" onClick={() => remove(c)}>Supprimer</button>
                      <span className="muted small">encore {plural(left, "minute", "minutes")}</span>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <form className="comment-form" onSubmit={publish}>
        <label className="sr-only" htmlFor={`comment-${task.id}`}>Votre commentaire</label>
        <textarea id={`comment-${task.id}`} rows={2} value={body} placeholder="Écrire un commentaire…" onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) publish(); }} />
        <div className="comment-form-foot">
          <span className="muted small">Vous pourrez le modifier pendant {COMMENT_EDIT_MINUTES} minutes.</span>
          <button className="primary" disabled={!body.trim()}>Publier le commentaire</button>
        </div>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

const sizeLabel = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);

/** Pièces jointes (stockage des justificatifs : photo ou PDF, hors ligne) et liens. */
function Attachments({ task, files, canRemoveAll }: { task: SyncRecord; files: SyncRecord[]; canRemoveAll: boolean }) {
  const { db, session } = useApp();
  const write = useGuardedWrite();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<{ id: string; title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const base = useMemo(() => ({ tbl: "tasks", row_id: task.id, project_id: text(task.data.project_id), created_by: session.user.id, created_by_name: session.user.name }), [task.id, task.data.project_id, session.user.id, session.user.name]);

  async function attach(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const blob = await prepareReceipt(file);
      const fileId = db.newId("pj");
      await db.putFile(fileId, blob, false);
      await write("attachments", db.newId("att"), { ...base, kind: "file", file_id: fileId, label: file.name.slice(0, 200), mime: blob.type, size: blob.size, created_at: new Date().toISOString() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Le fichier n'a pas pu être joint.");
    } finally {
      setBusy(false);
    }
  }
  async function addLink(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    let url = String(f.get("url") ?? "").trim();
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
    if (!LINK_RE.test(url)) return setError("Indiquez une adresse complète, par exemple https://github.com/…");
    setError(null);
    try {
      await write("attachments", db.newId("att"), { ...base, kind: "link", url, label: String(f.get("label") ?? "").trim().slice(0, 200), created_at: new Date().toISOString() });
      setAdding(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Le lien n'a pas pu être ajouté.");
    }
  }
  async function remove(a: SyncRecord) {
    if (!confirm(`Retirer « ${a.data.kind === "link" ? linkLabel(text(a.data.url), text(a.data.label)) : text(a.data.label)} » de la tâche ?`)) return;
    try {
      await write("attachments", a.id, { _deleted: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "La pièce jointe n'a pas pu être retirée.");
    }
  }

  return (
    <section className="tp-section" aria-label="Pièces jointes et liens" data-testid="task-files">
      {files.length === 0 ? (
        <p className="muted small tp-empty">Aucune pièce jointe. Joignez une photo ou un PDF (capture, bon de livraison, procès-verbal), ou le lien d'un document en ligne.</p>
      ) : (
        <ul className="att-list">
          {files.map((a) => {
            const link = a.data.kind === "link";
            const mineOrLead = canRemoveAll || a.data.created_by === session.user.id;
            return (
              <li key={a.id} className="att-row" data-testid="attachment">
                <span className="att-ico" aria-hidden="true"><PIcon name={link ? "link" : "clip"} /></span>
                <span className="att-main">
                  {link
                    ? <a href={text(a.data.url)} target="_blank" rel="noopener noreferrer">{linkLabel(text(a.data.url), text(a.data.label))}</a>
                    : <button className="link" onClick={() => setViewing({ id: text(a.data.file_id), title: text(a.data.label) || "Pièce jointe" })}>{text(a.data.label) || "Pièce jointe"}</button>}
                  <span className="muted small">{[link ? text(a.data.url).replace(/^https?:\/\//, "").split("/")[0] : a.data.size ? sizeLabel(Number(a.data.size)) : "", text(a.data.created_by_name), stamp(text(a.data.created_at))].filter(Boolean).join(" · ")}</span>
                </span>
                {mineOrLead && <button className="ghost small" onClick={() => remove(a)}>Retirer</button>}
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <form className="att-link-form" onSubmit={addLink}>
          <label>Adresse du lien<input name="url" inputMode="url" placeholder="https://" autoFocus required /></label>
          <label>Libellé (facultatif)<input name="label" placeholder="Ex. : demande de fusion n° 22" /></label>
          <div className="form-actions">
            <button type="button" className="ghost" onClick={() => setAdding(false)}>Annuler</button>
            <button className="primary">Ajouter le lien</button>
          </div>
        </form>
      ) : (
        <div className="att-actions">
          <input ref={input} type="file" accept="image/*,application/pdf" hidden onChange={(e) => { attach(e.target.files?.[0]); e.target.value = ""; }} aria-label="Fichier à joindre" />
          <button onClick={() => input.current?.click()} disabled={busy}><PIcon name="clip" />{busy ? "Envoi…" : "Joindre un fichier"}</button>
          <button onClick={() => setAdding(true)}><PIcon name="link" />Ajouter un lien</button>
          <span className="muted small">Photo ou PDF, 1,4 Mo au plus. Les fichiers restent consultables hors ligne sur cet appareil.</span>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {viewing && <ReceiptViewer id={viewing.id} title={viewing.title} alt={viewing.title} onClose={() => setViewing(null)} />}
    </section>
  );
}

function History({ lines }: { lines: ReturnType<typeof taskHistory> }) {
  return (
    <section className="tp-section" aria-label="Historique de la tâche" data-testid="task-history">
      <ol className="history-list">
        {lines.map((l, i) => (
          <li key={`${l.at}-${i}`} className={`history-item ${l.kind}`}>
            <span className="history-dot" aria-hidden="true" />
            <div>
              <strong>{l.label}</strong>
              <span className="muted small">{[l.byName ? `par ${l.byName}` : "", stamp(l.at) || (l.kind === "created" ? "avant l'historique" : "")].filter(Boolean).join(" · ")}</span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
