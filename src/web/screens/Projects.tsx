/**
 * Projets : liste, fiche avec tâches (Kanban), planning (Gantt), temps passés,
 * rentabilité et facturation du temps. Tout fonctionne hors ligne.
 */
import { useMemo, useState, type DragEvent, type FormEvent } from "react";
import { can, formatDate, normalize, text, today, useApp, useSettings, useTable } from "../context.ts";
import { addDays, DEFAULT_PAYMENT_DAYS, DEFAULT_VAT_RATE, formatXaf } from "../../shared/invoice.ts";
import { BILLING_MODES, PROJECT_STATUS, projectStats, TASK_STATUS, timeToInvoiceLines } from "../../shared/projects.ts";
import type { SyncRecord } from "../../shared/sync.ts";
import { currencyOf, totalsOf } from "../ledger.ts";
import { formatMoney } from "../../shared/currency.ts";

const PRIORITY: Record<string, string> = { low: "Basse", normal: "Normale", high: "Haute" };
const hoursLabel = (h: number) => `${Math.round(h * 100) / 100} h`;

function useProjectData() {
  const tasks = useTable("tasks");
  const time_entries = useTable("time_entries");
  const expenses = useTable("expenses");
  const invoices = useTable("invoices");
  const credit_notes = useTable("credit_notes");
  return { tasks, time_entries, expenses, invoices, credit_notes };
}

