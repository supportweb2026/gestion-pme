/**
 * Nouveau projet (maquette B, CDC §3.2, §3.3, parcours 5.1).
 * Seul le nom est obligatoire. Point de départ : un devis accepté (client, nom, montant
 * vendu et étapes repris, rien à ressaisir) ou un modèle. Le reste est replié.
 * Aucune facture n'est créée ici : la facture d'étape viendra avec la validation (lot 3).
 */
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { can, formatDate, text, today, useApp, useTable } from "../../context.ts";
import { formatMoney } from "../../../shared/currency.ts";
import { formatXaf } from "../../../shared/invoice.ts";
import { quoteTypeOf } from "../../../shared/documents.ts";
import {
  billingShareTotal, projectFromQuote, projectNameFromQuote, projectOfQuote, projectSeed, quoteNet, stageAmounts, type ProjectSeed, type StageSpec,
} from "../../../shared/projectControl.ts";
import { PROJECT_TEMPLATES, suggestTemplate, TEMPLATE_ORDER, templateOf, type TemplateId } from "../../../shared/projectTemplates.ts";
import { teamMemberIdOf } from "../../../shared/projectRules.ts";
import type { InvoiceLine } from "../../../shared/invoice.ts";
import type { SyncRecord } from "../../../shared/sync.ts";
import { useGuardedWrite, useTeam } from "../team.ts";
import { PIcon, type ProjectIconName } from "../ProjectIcons.tsx";

const TEMPLATE_ICONS: Record<TemplateId, ProjectIconName> = {
  forfait: "flag", regie: "clock", interne: "building", conseil: "list", creation: "image", blank: "plus",
};

type Fold = "stages" | "money" | "team" | "site";

/** Devis qui peuvent lancer un projet : devis (pas pro forma ni bon) accepté ou facturé, sans projet. */
export function launchableQuotes(quotes: SyncRecord[], projects: SyncRecord[]): SyncRecord[] {
  return quotes
    .filter((q) => !q.data._deleted && quoteTypeOf(q.data) === "quote" && ["accepted", "invoiced"].includes(text(q.data.status)) && text(q.data.number) && !projectOfQuote(q, projects))
    .sort((a, b) => text(b.data.decided_at || b.data.date).localeCompare(text(a.data.decided_at || a.data.date)));
}

const stagesFrom = (id: TemplateId): StageSpec[] => PROJECT_TEMPLATES[id].stages.map((s) => ({ ...s, tasks: [...s.tasks] }));

