/**
 * Ma journée (F12) : l'employé ouvre Gestia et sait quoi faire, sans chercher le projet.
 * Mobile d'abord (cibles de 44 px), utilisable hors ligne. Aucun montant n'est affiché.
 *
 *  - saisie du temps en deux gestes : toucher la tâche, toucher une durée ;
 *  - chronomètre : un seul à la fois, heure de début gardée sur l'appareil (survit
 *    à la fermeture de l'application et au mode hors ligne) ;
 *  - « J'ai terminé » (la tâche passe À vérifier, ou Terminé pour qui peut la clore)
 *    et « Je suis bloqué » (motif).
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { COMING_SOON, TABS_BY_ROLE, text, today, useApp, useSyncStatus, useTable } from "../context.ts";
import { BLOCK_LABELS, checkDayHours, chronoRounding, hoursOn, hoursWeek, myDay, type DayItem } from "../../shared/projectControl.ts";
import { withDeadlines } from "../../shared/projectBoard.ts";
import { canCloseTask } from "../../shared/projectRules.ts";
import { localProjectContext } from "../local/guard.ts";
import type { SyncRecord } from "../../shared/sync.ts";
import { hoursFr, useGuardedWrite, useMyTeamId } from "./team.ts";
import { PIcon } from "./ProjectIcons.tsx";

type AddResult = { ok: true; id: string } | { ok: false; message: string };

interface Chrono { taskId: string; projectId: string; title: string; start: number }

const chronoKey = (userId: string) => `gestia:chrono:${userId}`;
function readChrono(userId: string): Chrono | null {
  try { return JSON.parse(localStorage.getItem(chronoKey(userId)) ?? "null"); } catch { return null; }
}
function writeChrono(userId: string, c: Chrono | null) {
  try {
    if (c) localStorage.setItem(chronoKey(userId), JSON.stringify(c));
    else localStorage.removeItem(chronoKey(userId));
  } catch { /* stockage indisponible : le chronomètre reste en mémoire */ }
}

