/**
 * Projets : liste, fiche avec tâches (Kanban), planning (Gantt), temps passés,
 * équipe du projet, rentabilité et facturation du temps. Tout fonctionne hors ligne.
 *
 * Lot 1 : responsables choisis dans l'annuaire, équipe du projet, vérification
 * À vérifier → Terminé par le responsable ou le commanditaire, aucun montant pour
 * l'employé, montants rangés dans la table protégée `project_finance`.
 *
 * Rédaction : dire ce qui se passe et son effet, sans renvoyer vers une hiérarchie.
 */
import { useEffect, useMemo, useState, type DragEvent, type FormEvent } from "react";
import { can, formatDate, normalize, text, today, useApp, useSettings, useTable } from "../context.ts";
import { addDays, DEFAULT_PAYMENT_DAYS, DEFAULT_VAT_RATE, formatXaf } from "../../shared/invoice.ts";
import { BILLING_MODES, financeOf, PROJECT_STATUS, projectStats, TASK_STATUS, timeToInvoiceLines } from "../../shared/projects.ts";
import { assigneeOf, BLOCK_LABELS, checkDayHours, daysBetween, hoursOn, matchTeamMember, MEMBER_ROLE_LABELS } from "../../shared/projectControl.ts";
import { canCloseTask, financeIdOf, memberIdOf, teamMemberIdOf } from "../../shared/projectRules.ts";
import type { SyncRecord } from "../../shared/sync.ts";
import { currencyOf, totalsOf } from "../ledger.ts";
import { formatMoney } from "../../shared/currency.ts";
import { localProjectContext } from "../local/guard.ts";
import { migrateFinance, useGuardedWrite, useTeam } from "./team.ts";
import { Team } from "./Team.tsx";
import { Initials, PIcon } from "./ProjectIcons.tsx";

const PRIORITY: Record<string, string> = { low: "Basse", normal: "Normale", high: "Haute" };
const hoursLabel = (h: number) => `${(Math.round(h * 100) / 100).toLocaleString("fr-FR")} h`;
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const live = (r: SyncRecord) => !r.data._deleted;

function useProjectData() {
  const tasks = useTable("tasks");
  const time_entries = useTable("time_entries");
  const expenses = useTable("expenses");
  const invoices = useTable("invoices");
  const credit_notes = useTable("credit_notes");
  const project_finance = useTable("project_finance");
  const cost_rates = useTable("cost_rates");
  return { tasks, time_entries, expenses, invoices, credit_notes, project_finance, cost_rates };
}

/** Membres (non retirés) de l'équipe d'un projet. */
function useMembers(projectId?: string): SyncRecord[] {
  const all = useTable("project_members");
  return useMemo(() => all.filter((m) => live(m) && (!projectId || m.data.project_id === projectId)), [all, projectId]);
}

/** Responsable du projet affiché : l'équipe du projet, sinon l'ancien texte libre. */
function managerName(project: SyncRecord, members: SyncRecord[]): { name: string; legacy: boolean } | null {
  const m = members.find((x) => x.data.project_id === project.id && x.data.role === "manager");
  if (m) return { name: text(m.data.name), legacy: false };
  return project.data.manager ? { name: text(project.data.manager), legacy: true } : null;
}

