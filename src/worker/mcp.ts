/**
 * Serveur MCP distant de Gestia (transport « Streamable HTTP », sans état, réponses JSON).
 *
 * POST /mcp : initialize, ping, tools/list, tools/call ; GET → 405 (pas de flux SSE).
 * Le jeton OAuth (oauth.ts) agit au nom de l'utilisateur, avec son entreprise et son rôle
 * lus à chaque appel. Lectures : canRead, READABLE et redactRecord, comme la synchronisation ;
 * aucune table de montants n'est lue (API_FORBIDDEN) et aucun montant n'est renvoyé.
 * Écritures : applyIncoming, le chemin exact de /api/sync (checkChange, checkPermission,
 * règles des projets, clôture), avec un horodatage HLC postérieur aux horloges de la ligne ;
 * les appareils les reçoivent à leur synchronisation suivante, au nom de l'auteur.
 */
import type { Env } from "./d1.ts";
import { applyIncoming } from "./index.ts";
import { authenticateBearer, jsonResponse, resourceMetadataUrl, type McpCaller } from "./oauth.ts";
import { canRead, type Change, type SyncRecord, type SyncTable } from "../shared/sync.ts";
import { encodeHlc, decodeHlc } from "../shared/hlc.ts";
import { allows, API_FORBIDDEN, type ApiScopes } from "../shared/apiKeys.ts";
import { BLOCK_REASONS, canDecide, redactRecord, teamMemberIdOf, type ProjectContext } from "../shared/projectRules.ts";
import { PROJECT_STATUS, TASK_STATUS, type Rec } from "../shared/projects.ts";
import {
  BLOCK_LABELS, checkDayHours, daysBetween, fold, hoursOn, MEMBER_ROLE_LABELS, myDay, nextDeadline, projectProgress, STAGE_STATE_LABELS,
  pct100, stagesOf, type DayReason,
} from "../shared/projectControl.ts";
import { decisionsToMake } from "../shared/projectDecisions.ts";
import { subscriptionInfo } from "../shared/plans.ts";
import { LIGHT_LABELS, reservesLight, scheduleLight, type Light } from "../shared/projectBudget.ts";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "gestia", title: "Gestia", version: "1.0.0" };

/**
 * Portée du connecteur, au format des jetons d'API (src/shared/apiKeys.ts) : projets et
 * annuaire en lecture, tâches et temps en écriture. Les tables protégées restent fermées.
 */
export const MCP_SCOPES: ApiScopes = {
  projects: "r", project_stages: "r", project_members: "r", project_decisions: "r", team_members: "r", clients: "r",
  tasks: "rw", time_entries: "rw",
};

const PRIORITIES: Record<string, string> = { high: "Haute", normal: "Normale", low: "Basse" };
const DAY_REASONS: Record<DayReason, string> = {
  priority: "priorité de la semaine", late: "en retard", due: "à rendre aujourd'hui", doing: "en cours", start: "commence aujourd'hui", open: "à faire",
};

/** Date du jour à Libreville (UTC+1). */
export const todayLibreville = () => new Date(Date.now() + 3600_000).toISOString().slice(0, 10);

