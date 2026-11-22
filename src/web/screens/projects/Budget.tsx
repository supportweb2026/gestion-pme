/**
 * Projets, lot 4 : météo du projet, onglet Budget (prévu, réel, en attente, coût final estimé,
 * marges, recettes, tolérances), carte de décision en cas de dépassement (avenant, révision,
 * plan de redressement, pause) et révision tracée du budget (maquettes C, F et H).
 *
 * Confidentialité : ce fichier n'est affiché qu'aux rôles qui voient les montants, sauf la
 * météo (délai, réserves), que l'employé voit sans critère budget. Le responsable du projet
 * voit la marge et le coût horaire moyen, jamais le coût horaire de chaque personne.
 * Rédaction (revue UX) : le fait, puis son effet ; pas de renvoi vers une hiérarchie.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { formatDate, text, today, useApp, useSettings } from "../../context.ts";
import { DEFAULT_VAT_RATE, formatXaf } from "../../../shared/invoice.ts";
import { fiscalSettings, newDocTaxFields } from "../../../shared/taxes.ts";
import {
  amendmentAmount, amendmentQuote, budgetFromQuote, budgetLineId, budgetLinesOf, companyHourlyCost, lineAmount, LIGHT_LABELS, missingRateNotice,
  plannedRate, POSTE_LABELS, POSTES, quoteBudgetLines, revisionValues, tolerances,
  type BudgetData, type Forecast, type Light, type Poste, type ProjectAlert, type Weather,
} from "../../../shared/projectBudget.ts";
import { pct100, STAGE_STATE_LABELS, type StageInfo } from "../../../shared/projectControl.ts";
import { financeOf, type Rec } from "../../../shared/projects.ts";
import type { SyncRecord } from "../../../shared/sync.ts";
import { GuardError } from "../../local/guard.ts";
import { useGuardedWrite } from "../team.ts";
import { Initials, PIcon, type ProjectIconName } from "../ProjectIcons.tsx";

const ICON: Record<Light, ProjectIconName> = { green: "sun", orange: "cloud", red: "storm", grey: "dash" };
const fx = (n: number) => formatXaf(n);
const bare = (n: number) => formatXaf(n).replace(/\s?FCFA$/, "");
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${bare(Math.abs(n))}`;
const pctFr = (n: number | null) => (n === null ? "—" : `${n.toLocaleString("fr-FR")} %`);
const errorText = (e: unknown, fallback: string) => (e instanceof GuardError || e instanceof Error ? e.message : fallback);
const plusDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Pastille de météo : couleur d'état, icône et mot (jamais la couleur seule). */
export function WeatherBadge({ light, label }: { light: Light; label?: string }) {
  return (
    <span className={`weather-badge ${light}`} data-testid="weather-badge">
      <PIcon name={ICON[light]} />{label ?? LIGHT_LABELS[light]}
    </span>
  );
}

export interface BudgetView {
  project: SyncRecord;
  data: BudgetData & { budget_lines: Rec[]; quotes: Rec[]; project_members?: Rec[]; articles?: Rec[] };
  stages: StageInfo<SyncRecord>[];
  fc: Forecast;
  w: Weather;
  alerts: ProjectAlert[];
  /** Montants visibles (pas l'employé). */
  amounts: boolean;
  /** Coût horaire de chaque personne visible (direction, comptable). */
  perPerson: boolean;
  /** Peut décider pour ce projet (commanditaire, direction, responsable délégué). */
  decides: boolean;
  /** Dirige le projet (responsable, commanditaire, direction) : budget, tolérances, mot. */
  leads: boolean;
  locked: boolean;
}

// ---------------------------------------------------------------------------
// Météo en détail (sous l'en-tête) et mot du responsable du projet (RG9.1)
// ---------------------------------------------------------------------------