export function Projects({ open: initialOpen = null }: { open?: string | null }) {
  const { db, session } = useApp();
  const projects = useTable("projects");
  const clients = useTable("clients");
  const tasks = useTable("tasks");
  const members = useMembers();
  const data = useProjectData();
  const [open, setOpen] = useState<string | null>(initialOpen);
  const [view, setView] = useState<"list" | "team">("list");
  const [editing, setEditing] = useState<SyncRecord | "new" | null>(null);
  const [status, setStatus] = useState("open");
  const [query, setQuery] = useState("");
  const role = session.user.role;
  const manager = can.manageProjects(role);
  const amounts = can.seeAmounts(role);
  const clientName = (id: unknown) => text(clients.find((c) => c.id === id)?.data.name);
  const me = teamMemberIdOf(session.user.id);

  // Reprise des montants des anciens projets (direction, idempotent).
  useEffect(() => { migrateFinance(db, session).catch(() => {}); }, [db, session, projects.length]);
  useEffect(() => { if (initialOpen) setOpen(initialOpen); }, [initialOpen]);

  if (open) {
    const project = projects.find((p) => p.id === open);
    if (project) return <ProjectDetail project={project} clientName={clientName(project.data.client_id)} onBack={() => setOpen(null)} />;
  }

  // Employé : ses projets (équipe, tâches attribuées) et les anciens projets sans équipe (filtre d'affichage, MVP).
  const mine = (p: SyncRecord) => {
    if (role !== "employee") return true;
    const team = members.filter((m) => m.data.project_id === p.id);
    return team.length === 0 || team.some((m) => m.data.team_member_id === me) || tasks.some((t) => t.data.project_id === p.id && t.data.assignee_id === me);
  };
  const q = normalize(query.trim());
  const rows = projects
    .filter(mine)
    .filter((p) => status === "all" || (status === "open" ? !["done", "cancelled"].includes(text(p.data.status)) : p.data.status === status))
    .filter((p) => !q || normalize(`${text(p.data.name)} ${clientName(p.data.client_id)}`).includes(q))
    .sort((a, b) => text(a.data.end_date || "9999").localeCompare(text(b.data.end_date || "9999")));

  const visibleProjects = projects.filter(mine);
  return (
    <section>
      <div className="section-head">
        <h2>{view === "team" ? "Personnes" : "Projets"}</h2>
        <div className="head-actions">
          {manager && (
            <div className="segmented" role="tablist" aria-label="Affichage">
              <button role="tab" aria-selected={view === "list"} className={view === "list" ? "active" : ""} onClick={() => setView("list")}>Projets</button>
              <button role="tab" aria-selected={view === "team"} className={view === "team" ? "active" : ""} onClick={() => setView("team")}>Personnes</button>
            </div>
          )}
          {manager && view === "list" && visibleProjects.length > 0 && !editing && <button className="primary" onClick={() => setEditing("new")}>Nouveau projet</button>}
        </div>
      </div>
      {view === "team" ? <Team /> : (
        <>
          {editing && <ProjectForm record={editing === "new" ? null : editing} clients={clients} onClose={(id) => { setEditing(null); if (id) setOpen(id); }} />}
          {visibleProjects.length > 0 && (
            <div className="toolbar">
              <input type="search" placeholder="Rechercher un projet ou un client" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Rechercher un projet" />
              <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Statut">
                <option value="open">En cours et planifiés</option>
                <option value="all">Tous les projets</option>
                {Object.entries(PROJECT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          )}
          {rows.length === 0 ? (
            visibleProjects.length === 0 ? (
              !editing && (
                <div className="empty-state">
                  <span className="empty-ico" aria-hidden="true"><PIcon name="folder" /></span>
                  <h3 className="empty-title">{manager ? "Aucun projet pour l'instant" : "Aucun projet pour vous pour l'instant"}</h3>
                  <p className="muted">
                    {manager
                      ? "Un projet regroupe les tâches, le temps passé et la facturation d'un chantier ou d'une mission."
                      : "Les projets sur lesquels vous travaillez apparaîtront ici, avec vos tâches."}
                  </p>
                  {manager && <button className="primary" onClick={() => setEditing("new")}>Nouveau projet</button>}
                </div>
              )
            ) : (
              <div className="empty-state">
                <h3 className="empty-title">Aucun projet ne correspond</h3>
                <p className="muted">{q ? `Aucun projet ne contient « ${query.trim()} » avec ce statut.` : "Aucun projet n'a ce statut."}</p>
                <button onClick={() => { setQuery(""); setStatus("all"); }}>Afficher tous les projets</button>
              </div>
            )
          ) : (
            <div className="project-grid">
              {rows.map((p) => {
                const s = projectStats(p, data, today());
                const lead = managerName(p, members);
                const blocked = tasks.filter((t) => t.data.project_id === p.id && t.data.blocked && t.data.status !== "done").length;
                return (
                  <button key={p.id} className="card project-card" onClick={() => setOpen(p.id)}>
                    <div className="project-card-head">
                      <strong>{text(p.data.name)}</strong>
                      <span className={`badge ${p.data.status === "active" ? "ok" : p.data.status === "on_hold" ? "warn" : ""}`}>{PROJECT_STATUS[text(p.data.status)] ?? "—"}</span>
                    </div>
                    <div className="muted small project-card-meta">
                      <span>{[clientName(p.data.client_id) || (amounts ? "Projet interne" : ""), p.data.end_date ? `fin prévue le ${formatDate(p.data.end_date)}` : ""].filter(Boolean).join(" · ")}</span>
                      {lead && <span>Responsable : {lead.name}</span>}
                    </div>
                    {s.tasks > 0 ? <Progress value={s.progress} label={`${s.tasksDone}/${s.tasks} tâches terminées`} /> : <p className="muted small project-card-empty">Aucune tâche pour l'instant</p>}
                    {amounts ? (
                      <dl className="mini-stats">
                        <div><dt>Heures</dt><dd>{hoursLabel(s.hours)}</dd></div>
                        <div><dt>Budget consommé</dt><dd className={s.budgetUsed > 100 ? "danger-text" : s.budgetUsed >= 80 ? "warn-text" : ""}>{s.budget ? `${s.budgetUsed} %` : "—"}</dd></div>
                        <div><dt>Marge</dt><dd className={s.margin < 0 ? "danger-text" : ""}>{formatXaf(s.margin)}</dd></div>
                      </dl>
                    ) : (
                      <dl className="mini-stats">
                        <div><dt>Heures</dt><dd>{hoursLabel(s.hours)}</dd></div>
                        <div><dt>Mes tâches</dt><dd>{tasks.filter((t) => t.data.project_id === p.id && t.data.assignee_id === me && t.data.status !== "done").length}</dd></div>
                      </dl>
                    )}
                    {(s.overdueTasks > 0 || blocked > 0) && (
                      <div className="card-alerts small">
                        {s.overdueTasks > 0 && <span className="danger-text">{plural(s.overdueTasks, "tâche en retard", "tâches en retard")}</span>}
                        {blocked > 0 && <span className="danger-text">{plural(blocked, "tâche bloquée", "tâches bloquées")}</span>}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Progress({ value, label, hideValue = false }: { value: number; label?: string; hideValue?: boolean }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? "Avancement"}>
      <div className="progress-bar"><span style={{ width: `${Math.min(100, value)}%` }} /></div>
      <span className="small muted">{hideValue ? label : `${value} %${label ? ` · ${label}` : ""}`}</span>
    </div>
  );
}

function ProjectForm({ record, clients, onClose }: { record: SyncRecord | null; clients: SyncRecord[]; onClose: (openId?: string) => void }) {
  const { db, session } = useApp();
  const team = useTeam().filter((m) => m.data.active !== false);
  const finances = useTable("project_finance");
  const members = useMembers(record?.id);
  const v = (k: string, fallback = "") => (record ? text(record.data[k]) : fallback);
  const fin = record ? financeOf(record, finances) : null;
  const currentLead = members.find((m) => m.data.role === "manager");
  const legacyLead = record && !currentLead ? matchTeamMember(record.data.manager, team) : null;
  const defaultLead = currentLead ? text(currentLead.data.team_member_id) : legacyLead ? legacyLead.id : record ? "" : teamMemberIdOf(session.user.id);
  const amounts = can.seeAmounts(session.user.role);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const lead = team.find((m) => m.id === f.lead);
    const values: Record<string, unknown> = {
      name: f.name.trim(), client_id: f.client_id, status: f.status, billing: f.billing,
      start_date: f.start_date, end_date: f.end_date, description: f.description.trim(), site_address: (f.site_address ?? "").trim(),
      ...(lead ? { manager: text(lead.data.name) } : {}),
    };
    const id = record?.id ?? db.newId("prj");
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(values)) if (!record || (record.data[k] ?? "") !== val) patch[k] = val;
    if (!record) Object.assign(patch, { created_by: session.user.id, created_at: new Date().toISOString() });
    if (Object.keys(patch).length) await db.write("projects", id, patch);

    // Montants : ligne protégée, jamais envoyée à l'employé.
    if (amounts && "budget" in f) {
      const money = { legacy_budget: Math.round(Number(f.budget) || 0), hourly_rate: Math.round(Number(f.hourly_rate) || 0), cost_rate: Math.round(Number(f.cost_rate) || 0) };
      const before = { legacy_budget: fin?.budget ?? 0, hourly_rate: fin?.hourlyRate ?? 0, cost_rate: fin?.costRate ?? 0 };
      const finPatch: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(money)) if (before[k as keyof typeof before] !== val || !finances.some((x) => x.id === financeIdOf(id))) finPatch[k] = val;
      if (Object.keys(finPatch).length) {
        if (!finances.some((x) => x.id === financeIdOf(id))) Object.assign(finPatch, { project_id: id, created_by: session.user.id, created_at: new Date().toISOString() });
        await db.write("project_finance", financeIdOf(id), finPatch);
      }
    }

    // Responsable du projet : une ligne d'équipe déterministe ; l'ancien responsable reste dans l'équipe.
    if (lead && (!currentLead || currentLead.data.team_member_id !== lead.id)) {
      if (currentLead) await db.write("project_members", currentLead.id, { role: "member" });
      await db.write("project_members", memberIdOf(id, lead.id), {
        project_id: id, team_member_id: lead.id, user_id: text(lead.data.user_id), name: text(lead.data.name), role: "manager", _deleted: false,
        created_by: session.user.id, created_at: new Date().toISOString(),
      });
    }
    onClose(record ? undefined : id);
  }
  return (
    <form className="card form-grid section-card" onSubmit={save}>
      <h3 className="wide">{record ? "Modifier le projet" : "Nouveau projet"}</h3>
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
      <label>
        Responsable du projet
        <select name="lead" defaultValue={defaultLead}>
          <option value="">{record?.data.manager && !currentLead ? `${text(record.data.manager)} (à choisir dans la liste)` : "À choisir"}</option>
          {team.map((m) => <option key={m.id} value={m.id}>{text(m.data.name)}</option>)}
        </select>
      </label>
      <label>Début<input type="date" name="start_date" defaultValue={v("start_date", today())} /></label>
      <label>Fin prévue<input type="date" name="end_date" defaultValue={v("end_date")} /></label>
      <label className="wide">Adresse ou site<input name="site_address" defaultValue={v("site_address")} placeholder="Ex. : Agence BGFI, carrefour SNI, Owendo" /></label>
      {amounts && (
        <>
          <label>Budget HT (FCFA)<input type="number" min="0" name="budget" defaultValue={fin?.budget || ""} /></label>
          <label>Taux de facturation (FCFA / h)<input type="number" min="0" name="hourly_rate" defaultValue={fin?.hourlyRate || ""} /></label>
          <label>Coût horaire interne (FCFA / h)<input type="number" min="0" name="cost_rate" defaultValue={fin?.costRate || ""} /></label>
          <p className="wide muted small form-note">Montants confidentiels : ils ne sont jamais affichés ni envoyés sur les appareils des employés.</p>
        </>
      )}
      <label className="wide">Description<textarea name="description" rows={2} defaultValue={v("description")} /></label>
      <div className="form-actions">
        <button type="button" className="ghost" onClick={() => onClose()}>Annuler</button>
        <button className="primary">{record ? "Enregistrer le projet" : "Créer le projet"}</button>
      </div>
    </form>
  );
}

type DetailView = "tasks" | "gantt" | "time" | "team" | "finance";

function ProjectDetail({ project, clientName, onBack }: { project: SyncRecord; clientName: string; onBack: () => void }) {
  const { session } = useApp();
  const data = useProjectData();
  const clients = useTable("clients");
  const members = useMembers(project.id);
  const [view, setView] = useState<DetailView>("tasks");
  const [editing, setEditing] = useState(false);
  const s = projectStats(project, data, today());
  const role = session.user.role;
  const manager = can.manageProjects(role);
  const amounts = can.seeAmounts(role);
  const tasks = data.tasks.filter((t) => t.data.project_id === project.id);
  const entries = data.time_entries.filter((t) => t.data.project_id === project.id);
  const lead = managerName(project, members);
  const estimated = amounts && !can.seePersonCosts(role) && s.hours > 0;
  // Projet qui démarre : des indicateurs à zéro n'apprennent rien, on les montre dès qu'il y a de l'activité.
  const started = s.tasksDone > 0 || s.hours > 0 || s.costs > 0 || s.invoiced > 0;
  const tabs: [DetailView, string, string?][] = [
    ["tasks", "Tâches", tasks.length ? String(tasks.length) : undefined],
    ["gantt", "Planning"],
    ["time", "Temps", s.hours ? hoursLabel(s.hours) : undefined],
    ["team", "Équipe", members.length ? String(members.length) : undefined],
    ...(amounts ? [["finance", "Facturation"]] as [DetailView, string][] : []),
  ];

  return (
    <section>
      <div className="section-head">
        <div>
          <button className="link" onClick={onBack}>← Projets</button>
          <h2>{text(project.data.name)}</h2>
          <div className="project-meta muted small">
            {clientName || amounts ? <span>{clientName || "Projet interne"}</span> : null}
            <span>{PROJECT_STATUS[text(project.data.status)]}</span>
            {amounts && BILLING_MODES[text(project.data.billing)] && <span>{BILLING_MODES[text(project.data.billing)]}</span>}
            {lead && <span>Responsable : {lead.name}</span>}
            {project.data.end_date ? <span>{project.data.start_date ? `${formatDate(project.data.start_date)} → ` : "fin prévue le "}{formatDate(project.data.end_date)}</span> : project.data.start_date ? <span>depuis le {formatDate(project.data.start_date)}</span> : null}
            {project.data.site_address ? <span>{text(project.data.site_address)}</span> : null}
          </div>
        </div>
        {manager && !editing && <button onClick={() => setEditing(true)}>Modifier le projet</button>}
      </div>
      {editing && <ProjectForm record={project} clients={clients} onClose={() => setEditing(false)} />}

      {started && (
        <div className={`kpis ${amounts ? "five" : "two"}`}>
          <div className="card kpi"><div className="kpi-label">Avancement</div><div className="kpi-value">{s.progress} %</div><Progress value={s.progress} label={`${s.tasksDone}/${s.tasks} tâches terminées`} hideValue /></div>
          <div className="card kpi"><div className="kpi-label">Temps passé</div><div className="kpi-value mono">{hoursLabel(s.hours)}</div><div className="muted small">{s.hoursEstimated ? `sur ${hoursLabel(s.hoursEstimated)} estimées` : "aucune estimation sur les tâches"}</div></div>
          {amounts && (
            <>
              <div className="card kpi"><div className="kpi-label">Coûts (temps + dépenses)</div><div className="kpi-value mono">{formatXaf(s.costs)}</div>{s.budget > 0 ? <div className={`small ${s.budgetUsed > 100 ? "danger-text" : "muted"}`}>{s.budgetUsed} % du budget de {formatXaf(s.budget)}</div> : estimated ? <div className="small muted">Temps estimé au coût moyen</div> : null}</div>
              <div className="card kpi"><div className="kpi-label">Facturé (HT)</div><div className="kpi-value mono">{formatXaf(s.invoiced)}</div>{s.unbilledHours > 0 && <div className="small warn-text">{hoursLabel(s.unbilledHours)} pas encore facturées</div>}</div>
              <div className={`card kpi ${s.margin < 0 ? "danger" : ""}`}><div className="kpi-label">Marge</div><div className="kpi-value mono" data-testid="project-margin">{formatXaf(s.margin)}</div>{estimated ? <div className="small muted">Estimation au coût moyen</div> : s.margin < 0 && s.invoiced === 0 ? <div className="small muted">Rien n'est encore facturé</div> : null}</div>
            </>
          )}
        </div>
      )}

      <div className="segmented subnav" role="tablist" aria-label="Rubriques du projet">
        {tabs.map(([v, l, n]) => (
          <button key={v} role="tab" aria-selected={view === v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
            {l}{n ? <span className="seg-count">{n}</span> : null}
          </button>
        ))}
      </div>

      {view === "tasks" && <Kanban project={project} tasks={tasks} members={members} onTeam={() => setView("team")} />}
      {view === "gantt" && <Gantt project={project} tasks={tasks} />}
      {view === "time" && <TimeEntries project={project} tasks={tasks} entries={entries} invoices={data.invoices} />}
      {view === "team" && <ProjectTeam project={project} members={members} />}
      {view === "finance" && amounts && <Finance project={project} data={data} />}
    </section>
  );
}

/** Équipe du projet : responsable, commanditaire et membres, choisis dans l'annuaire. */
function ProjectTeam({ project, members }: { project: SyncRecord; members: SyncRecord[] }) {
  const { db, session } = useApp();
  const team = useTeam();
  const write = useGuardedWrite();
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);
  const editable = ["admin", "director", "sales", "project_manager"].includes(session.user.role);
  const directory = can.manageTeam(session.user.role);
  const available = team.filter((m) => m.data.active !== false && !members.some((x) => x.data.team_member_id === m.id));
  const legacy = !members.some((m) => m.data.role === "manager") && project.data.manager ? text(project.data.manager) : "";
  const legacyMatch = legacy ? matchTeamMember(legacy, team) : null;

  async function add(tmId: string, role = "member") {
    const m = team.find((x) => x.id === tmId);
    if (!m) return;
    setError(null);
    try {
      await write("project_members", memberIdOf(project.id, m.id), {
        project_id: project.id, team_member_id: m.id, user_id: text(m.data.user_id), name: text(m.data.name), role, _deleted: false,
        created_by: session.user.id, created_at: new Date().toISOString(),
      });
      setPick("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "La personne n'a pas pu être ajoutée.");
    }
  }
  const sorted = [...members].sort((a, b) => ["manager", "sponsor", "member"].indexOf(text(a.data.role)) - ["manager", "sponsor", "member"].indexOf(text(b.data.role)) || text(a.data.name).localeCompare(text(b.data.name)));

  return (
    <div className="card section-card project-team">
      <div className="card-head">
        <h3>Équipe du projet</h3>
        <span className="muted small">{plural(members.length, "personne", "personnes")}</span>
      </div>
      {legacy && (
        <p className="notice legacy-note">
          Responsable saisi avant l'annuaire : « {legacy} ».{" "}
          {editable && legacyMatch ? <button className="link" onClick={() => add(legacyMatch.id, "manager")}>Choisir {text(legacyMatch.data.name)}</button> : editable ? "Choisissez la personne dans la liste ci-dessous." : null}
        </p>
      )}
      {sorted.length === 0 ? <p className="muted small">Personne n'est encore sur ce projet. Les personnes ajoutées retrouvent leurs tâches dans « Ma journée ».</p> : (
        <ul className="member-list">
          {sorted.map((m) => {
            const person = team.find((x) => x.id === m.data.team_member_id);
            return (
              <li key={m.id}>
                <Initials name={text(m.data.name)} />
                <span className="member-name"><strong>{text(m.data.name)}</strong>{person?.data.job ? <span className="muted small">{text(person.data.job)}</span> : null}</span>
                {editable ? (
                  <select value={text(m.data.role) || "member"} aria-label={`Rôle de ${text(m.data.name)} dans le projet`} onChange={(e) => db.write("project_members", m.id, { role: e.target.value })}>
                    {Object.entries(MEMBER_ROLE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                ) : <span className="badge">{MEMBER_ROLE_LABELS[text(m.data.role)] ?? "Membre"}</span>}
                {editable && <button className="ghost small" onClick={() => db.write("project_members", m.id, { _deleted: true })}>Retirer</button>}
              </li>
            );
          })}
        </ul>
      )}
      {editable && (
        <div className="member-add">
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Personne à ajouter">
            <option value="">{available.length ? "Choisir une personne" : "Toutes les personnes sont déjà sur le projet"}</option>
            {available.map((m) => <option key={m.id} value={m.id}>{text(m.data.name)}{m.data.job ? ` · ${text(m.data.job)}` : ""}</option>)}
          </select>
          <button onClick={() => add(pick)} disabled={!pick}>Ajouter à l'équipe</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <p className="muted small">Les tâches « À vérifier » sont closes par le responsable du projet ou le commanditaire.{" "}
        {editable && (directory ? "Une personne manque dans la liste ? Ajoutez-la dans Projets › Personnes." : "La liste reprend les personnes actives de Projets › Personnes.")}
      </p>
    </div>
  );
}

const lateLabel = (days: number) => (days === 1 ? "En retard d'1 j" : `En retard de ${days} j`);

/**
 * Actions d'une carte, dites avec un verbe plutôt qu'avec des flèches.
 * Qui peut clore passe directement à Terminé ; les autres envoient la tâche « À vérifier ».
 */
function stepsOf(status: string, canClose: boolean, mine: boolean): { to: string; label: string; main?: boolean }[] {
  switch (status) {
    case "todo": return canClose || mine ? [{ to: "doing", label: "Commencer", main: true }] : [];
    case "doing": return canClose ? [{ to: "done", label: "Terminer", main: true }] : mine ? [{ to: "review", label: "J'ai terminé", main: true }] : [];
    case "review": return canClose ? [{ to: "done", label: "Clore la tâche", main: true }, { to: "doing", label: "Reprendre" }] : mine ? [{ to: "doing", label: "Reprendre" }] : [];
    case "done": return canClose ? [{ to: "doing", label: "Rouvrir" }] : [];
    default: return [];
  }
}

function Kanban({ project, tasks, members, onTeam }: { project: SyncRecord; tasks: SyncRecord[]; members: SyncRecord[]; onTeam: () => void }) {
  const { db, session } = useApp();
  const write = useGuardedWrite();
  const team = useTeam();
  const projects = useTable("projects");
  const actor = { userId: session.user.id, role: session.user.role };
  const ctx = localProjectContext(projects, members);
  const canClose = canCloseTask(actor, project.id, ctx);
  const employee = session.user.role === "employee" && !canClose;
  const me = teamMemberIdOf(session.user.id);
  const [title, setTitle] = useState("");
  const [assignTo, setAssignTo] = useState(employee ? me : "");
  const [editing, setEditing] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // L'employé arrive sur ses propres tâches quand il en a sur ce projet.
  const [picked, setWho] = useState<string | null>(null);
  const who = picked ?? (employee && tasks.some((t) => t.data.assignee_id === me) ? me : "all");
  const [error, setError] = useState<string | null>(null);
  const order = TASK_STATUS.map(([k]) => k);

  // Personnes du filtre : l'équipe du projet et les personnes chargées des tâches.
  const people = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) map.set(text(m.data.team_member_id), text(m.data.name));
    for (const t of tasks) {
      const a = assigneeOf(t, team);
      if (a && !a.legacy) map.set(a.id, a.name);
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], "fr"));
  }, [members, tasks, team]);
  const assignable = employee ? [] : people;

  async function add(e: FormEvent) {
    e.preventDefault();
    const name = title.trim();
    if (!name) return;
    setError(null);
    // Champ vidé tout de suite : on peut enchaîner la tâche suivante.
    setTitle("");
    try {
      await write("tasks", db.newId("tsk"), {
        project_id: project.id, title: name, status: "todo", priority: "normal", created_by: session.user.id, created_at: new Date().toISOString(),
        ...(assignTo ? { assignee_id: assignTo } : {}),
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
  function move(t: SyncRecord, status: string) {
    if (t.data.status === status) return;
    // Une tâche libre commencée par un employé lui est attribuée.
    const take = employee && status === "doing" && !t.data.assignee_id ? { assignee_id: me } : {};
    return patch(t, { status, ...take, ...(status === "done" ? { done_at: new Date().toISOString(), blocked: false } : {}) });
  }
  const onDrop = (e: DragEvent, status: string) => {
    e.preventDefault();
    setOver(null);
    const t = tasks.find((x) => x.id === e.dataTransfer.getData("text/plain"));
    if (t) move(t, status);
  };
  const visible = tasks.filter((t) => who === "all" || (who === "none" ? !t.data.assignee_id && !t.data.assignee : t.data.assignee_id === who));
  const day = today();

  return (
    <div>
      <div className="kanban-tools">
        <form className="kanban-add" onSubmit={add}>
          <input placeholder="Titre de la nouvelle tâche" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Nouvelle tâche" />
          <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} aria-label="Attribuer à">
            {employee && <option value={me}>À moi</option>}
            <option value="">Non attribuée</option>
            {assignable.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </select>
          <button className="primary" disabled={!title.trim()}>Ajouter la tâche</button>
        </form>
        {tasks.length > 0 && (
          <label className="people-filter">
            <span className="muted small">Afficher</span>
            <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Filtrer par personne">
              <option value="all">Toutes les tâches</option>
              {people.some(([id]) => id === me) && <option value={me}>Mes tâches</option>}
              <option value="none">Non attribuées</option>
              {people.filter(([id]) => id !== me).map(([id, n]) => <option key={id} value={id}>{n}</option>)}
            </select>
          </label>
        )}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {tasks.length === 0 ? (
        <div className="card empty-state kanban-empty">
          <span className="empty-ico" aria-hidden="true"><PIcon name="list" /></span>
          <h3 className="empty-title">Aucune tâche pour l'instant</h3>
          <p className="muted">
            Ajoutez une première tâche avec le champ ci-dessus : elle arrive dans « À faire ».
            {members.length === 0 && !employee ? " Pour attribuer des tâches, ajoutez d'abord les personnes du projet." : ""}
          </p>
          {members.length === 0 && !employee && <button onClick={onTeam}>Ajouter des personnes au projet</button>}
        </div>
      ) : (
      <div className="kanban">
        {TASK_STATUS.map(([status, label]) => {
          const col = visible.filter((t) => (t.data.status ?? "todo") === status)
            .sort((a, b) => Number(!!b.data.blocked) - Number(!!a.data.blocked) || ({ high: 0, normal: 1, low: 2 }[text(a.data.priority)] ?? 1) - ({ high: 0, normal: 1, low: 2 }[text(b.data.priority)] ?? 1) || text(a.data.due_date || "9").localeCompare(text(b.data.due_date || "9")));
          return (
            <div key={status} className={`kanban-col ${over === status ? "over" : ""}${col.length === 0 ? " is-empty" : ""}`} data-testid={`col-${status}`}
              onDragOver={(e) => { e.preventDefault(); setOver(status); }} onDragLeave={() => setOver(null)} onDrop={(e) => onDrop(e, status)}>
              <div className="kanban-head">
                <span>{label}{status === "review" && <span className="kanban-sub">closes après vérification</span>}</span>
                <span className="kanban-count">{col.length}</span>
              </div>
              {col.length === 0 && <p className="kanban-none">Aucune tâche</p>}
              {col.map((t) => {
                const due = text(t.data.due_date);
                const late = status !== "done" && due && due < day ? daysBetween(due, day) : 0;
                const person = assigneeOf(t, team);
                const mine = t.data.assignee_id === me || (!t.data.assignee_id && !t.data.assignee);
                const steps = stepsOf(status, canClose, mine);
                return (
                  <div key={t.id} className={`task-card${t.data.blocked ? " blocked" : ""}`} draggable={editing !== t.id} onDragStart={(e) => e.dataTransfer.setData("text/plain", t.id)}>
                    {editing === t.id ? (employee
                      ? <EmployeeTaskForm task={t} onClose={() => setEditing(null)} />
                      : <TaskForm task={t} members={members} onClose={() => setEditing(null)} />) : (
                      <>
                        <button className="task-title" onClick={() => setEditing(t.id)} title={employee ? "Voir la tâche" : "Modifier la tâche"}>{text(t.data.title)}</button>
                        {(t.data.priority === "high") && <div className="task-tags"><span className="tag danger">Priorité haute</span></div>}
                        {t.data.blocked ? (
                          <div className="task-blocked"><PIcon name="alert" />Bloquée : {BLOCK_LABELS[text(t.data.blocked_reason)] ?? "motif non précisé"}{t.data.blocked_note ? ` (${text(t.data.blocked_note)})` : ""}</div>
                        ) : null}
                        <div className="task-foot">
                          {person ? (
                            <span className={`task-who${person.legacy ? " legacy" : ""}`} title={person.legacy ? "Nom saisi avant l'annuaire" : undefined}>
                              <Initials name={person.name} />{person.name}
                            </span>
                          ) : <span className="task-who none">Non attribuée</span>}
                          <span className="task-facts">
                            {late > 0 ? <span className="danger-text strong">{lateLabel(late)}</span> : due ? <span title="Échéance">{formatDate(due).slice(0, 5)}</span> : null}
                            {t.data.estimate_hours ? <span title="Estimation">{hoursLabel(Number(t.data.estimate_hours))}</span> : null}
                          </span>
                        </div>
                        {(steps.length > 0 || (status === "review" && !canClose) || (t.data.blocked && (canClose || mine))) && (
                          <div className="task-move">
                            {status === "review" && !canClose && <span className="muted small">En attente de vérification</span>}
                            {t.data.blocked && (canClose || mine) ? <button className="ghost small" onClick={() => patch(t, { blocked: false, blocked_reason: "", blocked_note: "" })}>Débloquer</button> : null}
                            {steps.map((s) => (
                              <button key={s.to} className={`small${s.main ? "" : " ghost"}`} onClick={() => move(t, s.to)}>{s.label}</button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}

function TaskForm({ task, members, onClose }: { task: SyncRecord; members: SyncRecord[]; onClose: () => void }) {
  const write = useGuardedWrite();
  const team = useTeam();
  const [error, setError] = useState<string | null>(null);
  const legacy = !task.data.assignee_id && task.data.assignee ? text(task.data.assignee) : "";
  const suggestion = legacy ? matchTeamMember(legacy, team) : null;
  const [assignee, setAssignee] = useState(text(task.data.assignee_id));
  // Personnes du projet d'abord, puis le reste de l'annuaire actif.
  const inProject = new Set(members.map((m) => text(m.data.team_member_id)));
  const choices = team.filter((m) => m.data.active !== false || m.id === assignee);
  const ordered = [...choices.filter((m) => inProject.has(m.id)), ...choices.filter((m) => !inProject.has(m.id))];

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const values: Record<string, unknown> = {
      title: f.title, description: f.description, assignee_id: assignee, start_date: f.start_date, due_date: f.due_date,
      estimate_hours: Number(f.estimate_hours) || 0, priority: f.priority,
    };
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if ((task.data[k] ?? "") !== v) patch[k] = v;
    if (task.data.estimate_hours === undefined && values.estimate_hours === 0) delete patch.estimate_hours;
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
      <div className="task-form-row">
        <label>Estimation (h)<input type="number" min="0" step="0.5" name="estimate_hours" defaultValue={text(task.data.estimate_hours)} /></label>
        <label>
          Priorité
          <select name="priority" defaultValue={text(task.data.priority) || "normal"}>
            {Object.entries(PRIORITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
      </div>
      {task.data.blocked ? (
        <button type="button" className="ghost small" onClick={() => write("tasks", task.id, { blocked: false, blocked_reason: "", blocked_note: "" })}>Débloquer la tâche</button>
      ) : null}
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="button" className="ghost danger small" onClick={remove}>Supprimer</button>
        <button type="button" className="ghost small" onClick={onClose}>Annuler</button>
        <button className="primary small">Enregistrer</button>
      </div>
    </form>
  );
}

/** Ce qu'un employé modifie sur une tâche : la description, et la prendre si elle est libre. */
function EmployeeTaskForm({ task, onClose }: { task: SyncRecord; onClose: () => void }) {
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
      <div className="form-actions">
        <button type="button" className="ghost small" onClick={onClose}>Annuler</button>
        <button className="primary small">Enregistrer</button>
      </div>
    </form>
  );
}

/** Planning : une barre par tâche, du début à l'échéance, avec la date du jour. */
function Gantt({ project, tasks }: { project: SyncRecord; tasks: SyncRecord[] }) {
  const dated = tasks.filter((t) => t.data.start_date || t.data.due_date)
    .map((t) => ({ t, start: text(t.data.start_date || t.data.due_date), end: text(t.data.due_date || t.data.start_date) }))
    .sort((a, b) => a.start.localeCompare(b.start));
  if (dated.length === 0) {
    return (
      <div className="card empty-state">
        <h3 className="empty-title">Aucune tâche datée</h3>
        <p className="muted">Le planning montre les tâches qui ont une date de début ou une échéance. Ouvrez une tâche pour lui donner des dates.</p>
      </div>
    );
  }
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
        <span><i className="swatch gl-todo" /> À faire</span><span><i className="swatch gl-doing" /> En cours ou à vérifier</span>
        <span><i className="swatch gl-done" /> Terminé</span><span><i className="swatch gl-late" /> En retard</span><span><i className="swatch gl-today" /> Aujourd'hui</span>
      </div>
    </div>
  );
}

function TimeEntries({ project, tasks, entries, invoices }: { project: SyncRecord; tasks: SyncRecord[]; entries: SyncRecord[]; invoices: SyncRecord[] }) {
  const { db, session } = useApp();
  const write = useGuardedWrite();
  const allEntries = useTable("time_entries");
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
    if (!(hours > 0 && hours <= 24)) return setError("Indiquez une durée entre 0 et 24 h, par exemple 1,5.");
    if (closedUntil && f.date <= closedUntil) return setError(`La période est clôturée jusqu'au ${formatDate(closedUntil)}. Choisissez une date postérieure.`);
    // Plafond de 24 h par personne et par jour, toutes tâches confondues (RG12.1, contrôle sur l'appareil).
    const already = hoursOn(session.user.id, allEntries, f.date);
    const check = checkDayHours(already, hours);
    if (!check.ok) return setError(already > 0 ? `${check.message} : ${hoursLabel(already)} déjà saisies ce jour-là.` : `${check.message}.`);
    if (check.confirm && !confirm(`Cela fera ${hoursLabel(already + hours)} ce jour-là. Enregistrer quand même ?`)) return;
    setError(null);
    try {
      await write("time_entries", db.newId("tmp"), {
        project_id: project.id, task_id: f.task_id, date: f.date, hours, note: f.note.trim(),
        billable: f.billable === "on", user_id: session.user.id, user_name: session.user.name, team_member_id: teamMemberIdOf(session.user.id),
      });
    } catch (err) {
      return setError(err instanceof Error ? err.message : "Le temps n'a pas pu être enregistré.");
    }
    form.reset();
  }

  return (
    <div>
      <form className="card form-grid section-card time-form" onSubmit={add}>
        <h3 className="wide">Saisir mon temps</h3>
        <label>Date<input type="date" name="date" required defaultValue={today()} /></label>
        <label>
          Tâche
          <select name="task_id" defaultValue="">
            <option value="">Aucune tâche précise</option>
            {tasks.map((t) => <option key={t.id} value={t.id}>{text(t.data.title)}</option>)}
          </select>
        </label>
        <label>Durée (heures)<input name="hours" inputMode="decimal" required placeholder="1,5" aria-label="Durée (heures)" /></label>
        <label>Note (facultatif)<input name="note" placeholder="Ce qui a été fait" /></label>
        {can.seeAmounts(session.user.role) ? <label className="inline"><input type="checkbox" name="billable" defaultChecked={["time", ""].includes(text(project.data.billing))} /> Facturable</label> : <input type="hidden" name="billable" value={["time", ""].includes(text(project.data.billing)) ? "on" : ""} />}
        {error && <p className="error wide">{error}</p>}
        <div className="form-actions"><button className="primary">Enregistrer le temps</button></div>
      </form>
      {sorted.length === 0 ? <p className="muted small">Aucun temps saisi sur ce projet pour l'instant.</p> : (
        <p className="muted small time-total"><strong>{hoursLabel(total)}</strong> saisies sur ce projet, dont {hoursLabel(mine)} par vous.</p>
      )}
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
  const fin = financeOf(project, data.project_finance);
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
    if (!project.data.client_id) return setMessage("Ce projet n'a pas de client : choisissez-en un dans « Modifier le projet ».");
    if (!fin.hourlyRate) return setMessage("Ce projet n'a pas de taux de facturation : indiquez-le dans « Modifier le projet ».");
    const { lines, entryIds } = timeToInvoiceLines(project, data.tasks, data.time_entries, DEFAULT_VAT_RATE, invoiceIds, fin.hourlyRate);
    if (lines.length === 0) return setMessage("Aucun temps facturable à facturer.");
    const id = db.newId("fa");
    await db.write("invoices", id, { ...baseInvoice(), lines, notes: `Temps passé sur le projet ${text(project.data.name)}` });
    for (const e of entryIds) await db.write("time_entries", e, { invoice_id: id });
    go("invoices", id);
  }

  async function billMilestone() {
    if (!project.data.client_id) return setMessage("Ce projet n'a pas de client : choisissez-en un dans « Modifier le projet ».");
    const pct = Number(percent);
    const budget = fin.budget;
    if (!budget) return setMessage("Ce projet n'a pas de budget : indiquez-le dans « Modifier le projet ».");
    if (!(pct > 0 && pct <= 100)) return setMessage("Indiquez un pourcentage entre 1 et 100.");
    const id = db.newId("fa");
    await db.write("invoices", id, {
      ...baseInvoice(),
      lines: [{ label: `${text(project.data.name)} · ${pct} % du forfait`, qty: 1, unitPrice: Math.round((budget * pct) / 100), vatRate: DEFAULT_VAT_RATE }],
    });
    go("invoices", id);
  }

  return (
    <div className="two-cols">
      <div className="card section-card">
        <h3>Factures du projet</h3>
        {invoices.length === 0 ? <p className="muted small">Aucune facture pour ce projet.</p> : (
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
              {s.unbilledHours > 0 ? `${hoursLabel(s.unbilledHours)} pas encore facturées, soit ${formatXaf(s.unbilledValue)} HT au taux du projet.` : "Tout le temps facturable est déjà facturé."}
            </p>
            <div className="actions">
              <button className="primary" onClick={billTime} disabled={s.unbilledHours === 0}>Facturer le temps passé</button>
              <label className="inline">Part du budget <input type="number" min="1" max="100" value={percent} onChange={(e) => setPercent(e.target.value)} style={{ width: 72 }} /> %</label>
              <button onClick={billMilestone}>Facturer cette part</button>
            </div>
            {message && <p className="error">{message}</p>}
          </>
        )}
      </div>
      <div className="card section-card">
        <h3>Dépenses du projet</h3>
        {expenses.length === 0 ? <p className="muted small">Aucune dépense pour ce projet. Pour en ajouter une, choisissez ce projet en saisissant la dépense.</p> : (
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
          <dt>Temps ({hoursLabel(s.hours)} × coût horaire{can.seePersonCosts(session.user.role) ? "" : " moyen"})</dt><dd className="mono">{formatXaf(s.timeCost)}</dd>
          <dt>Dépenses HT</dt><dd className="mono">{formatXaf(s.expenses)}</dd>
          <dt className="strong">Coûts</dt><dd className="mono strong">{formatXaf(s.costs)}</dd>
          <dt>Facturé HT</dt><dd className="mono">{formatXaf(s.invoiced)}</dd>
          <dt className="strong">Marge</dt><dd className="mono strong">{formatXaf(s.margin)}</dd>
        </dl>
      </div>
    </div>
  );
}