class ToolError extends Error {}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const live = (r: Rec) => !r.data._deleted;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const sentence = (m: string) => {
  const t = m.trim();
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}`;
};

// ---------------------------------------------------------------------------
// Contexte d'un appel
// ---------------------------------------------------------------------------

export interface ToolContext {
  env: Env;
  caller: McpCaller;
  today: string;
}

type Data = Partial<Record<SyncTable, SyncRecord[]>>;

/** Lignes vivantes lisibles par l'utilisateur, filtrées et expurgées comme la synchronisation. */
export async function loadTables(ctx: ToolContext, tables: SyncTable[]): Promise<Data> {
  const { s } = ctx.caller;
  const actor = { userId: s.sub, role: s.role };
  const wanted = tables.filter((t) => !API_FORBIDDEN.includes(t) && allows(MCP_SCOPES, t, false) && canRead(actor, t, undefined, ""));
  const out: Data = {};
  for (const t of tables) out[t] = [];
  if (!wanted.length) return out;
  const { results } = await ctx.env.DB.prepare(
    `SELECT tbl, id, data, clocks FROM records WHERE company_id = ? AND tbl IN (SELECT value FROM json_each(?))`,
  ).bind(s.cid, JSON.stringify(wanted)).all<{ tbl: string; id: string; data: string; clocks: string }>();
  for (const r of results) {
    const data = JSON.parse(r.data);
    if (data._deleted || !canRead(actor, r.tbl, data.created_by, r.id)) continue;
    const rec = redactRecord(actor, { tbl: r.tbl as SyncTable, id: r.id, data, clocks: JSON.parse(r.clocks) })!;
    out[r.tbl as SyncTable]!.push(rec);
  }
  return out;
}

async function loadRow(ctx: ToolContext, tbl: SyncTable, id: string): Promise<SyncRecord | null> {
  const row = await ctx.env.DB.prepare(`SELECT tbl, id, data, clocks FROM records WHERE company_id = ? AND tbl = ? AND id = ?`)
    .bind(ctx.caller.s.cid, tbl, id).first<{ tbl: string; id: string; data: string; clocks: string }>();
  if (!row) return null;
  return { tbl, id: row.id, data: JSON.parse(row.data), clocks: JSON.parse(row.clocks) };
}

/**
 * Écriture par le chemin de la synchronisation. Refus (droits, règles des projets, clôture)
 * renvoyé tel quel, en phrase.
 */
export async function writeRow(ctx: ToolContext, tbl: SyncTable, row: string, patch: Record<string, unknown>): Promise<void> {
  const { s, company } = ctx.caller;
  if (!allows(MCP_SCOPES, tbl, true)) throw new ToolError("Le connecteur ne peut pas modifier ces données.");
  if (subscriptionInfo(company, ctx.today).readOnly) throw new ToolError("L'abonnement de l'entreprise est en consultation seule : aucune modification n'est possible pour l'instant.");
  const existing = await loadRow(ctx, tbl, row);
  const latest = Math.max(0, ...Object.values(existing?.clocks ?? {}).map((h) => decodeHlc(String(h)).ms));
  const change: Change = { id: crypto.randomUUID(), tbl, row, patch, hlc: encodeHlc(Math.max(Date.now(), latest + 1), 0, s.dev), device: s.dev };
  const { accepted, rejected } = await applyIncoming(ctx.env, s, [change]);
  if (rejected.length) throw new ToolError(sentence(rejected[0].reason));
  if (!accepted.includes(change.id)) throw new ToolError("La modification n'a pas été enregistrée.");
}

function projectContext(data: Data): ProjectContext {
  return {
    project: (pid) => (data.projects ?? []).find((p) => p.id === pid) ?? null,
    rolesIn: (pid, uid) => (data.project_members ?? []).filter((m) => m.data.project_id === pid && m.data.user_id === uid).map((m) => String(m.data.role ?? "member")),
    stages: (pid) => (data.project_stages ?? []).filter((x) => x.data.project_id === pid),
    decisions: (pid) => (data.project_decisions ?? []).filter((x) => x.data.project_id === pid),
  };
}

// ---------------------------------------------------------------------------
// Résolutions (identifiant ou nom)
// ---------------------------------------------------------------------------

function findProject(projects: Rec[], input: unknown): Rec {
  const q = str(input).trim();
  if (!q) throw new ToolError("Indiquez le projet (identifiant ou nom).");
  const byId = projects.find((p) => p.id === q);
  if (byId) return byId;
  const exact = projects.filter((p) => fold(str(p.data.name)) === fold(q));
  if (exact.length === 1) return exact[0];
  const partial = projects.filter((p) => fold(str(p.data.name)).includes(fold(q)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new ToolError(`Plusieurs projets correspondent à « ${q} » : ${partial.slice(0, 6).map((p) => `${str(p.data.name)} (${p.id})`).join(", ")}. Précisez l'identifiant.`);
  throw new ToolError(`Projet « ${q} » introuvable (ou non visible avec vos droits).`);
}

function findTask(tasks: Rec[], input: unknown): Rec {
  const q = str(input).trim();
  const t = tasks.find((x) => x.id === q);
  if (!t) throw new ToolError(`Tâche « ${q} » introuvable (ou non visible avec vos droits). Utilisez list_tasks pour trouver son identifiant.`);
  return t;
}

/** Personne de l'annuaire : « moi », identifiant tm-…, identifiant de compte, ou nom. "" = personne. */
function resolvePerson(team: Rec[], input: unknown, me: string): string {
  const q = str(input).trim();
  if (!q) return "";
  if (["moi", "me", "moi-même"].includes(fold(q))) return teamMemberIdOf(me);
  const byId = team.find((m) => m.id === q || m.id === teamMemberIdOf(q));
  if (byId) return byId.id;
  const exact = team.filter((m) => fold(str(m.data.name)) === fold(q));
  if (exact.length === 1) return exact[0].id;
  const partial = team.filter((m) => m.data.active !== false && fold(str(m.data.name)).includes(fold(q)));
  if (partial.length === 1) return partial[0].id;
  if (partial.length > 1) throw new ToolError(`Plusieurs personnes correspondent à « ${q} » : ${partial.map((m) => `${str(m.data.name)} (${m.id})`).join(", ")}.`);
  throw new ToolError(`Personne « ${q} » introuvable dans l'annuaire. Utilisez list_people.`);
}

function parseStatus(input: unknown): string {
  const q = fold(str(input)).replace(/[_-]/g, " ");
  const map: Record<string, string> = {
    todo: "todo", "a faire": "todo", doing: "doing", "en cours": "doing", review: "review", "a verifier": "review", done: "done", termine: "done", terminee: "done",
  };
  const s = map[q];
  if (!s) throw new ToolError("Statut inconnu : todo (À faire), doing (En cours), review (À vérifier) ou done (Terminé).");
  return s;
}