export function Projects() {
  const { session } = useApp();
  const projects = useTable("projects");
  const clients = useTable("clients");
  const data = useProjectData();
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<SyncRecord | "new" | null>(null);
  const [status, setStatus] = useState("open");
  const [query, setQuery] = useState("");
  const manager = can.manageProjects(session.user.role);
  const clientName = (id: unknown) => text(clients.find((c) => c.id === id)?.data.name);

  if (open) {
    const project = projects.find((p) => p.id === open);
    if (project) return <ProjectDetail project={project} clientName={clientName(project.data.client_id)} onBack={() => setOpen(null)} />;
  }

  const q = normalize(query.trim());
  const rows = projects
    .filter((p) => status === "all" || (status === "open" ? !["done", "cancelled"].includes(text(p.data.status)) : p.data.status === status))
    .filter((p) => !q || normalize(`${text(p.data.name)} ${clientName(p.data.client_id)}`).includes(q))
    .sort((a, b) => text(a.data.end_date || "9999").localeCompare(text(b.data.end_date || "9999")));

  return (
    <section>
      <div className="section-head">
        <h2>Projets</h2>
        {manager && <button className="primary" onClick={() => setEditing("new")}>Nouveau projet</button>}
      </div>
      {editing && <ProjectForm record={editing === "new" ? null : editing} clients={clients} onClose={(id) => { setEditing(null); if (id) setOpen(id); }} />}
      <div className="toolbar">
        <input type="search" placeholder="Rechercher un projet ou un client" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Rechercher un projet" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Statut">
          <option value="open">En cours et planifiés</option>
          <option value="all">Tous</option>
          {Object.entries(PROJECT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {rows.length === 0 ? (
        <p className="empty">{projects.length === 0 ? "Aucun projet pour l'instant." : "Aucun projet pour ce filtre."}</p>
      ) : (
        <div className="project-grid">
          {rows.map((p) => {
            const s = projectStats(p, data, today());
            return (
              <button key={p.id} className="card project-card" onClick={() => setOpen(p.id)}>
                <div className="project-card-head">
                  <strong>{text(p.data.name)}</strong>
                  <span className={`badge ${p.data.status === "active" ? "ok" : p.data.status === "on_hold" ? "warn" : ""}`}>{PROJECT_STATUS[text(p.data.status)] ?? "—"}</span>
                </div>
                <div className="muted small">{clientName(p.data.client_id) || "Projet interne"}{p.data.end_date ? ` · fin ${formatDate(p.data.end_date)}` : ""}</div>
                <Progress value={s.progress} label={`${s.tasksDone}/${s.tasks} tâches`} />
                <dl className="mini-stats">
                  <div><dt>Heures</dt><dd>{hoursLabel(s.hours)}</dd></div>
                  <div><dt>Budget consommé</dt><dd className={s.budgetUsed > 100 ? "danger-text" : s.budgetUsed >= 80 ? "warn-text" : ""}>{s.budget ? `${s.budgetUsed} %` : "—"}</dd></div>
                  <div><dt>Marge</dt><dd className={s.margin < 0 ? "danger-text" : ""}>{formatXaf(s.margin)}</dd></div>
                </dl>
                {s.overdueTasks > 0 && <div className="danger-text small">{s.overdueTasks} tâche(s) en retard</div>}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Progress({ value, label }: { value: number; label?: string }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? "Avancement"}>
      <div className="progress-bar"><span style={{ width: `${Math.min(100, value)}%` }} /></div>
      <span className="small muted">{value} %{label ? ` · ${label}` : ""}</span>
    </div>
  );
}

function ProjectForm({ record, clients, onClose }: { record: SyncRecord | null; clients: SyncRecord[]; onClose: (openId?: string) => void }) {
  const { db, session } = useApp();
  const v = (k: string, fallback = "") => (record ? text(record.data[k]) : fallback);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const values: Record<string, unknown> = {
      name: f.name.trim(), client_id: f.client_id, status: f.status, billing: f.billing, manager: f.manager.trim(),
      start_date: f.start_date, end_date: f.end_date, description: f.description.trim(),
      budget: Math.round(Number(f.budget) || 0), hourly_rate: Math.round(Number(f.hourly_rate) || 0), cost_rate: Math.round(Number(f.cost_rate) || 0),
    };
    const id = record?.id ?? db.newId("prj");
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(values)) if (!record || record.data[k] !== val) patch[k] = val;
    if (!record) patch.created_by = session.user.id;
    if (Object.keys(patch).length) await db.write("projects", id, patch);
    onClose(record ? undefined : id);
  }
  return (
    <form className="card form-grid section-card" onSubmit={save}>
      <label className="wide">Nom du projet<input name="name" required defaultValue={v("name")} /></label>
      <label>
        Client
        <select name="client_id" defaultValue={v("client_id")}>
          <option value="">Projet interne</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{text(c.data.name)}</option>)}
        </select>
      </label>
      <label>
        Statut
        <select name="status" defaultValue={v("status", "active")}>
          {Object.entries(PROJECT_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <label>
        Facturation
        <select name="billing" defaultValue={v("billing", "time")}>
          {Object.entries(BILLING_MODES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <label>Chef de projet<input name="manager" defaultValue={v("manager", session.user.name)} /></label>
      <label>Début<input type="date" name="start_date" defaultValue={v("start_date", today())} /></label>
      <label>Fin prévue<input type="date" name="end_date" defaultValue={v("end_date")} /></label>
      <label>Budget HT (FCFA)<input type="number" min="0" name="budget" defaultValue={v("budget")} /></label>
      <label>Taux de facturation (FCFA / h)<input type="number" min="0" name="hourly_rate" defaultValue={v("hourly_rate")} /></label>
      <label>Coût horaire interne (FCFA / h)<input type="number" min="0" name="cost_rate" defaultValue={v("cost_rate")} /></label>
      <label className="wide">Description<textarea name="description" rows={2} defaultValue={v("description")} /></label>
      <div className="form-actions">
        <button type="button" className="ghost" onClick={() => onClose()}>Annuler</button>
        <button className="primary">Enregistrer le projet</button>
      </div>
    </form>
  );
}

type DetailView = "tasks" | "gantt" | "time" | "finance";

function ProjectDetail({ project, clientName, onBack }: { project: SyncRecord; clientName: string; onBack: () => void }) {
  const { session } = useApp();
  const data = useProjectData();
  const clients = useTable("clients");
  const [view, setView] = useState<DetailView>("tasks");
  const [editing, setEditing] = useState(false);
  const s = projectStats(project, data, today());
  const manager = can.manageProjects(session.user.role);
  const tasks = data.tasks.filter((t) => t.data.project_id === project.id);

  return (
    <section>
      <div className="section-head">
        <div>
          <button className="link" onClick={onBack}>← Projets</button>
          <h2>{text(project.data.name)}</h2>
          <div className="muted small">
            {clientName || "Projet interne"} · {PROJECT_STATUS[text(project.data.status)]} · {BILLING_MODES[text(project.data.billing)] ?? ""}
            {project.data.manager ? ` · ${text(project.data.manager)}` : ""}
          </div>
        </div>
        {manager && <button onClick={() => setEditing((e) => !e)}>{editing ? "Fermer" : "Modifier le projet"}</button>}
      </div>
      {editing && <ProjectForm record={project} clients={clients} onClose={() => setEditing(false)} />}

      <div className="kpis">
        <div className="card kpi"><div className="kpi-label">Avancement</div><div className="kpi-value">{s.progress} %</div><Progress value={s.progress} label={`${s.tasksDone}/${s.tasks} tâches`} /></div>
        <div className="card kpi"><div className="kpi-label">Heures passées / estimées</div><div className="kpi-value mono">{hoursLabel(s.hours)}</div><div className="muted small">{s.hoursEstimated ? `sur ${hoursLabel(s.hoursEstimated)} estimées` : "pas d'estimation"}</div></div>
        <div className="card kpi"><div className="kpi-label">Coûts (temps + dépenses)</div><div className="kpi-value mono">{formatXaf(s.costs)}</div>{s.budget > 0 && <div className={`small ${s.budgetUsed > 100 ? "danger-text" : "muted"}`}>{s.budgetUsed} % du budget de {formatXaf(s.budget)}</div>}</div>
        <div className="card kpi"><div className="kpi-label">Facturé (HT)</div><div className="kpi-value mono">{formatXaf(s.invoiced)}</div>{s.unbilledHours > 0 && <div className="small warn-text">{hoursLabel(s.unbilledHours)} non facturées</div>}</div>
        <div className={`card kpi ${s.margin < 0 ? "danger" : ""}`}><div className="kpi-label">Marge</div><div className="kpi-value mono" data-testid="project-margin">{formatXaf(s.margin)}</div></div>
      </div>

      <div className="segmented subnav" role="tablist">
        {([["tasks", "Tâches"], ["gantt", "Planning"], ["time", "Temps passés"], ["finance", "Facturation"]] as [DetailView, string][]).map(([v, l]) => (
          <button key={v} role="tab" aria-selected={view === v} className={view === v ? "active" : ""} onClick={() => setView(v)}>{l}</button>
        ))}
      </div>

      {view === "tasks" && <Kanban project={project} tasks={tasks} />}
      {view === "gantt" && <Gantt project={project} tasks={tasks} />}
      {view === "time" && <TimeEntries project={project} tasks={tasks} entries={data.time_entries.filter((t) => t.data.project_id === project.id)} invoices={data.invoices} />}
      {view === "finance" && <Finance project={project} data={data} />}
    </section>
  );
}

function Kanban({ project, tasks }: { project: SyncRecord; tasks: SyncRecord[] }) {
  const { db, session } = useApp();
  const [title, setTitle] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const order = TASK_STATUS.map(([k]) => k);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    await db.write("tasks", db.newId("tsk"), {
      project_id: project.id, title: title.trim(), status: "todo", priority: "normal", created_by: session.user.id, created_at: new Date().toISOString(),
    });
    setTitle("");
  }
  const move = (t: SyncRecord, status: string) => t.data.status !== status && db.write("tasks", t.id, { status, ...(status === "done" ? { done_at: new Date().toISOString() } : {}) });
  const onDrop = (e: DragEvent, status: string) => {
    e.preventDefault();
    setOver(null);
    const t = tasks.find((x) => x.id === e.dataTransfer.getData("text/plain"));
    if (t) move(t, status);
  };

  return (
    <div>
      <form className="toolbar" onSubmit={add}>
        <input placeholder="Nouvelle tâche" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Nouvelle tâche" />
        <button className="primary">Ajouter</button>
      </form>
      <div className="kanban">
        {TASK_STATUS.map(([status, label]) => {
          const col = tasks.filter((t) => (t.data.status ?? "todo") === status)
            .sort((a, b) => ({ high: 0, normal: 1, low: 2 }[text(a.data.priority)] ?? 1) - ({ high: 0, normal: 1, low: 2 }[text(b.data.priority)] ?? 1) || text(a.data.due_date || "9").localeCompare(text(b.data.due_date || "9")));
          return (
            <div key={status} className={`kanban-col ${over === status ? "over" : ""}`} data-testid={`col-${status}`}
              onDragOver={(e) => { e.preventDefault(); setOver(status); }} onDragLeave={() => setOver(null)} onDrop={(e) => onDrop(e, status)}>
              <div className="kanban-head"><span>{label}</span><span className="muted small">{col.length}</span></div>
              {col.map((t) => {
                const i = order.indexOf(status);
                const late = status !== "done" && typeof t.data.due_date === "string" && t.data.due_date < today();
                return (
                  <div key={t.id} className="task-card" draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", t.id)}>
                    {editing === t.id ? <TaskForm task={t} onClose={() => setEditing(null)} /> : (
                      <>
                        <button className="task-title" onClick={() => setEditing(t.id)}>{text(t.data.title)}</button>
                        <div className="task-meta">
                          {t.data.priority === "high" && <span className="badge danger">Haute</span>}
                          {t.data.assignee ? <span>{text(t.data.assignee)}</span> : null}
                          {t.data.due_date ? <span className={late ? "danger-text" : ""}>{formatDate(t.data.due_date)}</span> : null}
                          {t.data.estimate_hours ? <span>{hoursLabel(Number(t.data.estimate_hours))}</span> : null}
                        </div>
                        <div className="task-move">
                          {i > 0 && <button className="ghost small" onClick={() => move(t, order[i - 1])} aria-label={`Reculer vers ${TASK_STATUS[i - 1][1]}`}>←</button>}
                          {i < order.length - 1 && <button className="ghost small" onClick={() => move(t, order[i + 1])} aria-label={`Avancer vers ${TASK_STATUS[i + 1][1]}`}>→</button>}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TaskForm({ task, onClose }: { task: SyncRecord; onClose: () => void }) {
  const { db } = useApp();
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const values: Record<string, unknown> = { ...f, estimate_hours: Number(f.estimate_hours) || 0 };
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if ((task.data[k] ?? "") !== v) patch[k] = v;
    if (Object.keys(patch).length) await db.write("tasks", task.id, patch);
    onClose();
  }
  return (
    <form className="task-form" onSubmit={save}>
      <input name="title" required defaultValue={text(task.data.title)} aria-label="Titre" />
      <textarea name="description" rows={2} defaultValue={text(task.data.description)} placeholder="Description" aria-label="Description" />
      <input name="assignee" defaultValue={text(task.data.assignee)} placeholder="Responsable" aria-label="Responsable" />
      <label>Début<input type="date" name="start_date" defaultValue={text(task.data.start_date)} /></label>
      <label>Échéance<input type="date" name="due_date" defaultValue={text(task.data.due_date)} /></label>
      <label>Estimation (h)<input type="number" min="0" step="0.5" name="estimate_hours" defaultValue={text(task.data.estimate_hours)} /></label>
      <label>
        Priorité
        <select name="priority" defaultValue={text(task.data.priority) || "normal"}>
          {Object.entries(PRIORITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <div className="form-actions">
        <button type="button" className="ghost danger small" onClick={async () => { if (confirm("Supprimer la tâche ?")) { await db.remove("tasks", task.id); onClose(); } }}>Supprimer</button>
        <button type="button" className="ghost small" onClick={onClose}>Annuler</button>
        <button className="primary small">OK</button>
      </div>
    </form>
  );
}

/** Planning : une barre par tâche, du début à l'échéance, avec la date du jour. */
function Gantt({ project, tasks }: { project: SyncRecord; tasks: SyncRecord[] }) {
  const dated = tasks.filter((t) => t.data.start_date || t.data.due_date)
    .map((t) => ({ t, start: text(t.data.start_date || t.data.due_date), end: text(t.data.due_date || t.data.start_date) }))
    .sort((a, b) => a.start.localeCompare(b.start));
  if (dated.length === 0) return <p className="empty">Donnez une date de début ou une échéance aux tâches pour les voir sur le planning.</p>;
  const dates = [...dated.flatMap((d) => [d.start, d.end]), text(project.data.start_date), text(project.data.end_date), today()].filter(Boolean).sort();
  const from = dates[0];
  const to = addDays(dates[dates.length - 1], 1);
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 864e5;
  const span = Math.max(1, day(to) - day(from));
  const x = (d: string) => ((day(d) - day(from)) / span) * 100;
  // Repères de mois.
  const months: string[] = [];
  for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 10) < to; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (iso >= from) months.push(iso);
  }
  const fmtMonth = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("fr-FR", { month: "short", year: "2-digit" });
  return (
    <div className="card gantt">
      <div className="gantt-row gantt-axis">
        <div className="gantt-label" />
        <div className="gantt-track">
          {months.map((m) => <span key={m} className="gantt-month" style={{ left: `${x(m)}%` }}>{fmtMonth(m)}</span>)}
        </div>
      </div>
      {dated.map(({ t, start, end }) => {
        const status = text(t.data.status) || "todo";
        const late = status !== "done" && end < today();
        return (
          <div key={t.id} className="gantt-row">
            <div className="gantt-label" title={text(t.data.title)}>{text(t.data.title)}</div>
            <div className="gantt-track">
              {months.map((m) => <span key={m} className="gantt-grid" style={{ left: `${x(m)}%` }} />)}
              <span className="gantt-today" style={{ left: `${x(today())}%` }} />
              <span className={`gantt-bar ${status} ${late ? "late" : ""}`} style={{ left: `${x(start)}%`, width: `${Math.max(1.2, x(addDays(end, 1)) - x(start))}%` }}
                title={`${formatDate(start)} → ${formatDate(end)}`} />
            </div>
          </div>
        );
      })}
      <div className="legend gantt-legend">
        <span><i className="swatch gl-todo" /> À faire</span><span><i className="swatch gl-doing" /> En cours / à valider</span>
        <span><i className="swatch gl-done" /> Terminé</span><span><i className="swatch gl-late" /> En retard</span><span>│ aujourd'hui</span>
      </div>
    </div>
  );
}

function TimeEntries({ project, tasks, entries, invoices }: { project: SyncRecord; tasks: SyncRecord[]; entries: SyncRecord[]; invoices: SyncRecord[] }) {
  const { db, session } = useApp();
  const closedUntil = text(useSettings().closed_until);
  const [error, setError] = useState<string | null>(null);
  const invoiceIds = new Set(invoices.map((i) => i.id));
  const sorted = [...entries].sort((a, b) => text(b.data.date).localeCompare(text(a.data.date)));
  const total = entries.reduce((n, e) => n + Number(e.data.hours || 0), 0);
  const mine = entries.filter((e) => e.data.user_id === session.user.id).reduce((n, e) => n + Number(e.data.hours || 0), 0);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    const hours = Number(f.hours.replace(",", "."));
    if (!(hours > 0 && hours <= 24)) return setError("Durée invalide (entre 0 et 24 h).");
    if (closedUntil && f.date <= closedUntil) return setError(`Période clôturée jusqu'au ${formatDate(closedUntil)}.`);
    setError(null);
    await db.write("time_entries", db.newId("tmp"), {
      project_id: project.id, task_id: f.task_id, date: f.date, hours, note: f.note.trim(),
      billable: f.billable === "on", user_id: session.user.id, user_name: session.user.name,
    });
    form.reset();
  }

  return (
    <div>
      <form className="card form-grid section-card" onSubmit={add}>
        <label>Date<input type="date" name="date" required defaultValue={today()} /></label>
        <label>
          Tâche
          <select name="task_id" defaultValue="">
            <option value="">Sans tâche</option>
            {tasks.map((t) => <option key={t.id} value={t.id}>{text(t.data.title)}</option>)}
          </select>
        </label>
        <label>Durée (heures)<input name="hours" inputMode="decimal" required placeholder="1,5" aria-label="Durée (heures)" /></label>
        <label>Note<input name="note" placeholder="Ce qui a été fait" /></label>
        <label className="inline"><input type="checkbox" name="billable" defaultChecked /> Facturable</label>
        {error && <p className="error wide">{error}</p>}
        <div className="form-actions"><button className="primary">Enregistrer le temps</button></div>
      </form>
      <p className="muted small">Total : {hoursLabel(total)} · dont vous : {hoursLabel(mine)}</p>
      {sorted.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Personne</th><th>Tâche</th><th>Note</th><th className="right">Durée</th><th /></tr></thead>
            <tbody>
              {sorted.map((e) => {
                const billed = !!e.data.invoice_id && invoiceIds.has(text(e.data.invoice_id));
                const removable = !billed && (e.data.user_id === session.user.id || can.manageProjects(session.user.role)) && !(closedUntil && text(e.data.date) <= closedUntil);
                return (
                  <tr key={e.id}>
                    <td>{formatDate(e.data.date)}</td>
                    <td>{text(e.data.user_name)}</td>
                    <td>{text(tasks.find((t) => t.id === e.data.task_id)?.data.title)}</td>
                    <td className="muted">{text(e.data.note)}</td>
                    <td className="right mono">{hoursLabel(Number(e.data.hours || 0))}</td>
                    <td className="right nowrap">
                      {billed ? <span className="badge ok">Facturé</span> : e.data.billable === false ? <span className="badge">Non facturable</span> : null}
                      {removable && <button className="ghost small" onClick={() => db.remove("time_entries", e.id)}>Supprimer</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Finance({ project, data }: { project: SyncRecord; data: ReturnType<typeof useProjectData> }) {
  const { db, session, go } = useApp();
  const settings = useSettings();
  const s = projectStats(project, data, today());
  const invoices = data.invoices.filter((i) => i.data.project_id === project.id);
  const expenses = data.expenses.filter((e) => e.data.project_id === project.id);
  const invoiceIds = useMemo(() => new Set(data.invoices.map((i) => i.id)), [data.invoices]);
  const manager = can.manageProjects(session.user.role);
  const [percent, setPercent] = useState("30");
  const [message, setMessage] = useState<string | null>(null);

  const baseInvoice = () => ({
    status: "draft",
    client_id: text(project.data.client_id),
    date: today(),
    due_date: addDays(today(), Number(settings.payment_days ?? DEFAULT_PAYMENT_DAYS)),
    currency: "XAF",
    rate: 1,
    project_id: project.id,
    created_by: session.user.id,
  });

  async function billTime() {
    if (!project.data.client_id) return setMessage("Associez d'abord un client au projet.");
    if (!project.data.hourly_rate) return setMessage("Renseignez le taux de facturation horaire du projet.");
    const { lines, entryIds } = timeToInvoiceLines(project, data.tasks, data.time_entries, DEFAULT_VAT_RATE, invoiceIds);
    if (lines.length === 0) return setMessage("Aucun temps facturable en attente.");
    const id = db.newId("fa");
    await db.write("invoices", id, { ...baseInvoice(), lines, notes: `Temps passé sur le projet ${text(project.data.name)}` });
    for (const e of entryIds) await db.write("time_entries", e, { invoice_id: id });
    go("invoices", id);
  }

  async function billMilestone() {
    if (!project.data.client_id) return setMessage("Associez d'abord un client au projet.");
    const pct = Number(percent);
    const budget = Number(project.data.budget || 0);
    if (!(pct > 0 && pct <= 100) || !budget) return setMessage("Indiquez un pourcentage et un budget de projet.");
    const id = db.newId("fa");
    await db.write("invoices", id, {
      ...baseInvoice(),
      lines: [{ label: `${text(project.data.name)} · jalon ${pct} % du forfait`, qty: 1, unitPrice: Math.round((budget * pct) / 100), vatRate: DEFAULT_VAT_RATE }],
    });
    go("invoices", id);
  }

  return (
    <div className="two-cols">
      <div className="card section-card">
        <h3>Factures du projet</h3>
        {invoices.length === 0 ? <p className="muted small">Aucune facture rattachée.</p> : (
          <table>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => go("invoices", i.id)}>
                  <td className="mono">{text(i.data.number) || "Brouillon"}</td>
                  <td>{formatDate(i.data.date)}</td>
                  <td className="right mono">{formatMoney(totalsOf(i).net, currencyOf(i))} HT</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {manager && (
          <>
            <h3>Facturer</h3>
            <p className="muted small">
              {s.unbilledHours > 0 ? `${hoursLabel(s.unbilledHours)} non facturées, soit ${formatXaf(s.unbilledValue)} HT au taux du projet.` : "Aucun temps en attente de facturation."}
            </p>
            <div className="actions">
              <button className="primary" onClick={billTime} disabled={s.unbilledHours === 0}>Facturer le temps passé</button>
              <label className="inline">Jalon <input type="number" min="1" max="100" value={percent} onChange={(e) => setPercent(e.target.value)} style={{ width: 72 }} /> %</label>
              <button onClick={billMilestone}>Facturer un jalon du forfait</button>
            </div>
            {message && <p className="error">{message}</p>}
          </>
        )}
      </div>
      <div className="card section-card">
        <h3>Dépenses du projet</h3>
        {expenses.length === 0 ? <p className="muted small">Aucune dépense rattachée. Choisissez ce projet lors de la saisie d'une dépense.</p> : (
          <table>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id}>
                  <td>{formatDate(e.data.date)}</td>
                  <td>{text(e.data.supplier) || text(e.data.description)}</td>
                  <td className="right mono">{formatXaf(Number(e.data.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <dl className="totals">
          <dt>Temps ({hoursLabel(s.hours)} × coût interne)</dt><dd className="mono">{formatXaf(s.timeCost)}</dd>
          <dt>Dépenses HT</dt><dd className="mono">{formatXaf(s.expenses)}</dd>
          <dt className="strong">Coûts</dt><dd className="mono strong">{formatXaf(s.costs)}</dd>
          <dt>Facturé HT</dt><dd className="mono">{formatXaf(s.invoiced)}</dd>
          <dt className="strong">Marge</dt><dd className="mono strong">{formatXaf(s.margin)}</dd>
        </dl>
      </div>
    </div>
  );
}