export function NewProject({ quoteId, onClose }: { quoteId?: string; onClose: (openId?: string) => void }) {
  const { db, session } = useApp();
  const write = useGuardedWrite();
  const quotes = useTable("quotes");
  const projects = useTable("projects");
  const clients = useTable("clients");
  const articles = useTable("articles");
  const team = useTeam().filter((m) => m.data.active !== false);
  const amounts = can.seeAmounts(session.user.role);
  const me = teamMemberIdOf(session.user.id);

  const eligible = useMemo(() => launchableQuotes(quotes, projects), [quotes, projects]);
  const [source, setSource] = useState<string>(quoteId ?? "");
  const [template, setTemplate] = useState<TemplateId>("blank");
  const [stages, setStages] = useState<StageSpec[]>([]);
  const [name, setName] = useState("");
  const [nameFromQuote, setNameFromQuote] = useState(false);
  const [clientId, setClientId] = useState("");
  const [lead, setLead] = useState(me);
  const [sponsor, setSponsor] = useState("");
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState("");
  const [site, setSite] = useState("");
  const [money, setMoney] = useState({ sold: "", hourly: "", cost: "", budget: "" });
  const [open, setOpen] = useState<Set<Fold>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);

  const quote = quotes.find((q) => q.id === source) ?? null;
  const clientName = (id: unknown) => text(clients.find((c) => c.id === id)?.data.name);

  // Un devis choisi reprend le client, le nom et propose un modèle (une seule fois par devis).
  if (quote && applied !== quote.id) {
    const lines = (quote.data.lines as InvoiceLine[] | undefined) ?? [];
    const t = suggestTemplate(lines, articles);
    setApplied(quote.id);
    setClientId(text(quote.data.client_id));
    setName(projectNameFromQuote(quote, clientName(quote.data.client_id)));
    setNameFromQuote(true);
    setTemplate(t);
    setStages(stagesFrom(t));
  }
  if (!quote && applied && applied !== "none") setApplied(null);

  const pickTemplate = (t: TemplateId) => { setTemplate(t); setStages(stagesFrom(t)); };
  const pickSource = (id: string) => { setSource(id); if (!id) { setApplied("none"); setNameFromQuote(false); } };
  const toggle = (f: Fold) => setOpen((s) => { const n = new Set(s); if (n.has(f)) n.delete(f); else n.add(f); return n; });

  const qn = quote ? quoteNet(quote) : null;
  const tpl = templateOf(template);
  const invoicedQuote = quote?.data.status === "invoiced";
  const billing = invoicedQuote && tpl.billing === "stages" ? "time" : tpl.billing;
  const V = qn ? qn.net : Math.round(Number(money.sold) || 0);
  const currency = qn?.currency ?? "XAF";
  const fm = (n: number) => (currency === "XAF" ? formatXaf(n) : formatMoney(n, currency));
  const share = billingShareTotal(stages.map((s, i) => ({ id: String(i), data: { billing_pct: s.billing_pct } })));
  const plan = stageAmounts(V, stages.map((s, i) => ({ id: String(i), data: { billing_pct: s.billing_pct } })));
  const taskCount = stages.reduce((n, s) => n + (s.tasks?.length ?? 0), 0);
  const deliverables = stages.reduce((n, s) => n + (s.tasks?.filter((t) => t.deliverable).length ?? 0), 0);

  const setStage = (i: number, patch: Partial<StageSpec>) => setStages((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const stagesSummary = stages.length
    ? `${stages.length} étape${stages.length > 1 ? "s" : ""} : ${stages.map((s) => `${s.name}${s.billing_pct ? ` ${s.billing_pct.toLocaleString("fr-FR")} %` : ""}`).join(", ")}`
    : "Aucune étape : l'avancement suivra les tâches. Vous pourrez en ajouter ensuite.";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Donnez un nom au projet.");
    if (end && start && end < start) return setError("La fin prévue précède le début.");
    if (stages.some((s) => !s.name.trim())) return setError("Chaque étape doit avoir un nom.");
    if (quote && projectOfQuote(quote, projects)) return setError("Ce devis a déjà lancé un projet.");
    setError(null);
    setBusy(true);
    const person = (id: string) => {
      const m = team.find((x) => x.id === id);
      return m ? { id: m.id, name: text(m.data.name), user_id: text(m.data.user_id) } : null;
    };
    const base = {
      start_date: start, end_date: end, site_address: site, manager: person(lead), sponsor: person(sponsor),
      userId: session.user.id, now: new Date().toISOString(),
    };
    const rates = amounts ? { hourly_rate: Number(money.hourly) || 0, cost_rate: Number(money.cost) || 0 } : {};
    let seed: ProjectSeed;
    if (quote) {
      seed = projectFromQuote(quote, { id: template, billing: tpl.billing, stages }, { ...base, name, stages, money: rates });
    } else {
      seed = projectSeed({
        ...base, id: db.newId("prj"), name, client_id: clientId, template, billing, stages,
        money: amounts ? { ...rates, sold_manual: Number(money.sold) || 0, legacy_budget: Number(money.budget) || 0 } : null,
      });
    }
    try {
      // Ordre de §5.1 : projet, finance, équipe, étapes, tâches types, puis le devis.
      await write("projects", seed.project.id, { ...seed.project.patch, client_id: clientId || text(seed.project.patch.client_id), _deleted: false });
      if (seed.finance && amounts) await write("project_finance", seed.finance.id, seed.finance.patch);
      for (const m of seed.members) await write("project_members", m.id, m.patch);
      for (const s of seed.stages) await write("project_stages", s.id, s.patch);
      for (const t of seed.tasks) await write("tasks", t.id, t.patch);
      if (seed.quoteLink) await write("quotes", seed.quoteLink.id, seed.quoteLink.patch);
      onClose(seed.project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Création impossible.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="new-project">
      <nav className="crumbs" aria-label="Fil d'Ariane">
        <button className="link" onClick={() => onClose()}>Projets</button>
        <PIcon name="chevron" />
        <span>Nouveau projet</span>
      </nav>
      <h2>Nouveau projet</h2>
      <p className="muted np-lead">Seul le nom est obligatoire. Tout le reste est proposé et modifiable ensuite.</p>

      <form className="np-layout" onSubmit={submit}>
        <div className="np-main">
          <Step n={1} title="Point de départ">
            <div className={`np-source${source ? " selected" : ""}${eligible.length === 0 && !quote ? " empty" : ""}`}>
              <div className="np-source-head">
                <span className="np-ico"><PIcon name="doc" /></span>
                <div>
                  <strong>Depuis un devis accepté</strong>
                  <p className="muted small">Le client, le montant vendu et les étapes sont repris du devis. Rien à ressaisir.</p>
                </div>
              </div>
              {eligible.length === 0 && !quote ? (
                <p className="muted small np-source-empty">Aucun devis accepté en attente de projet. Marquez un devis « accepté » pour le lancer d'ici.</p>
              ) : (
                <div className="np-quotes" role="radiogroup" aria-label="Devis accepté">
                  {[...(quote && !eligible.includes(quote) ? [quote] : []), ...eligible].slice(0, 6).map((q) => {
                    const n = quoteNet(q);
                    return (
                      <label key={q.id} className={`np-quote${source === q.id ? " on" : ""}`}>
                        <input type="radio" name="source" checked={source === q.id} onChange={() => pickSource(q.id)} />
                        <span className="mono strong">{text(q.data.number)}</span>
                        <span className="np-quote-name">{clientName(q.data.client_id) || "Sans client"}{projectNameFromQuote(q, "") !== "Nouveau projet" ? ` : ${projectNameFromQuote(q, "")}` : ""}</span>
                        {amounts && <span className="mono">{formatMoney(n.net, n.currency)}</span>}
                        <span className="muted small nowrap">{q.data.status === "invoiced" ? "facturé" : "accepté"}{q.data.decided_at ? ` le ${formatDate(text(q.data.decided_at).slice(0, 10)).slice(0, 5)}` : ""}</span>
                      </label>
                    );
                  })}
                  {source && (
                    <label className="np-quote">
                      <input type="radio" name="source" checked={false} onChange={() => pickSource("")} />
                      <span className="muted">Sans devis</span>
                    </label>
                  )}
                </div>
              )}
            </div>
            <p className="np-sub">{quote ? "Modèle proposé d'après le devis (modifiable)" : "Ou partir d'un modèle, sans devis"}</p>
            <div className="np-templates" role="radiogroup" aria-label="Modèle de projet">
              {TEMPLATE_ORDER.map((id) => {
                const t = PROJECT_TEMPLATES[id];
                return (
                  <label key={id} className={`np-template${template === id ? " on" : ""}`}>
                    <span className="np-ico"><PIcon name={TEMPLATE_ICONS[id]} /></span>
                    <span className="np-template-text"><strong>{t.label}</strong><span className="muted small">{t.hint}</span></span>
                    <input type="radio" name="template" checked={template === id} onChange={() => pickTemplate(id)} aria-label={t.label} />
                  </label>
                );
              })}
            </div>
          </Step>

          <Step n={2} title="L'essentiel">
            <div className="np-grid">
              <label className="wide">
                Nom du projet
                <span className="np-input-note">
                  <input value={name} onChange={(e) => { setName(e.target.value); setNameFromQuote(false); }} required placeholder="Ex. : Rénovation agence BGFI Owendo" />
                  {nameFromQuote && <em>repris du devis</em>}
                </span>
              </label>
              <label>
                Client
                <select value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={!!quote}>
                  <option value="">Projet interne</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{text(c.data.name)}</option>)}
                </select>
              </label>
              <label>
                Responsable du projet
                <select value={lead} onChange={(e) => setLead(e.target.value)}>
                  <option value="">À choisir</option>
                  {team.map((m) => <option key={m.id} value={m.id}>{text(m.data.name)}</option>)}
                </select>
              </label>
              <label>Début<input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
              <label><span>Fin prévue <span className="muted">(conseillée)</span></span><input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} /></label>
            </div>
          </Step>

          <Step n={3} title="Le reste, si vous voulez">
            <div className="np-folds">
              <Fold icon="diamond" title="Étapes et facturation" summary={stagesSummary} open={open.has("stages")} onToggle={() => toggle("stages")} tone={stages.length ? "ok" : ""}>
                <StagesEditor stages={stages} setStage={setStage} setStages={setStages} showPct={amounts} />
                {stages.length > 0 && amounts && billing === "stages" && Math.abs(share - 100) > 1e-9 && (
                  <p className="notice warn-note">Les étapes facturent {share.toLocaleString("fr-FR")} % du montant vendu.</p>
                )}
              </Fold>
              {amounts && (
                <Fold icon="coins" title="Montant vendu et taux"
                  summary={qn ? `${fm(qn.net)} HT repris du devis ${text(quote?.data.number)}` : V ? `${fm(V)} HT saisi à la main` : "À saisir si le projet n'a pas de devis. Jamais visible des employés."}
                  open={open.has("money")} onToggle={() => toggle("money")}>
                  <div className="np-grid">
                    {!qn && <label>Montant vendu HT (FCFA)<input type="number" min="0" value={money.sold} onChange={(e) => setMoney({ ...money, sold: e.target.value })} /></label>}
                    <label>Taux de facturation (FCFA / h)<input type="number" min="0" value={money.hourly} onChange={(e) => setMoney({ ...money, hourly: e.target.value })} /></label>
                    <label>Coût horaire interne (FCFA / h)<input type="number" min="0" value={money.cost} onChange={(e) => setMoney({ ...money, cost: e.target.value })} /></label>
                    {!qn && <label>Budget HT (FCFA)<input type="number" min="0" value={money.budget} onChange={(e) => setMoney({ ...money, budget: e.target.value })} /></label>}
                  </div>
                  <p className="muted small">Montants rangés à part : ils ne sont jamais envoyés aux téléphones des employés. Le budget par poste arrive avec le suivi du budget.</p>
                </Fold>
              )}
              <Fold icon="users" title="Équipe" summary={sponsor ? `Commanditaire : ${text(team.find((m) => m.id === sponsor)?.data.name)}. Ajoutez l'équipe dans la fiche du projet.` : "Choisissez le commanditaire, celui qui valide les étapes. L'équipe s'ajoute dans la fiche."}
                open={open.has("team")} onToggle={() => toggle("team")}>
                <label className="np-narrow">
                  Commanditaire
                  <select value={sponsor} onChange={(e) => setSponsor(e.target.value)}>
                    <option value="">À choisir</option>
                    {team.map((m) => <option key={m.id} value={m.id}>{text(m.data.name)}</option>)}
                  </select>
                </label>
              </Fold>
              <Fold icon="pin" title="Adresse du site" summary={site || "Affichée aux techniciens dans Ma journée, avec un lien vers la carte."}
                open={open.has("site")} onToggle={() => toggle("site")}>
                <label>Adresse ou site<input value={site} onChange={(e) => setSite(e.target.value)} placeholder="Ex. : Agence BGFI, carrefour SNI, Owendo" /></label>
              </Fold>
            </div>
          </Step>

          {error && <p className="error" role="alert">{error}</p>}
          <div className="np-actions">
            <p className="muted small">Le projet est créé sur cet appareil : rien n'est envoyé au client, aucune facture n'est préparée.</p>
            <button type="button" className="ghost" onClick={() => onClose()}>Annuler</button>
            <button className="primary" disabled={busy}>Créer le projet</button>
          </div>
        </div>

        <aside className="np-aside card" aria-label="Ce que Gestia va créer">
          <h3>Ce que Gestia va créer</h3>
          <p className="muted small">{quote ? `À partir du devis ${text(quote.data.number)}` : `Modèle « ${tpl.label} »`}</p>
          {amounts && (
            <div className="np-sold">
              <div className="muted small">Montant vendu</div>
              <div className="np-sold-value" data-testid="np-sold">{V ? <>{(currency === "XAF" ? formatXaf(V).replace(/\s?FCFA$/, "") : formatMoney(V, currency))}{currency === "XAF" && <span> FCFA HT</span>}</> : <span className="muted">Non renseigné</span>}</div>
              {qn && qn.currency !== "XAF" && <div className="muted small">soit {formatXaf(qn.netXaf)} au taux du devis</div>}
            </div>
          )}
          <div className="np-aside-block">
            <div className="muted small">{stages.length ? "Étapes" : "Organisation"}</div>
            {stages.length === 0 ? <p className="small">Pas d'étape : l'avancement suit les tâches terminées.</p> : (
              <ul className="np-stage-list">
                {stages.map((s, i) => (
                  <li key={i}>
                    <span className={`np-diamond${s.kind === "start" ? " start" : ""}`} aria-hidden="true" />
                    <span>{s.name || "Sans nom"}{amounts && s.billing_pct ? <span className="muted"> · {s.billing_pct.toLocaleString("fr-FR")} %</span> : null}</span>
                    {amounts && V > 0 && plan.has(String(i)) ? <span className="mono">{fm(plan.get(String(i))!).replace(/\s?FCFA$/, "")}</span> : null}
                  </li>
                ))}
              </ul>
            )}
            {taskCount > 0 && <p className="muted small">{taskCount} tâche{taskCount > 1 ? "s" : ""} type{taskCount > 1 ? "s" : ""}{deliverables ? `, dont ${deliverables} à remettre au client` : ""}.</p>}
          </div>
          {invoicedQuote && <p className="notice small">Devis déjà facturé : les étapes servent au suivi, la facturation reste au temps passé pour éviter une double facture.</p>}
          {amounts && stages.some((s) => s.kind === "start" && s.billing_pct > 0) && V > 0 && billing === "stages" && (
            <div className="np-next">
              <PIcon name="doc" />
              <div>
                <strong>Étape Démarrage : {fm(plan.get(String(stages.findIndex((s) => s.kind === "start"))) ?? 0)} HT prévus</strong>
                <p className="muted small">Aucune facture n'est créée maintenant. La facture d'étape sera proposée à la validation de l'étape.</p>
              </div>
            </div>
          )}
        </aside>
      </form>
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="np-step">
      <h3 className="np-step-title"><span className="np-step-n" aria-hidden="true">{n}</span>{title}</h3>
      {children}
    </div>
  );
}