function parseDate(input: unknown, label: string): string {
  const d = str(input).trim();
  if (d === "") return "";
  if (!DATE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw new ToolError(`${label} : date au format AAAA-MM-JJ attendue.`);
  return d;
}

function parsePriority(input: unknown): string {
  const q = fold(str(input));
  const map: Record<string, string> = { high: "high", haute: "high", normal: "normal", normale: "normal", low: "low", basse: "low" };
  if (!map[q]) throw new ToolError("Priorité : high (haute), normal ou low (basse).");
  return map[q];
}

// ---------------------------------------------------------------------------
// Présentation (jamais de montant)
// ---------------------------------------------------------------------------

const personName = (team: Rec[], id: unknown) => {
  const m = team.find((x) => x.id === id);
  return m ? str(m.data.name) : "";
};

function taskView(t: Rec, d: { projects: Rec[]; team: Rec[]; stages: Rec[] }, today: string) {
  const status = str(t.data.status) || "todo";
  const due = str(t.data.due_date);
  const project = d.projects.find((p) => p.id === t.data.project_id);
  const stage = d.stages.find((s) => s.id === t.data.stage_id);
  return {
    id: t.id,
    title: str(t.data.title),
    project_id: str(t.data.project_id),
    project: project ? str(project.data.name) : "",
    ...(stage ? { stage: str(stage.data.name), stage_id: stage.id } : {}),
    status,
    status_label: Object.fromEntries(TASK_STATUS)[status] ?? status,
    assignee_id: str(t.data.assignee_id),
    assignee: personName(d.team, t.data.assignee_id) || str(t.data.assignee),
    priority: str(t.data.priority) || "normal",
    ...(str(t.data.start_date) ? { start_date: str(t.data.start_date) } : {}),
    due_date: due,
    overdue: status !== "done" && !!due && due < today,
    ...(due && status !== "done" && due < today ? { days_late: daysBetween(due, today) } : {}),
    blocked: !!t.data.blocked,
    ...(t.data.blocked ? { blocked_reason: BLOCK_LABELS[str(t.data.blocked_reason)] ?? "motif non précisé", blocked_note: str(t.data.blocked_note) } : {}),
    ...(str(t.data.description) ? { description: str(t.data.description) } : {}),
    ...(t.data.estimate_hours ? { estimate_hours: Number(t.data.estimate_hours) } : {}),
  };
}

const LIGHT_RANK: Record<Light, number> = { grey: 0, green: 1, orange: 2, red: 3 };

/**
 * Météo du projet (lot 4) sur ses critères sans montant : délai, réserves et blocages.
 * Le critère budget porte des montants : il n'est pas transmis par le connecteur.
 */
function weatherOf(project: Rec, tasks: Rec[], prog: ReturnType<typeof projectProgress>, today: string, d: Data) {
  const progressAt = (iso: string) => projectProgress(project, { tasks, project_stages: d.project_stages ?? [], project_decisions: d.project_decisions ?? [] }, iso).P;
  const schedule = scheduleLight(project, prog, today, progressAt);
  const reserves = reservesLight(project, tasks, today);
  const worst = LIGHT_RANK[schedule.light] >= LIGHT_RANK[reserves.light] ? schedule : reserves;
  return {
    overall: LIGHT_LABELS[worst.light],
    ...(worst.light === "grey" ? {} : { reason: worst.reason }),
    delay: { light: schedule.light, label: LIGHT_LABELS[schedule.light], reason: schedule.reason },
    reserves: { light: reserves.light, label: LIGHT_LABELS[reserves.light], reason: reserves.reason },
    budget: "non transmis par le connecteur (montants) : voir la fiche du projet dans Gestia",
  };
}

function managerOf(project: Rec, members: Rec[]): string {
  const m = members.find((x) => x.data.project_id === project.id && x.data.role === "manager");
  return m ? str(m.data.name) : str(project.data.manager);
}

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const s_ = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });

const PROJECT_TABLES: SyncTable[] = ["projects", "tasks", "project_stages", "project_members", "project_decisions", "team_members", "clients"];