export function WeatherDetail({ v, onClose }: { v: BudgetView; onClose: () => void }) {
  const write = useGuardedWrite();
  const { session } = useApp();
  const note = text(v.project.data.pm_note);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note);
  const [error, setError] = useState<string | null>(null);
  const rows: [string, Light, string][] = [
    ["Délai", v.w.schedule.light, v.w.schedule.reason],
    ...(v.amounts ? [["Budget", v.w.budget.light, v.w.budget.reason] as [string, Light, string]] : []),
    ["Vigilance", v.w.reserves.light, v.w.reserves.reason],
  ];
  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await write("projects", v.project.id, { pm_note: draft.trim(), pm_note_at: new Date().toISOString(), pm_note_by: session.user.name });
      setEditing(false);
    } catch (err) {
      setError(errorText(err, "Le mot n'a pas pu être enregistré."));
    }
  }
  return (
    <section className="card weather-detail" aria-labelledby="weather-title" data-testid="weather-detail">
      <div className="card-head">
        <h3 id="weather-title">Météo en détail</h3>
        <button className="ghost small icon" onClick={onClose} aria-label="Fermer le détail de la météo"><PIcon name="close" /></button>
      </div>
      <dl className="weather-rows">
        {rows.map(([label, light, reason]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd><WeatherBadge light={light} /><span>{reason}</span></dd>
          </div>
        ))}
      </dl>
      <p className="muted small weather-rule">La météo est calculée à chaque ouverture : elle ne se règle pas à la main. Un critère gris n'est pas suivi et ne compte pas.</p>
      {(note || v.leads) && (
        <div className="pm-note" data-testid="pm-note">
          {editing ? (
            <form onSubmit={save}>
              <label className="val-field">
                <span>Mot du responsable du projet</span>
                <textarea rows={2} maxLength={280} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ex. : le site d'Owendo demande deux fois plus de câblage que prévu au devis" />
              </label>
              {error && <p className="error" role="alert">{error}</p>}
              <div className="pm-note-actions">
                <button type="button" className="ghost" onClick={() => { setEditing(false); setDraft(note); }}>Annuler</button>
                <button className="primary">Enregistrer le mot</button>
              </div>
            </form>
          ) : note ? (
            <>
              <div className="pm-note-head">
                <Initials name={text(v.project.data.pm_note_by) || "?"} />
                <strong>Mot du responsable du projet</strong>
                {v.project.data.pm_note_at ? <span className="muted small">{formatDate(text(v.project.data.pm_note_at).slice(0, 10))}</span> : null}
                {v.leads && <button className="link small" onClick={() => setEditing(true)}>Modifier</button>}
              </div>
              <p>{note}</p>
            </>
          ) : (
            <button className="link" onClick={() => setEditing(true)}><PIcon name="edit" />Expliquer la météo en une phrase</button>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Carte de décision (dépassement de tolérance) et information du responsable
// ---------------------------------------------------------------------------

export function ExceptionCard({ v, alert, onRevise, onPause, onDone }: {
  v: BudgetView; alert: ProjectAlert; onRevise: (a: ProjectAlert) => void; onPause: () => void; onDone: (msg: string, quoteId?: string) => void;
}) {
  const { db, session, go } = useApp();
  const settings = useSettings();
  const write = useGuardedWrite();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [later, setLater] = useState(false);
  const isDelay = alert.key === "delay";
  const f = alert.figures;
  const overrun = Math.max(0, f.delta ?? 0);
  const amount = amendmentAmount(overrun, v.fc.marginPlannedPct);
  const stageName = alert.stageId ? text(v.stages.find((i) => i.stage.id === alert.stageId)?.stage.data.name) : "";
  const day = today();
  if (later) return null;

  async function run(fn: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try { await fn(); } catch (e) { setError(errorText(e, "La décision n'a pas pu être enregistrée.")); } finally { setBusy(false); }
  }
  const base = () => {
    const now = new Date().toISOString();
    return { project_id: v.project.id, ...(alert.stageId ? { stage_id: alert.stageId } : {}), alert_key: alert.key, alert_level: alert.step,
      decided_by: session.user.id, decided_by_name: session.user.name, decided_at: now, created_by: session.user.id, created_at: now,
      snapshot: { progress: pct100(v.fc.A), budget: v.fc.BP, cfe: v.fc.CFE, sold: v.fc.RP, delayDays: v.w.schedule.delayDays, weather: v.w.overall } };
  };

  const amend = () => run(async () => {
    const cause = stageName ? `travaux supplémentaires, étape ${stageName}` : "travaux supplémentaires";
    const quoteId = db.newId("dv");
    const decisionId = db.newId("dec");
    await write("project_decisions", decisionId, { ...base(), kind: "amendment_proposed", quote_id: quoteId, comment: `Avenant proposé au client (${cause}).` });
    await write("quotes", quoteId, {
      ...amendmentQuote(v.project, amount, cause.charAt(0).toUpperCase() + cause.slice(1), { today: day, userId: session.user.id, userName: session.user.name, vatRate: DEFAULT_VAT_RATE }),
      doc_type: "quote", ...newDocTaxFields(fiscalSettings(settings)), withholding_rate: 0, withholding_label: "",
    });
    onDone(`Devis d'avenant préparé en brouillon : ${fx(amount)} HT, rattaché au projet. Ajustez-le puis envoyez-le au client.`, quoteId);
    go("quotes", quoteId);
  });

  const plan = () => run(async () => {
    const lead = v.data.project_members?.find((m: Rec) => m.data.project_id === v.project.id && m.data.role === "manager" && !m.data._deleted);
    const decisionId = db.newId("dec");
    await write("project_decisions", decisionId, { ...base(), kind: "plan_requested", task_id: `tsk-plan-${decisionId}`, comment: `Plan de redressement demandé : ${alert.title.toLowerCase()}.` });
    await write("tasks", `tsk-plan-${decisionId}`, {
      project_id: v.project.id, title: "Proposer un plan de redressement", description: `${alert.title}. ${isDelay ? alert.detail : "Proposez comment revenir dans la tolérance (délais, achats, avenant)."}`,
      status: "todo", priority: "high", kind: "plan", decision_id: decisionId, assignee_id: text(lead?.data.team_member_id), due_date: plusDays(day, 3),
      ...(alert.stageId ? { stage_id: alert.stageId } : {}), created_by: session.user.id, created_at: new Date().toISOString(),
    });
    onDone(`Tâche « Proposer un plan de redressement » créée${lead ? ` pour ${text(lead.data.name)}` : ""}, échéance le ${formatDate(plusDays(day, 3))}. L'alerte reste ouverte.`);
  });

  const figures: [string, ReactNode, string, string?][] = isDelay
    ? [
      ["Retard estimé", `${f.delayDays} j`, `tolérance de ${f.toleranceDays} j`, "danger"],
      ["Avancement", `${pct100(v.fc.A)} %`, "fait à date"],
      ["Fin prévue", v.project.data.end_date ? formatDate(v.project.data.end_date) : "—", stageName ? `étape ${stageName} en retard` : "du projet"],
      ["Effet sur le projet", v.amounts && v.fc.RP > 0 ? `Marge ${pctFr(v.fc.marginEstimatedPct)}` : "—", v.amounts && v.fc.RP > 0 ? `estimée, prévue ${pctFr(v.fc.marginPlannedPct)}` : ""],
    ]
    : [
      [stageName ? "Budget de l'étape" : "Budget prévu", bare(f.budget ?? 0), `tolérance ±${f.tolerancePct} %`],
      ["Coût réel", bare(f.actual ?? 0), "dépensé à date"],
      ["Coût final estimé", bare(f.cfe ?? 0), `${signed(f.delta ?? 0)} · ${(f.deltaPct ?? 0) > 0 ? "+" : ""}${f.deltaPct ?? 0} %`, "danger"],
      ["Effet sur le projet", v.fc.RP > 0 ? `Marge ${pctFr(v.fc.marginEstimatedPct)}` : bare(v.fc.CFE), v.fc.RP > 0 ? `estimée, prévue ${pctFr(v.fc.marginPlannedPct)}` : "coût final estimé du projet"],
    ];
  const note = text(v.project.data.pm_note);

  return (
    <section className="card exception-card" aria-labelledby={`exc-${alert.key}`} data-testid="exception-card">
      <div className="exc-head">
        <span className="exc-ico"><PIcon name="alert" /></span>
        <div>
          <p className="exc-eyebrow">Dépassement de tolérance · à décider</p>
          <h3 id={`exc-${alert.key}`}>{alert.title}</h3>
          <p className="muted small">{alert.detail} L'alerte disparaît dès que vous décidez ou que l'écart revient dans la tolérance.</p>
        </div>
        <button className="ghost small" onClick={() => setLater(true)}>Plus tard</button>
      </div>
      <dl className="exc-figures">
        {figures.map(([label, value, sub, tone]) => (
          <div key={label}><dt>{label}</dt><dd className={`mono${tone === "danger" ? " danger-text" : ""}`}>{value}</dd><dd className="muted small">{sub}</dd></div>
        ))}
      </dl>
      {note && (
        <div className="exc-note"><Initials name={text(v.project.data.pm_note_by) || "?"} /><div><strong>Mot du responsable du projet</strong>{v.project.data.pm_note_at ? <span className="muted small"> · {formatDate(text(v.project.data.pm_note_at).slice(0, 10))}</span> : null}<p>{note}</p></div></div>
      )}
      {alert.planRequested && <p className="notice small">Plan de redressement demandé le {formatDate(text(alert.planRequested.data.decided_at).slice(0, 10))}{alert.planRequested.data.decided_by_name ? ` par ${text(alert.planRequested.data.decided_by_name)}` : ""}.</p>}
      <div className="exc-options">
        {!isDelay && (
          <div className="exc-option lead">
            <strong><PIcon name="doc" />Proposer un avenant au client</strong>
            <span>{text(v.project.data.client_id)
              ? `Crée un devis brouillon de ${fx(amount)} HT (dépassement${v.fc.marginPlannedPct ? " et marge prévue" : ""}), rattaché au projet. Accepté, il augmente le montant vendu.`
              : "Ce projet n'a pas de client : choisissez-en un dans « Modifier le projet » pour préparer l'avenant."}</span>
            <button className="primary" disabled={busy || !text(v.project.data.client_id) || amount <= 0} onClick={amend}>Préparer l'avenant</button>
          </div>
        )}
        <div className="exc-option">
          <strong><PIcon name="edit" />Accepter et réviser</strong>
          <span>{isDelay ? "Nouvelle date de fin saisie avec son motif. Le retard repart de zéro, la révision est tracée." : `Nouveau budget${stageName ? " de l'étape" : ""} saisi avec son motif. L'écart repart de zéro, la révision est tracée.`}</span>
          <button disabled={busy} onClick={() => onRevise(alert)}>Réviser</button>
        </div>
        <div className="exc-option">
          <strong><PIcon name="list" />Demander un plan de redressement</strong>
          <span>Tâche pour le responsable du projet, à rendre sous 3 jours. L'alerte reste ouverte.</span>
          <button disabled={busy || !!alert.planRequested} onClick={plan}>{alert.planRequested ? "Plan demandé" : "Demander un plan"}</button>
        </div>
        <div className="exc-option stop">
          <strong><PIcon name="pause" />Mettre en pause ou arrêter</strong>
          <span>Aucune facture. Le motif est demandé et enregistré.</span>
          <button className="ghost danger" disabled={busy} onClick={onPause}>Choisir…</button>
        </div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

/** Alerte vue par le responsable du projet : une information, jamais une décision (CA4.6). */
export function AlertNotice({ alert, onOpen, onNote }: { alert: ProjectAlert; onOpen?: () => void; onNote?: () => void }) {
  const red = alert.level === "red";
  return (
    <div className={`alert-notice ${alert.level}`} role="status" data-testid="alert-notice">
      <PIcon name={red ? "alert" : "cloud"} />
      <div>
        <strong>{red ? "Hors tolérance, en attente de décision : " : "À surveiller : "}{alert.title.charAt(0).toLowerCase()}{alert.title.slice(1)}.</strong>
        <span className="muted small">{alert.detail}{alert.planRequested ? " Un plan de redressement est demandé." : ""}</span>
      </div>
      <span className="alert-notice-actions">
        {onNote && <button className="ghost small" onClick={onNote}>Écrire un mot</button>}
        {onOpen && <button className="small" onClick={onOpen}>Voir le budget</button>}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Révision de la date de fin (Accepter et réviser, délai)
// ---------------------------------------------------------------------------

export function DeadlineDialog({ v, alert, onClose, onDone }: { v: BudgetView; alert: ProjectAlert | null; onClose: () => void; onDone: (m: string) => void }) {
  const { db, session } = useApp();
  const write = useGuardedWrite();
  const old = text(v.project.data.end_date);
  const [end, setEnd] = useState(old ? plusDays(old, alert?.figures.delayDays ?? 7) : plusDays(today(), 30));
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  useDialog(onClose);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!comment.trim()) return setError("Indiquez le motif de la révision.");
    if (!end || (text(v.project.data.start_date) && end < text(v.project.data.start_date))) return setError("Choisissez une date de fin après le début du projet.");
    try {
      const now = new Date().toISOString();
      await write("project_decisions", db.newId("dec"), {
        project_id: v.project.id, kind: "deadline_revised", comment: comment.trim(), old_value: { end_date: old }, new_value: { end_date: end },
        ...(alert ? { alert_key: alert.key, alert_level: alert.step } : {}),
        decided_by: session.user.id, decided_by_name: session.user.name, decided_at: now, created_by: session.user.id, created_at: now,
      });
      await write("projects", v.project.id, { end_date: end });
      onDone(`Date de fin révisée : ${formatDate(end)}. La révision est enregistrée dans l'historique du projet.`);
    } catch (err) {
      setError(errorText(err, "La révision n'a pas pu être enregistrée."));
    }
  }
  return (
    <>
      <div className="val-backdrop" onClick={onClose} aria-hidden="true" />
      <form className="val-dialog narrow" role="dialog" aria-modal="true" aria-labelledby="dl-title" onSubmit={submit}>
        <header className="val-head">
          <div><h3 id="dl-title">Réviser la date de fin</h3><p className="muted small">{text(v.project.data.name)}{old ? ` · fin prévue le ${formatDate(old)}` : ""}</p></div>
          <button type="button" className="ghost icon" onClick={onClose} aria-label="Fermer"><PIcon name="close" /></button>
        </header>
        <div className="val-body">
          <label className="val-field"><span>Nouvelle date de fin</span><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
          <label className="val-field"><span>Motif</span><textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Ex. : le client a ajouté un site, accord par courriel du 20/11" /></label>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="val-foot">
          <p className="muted small">La date initiale reste visible dans l'historique. Le retard se calcule sur la nouvelle date.</p>
          <div className="val-foot-actions"><button type="button" className="ghost" onClick={onClose}>Annuler</button><button className="primary">Enregistrer la révision</button></div>
        </footer>
      </form>
    </>
  );
}

function useDialog(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.classList.add("dialog-open");
    return () => { window.removeEventListener("keydown", onKey); document.body.classList.remove("dialog-open"); };
  }, [onClose]);
}

// ---------------------------------------------------------------------------
// Saisie et révision du budget (grille poste × étape, RG7.1, RG7.3, R7)
// ---------------------------------------------------------------------------

export function BudgetEditor({ v, alert, onClose, onDone }: { v: BudgetView; alert: ProjectAlert | null; onClose: () => void; onDone: (m: string) => void }) {
  const { db, session } = useApp();
  const write = useGuardedWrite();
  const rate = plannedRate(v.project, v.data);
  const lines = budgetLinesOf(v.project.id, v.data.budget_lines);
  const stages = v.stages.map((i) => i.stage);
  const current = (stageId: string, p: Poste) => {
    const l = lines.find((x) => x.id === budgetLineId(v.project.id, stageId, p));
    return l ? lineAmount(l, rate) : 0;
  };
  const stageAlert = alert?.stageId && alert.key !== "delay" ? alert.stageId : "";
  // Révision depuis une alerte : proposer les montants portés au coût final estimé.
  const suggest = (stageId: string, p: Poste) => {
    const c = current(stageId, p);
    if (!alert || alert.key === "delay" || !alert.figures.budget || !alert.figures.cfe) return c;
    if (stageAlert && stageId !== stageAlert) return c;
    if (!stageAlert && v.fc.byStage && stageId) return c;
    return Math.round((c * alert.figures.cfe) / alert.figures.budget / 1000) * 1000;
  };
  const hasStageLines = lines.some((l) => stages.some((s) => s.id === l.data.stage_id));
  const [detail, setDetail] = useState(hasStageLines || !!stageAlert);
  const cols = ["", ...(detail ? stages.map((s) => s.id) : [])];
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const sid of ["", ...stages.map((s) => s.id)]) for (const p of POSTES) {
      const n = suggest(sid, p);
      out[budgetLineId(v.project.id, sid, p)] = n ? String(n) : "";
    }
    return out;
  });
  const [comment, setComment] = useState(alert && alert.key !== "delay" ? "Budget porté au coût final estimé après le dépassement." : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useDialog(onClose);
  const val = (sid: string, p: Poste) => Math.max(0, Math.round(Number(String(values[budgetLineId(v.project.id, sid, p)] ?? "").replace(/\s/g, "")) || 0));
  const colTotal = (sid: string) => POSTES.reduce((n, p) => n + val(sid, p), 0);
  const rowTotal = (p: Poste) => cols.reduce((n, sid) => n + val(sid, p), 0);
  const grand = cols.reduce((n, sid) => n + colTotal(sid), 0);
  const hidden = detail ? 0 : stages.reduce((n, s) => n + POSTES.reduce((m, p) => m + current(s.id, p), 0), 0);
  const labourHours = Number(lines.find((l) => l.data.poste === "labour" && !l.data.stage_id)?.data.hours) || 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const next: Record<string, number> = {};
    for (const sid of cols) for (const p of POSTES) {
      const id = budgetLineId(v.project.id, sid, p);
      if (val(sid, p) !== current(sid, p)) next[id] = val(sid, p);
    }
    if (Object.keys(next).length === 0) return onClose();
    if (v.locked && !comment.trim()) return setError("Indiquez le motif de la révision : il reste dans l'historique du projet.");
    setBusy(true);
    try {
      const now = new Date().toISOString();
      if (v.locked) {
        await write("project_decisions", db.newId("dec"), {
          project_id: v.project.id, kind: "budget_revised", comment: comment.trim(), ...revisionValues(v.project, v.data, next),
          ...(alert && alert.key !== "delay" ? { alert_key: alert.key, alert_level: alert.step, ...(alert.stageId ? { stage_id: alert.stageId } : {}) } : {}),
          decided_by: session.user.id, decided_by_name: session.user.name, decided_at: now, created_by: session.user.id, created_at: now,
          snapshot: { progress: pct100(v.fc.A), budget: v.fc.BP, cfe: v.fc.CFE, sold: v.fc.RP },
        });
      }
      for (const [id, amount] of Object.entries(next)) {
        const exists = lines.some((l) => l.id === id) || v.data.budget_lines.some((l) => l.id === id);
        const [sid, p] = (() => { for (const s of cols) for (const q of POSTES) if (budgetLineId(v.project.id, s, q) === id) return [s, q] as const; return ["", "other"] as const; })();
        await write("budget_lines", id, exists ? { amount, _deleted: false } : { project_id: v.project.id, stage_id: sid, poste: p, amount, source: "manual", created_by: session.user.id, created_at: now, _deleted: false });
      }
      onDone(v.locked ? `Budget révisé : ${fx(v.fc.BP)} → ${fx(v.fc.BP + Object.entries(next).reduce((n, [id, a]) => n + a - (lines.find((l) => l.id === id) ? lineAmount(lines.find((l) => l.id === id)!, rate) : 0), 0))}. La révision est enregistrée dans l'historique.` : "Budget enregistré.");
    } catch (err) {
      setError(errorText(err, "Le budget n'a pas pu être enregistré."));
    } finally {
      setBusy(false);
    }
  }

  const title = v.locked ? "Réviser le budget" : v.fc.budgetSource === "none" ? "Définir le budget" : "Modifier le budget";
  return (
    <>
      <div className="val-backdrop" onClick={() => !busy && onClose()} aria-hidden="true" />
      <form className="val-dialog wide" role="dialog" aria-modal="true" aria-labelledby="be-title" onSubmit={submit}>
        <header className="val-head">
          <div>
            <h3 id="be-title">{title}</h3>
            <p className="muted small">{text(v.project.data.name)} · montants hors taxes, en FCFA{v.fc.RP > 0 ? ` · vendu ${fx(v.fc.RP)}` : ""}</p>
          </div>
          <button type="button" className="ghost icon" onClick={onClose} aria-label="Fermer"><PIcon name="close" /></button>
        </header>
        <div className="val-body">
          {alert && alert.key !== "delay" && (
            <p className="notice small">Proposition : montants portés au coût final estimé ({fx(alert.figures.cfe ?? 0)}{stageAlert ? ` pour l'étape ${text(stages.find((s) => s.id === stageAlert)?.data.name)}` : ""}). Ajustez-les si besoin.</p>
          )}
          <div className="budget-grid-wrap">
            <table className="budget-grid">
              <thead>
                <tr>
                  <th>Poste</th>
                  {cols.map((sid) => <th key={sid || "all"} className="right">{sid ? text(stages.find((s) => s.id === sid)?.data.name) : detail ? "Sans étape" : "Prévu"}</th>)}
                  {detail && <th className="right">Total</th>}
                </tr>
              </thead>
              <tbody>
                {POSTES.map((p) => (
                  <tr key={p}>
                    <th scope="row">{POSTE_LABELS[p]}{p === "labour" && labourHours > 0 && !detail ? <span className="muted small">{labourHours.toLocaleString("fr-FR")} h prévues</span> : null}</th>
                    {cols.map((sid) => {
                      const id = budgetLineId(v.project.id, sid, p);
                      return (
                        <td key={sid || "all"} className="right">
                          <input inputMode="numeric" className="money-input" value={values[id] ?? ""} placeholder="0" aria-label={`${POSTE_LABELS[p]}${sid ? `, ${text(stages.find((s) => s.id === sid)?.data.name)}` : ""}`}
                            onChange={(e) => setValues((x) => ({ ...x, [id]: e.target.value.replace(/[^\d\s]/g, "") }))} />
                        </td>
                      );
                    })}
                    {detail && <td className="right mono">{bare(rowTotal(p))}</td>}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  {cols.map((sid) => <td key={sid || "all"} className="right mono">{bare(colTotal(sid))}</td>)}
                  {detail && <td className="right mono strong">{bare(grand)}</td>}
                </tr>
              </tfoot>
            </table>
          </div>
          {stages.length > 0 && (
            <label className="check-line">
              <input type="checkbox" checked={detail} onChange={(e) => setDetail(e.target.checked)} />
              <span>Détailler par étape<span className="muted small"> : chaque étape reçoit son budget, et son dépassement est suivi à part.{hidden > 0 ? ` ${fx(hidden)} déjà répartis sur les étapes.` : ""}</span></span>
            </label>
          )}
          <p className="small budget-total">Budget prévu : <strong className="mono">{fx(grand + hidden)}</strong>{v.fc.RP > 0 ? <> · marge prévue <strong className="mono">{fx(v.fc.RP - grand - hidden)}</strong></> : null}</p>
          {v.locked && (
            <label className="val-field">
              <span>Motif de la révision</span>
              <textarea rows={2} value={comment} onChange={(e) => { setComment(e.target.value); setError(null); }} placeholder="Ex. : avenant DV-2026-0051 accepté, câblage supplémentaire à Owendo" />
            </label>
          )}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="val-foot">
          <p className="muted small">{v.locked ? "Le budget a été validé avec la première étape : la révision garde l'ancien et le nouveau montant, avec votre nom et la date." : "Montants confidentiels : ils ne sont jamais envoyés sur les appareils des employés."}</p>
          <div className="val-foot-actions">
            <button type="button" className="ghost" onClick={onClose} disabled={busy}>Annuler</button>
            <button className="primary" disabled={busy}>{busy ? "Enregistrement…" : v.locked ? "Enregistrer la révision" : "Enregistrer le budget"}</button>
          </div>
        </footer>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------
// Onglet Budget (maquette F)
// ---------------------------------------------------------------------------

export function BudgetTab({ v, onEdit, flash }: { v: BudgetView; onEdit: () => void; flash: ReactNode }) {
  const { session } = useApp();
  const write = useGuardedWrite();
  const { fc, project } = v;
  const [mode, setMode] = useState<"poste" | "stage">("poste");
  const [error, setError] = useState<string | null>(null);
  const [tol, setTol] = useState(() => ({ budget: String(tolerances(project).budgetPct), delay: String(tolerances(project).delayPct) }));
  const [tolSaved, setTolSaved] = useState(false);
  const quote = v.data.quotes.find((q) => q.id === project.data.quote_id && !q.data._deleted) ?? null;
  const rate = companyHourlyCost(v.data.cost_rates) || financeOf(project, v.data.project_finance).costRate;
  const lines = budgetLinesOf(project.id, v.data.budget_lines);
  const toComplete = lines.filter((l) => l.data.to_complete && !(Number(l.data.amount) > 0));
  const missing = missingRateNotice(fc);
  const light = v.w.budget.light;
  const revisions = (v.data.project_decisions ?? []).filter((d) => !d.data._deleted && d.data.project_id === project.id && (d.data.kind === "budget_revised" || d.data.kind === "deadline_revised" || d.data.kind === "amendment_proposed" || d.data.kind === "plan_requested"))
    .sort((a, b) => text(b.data.decided_at).localeCompare(text(a.data.decided_at)));

  async function fromQuote() {
    if (!quote) return;
    setError(null);
    try {
      const qb = budgetFromQuote(quote, v.data.articles ?? [], plannedRate(project, v.data));
      for (const l of quoteBudgetLines(project.id, qb, { userId: session.user.id, now: new Date().toISOString() })) await write("budget_lines", l.id, l.patch);
    } catch (e) {
      setError(errorText(e, "Le budget n'a pas pu être repris du devis."));
    }
  }
  async function saveTolerances(e: FormEvent) {
    e.preventDefault();
    const b = Number(tol.budget.replace(",", "."));
    const d = Number(tol.delay.replace(",", "."));
    if (!(b >= 0 && b <= 100) || !(d >= 0 && d <= 100)) return setError("Indiquez des tolérances entre 0 et 100 %.");
    setError(null);
    try {
      await write("projects", project.id, { tolerance_budget_pct: Math.round(b), tolerance_delay_pct: Math.round(d) });
      setTolSaved(true);
      setTimeout(() => setTolSaved(false), 2500);
    } catch (err) {
      setError(errorText(err, "Les tolérances n'ont pas pu être enregistrées."));
    }
  }

  if (fc.budgetSource === "none") {
    return (
      <div className="budget-tab">
        {flash}
        <div className="card empty-invite" data-testid="budget-invite">
          <PIcon name="coins" />
          <div>
            <strong>Définir un budget</strong>
            <p className="muted small">Le budget par poste (main-d'œuvre, achats, sous-traitance, autres frais) donne la marge estimée, la météo du budget et une alerte avant le dépassement.{quote ? " Il peut être repris des lignes du devis." : ""}</p>
          </div>
          {v.leads && quote && <button className="primary" onClick={fromQuote}>Reprendre le budget du devis</button>}
          {v.leads && <button className={quote ? "" : "primary"} onClick={onEdit}>Saisir le budget</button>}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </div>
    );
  }

  const labourHint = fc.actuals.hours > 0
    ? `${fc.actuals.hours.toLocaleString("fr-FR")} h saisies × ${v.perPerson ? "coût horaire de chaque personne" : rate ? `coût horaire moyen de ${fx(rate)}/h, estimation` : "coût horaire à renseigner"}`
    : rate && !v.perPerson ? `Coût horaire moyen : ${fx(rate)}/h` : "temps saisis × coût horaire";
  const deltaTone = light === "red" ? "danger-text" : light === "orange" ? "warn-text" : "ok-text";
  const initial = fc.initialBP;

  return (
    <div className="budget-tab" data-testid="budget-tab">
      {flash}
      {missing && <p className="notice warn-note small" role="status">{missing}</p>}
      {toComplete.length > 0 && (
        <p className="notice small" role="status">Coût à compléter : {toComplete.map((l) => `${text(l.data.note) || "lignes du devis"} (${POSTE_LABELS[l.data.poste as Poste]})`).join(" ; ")}.</p>
      )}
      <div className="budget-kpis">
        <div className="card budget-kpi">
          <span className="kpi-label">Budget prévu</span>
          <strong className="mono" data-testid="budget-planned">{bare(fc.BP)}<small> FCFA</small></strong>
          <span className="muted small">{fc.budgetSource === "legacy" ? "budget global, à répartir par poste" : initial !== null ? `initial ${fx(initial)}, ${fc.revisions > 1 ? `${fc.revisions} révisions` : "1 révision"}` : lines.some((l) => l.data.source === "quote") ? "repris du devis, jamais révisé" : "jamais révisé"}</span>
        </div>
        <div className="card budget-kpi">
          <span className="kpi-label">Coût réel à date</span>
          <strong className="mono" data-testid="budget-actual">{bare(fc.CR)}<small> FCFA</small></strong>
          <span className="muted small">{fc.consumptionPct ?? 0} % du budget, pour {pct100(fc.A)} % d'avancement{fc.committed > 0 ? ` · ${fx(fc.committed)} en attente` : ""}</span>
        </div>
        <div className="card budget-kpi">
          <span className="kpi-label">Coût final estimé</span>
          <strong className="mono" data-testid="budget-cfe">{bare(fc.CFE)}<small> FCFA</small></strong>
          <span className="small"><span className={`strong ${deltaTone}`}>{signed(fc.deltaB)} · {(fc.deltaBPct ?? 0) > 0 ? "+" : ""}{fc.deltaBPct ?? 0} %</span><span className="muted"> · tolérance {tolerances(project).budgetPct} %</span></span>
        </div>
        <div className="card budget-kpi">
          <span className="kpi-label">Marge estimée</span>
          {fc.RP > 0 ? (
            <>
              <strong className={`mono${fc.marginEstimated < 0 ? " danger-text" : ""}`} data-testid="budget-margin">{bare(fc.marginEstimated)}<small> FCFA</small></strong>
              <span className="muted small">{pctFr(fc.marginEstimatedPct)} du vendu · prévue {pctFr(fc.marginPlannedPct)}</span>
            </>
          ) : (
            <>
              <strong className="mono muted">—</strong>
              <span className="muted small">Montant vendu inconnu : indiquez-le dans « Modifier le projet ».</span>
            </>
          )}
        </div>
      </div>

      <section className="card section-card budget-table-card">
        <div className="card-head">
          <h3>Budget par {mode === "poste" ? "poste" : "étape"}</h3>
          <div className="budget-tools">
            {v.stages.length > 0 && (
              <div className="segmented small-seg" role="tablist" aria-label="Affichage du budget">
                <button role="tab" aria-selected={mode === "poste"} className={mode === "poste" ? "active" : ""} onClick={() => setMode("poste")}>Par poste</button>
                <button role="tab" aria-selected={mode === "stage"} className={mode === "stage" ? "active" : ""} onClick={() => setMode("stage")}>Par étape</button>
              </div>
            )}
            {v.leads && <button onClick={onEdit}><PIcon name="edit" />{v.locked ? "Réviser le budget" : "Modifier le budget"}</button>}
          </div>
        </div>
        <div className="table-scroll">
          {mode === "poste" ? (
            <table className="budget-table">
              <thead><tr><th>Poste</th><th className="right">Prévu</th><th className="right">Réel</th><th className="right">En attente de validation</th><th>Consommé</th></tr></thead>
              <tbody>
                {fc.byPoste.map((r) => (
                  <tr key={r.poste}>
                    <td><strong>{POSTE_LABELS[r.poste]}</strong>{r.unplanned && <span className="badge warn">non prévu</span>}<span className="muted small block">{r.poste === "labour" ? labourHint : r.poste === "purchases" ? "dépenses Achats, Fournitures, Entretien" : r.poste === "subcontracting" ? "honoraires et dépenses marquées sous-traitance" : "transport, carburant, location, autres"}</span></td>
                    <td className="right mono">{fc.budgetSource === "legacy" ? "—" : bare(r.BP)}</td>
                    <td className="right mono strong">{bare(r.CR)}</td>
                    <td className="right mono">{r.committed ? bare(r.committed) : "—"}</td>
                    <td><Meter pct={r.pct} unplanned={r.unplanned} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><th>Total</th><td className="right mono">{bare(fc.BP)}</td><td className="right mono">{bare(fc.CR)}</td><td className="right mono">{fc.committed ? bare(fc.committed) : "—"}</td><td><Meter pct={fc.consumptionPct} /></td></tr>
              </tfoot>
            </table>
          ) : (
            <table className="budget-table">
              <thead><tr><th>Étape</th><th className="right">Prévu</th><th className="right">Réel</th><th className="right">Avancement</th><th className="right">Coût final estimé</th><th className="right">Écart</th></tr></thead>
              <tbody>
                {fc.stages.map((s) => (
                  <tr key={s.stageId}>
                    <td><strong>{s.name}</strong><span className="muted small block">{STAGE_STATE_LABELS[s.state]}</span></td>
                    <td className="right mono">{s.BP ? bare(s.BP) : "—"}</td>
                    <td className="right mono strong">{bare(s.CR + s.committed)}</td>
                    <td className="right mono">{pct100(s.A)} %</td>
                    <td className="right mono">{bare(s.CFE)}</td>
                    <td className={`right mono ${s.deltaPct === null ? "muted" : s.deltaPct > tolerances(project).budgetPct ? "danger-text strong" : s.deltaPct >= tolerances(project).budgetPct / 2 ? "warn-text strong" : ""}`}>{s.deltaPct === null ? "pas de budget" : `${s.deltaPct > 0 ? "+" : ""}${s.deltaPct} %`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className={`budget-foot small ${deltaTone}`} data-testid="budget-sentence"><WeatherBadge light={light} /> {v.w.budget.reason}</p>
        <p className="muted small budget-legend">Montants hors taxes. « En attente de validation » : dépenses saisies, pas encore validées ; elles comptent dans le coût final estimé. Le coût final estimé prolonge le rythme actuel à partir de 25 % d'avancement.{fc.byStage ? "" : v.stages.length ? " Détaillez le budget par étape pour suivre chaque étape à part." : ""}</p>
      </section>

      <div className="two-cols">
        <section className="card section-card">
          <div className="card-head"><h3>Recettes</h3><span className="muted small">hors taxes</span></div>
          <dl className="stage-facts">
            <div><dt>Vendu</dt><dd className="mono">{fc.RP ? fx(fc.RP) : "—"}</dd></div>
            <div><dt>Facturé</dt><dd className="mono">{fx(fc.invoiced)}</dd></div>
            <div><dt>Encaissé</dt><dd className="mono">{fx(fc.collected)}{fc.invoiced > 0 ? <span className="muted"> · {Math.round((fc.collected / fc.invoiced) * 100)} % du facturé</span> : null}</dd></div>
            <div><dt>Reste à facturer</dt><dd className="mono">{fx(fc.toInvoice)}</dd></div>
          </dl>
        </section>
        <section className="card section-card">
          <div className="card-head"><h3>Tolérances du projet</h3></div>
          {v.leads ? (
            <form className="tolerance-form" onSubmit={saveTolerances}>
              <label>Budget<span className="pct-wrap"><input inputMode="decimal" value={tol.budget} onChange={(e) => setTol((t) => ({ ...t, budget: e.target.value }))} aria-label="Tolérance budget (%)" /> %</span></label>
              <label>Délai<span className="pct-wrap"><input inputMode="decimal" value={tol.delay} onChange={(e) => setTol((t) => ({ ...t, delay: e.target.value }))} aria-label="Tolérance délai (%)" /> % de la durée</span></label>
              <div className="tolerance-actions">{tolSaved && <span className="success small" role="status">Enregistré</span>}<button>Enregistrer les tolérances</button></div>
            </form>
          ) : (
            <p className="small">Budget ±{tolerances(project).budgetPct} % · délai ±{tolerances(project).delayPct} % de la durée.</p>
          )}
          <p className="muted small">À la moitié de la tolérance, la météo passe « À surveiller ». Au-delà de la tolérance, l'alerte demande une décision.</p>
        </section>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {revisions.length > 0 && (
        <section className="card section-card decision-log" data-testid="budget-history">
          <div className="card-head"><h3>Révisions et décisions</h3><span className="muted small">{revisions.length} {revisions.length > 1 ? "décisions" : "décision"}</span></div>
          <ol>
            {revisions.map((d) => {
              const o = d.data.old_value as { total?: number; end_date?: string } | undefined;
              const n = d.data.new_value as { total?: number; end_date?: string } | undefined;
              const label = { budget_revised: "Budget révisé", deadline_revised: "Date de fin révisée", amendment_proposed: "Avenant proposé au client", plan_requested: "Plan de redressement demandé" }[text(d.data.kind)];
              return (
                <li key={d.id}>
                  <span className={`dot ${d.data.kind === "amendment_proposed" ? "ok" : ""}`} aria-hidden="true" />
                  <div>
                    <strong>{label}</strong>
                    <span className="muted small"> · {formatDate(text(d.data.decided_at).slice(0, 10))}{d.data.decided_by_name ? ` · ${text(d.data.decided_by_name)}` : ""}</span>
                    {d.data.kind === "budget_revised" && typeof o?.total === "number" && typeof n?.total === "number" ? <p className="small mono">{fx(o.total)} → {fx(n.total)}</p> : null}
                    {d.data.kind === "deadline_revised" && n?.end_date ? <p className="small">{o?.end_date ? formatDate(o.end_date) : "sans date"} → {formatDate(n.end_date)}</p> : null}
                    {d.data.comment ? <p className="small">Motif : {text(d.data.comment)}</p> : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}

function Meter({ pct, unplanned }: { pct: number | null; unplanned?: boolean }) {
  if (pct === null) return <span className="muted small">{unplanned ? "sans budget" : "—"}</span>;
  const tone = pct > 100 ? "danger" : pct >= 80 ? "warn" : "";
  return (
    <span className={`meter ${tone}`} role="img" aria-label={`${pct} % consommé`}>
      <span className="meter-track"><span style={{ width: `${Math.min(100, pct)}%` }} /></span>
      <span className="mono small">{pct} %</span>
    </span>
  );
}