const longDate = (iso: string) => {
  const s = new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
const timeOfDay = (ms: number) => new Date(ms).toLocaleTimeString("fr-FR", { hour: "numeric", minute: "2-digit" }).replace(":", " h ");
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Ligne de temps prête à écrire, facturable selon le mode du projet. */
function timeEntry(task: SyncRecord, project: SyncRecord | undefined, hours: number, user: { id: string; name: string }, tm: string) {
  return {
    project_id: text(task.data.project_id), task_id: task.id, date: today(), hours, note: "",
    billable: !project || ["time", ""].includes(text(project.data.billing)),
    user_id: user.id, user_name: user.name, team_member_id: tm,
  };
}

export function MyDay() {
  const { db, session, go } = useApp();
  const tasks = useTable("tasks");
  const projects = useTable("projects");
  const entries = useTable("time_entries");
  const members = useTable("project_members");
  const status = useSyncStatus();
  const write = useGuardedWrite();
  const tm = useMyTeamId();
  const user = { id: session.user.id, name: session.user.name };
  const day = today();
  const [chrono, setChrono] = useState<Chrono | null>(() => readChrono(user.id));
  const [now, setNow] = useState(Date.now());
  const [sheet, setSheet] = useState<{ task: SyncRecord; mode: "time" | "block" } | null>(null);
  const [blockPicker, setBlockPicker] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (!chrono) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [chrono]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(t);
  }, [flash]);
  // Un autre onglet a démarré ou arrêté le chronomètre.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === chronoKey(user.id) && setChrono(readChrono(user.id));
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [user.id]);

  // Lot 5 : rappel des échéances (dues dans les 2 jours) par-dessus le calcul de base.
  const plan = useMemo(() => withDeadlines(myDay(tm, { tasks, projects }, day), day), [tm, tasks, projects, day]);
  const projectOf = (t: SyncRecord) => projects.find((p) => p.id === t.data.project_id);
  const hoursToday = hoursOn(user.id, entries, day);
  const week = hoursWeek(user.id, entries, day);
  const canExpense = !COMING_SOON.expenses && (TABS_BY_ROLE[session.user.role] ?? []).includes("expenses");

  async function addHours(task: SyncRecord, hours: number): Promise<AddResult> {
    const already = hoursOn(user.id, entries, day);
    const check = checkDayHours(already, hours);
    if (!check.ok) return { ok: false, message: already > 0 ? `${check.message} : ${hoursFr(already)} déjà saisies aujourd'hui.` : check.message };
    if (check.confirm && !confirm(`Cela fera ${hoursFr(already + hours)} aujourd'hui. Confirmer ?`)) return { ok: false, message: "Saisie annulée." };
    const id = db.newId("tmp");
    try {
      await write("time_entries", id, timeEntry(task, projectOf(task), hours, user, tm));
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Le temps n'a pas pu être enregistré." };
    }
    return { ok: true, id };
  }

  async function startChrono(task: SyncRecord) {
    if (chrono) return;
    const c: Chrono = { taskId: task.id, projectId: text(task.data.project_id), title: text(task.data.title), start: Date.now() };
    writeChrono(user.id, c);
    setChrono(c);
    setNow(Date.now());
    if ((text(task.data.status) || "todo") === "todo") await write("tasks", task.id, { status: "doing" }).catch(() => {});
  }

  async function stopChrono(hours: number | null) {
    if (!chrono) return;
    const task = tasks.find((t) => t.id === chrono.taskId);
    if (hours !== null && task) {
      const r = await addHours(task, hours);
      if (!r.ok) { setFlash(r.message); return; }
      setFlash(`${hoursFr(hours)} enregistrées sur « ${chrono.title} ».`);
    }
    writeChrono(user.id, null);
    setChrono(null);
  }

  const render = (i: DayItem<SyncRecord> & { soonDays: number }) => (
    <DayTask key={i.task.id} item={i} project={projectOf(i.task)} running={chrono?.taskId === i.task.id} chronoBusy={!!chrono}
      onOpen={() => setSheet({ task: i.task, mode: "time" })} onStart={() => startChrono(i.task)} />
  );
  const mineOpen = [...plan.today, ...plan.others];
  const ctx = localProjectContext(projects, members);
  const canClose = (t: SyncRecord) => canCloseTask({ userId: user.id, role: session.user.role }, text(t.data.project_id), ctx);
  // Rien aujourd'hui mais d'autres tâches ouvertes : on les montre tout de suite.
  const othersOpen = showOthers || plan.today.length === 0;

  return (
    <section className="myday">
      <header className="myday-head">
        <div>
          <h2>Ma journée</h2>
          <p className="muted">{longDate(day)}</p>
        </div>
        <div className="myday-hours">
          <strong className="mono" data-testid="hours-today">{hoursFr(hoursToday)}</strong>
          <span className="muted small">aujourd'hui · {hoursFr(week)} cette semaine</span>
        </div>
      </header>

      {status.pending > 0 && (
        <p className="myday-pending" role="status" data-testid="pending-banner">
          <PIcon name="sync" />
          {status.state === "offline"
            ? `${plural(status.pending, "saisie sera envoyée", "saisies seront envoyées")} au retour du réseau`
            : `${plural(status.pending, "modification", "modifications")} en attente d'envoi`}
        </p>
      )}
      {flash && (
        <p className="myday-flash" role="status">
          <span>{flash}</span>
          <button className="ghost small" onClick={() => setFlash(null)}>Fermer</button>
        </p>
      )}

      {chrono && <ChronoCard chrono={chrono} now={now} project={projects.find((p) => p.id === chrono.projectId)} onStop={stopChrono} />}

      {(mineOpen.length > 0 || plan.review.length > 0) && (
        <div className="myday-list-head">
          <h3>Aujourd'hui</h3>
          <span className="muted small">{plural(plan.today.length, "tâche", "tâches")}</span>
        </div>
      )}
      {plan.today.length === 0 ? (
        mineOpen.length === 0 && plan.review.length === 0 ? (
          <div className="myday-empty">
            <span className="empty-ico" aria-hidden="true"><PIcon name="list" /></span>
            <p><strong>Aucune tâche ne vous est attribuée.</strong></p>
            <p className="muted">Les tâches qui vous sont attribuées sur un projet apparaîtront ici, avec leur échéance et l'adresse du site.</p>
            <button onClick={() => go("projects")}>Voir les projets</button>
          </div>
        ) : (
          <div className="myday-empty compact">
            <p><strong>Aucune tâche prévue aujourd'hui.</strong></p>
            {plan.others.length > 0 && <p className="muted">Vos autres tâches en cours sont ci-dessous.</p>}
          </div>
        )
      ) : (
        <ul className="day-list" data-testid="day-list">{plan.today.map(render)}</ul>
      )}

      {plan.others.length > 0 && (
        <>
          {plan.today.length > 0 ? (
            <button className="link myday-more" aria-expanded={showOthers} onClick={() => setShowOthers((s) => !s)}>
              {showOthers ? "Masquer mes autres tâches" : `Voir mes autres tâches (${plan.others.length})`}
            </button>
          ) : (
            <div className="myday-list-head"><h3>Mes autres tâches</h3><span className="muted small">{plural(plan.others.length, "tâche", "tâches")}</span></div>
          )}
          {othersOpen && <ul className="day-list" data-testid={plan.today.length === 0 ? "day-list" : undefined}>{plan.others.map(render)}</ul>}
        </>
      )}

      {plan.review.length > 0 && (
        <>
          <div className="myday-list-head"><h3>En attente de vérification</h3><span className="muted small">{plural(plan.review.length, "tâche", "tâches")}</span></div>
          <ul className="day-list review">
            {plan.review.map((t) => (
              <li key={t.id} className="day-task">
                <div className="day-task-main static">
                  <span className="day-title">{text(t.data.title)}</span>
                  <span className="day-meta"><span className="tag info"><PIcon name="check" />Terminée, sera close après vérification</span></span>
                  <span className="day-sub muted">{text(projectOf(t)?.data.name)}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {(canExpense || mineOpen.length > 0) && (
        <div className="myday-actions">
          {canExpense && <button onClick={() => go("expenses")}><PIcon name="receipt" />Ajouter une dépense</button>}
          {mineOpen.length > 0 && <button onClick={() => setBlockPicker(true)}><PIcon name="hand" />Je suis bloqué</button>}
        </div>
      )}

      {blockPicker && (
        <Sheet title="Sur quelle tâche êtes-vous bloqué ?" onClose={() => setBlockPicker(false)}>
          <ul className="pick-list">
            {mineOpen.map((i) => (
              <li key={i.task.id}>
                <button onClick={() => { setBlockPicker(false); setSheet({ task: i.task, mode: "block" }); }}>
                  <span>{text(i.task.data.title)}</span>
                  <span className="muted small">{text(projectOf(i.task)?.data.name)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
      {sheet && (
        <TaskSheet
          key={sheet.task.id}
          task={tasks.find((t) => t.id === sheet.task.id) ?? sheet.task}
          project={projectOf(sheet.task)}
          initialMode={sheet.mode}
          chronoBusy={!!chrono}
          canClose={canClose(sheet.task)}
          addHours={addHours}
          onStart={() => { startChrono(sheet.task); setSheet(null); }}
          onClose={() => setSheet(null)}
        />
      )}
    </section>
  );
}

function DayTask({ item, project, running, chronoBusy, onOpen, onStart }: {
  item: DayItem<SyncRecord> & { soonDays: number }; project?: SyncRecord; running: boolean; chronoBusy: boolean; onOpen: () => void; onStart: () => void;
}) {
  const t = item.task;
  const site = text(project?.data.site_address);
  const due = text(t.data.due_date);
  return (
    <li className={`day-task${t.data.blocked ? " blocked" : ""}${running ? " running" : ""}`}>
      <button className="day-task-main" onClick={onOpen} aria-label={`${text(t.data.title)} : saisir du temps`}>
        <span className="day-title">{text(t.data.title)}</span>
        <span className="day-meta">
          {item.reason === "priority" && <span className="tag"><PIcon name="pushpin" />Priorité de la semaine</span>}
          {item.lateDays > 0 && <span className="tag danger"><PIcon name="clock" />En retard {item.lateDays === 1 ? "d'1 jour" : `de ${item.lateDays} jours`}</span>}
          {item.reason === "due" && <span className="tag warn">Échéance aujourd'hui</span>}
          {item.soonDays > 0 && <span className="tag warn"><PIcon name="clock" />{item.soonDays === 1 ? "Échéance demain" : `Échéance dans ${item.soonDays} jours`}</span>}
          {(text(t.data.status) === "doing") && <span className="tag info">En cours</span>}
          {item.reason === "start" && <span className="tag">Commence aujourd'hui</span>}
          {item.reason === "open" && due && !item.soonDays && <span className="tag">Échéance {new Date(`${due}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}</span>}
        </span>
        <span className="day-sub muted">{text(project?.data.name)}</span>
        {t.data.blocked ? (
          <span className="day-blocked"><PIcon name="alert" />Bloquée : {BLOCK_LABELS[text(t.data.blocked_reason)] ?? "motif non précisé"}{t.data.blocked_note ? ` (${text(t.data.blocked_note)})` : ""}</span>
        ) : null}
        {site && <span className="day-site muted"><PIcon name="pin" />{site}</span>}
      </button>
      {!running && (
        <button className="day-play" onClick={onStart} disabled={chronoBusy} aria-label={`Démarrer le chronomètre : ${text(t.data.title)}`}
          title={chronoBusy ? "Un chronomètre tourne déjà : arrêtez-le pour en démarrer un autre" : "Démarrer le chronomètre"}>
          <PIcon name="play" />
        </button>
      )}
    </li>
  );
}

function ChronoCard({ chrono, now, project, onStop }: { chrono: Chrono; now: number; project?: SyncRecord; onStop: (hours: number | null) => void }) {
  const [stopping, setStopping] = useState(false);
  const elapsed = now - chrono.start;
  const r = chronoRounding(elapsed);
  return (
    <div className="chrono-card" data-testid="chrono">
      <p className="chrono-since">Chronomètre en cours depuis {timeOfDay(chrono.start)}</p>
      <p className="chrono-task">{chrono.title}</p>
      {project && <p className="chrono-project">{text(project.data.name)}</p>}
      <div className="chrono-row">
        <span className="chrono-time mono" aria-live="off">{clock(elapsed)}</span>
        {!stopping && <button className="chrono-stop" onClick={() => setStopping(true)}><PIcon name="stop" />Arrêter</button>}
      </div>
      {stopping && (
        <div className="chrono-choose">
          <p>Temps passé : {hoursFr(Math.round(r.exact * 100) / 100)}. Quelle durée enregistrer ?</p>
          <div className="chrono-options">
            <button onClick={() => onStop(r.down)}>{hoursFr(r.down)}</button>
            {r.up !== r.down && <button onClick={() => onStop(r.up)}>{hoursFr(r.up)}</button>}
          </div>
          <div className="chrono-options secondary">
            <button className="ghost small" onClick={() => setStopping(false)}>Laisser tourner</button>
            <button className="ghost small" onClick={() => confirm("Arrêter sans enregistrer ce temps ?") && onStop(null)}>Ne pas enregistrer</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Feuille du bas (téléphone) ou fenêtre centrée (ordinateur). */
export function Sheet({ title, onClose, children, labelledBy }: { title?: string; onClose: () => void; children: ReactNode; labelledBy?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="p-sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="p-sheet" role="dialog" aria-modal="true" aria-label={labelledBy ? undefined : title} aria-labelledby={labelledBy}>
        <div className="sheet-grip" aria-hidden="true" />
        <div className="p-sheet-head">
          {title && <h3>{title}</h3>}
          <button className="icon" onClick={onClose} aria-label="Fermer"><PIcon name="close" /></button>
        </div>
        {children}
      </div>
    </>
  );
}

const DURATIONS: [number, string][] = [[1, "1 h"], [2, "2 h"], [4, "4 h"], [8, "8 h"]];

function TaskSheet({ task, project, initialMode, chronoBusy, canClose, addHours, onStart, onClose }: {
  task: SyncRecord; project?: SyncRecord; initialMode: "time" | "block"; chronoBusy: boolean; canClose: boolean;
  addHours: (task: SyncRecord, hours: number) => Promise<AddResult>; onStart: () => void; onClose: () => void;
}) {
  const { db, session } = useApp();
  const write = useGuardedWrite();
  const [mode, setMode] = useState<"time" | "block">(initialMode);
  const [saved, setSaved] = useState<{ id: string; hours: number } | null>(null);
  const [other, setOther] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState(text(task.data.blocked_reason) || "material");
  const status = text(task.data.status) || "todo";

  async function record(hours: number) {
    setError(null);
    const r = await addHours(task, hours);
    if (r.ok) setSaved({ id: r.id, hours });
    else setError(r.message);
  }
  async function undo() {
    if (!saved) return;
    await db.remove("time_entries", saved.id);
    setSaved(null);
  }
  async function act(patch: Record<string, unknown>, after?: () => void) {
    setError(null);
    try {
      await write("tasks", task.id, patch);
      after?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "La tâche n'a pas pu être modifiée.");
    }
  }
  function onOther(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = Number(String(new FormData(e.currentTarget).get("hours") ?? "").replace(",", "."));
    if (!(v > 0)) return setError("Indiquez une durée, par exemple 1,5.");
    record(Math.round(v * 100) / 100);
  }
  function onBlock(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const note = String(new FormData(e.currentTarget).get("note") ?? "").trim();
    act({ blocked: true, blocked_reason: reason, blocked_note: note, blocked_at: new Date().toISOString(), blocked_by: session.user.id }, onClose);
  }

  return (
    <Sheet onClose={onClose} labelledBy="task-sheet-title">
      {mode === "time" ? (
        <>
          <h3 id="task-sheet-title" className="sheet-task">{text(task.data.title)}</h3>
          <p className="muted small">{text(project?.data.name)}</p>
          <p className="durations-label">Temps passé aujourd'hui</p>
          <div className="durations" role="group" aria-label="Durée travaillée aujourd'hui">
            {DURATIONS.map(([h, l]) => (
              <button key={h} className={saved?.hours === h ? "selected" : ""} onClick={() => record(h)} disabled={!!saved}>{l}</button>
            ))}
            <button className={`wide${other ? " selected" : ""}`} onClick={() => setOther(true)} disabled={!!saved}>Autre durée</button>
          </div>
          {other && !saved && (
            <form className="other-duration" onSubmit={onOther}>
              <label>Durée (heures)<input name="hours" inputMode="decimal" autoFocus placeholder="1,5" /></label>
              <button className="primary">Enregistrer</button>
            </form>
          )}
          <p className="muted small hint">Le temps est enregistré dès que vous choisissez une durée. 4 h = demi-journée, 8 h = journée.</p>
          {saved && (
            <p className="saved-bar" role="status" data-testid="saved-bar">
              <PIcon name="check" /><span>{hoursFr(saved.hours)} enregistrées</span>
              <button className="ghost small" onClick={undo}>Annuler</button>
            </p>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="sheet-actions">
            {status !== "review" && status !== "done" && (
              <>
                <button onClick={() => act(canClose ? { status: "done", done_at: new Date().toISOString(), blocked: false } : { status: "review" }, onClose)}><PIcon name="check" />J'ai terminé cette tâche</button>
                {!canClose && <p className="muted small sheet-note">Elle sera close après vérification.</p>}
              </>
            )}
            {status === "review" && <p className="muted small">Tâche terminée : elle sera close après vérification.</p>}
            <div className="sheet-actions-row">
              {!chronoBusy && <button className="ghost" onClick={onStart}><PIcon name="play" />Démarrer le chronomètre</button>}
              {task.data.blocked
                ? <button className="ghost" onClick={() => act({ blocked: false, blocked_reason: "", blocked_note: "" })}>Je ne suis plus bloqué</button>
                : <button className="ghost" onClick={() => setMode("block")}><PIcon name="hand" />Je suis bloqué</button>}
            </div>
          </div>
        </>
      ) : (
        <form onSubmit={onBlock} className="block-form">
          <h3 id="task-sheet-title" className="sheet-task">Je suis bloqué</h3>
          <p className="muted small">{text(task.data.title)} · {text(project?.data.name)}</p>
          <div className="reasons" role="radiogroup" aria-label="Motif du blocage">
            {Object.entries(BLOCK_LABELS).map(([k, l]) => (
              <button type="button" key={k} role="radio" aria-checked={reason === k} className={`reason${reason === k ? " selected" : ""}`} onClick={() => setReason(k)}>
                <span className="radio-dot" aria-hidden="true" />{l}
              </button>
            ))}
          </div>
          <label>Précision (facultatif)<input name="note" maxLength={140} placeholder="Ex. : plâtre en rupture chez le fournisseur" /></label>
          <p className="muted small hint">La tâche reste dans sa colonne, marquée « Bloquée » avec ce motif, sur la fiche du projet.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="sheet-actions">
            <button className="primary">Signaler le blocage</button>
            <button type="button" className="ghost" onClick={() => (initialMode === "block" ? onClose() : setMode("time"))}>Retour</button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