function Fold({ icon, title, summary, open, onToggle, tone = "", children }: { icon: ProjectIconName; title: string; summary: string; open: boolean; onToggle: () => void; tone?: string; children: ReactNode }) {
  return (
    <div className={`np-fold${open ? " open" : ""}`}>
      <button type="button" className="np-fold-head" aria-expanded={open} onClick={onToggle}>
        <span className={`np-fold-ico ${tone}`}><PIcon name={icon} /></span>
        <span className="np-fold-text"><strong>{title}</strong><span className="muted small">{summary}</span></span>
        <span className="np-fold-action">{open ? "Replier" : "Modifier"}</span>
        <PIcon name="chevron" className="np-chevron" />
      </button>
      {open && <div className="np-fold-body">{children}</div>}
    </div>
  );
}

/** Étapes proposées : nom, part du vendu, ordre ; ajout et retrait. */
function StagesEditor({ stages, setStage, setStages, showPct }: { stages: StageSpec[]; setStage: (i: number, p: Partial<StageSpec>) => void; setStages: (f: (s: StageSpec[]) => StageSpec[]) => void; showPct: boolean }) {
  const move = (i: number, d: number) => setStages((ss) => { const n = [...ss]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n; });
  return (
    <div className="np-stages">
      {stages.length === 0 && <p className="muted small">Ce modèle ne découpe pas le projet en étapes.</p>}
      {stages.map((s, i) => (
        <div key={i} className="np-stage-row">
          <span className={`np-diamond${s.kind === "start" ? " start" : ""}`} aria-hidden="true" />
          <input value={s.name} onChange={(e) => setStage(i, { name: e.target.value })} aria-label={`Nom de l'étape ${i + 1}`} />
          {showPct && (
            <span className="np-pct">
              <input type="number" min="0" max="100" step="1" value={s.billing_pct || ""} placeholder="0" onChange={(e) => setStage(i, { billing_pct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} aria-label={`Part du vendu, étape ${i + 1} (%)`} />
              <span className="muted">%</span>
            </span>
          )}
          <span className="np-row-tools">
            <button type="button" className="ghost small icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Monter l'étape ${s.name}`}><PIcon name="arrowUp" /></button>
            <button type="button" className="ghost small icon" disabled={i === stages.length - 1} onClick={() => move(i, 1)} aria-label={`Descendre l'étape ${s.name}`}><PIcon name="arrowDown" /></button>
            <button type="button" className="ghost small icon" onClick={() => setStages((ss) => ss.filter((_, j) => j !== i))} aria-label={`Retirer l'étape ${s.name}`}><PIcon name="close" /></button>
          </span>
        </div>
      ))}
      <button type="button" className="small" onClick={() => setStages((ss) => [...ss, { name: "", kind: "normal", billing_pct: 0, span: 1, tasks: [] }])}><PIcon name="plus" />Ajouter une étape</button>
    </div>
  );
}