export const TOOLS: Tool[] = [
  {
    name: "list_projects",
    title: "Lister les projets",
    description: "Liste les projets de l'entreprise visibles par l'utilisateur, avec leur état, leur avancement (réel et prévu à date), leur météo (délai, réserves et blocages), leur échéance, la prochaine étape à valider, leur responsable et le nombre de tâches ouvertes, en retard ou bloquées. Par défaut : projets planifiés, en cours ou en pause.",
    inputSchema: obj({
      status: s_("État : planned (Planifié), active (En cours), on_hold (En pause), done (Terminé), cancelled (Annulé), open (planifié, en cours ou en pause, par défaut) ou all."),
      client: s_("Client : identifiant ou partie du nom."),
      search: s_("Texte cherché dans le nom du projet."),
    }),
    annotations: { title: "Lister les projets", ...READ },
    async run(ctx, a) {
      const d = await loadTables(ctx, PROJECT_TABLES);
      const status = str(a.status) || "open";
      if (!["open", "all", ...Object.keys(PROJECT_STATUS)].includes(status)) throw new ToolError("État inconnu : planned, active, on_hold, done, cancelled, open ou all.");
      const clients = d.clients ?? [];
      const q = fold(str(a.client));
      const search = fold(str(a.search));
      const projects = (d.projects ?? []).filter((p) => {
        const st = str(p.data.status) || "active";
        if (status === "open" ? ["done", "cancelled"].includes(st) : status !== "all" && st !== status) return false;
        if (search && !fold(str(p.data.name)).includes(search)) return false;
        if (q) {
          const c = clients.find((x) => x.id === p.data.client_id);
          if (p.data.client_id !== a.client && !(c && fold(str(c.data.name)).includes(q))) return false;
        }
        return true;
      });
      const tasks = d.tasks ?? [];
      return {
        count: projects.length,
        projects: projects.sort((x, y) => str(x.data.name).localeCompare(str(y.data.name), "fr")).map((p) => {
          const prog = projectProgress(p, { tasks, project_stages: d.project_stages ?? [], project_decisions: d.project_decisions ?? [] }, ctx.today);
          const own = tasks.filter((t) => t.data.project_id === p.id && t.data.status !== "done");
          const client = clients.find((c) => c.id === p.data.client_id);
          const next = nextDeadline(p, prog.stages, ctx.today);
          return {
            id: p.id,
            name: str(p.data.name),
            status: str(p.data.status) || "active",
            status_label: PROJECT_STATUS[str(p.data.status) || "active"] ?? str(p.data.status),
            ...(client ? { client: str(client.data.name), client_id: client.id } : {}),
            progress_pct: pct100(prog.A),
            ...(prog.P !== null ? { planned_pct: pct100(prog.P) } : {}),
            start_date: str(p.data.start_date),
            end_date: str(p.data.end_date),
            next_deadline: next,
            manager: managerOf(p, d.project_members ?? []),
            open_tasks: own.length,
            overdue_tasks: own.filter((t) => str(t.data.due_date) && str(t.data.due_date) < ctx.today).length,
            blocked_tasks: own.filter((t) => t.data.blocked).length,
            weather: weatherOf(p, tasks, prog, ctx.today, d),
          };
        }),
      };
    },
  },
  {
    name: "get_project",
    title: "Détail d'un projet",
    description: "Détail d'un projet : météo (délai, réserves et blocages), étapes (état, avancement, dates, responsable), équipe, tâches ouvertes, prochaine échéance et bloc « À décider » (validations d'étape demandées, si l'utilisateur peut décider sur ce projet).",
    inputSchema: obj({ project: s_("Identifiant du projet, ou son nom (exact ou partiel s'il est unique).") }, ["project"]),
    annotations: { title: "Détail d'un projet", ...READ },
    async run(ctx, a) {
      const d = await loadTables(ctx, PROJECT_TABLES);
      const projects = d.projects ?? [];
      const p = findProject(projects, a.project);
      const tasks = d.tasks ?? [];
      const team = d.team_members ?? [];
      const stages = d.project_stages ?? [];
      const decisions = d.project_decisions ?? [];
      const prog = projectProgress(p, { tasks, project_stages: stages, project_decisions: decisions }, ctx.today);
      const actor = { userId: ctx.caller.s.sub, role: ctx.caller.s.role };
      const pctx = projectContext(d);
      const toDecide = decisionsToMake([p], { project_stages: stages, project_decisions: decisions, tasks }, (x) => canDecide(actor, x.id, pctx), ctx.today, false);
      const client = (d.clients ?? []).find((c) => c.id === p.data.client_id);
      const view = { projects, team, stages };
      return {
        id: p.id,
        name: str(p.data.name),
        status: str(p.data.status) || "active",
        status_label: PROJECT_STATUS[str(p.data.status) || "active"] ?? "",
        ...(client ? { client: str(client.data.name) } : {}),
        ...(str(p.data.description) ? { description: str(p.data.description) } : {}),
        ...(str(p.data.site_address) ? { site_address: str(p.data.site_address) } : {}),
        start_date: str(p.data.start_date),
        end_date: str(p.data.end_date),
        progress_pct: pct100(prog.A),
        ...(prog.P !== null ? { planned_pct: pct100(prog.P) } : {}),
        manager: managerOf(p, d.project_members ?? []),
        next_deadline: nextDeadline(p, prog.stages, ctx.today),
        weather: weatherOf(p, tasks, prog, ctx.today, d),
        stages: prog.stages.map((i) => ({
          id: i.stage.id,
          name: str(i.stage.data.name),
          state: i.state,
          state_label: STAGE_STATE_LABELS[i.state],
          progress_pct: pct100(i.progress),
          start_date: str(i.stage.data.start_date),
          end_date: str(i.stage.data.end_date),
          owner: personName(team, i.stage.data.owner_id) || str(i.stage.data.owner_name),
          tasks: i.tasks,
        })),
        team: (d.project_members ?? []).filter((m) => m.data.project_id === p.id).map((m) => ({
          team_member_id: str(m.data.team_member_id),
          name: personName(team, m.data.team_member_id) || str(m.data.name),
          role: MEMBER_ROLE_LABELS[str(m.data.role)] ?? str(m.data.role),
        })),
        open_tasks: tasks.filter((t) => t.data.project_id === p.id && t.data.status !== "done").map((t) => taskView(t, view, ctx.today)),
        done_tasks: tasks.filter((t) => t.data.project_id === p.id && t.data.status === "done").length,
        to_decide: toDecide.map((i) => ({
          what: `Validation de l'étape ${str(i.stage.data.name)}`,
          stage_id: i.stage.id,
          requested_by: i.by,
          requested_at: i.since.slice(0, 10),
          waiting_days: i.days,
          ...(i.note ? { note: i.note } : {}),
        })),
      };
    },
  },
  {
    name: "list_tasks",
    title: "Lister les tâches",
    description: "Liste les tâches de tous les projets visibles, avec filtres. Par défaut : tâches non terminées. Les dates sont au format AAAA-MM-JJ.",
    inputSchema: obj({
      person: s_("Personne chargée : « moi », identifiant (tm-…) ou nom. « personne » pour les tâches non attribuées."),
      project: s_("Projet : identifiant ou nom."),
      status: s_("Statut : todo, doing, review, done, ou all pour tout inclure (par défaut : tout sauf done)."),
      blocked: { type: "boolean", description: "true : seulement les tâches bloquées ; false : seulement les non bloquées." },
      overdue: { type: "boolean", description: "true : seulement les tâches en retard (échéance passée, non terminées)." },
      due_before: s_("Échéance au plus tard ce jour (AAAA-MM-JJ), inclus."),
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Nombre maximal de tâches (100 par défaut)." },
    }),
    annotations: { title: "Lister les tâches", ...READ },
    async run(ctx, a) {
      const d = await loadTables(ctx, ["projects", "tasks", "project_stages", "team_members"]);
      const projects = d.projects ?? [];
      const team = d.team_members ?? [];
      const known = new Set(projects.map((p) => p.id));
      let tasks = (d.tasks ?? []).filter((t) => known.has(str(t.data.project_id)));
      if (a.project !== undefined && str(a.project)) {
        const p = findProject(projects, a.project);
        tasks = tasks.filter((t) => t.data.project_id === p.id);
      }
      const status = str(a.status);
      if (status && status !== "all") {
        const st = parseStatus(status);
        tasks = tasks.filter((t) => (str(t.data.status) || "todo") === st);
      } else if (!status) tasks = tasks.filter((t) => t.data.status !== "done");
      if (a.person !== undefined && str(a.person)) {
        if (["personne", "aucun", "aucune", "none"].includes(fold(str(a.person)))) tasks = tasks.filter((t) => !t.data.assignee_id && !t.data.assignee);
        else {
          const who = resolvePerson(team, a.person, ctx.caller.s.sub);
          tasks = tasks.filter((t) => t.data.assignee_id === who);
        }
      }
      if (typeof a.blocked === "boolean") tasks = tasks.filter((t) => !!t.data.blocked === a.blocked);
      if (a.overdue === true) tasks = tasks.filter((t) => t.data.status !== "done" && str(t.data.due_date) && str(t.data.due_date) < ctx.today);
      if (a.due_before !== undefined && str(a.due_before)) {
        const lim = parseDate(a.due_before, "due_before");
        tasks = tasks.filter((t) => str(t.data.due_date) && str(t.data.due_date) <= lim);
      }
      tasks.sort((x, y) => (str(x.data.due_date) || "9999").localeCompare(str(y.data.due_date) || "9999") || str(x.data.title).localeCompare(str(y.data.title), "fr"));
      const limit = Math.min(200, Math.max(1, Number(a.limit) || 100));
      const view = { projects, team, stages: d.project_stages ?? [] };
      return { count: tasks.length, truncated: tasks.length > limit, tasks: tasks.slice(0, limit).map((t) => taskView(t, view, ctx.today)) };
    },
  },
  {
    name: "create_task",
    title: "Créer une tâche",
    description: "Crée une tâche dans un projet (statut À faire). Elle apparaît dans Gestia sur tous les appareils à la synchronisation suivante, au nom de l'utilisateur connecté. Les droits de son rôle s'appliquent (un employé ne peut attribuer une tâche qu'à lui-même).",
    inputSchema: obj({
      project: s_("Projet : identifiant ou nom."),
      title: s_("Titre de la tâche.", { maxLength: 200 }),
      description: s_("Description ou consignes."),
      assignee: s_("Personne chargée : « moi », identifiant (tm-…) ou nom de l'annuaire."),
      due_date: s_("Échéance (AAAA-MM-JJ)."),
      start_date: s_("Date de début (AAAA-MM-JJ)."),
      priority: s_("Priorité : high, normal (par défaut) ou low."),
      stage: s_("Étape du projet : identifiant ou nom."),
      estimate_hours: { type: "number", minimum: 0, maximum: 1000, description: "Estimation en heures." },
    }, ["project", "title"]),
    annotations: { title: "Créer une tâche", ...WRITE, idempotentHint: false },
    async run(ctx, a) {
      const d = await loadTables(ctx, ["projects", "project_stages", "team_members"]);
      const p = findProject(d.projects ?? [], a.project);
      const title = str(a.title).trim();
      if (!title || title.length > 200) throw new ToolError("Indiquez un titre (200 caractères au plus).");
      const { s } = ctx.caller;
      const patch: Record<string, unknown> = {
        project_id: p.id, title, status: "todo", priority: a.priority !== undefined ? parsePriority(a.priority) : "normal",
        created_by: s.sub, created_at: new Date().toISOString(), created_by_name: `${ctx.caller.userName} (via ${ctx.caller.clientName})`,
      };
      if (str(a.description).trim()) patch.description = str(a.description).trim();
      if (str(a.assignee)) patch.assignee_id = resolvePerson(d.team_members ?? [], a.assignee, s.sub);
      if (str(a.due_date)) patch.due_date = parseDate(a.due_date, "Échéance");
      if (str(a.start_date)) patch.start_date = parseDate(a.start_date, "Début");
      if (typeof a.estimate_hours === "number" && a.estimate_hours > 0) patch.estimate_hours = a.estimate_hours;
      if (str(a.stage)) {
        const st = stagesOf(p.id, d.project_stages ?? []);
        const found = st.find((x) => x.id === a.stage) ?? st.find((x) => fold(str(x.data.name)) === fold(str(a.stage)));
        if (!found) throw new ToolError(`Étape « ${str(a.stage)} » introuvable dans ce projet. Étapes : ${st.map((x) => str(x.data.name)).join(", ") || "aucune"}.`);
        patch.stage_id = found.id;
      }
      const id = `tsk-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await writeRow(ctx, "tasks", id, patch);
      const after = await loadTables(ctx, ["projects", "tasks", "project_stages", "team_members"]);
      const task = (after.tasks ?? []).find((t) => t.id === id)!;
      return { created: true, task: taskView(task, { projects: after.projects ?? [], team: after.team_members ?? [], stages: after.project_stages ?? [] }, ctx.today) };
    },
  },
  {
    name: "update_task",
    title: "Modifier une tâche",
    description: "Modifie une tâche : titre, description, statut, échéance, personne chargée, priorité, blocage (avec motif) ou déblocage. Seuls les champs indiqués changent. Les règles de Gestia s'appliquent (par exemple, un employé ne passe pas une tâche à Terminé : elle est close après vérification). Pas de suppression.",
    inputSchema: obj({
      task_id: s_("Identifiant de la tâche (voir list_tasks)."),
      title: s_("Nouveau titre.", { maxLength: 200 }),
      description: s_("Nouvelle description."),
      status: s_("Statut : todo (À faire), doing (En cours), review (À vérifier), done (Terminé)."),
      due_date: s_("Échéance (AAAA-MM-JJ) ; chaîne vide pour la retirer."),
      assignee: s_("Personne chargée : « moi », identifiant (tm-…) ou nom ; chaîne vide pour retirer."),
      priority: s_("Priorité : high, normal ou low."),
      blocked: { type: "boolean", description: "true pour bloquer la tâche (motif obligatoire), false pour la débloquer." },
      block_reason: s_("Motif du blocage : material (matériel attendu), client (attente du client), info (information manquante), other."),
      block_note: s_("Précision sur le blocage."),
    }, ["task_id"]),
    annotations: { title: "Modifier une tâche", ...WRITE, idempotentHint: true },
    async run(ctx, a) {
      const d = await loadTables(ctx, ["projects", "tasks", "project_stages", "team_members"]);
      const task = findTask(d.tasks ?? [], a.task_id);
      const { s } = ctx.caller;
      const values: Record<string, unknown> = {};
      if (a.title !== undefined) {
        const t = str(a.title).trim();
        if (!t || t.length > 200) throw new ToolError("Le titre ne peut pas être vide (200 caractères au plus).");
        values.title = t;
      }
      if (a.description !== undefined) values.description = str(a.description);
      if (a.due_date !== undefined) values.due_date = parseDate(a.due_date, "Échéance");
      if (a.assignee !== undefined) values.assignee_id = resolvePerson(d.team_members ?? [], a.assignee, s.sub);
      if (a.priority !== undefined) values.priority = parsePriority(a.priority);
      if (a.status !== undefined) {
        values.status = parseStatus(a.status);
        if (values.status === "done" && task.data.status !== "done") Object.assign(values, { done_at: new Date().toISOString(), blocked: false });
      }
      if (a.blocked === true) {
        const reason = str(a.block_reason);
        if (!(BLOCK_REASONS as readonly string[]).includes(reason)) throw new ToolError("Pour bloquer, indiquez block_reason : material, client, info ou other.");
        Object.assign(values, { blocked: true, blocked_reason: reason, blocked_note: str(a.block_note).trim(), blocked_at: new Date().toISOString(), blocked_by: s.sub });
      } else if (a.blocked === false) {
        Object.assign(values, { blocked: false, blocked_reason: "", blocked_note: "" });
      } else if (a.block_reason !== undefined || a.block_note !== undefined) {
        throw new ToolError("Pour bloquer la tâche, passez aussi blocked: true.");
      }
      // Seuls les champs qui changent partent : un employé garde ainsi les droits qu'il a sur l'écran.
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values)) if ((task.data[k] ?? "") !== v) patch[k] = v;
      const view = (rows: typeof d) => ({ projects: rows.projects ?? [], team: rows.team_members ?? [], stages: rows.project_stages ?? [] });
      if (Object.keys(patch).length === 0) return { updated: false, message: "Rien à modifier.", task: taskView(task, view(d), ctx.today) };
      await writeRow(ctx, "tasks", task.id, patch);
      const after = await loadTables(ctx, ["projects", "tasks", "project_stages", "team_members"]);
      return { updated: true, changed: Object.keys(patch), task: taskView((after.tasks ?? []).find((t) => t.id === task.id)!, view(after), ctx.today) };
    },
  },
  {
    name: "list_people",
    title: "Annuaire de l'équipe",
    description: "Annuaire de l'équipe : identifiant (tm-…) à utiliser pour attribuer une tâche, nom, métier, téléphone, compte Gestia, et nombre de tâches ouvertes de chacun.",
    inputSchema: obj({ include_inactive: { type: "boolean", description: "Inclure les personnes inactives (non par défaut)." } }),
    annotations: { title: "Annuaire de l'équipe", ...READ },
    async run(ctx, a) {
      const d = await loadTables(ctx, ["team_members", "tasks"]);
      const tasks = d.tasks ?? [];
      const people = (d.team_members ?? []).filter((m) => a.include_inactive === true || m.data.active !== false)
        .sort((x, y) => str(x.data.name).localeCompare(str(y.data.name), "fr"));
      return {
        me: teamMemberIdOf(ctx.caller.s.sub),
        people: people.map((m) => ({
          id: m.id,
          name: str(m.data.name),
          ...(str(m.data.job) ? { job: str(m.data.job) } : {}),
          ...(str(m.data.phone) ? { phone: str(m.data.phone) } : {}),
          has_account: !!str(m.data.user_id),
          active: m.data.active !== false,
          open_tasks: tasks.filter((t) => t.data.assignee_id === m.id && t.data.status !== "done").length,
        })),
      };
    },
  },
  {
    name: "my_day",
    title: "Ma journée",
    description: "Les tâches du jour de l'utilisateur connecté, dans l'ordre de l'écran « Ma journée » de Gestia : priorités de la semaine, retards, échéances du jour, tâches en cours… ; puis ses autres tâches et celles qui attendent une vérification, et les heures déjà saisies aujourd'hui.",
    inputSchema: obj({ date: s_("Jour (AAAA-MM-JJ) ; aujourd'hui à Libreville par défaut.") }),
    annotations: { title: "Ma journée", ...READ },
    async run(ctx, a) {
      const day = str(a.date) ? parseDate(a.date, "date") : ctx.today;
      const d = await loadTables(ctx, ["projects", "tasks", "project_stages", "team_members", "time_entries"]);
      const projects = d.projects ?? [];
      const view = { projects, team: d.team_members ?? [], stages: d.project_stages ?? [] };
      const r = myDay(teamMemberIdOf(ctx.caller.s.sub), { tasks: d.tasks ?? [], projects }, day);
      const item = (i: { task: Rec; reason: DayReason }) => ({ ...taskView(i.task, view, day), why: DAY_REASONS[i.reason] });
      return {
        date: day,
        person: ctx.caller.userName,
        hours_logged: hoursOn(ctx.caller.s.sub, d.time_entries ?? [], day),
        today: r.today.map(item),
        others: r.others.map(item),
        waiting_review: r.review.map((t) => taskView(t, view, day)),
      };
    },
  },
  {
    name: "log_time",
    title: "Saisir du temps",
    description: "Enregistre du temps passé par l'utilisateur connecté sur une tâche (en heures, par exemple 1.5). 24 h au plus par jour, toutes tâches confondues ; pas de saisie sur un projet terminé ni sur une période clôturée.",
    inputSchema: obj({
      task_id: s_("Identifiant de la tâche."),
      hours: { type: "number", exclusiveMinimum: 0, maximum: 24, description: "Durée en heures (ex. 1.5)." },
      date: s_("Jour travaillé (AAAA-MM-JJ) ; aujourd'hui par défaut."),
      note: s_("Commentaire."),
    }, ["task_id", "hours"]),
    annotations: { title: "Saisir du temps", ...WRITE, idempotentHint: false },
    async run(ctx, a) {
      const d = await loadTables(ctx, ["projects", "tasks", "time_entries", "project_stages", "team_members"]);
      const task = findTask(d.tasks ?? [], a.task_id);
      const hours = Math.round(Number(a.hours) * 100) / 100;
      const date = str(a.date) ? parseDate(a.date, "date") : ctx.today;
      const { s } = ctx.caller;
      const already = hoursOn(s.sub, d.time_entries ?? [], date);
      const check = checkDayHours(already, hours);
      if (!check.ok) throw new ToolError(already > 0 ? `${check.message} : ${already} h déjà saisies ce jour-là.` : `${check.message}.`);
      const project = (d.projects ?? []).find((p) => p.id === task.data.project_id);
      const id = `tmp-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await writeRow(ctx, "time_entries", id, {
        project_id: str(task.data.project_id), task_id: task.id, date, hours, note: str(a.note).trim(),
        billable: ["time", ""].includes(str(project?.data.billing)),
        user_id: s.sub, user_name: ctx.caller.userName, team_member_id: teamMemberIdOf(s.sub),
        created_by: s.sub, created_at: new Date().toISOString(),
      });
      return { logged: true, id, task: str(task.data.title), date, hours, total_that_day: Math.round((already + hours) * 100) / 100 };
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

interface RpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

const rpcResult = (id: RpcMessage["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const INSTRUCTIONS = "Gestia est le logiciel de gestion de l'entreprise : projets, étapes, tâches, temps passés. "
  + "Ces outils agissent au nom de l'utilisateur connecté, avec ses droits. Utilisez list_people pour trouver l'identifiant d'une personne, "
  + "list_projects ou list_tasks pour les identifiants de projets et de tâches. Les dates sont au format AAAA-MM-JJ (fuseau de Libreville). "
  + "Aucun montant n'est accessible par ce connecteur et rien ne peut y être supprimé.";

export async function callTool(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  try {
    const result = await tool.run(ctx, args ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }], structuredContent: result as Record<string, unknown>, isError: false };
  } catch (e) {
    if (e instanceof ToolError) return { content: [{ type: "text", text: e.message }], isError: true };
    throw e;
  }
}

async function dispatch(ctx: ToolContext, msg: RpcMessage): Promise<unknown | null> {
  const isRequest = msg && typeof msg === "object" && typeof msg.method === "string" && msg.id !== undefined && msg.id !== null;
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return rpcError(msg?.id ?? null, -32600, "requête JSON-RPC 2.0 invalide");
  if (!isRequest) return null; // notification ou réponse : rien à renvoyer
  const p = msg.params ?? {};
  switch (msg.method) {
    case "initialize": {
      const asked = String(p.protocolVersion ?? "");
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) });
    case "tools/call": {
      const out = await callTool(ctx, String(p.name ?? ""), (p.arguments as Record<string, unknown>) ?? {});
      return out ? rpcResult(msg.id, out) : rpcError(msg.id, -32602, `outil inconnu : ${String(p.name ?? "")}`);
    }
    default:
      return rpcError(msg.id, -32601, `méthode inconnue : ${msg.method}`);
  }
}

export async function handleMcp(req: Request, env: Env): Promise<Response> {
  const origin = new URL(req.url).origin;
  if (req.method !== "POST") {
    return jsonResponse(rpcError(null, -32000, "méthode non autorisée : utilisez POST (pas de flux SSE)"), 405, { allow: "POST, OPTIONS" });
  }
  const caller = await authenticateBearer(req, env);
  if (!caller) {
    return jsonResponse({ error: "invalid_token", error_description: "jeton d'accès absent, expiré ou révoqué" }, 401, {
      "www-authenticate": `Bearer realm="Gestia", error="invalid_token", resource_metadata="${resourceMetadataUrl(origin)}"`,
    });
  }
  if (caller.company.status === "suspended") return jsonResponse(rpcError(null, -32000, "compte de l'entreprise suspendu : contactez l'équipe Gestia"), 403);
  let body: unknown;
  try { body = await req.json(); } catch { return jsonResponse(rpcError(null, -32700, "JSON invalide"), 400); }
  const ctx: ToolContext = { env, caller, today: todayLibreville() };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => dispatch(ctx, m as RpcMessage)))).filter((x) => x !== null);
    return out.length ? jsonResponse(out) : new Response(null, { status: 202 });
  }
  const out = await dispatch(ctx, body as RpcMessage);
  return out === null ? new Response(null, { status: 202, headers: { "access-control-allow-origin": "*" } }) : jsonResponse(out);
}
