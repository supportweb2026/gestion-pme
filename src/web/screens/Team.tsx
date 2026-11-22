/**
 * Annuaire d'équipe (Projets › Équipe) : les personnes qui travaillent sur les
 * projets, avec ou sans compte Gestia. Les comptes sont repris automatiquement
 * (fiche `tm-{user_id}`). Le coût horaire de chaque personne est une donnée
 * salariale : direction et comptable seulement ; le chef de projet ne voit que
 * le coût moyen (arbitrage 2).
 */
import { useState, type FormEvent } from "react";
import { can, text, useApp, useTable } from "../context.ts";
import { formatXaf } from "../../shared/invoice.ts";
import { averageCost } from "../../shared/projectControl.ts";
import { COMPANY_COST_ID, costRateIdOf } from "../../shared/projectRules.ts";
import type { SyncRecord } from "../../shared/sync.ts";
import { useGuardedWrite, useTeam } from "./team.ts";
import { Initials, PIcon } from "./ProjectIcons.tsx";

export function Team() {
  const { session } = useApp();
  const team = useTeam();
  const costs = useTable("cost_rates");
  const members = useTable("project_members");
  const write = useGuardedWrite();
  const [editing, setEditing] = useState<SyncRecord | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const role = session.user.role;
  const manage = can.manageTeam(role);
  const personCosts = can.seePersonCosts(role);
  const company = costs.find((c) => c.id === COMPANY_COST_ID);
  const avg = Number(company?.data.hourly_cost ?? 0) || 0;
  const costOf = (id: string) => Number(costs.find((c) => c.id === costRateIdOf(id))?.data.hourly_cost ?? 0) || 0;
  const projectsOf = (id: string) => members.filter((m) => m.data.team_member_id === id).length;
  const active = team.filter((m) => m.data.active !== false).length;

  /** Coût horaire d'une personne, puis coût moyen de l'équipe recalculé. */
  async function saveCost(tmId: string, value: number, current: SyncRecord[]) {
    const id = costRateIdOf(tmId);
    const before = current.find((c) => c.id === id);
    if (Number(before?.data.hourly_cost ?? -1) === value) return;
    await write("cost_rates", id, { team_member_id: tmId, hourly_cost: value, ...(before ? {} : { created_by: session.user.id, created_at: new Date().toISOString() }) });
    const next = [...current.filter((c) => c.id !== id), { id, data: { team_member_id: tmId, hourly_cost: value } }];
    const people = team.some((m) => m.id === tmId) ? team : [...team, { id: tmId, data: { active: true } }];
    const mean = averageCost(people, next);
    if (mean !== avg) await write("cost_rates", COMPANY_COST_ID, { hourly_cost: mean, ...(company ? {} : { created_by: session.user.id, created_at: new Date().toISOString() }) });
  }

  async function toggle(m: SyncRecord) {
    const leaving = m.data.active !== false;
    if (leaving && !confirm(`Rendre ${text(m.data.name)} inactif ? Il ne sera plus proposé pour les nouvelles tâches ; son historique est conservé.`)) return;
    try {
      await write("team_members", m.id, { active: !leaving });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Modification impossible.");
    }
  }

  return (
    <div className="team">
      <div className="team-intro">
        <p className="muted">Les personnes qui travaillent sur vos projets, avec ou sans compte Gestia. Chaque compte utilisateur y figure automatiquement.</p>
        {manage && !editing && <button className="primary" onClick={() => setEditing("new")}><PIcon name="plus" />Ajouter une personne</button>}
      </div>

      <div className="team-stats">
        <div className="card kpi"><div className="kpi-label">Personnes actives</div><div className="kpi-value">{active}</div><div className="kpi-sub">{team.length - active > 0 ? `${team.length - active} inactive(s)` : "dans l'annuaire"}</div></div>
        <div className="card kpi"><div className="kpi-label">Avec un compte Gestia</div><div className="kpi-value">{team.filter((m) => m.data.user_id).length}</div><div className="kpi-sub">les autres n'ont pas de téléphone ou de compte</div></div>
        {(personCosts || avg > 0) && (
          <div className="card kpi"><div className="kpi-label">Coût horaire moyen</div><div className="kpi-value mono">{avg ? formatXaf(avg) : "—"}</div><div className="kpi-sub">{personCosts ? "calculé sur les personnes actives ; seul ce coût moyen est visible des chefs de projet" : "sert à estimer le coût du temps des projets"}</div></div>
        )}
      </div>

      {editing && <PersonForm record={editing === "new" ? null : editing} cost={editing === "new" ? 0 : costOf(editing.id)} showCost={personCosts && manage}
        onSave={async (id, patch, cost) => {
          await write("team_members", id, patch);
          if (cost !== null) await saveCost(id, cost, costs);
          setEditing(null);
        }} onClose={() => setEditing(null)} />}
      {error && <p className="error">{error}</p>}

      {team.length === 0 ? (
        <p className="empty">L'annuaire se remplit avec les comptes utilisateurs dès la prochaine connexion de l'administrateur. {manage ? "Vous pouvez aussi ajouter une personne sans compte." : ""}</p>
      ) : (
        <div className="card table-wrap">
          <table className="team-table">
            <thead>
              <tr>
                <th>Personne</th><th>Téléphone</th><th>Compte</th><th className="right">Projets</th>
                {personCosts && <th className="right">Coût horaire</th>}
                <th>Statut</th>{manage && <th />}
              </tr>
            </thead>
            <tbody>
              {team.map((m) => {
                const off = m.data.active === false;
                return (
                  <tr key={m.id} className={off ? "inactive" : ""}>
                    <td>
                      <span className="person">
                        <Initials name={text(m.data.name)} />
                        <span><strong>{text(m.data.name)}</strong>{m.data.job ? <span className="muted small">{text(m.data.job)}</span> : null}</span>
                      </span>
                    </td>
                    <td className="nowrap">{m.data.phone ? <a href={`tel:${text(m.data.phone).replace(/\s/g, "")}`}>{text(m.data.phone)}</a> : <span className="muted">—</span>}</td>
                    <td>{m.data.user_id ? <span className="badge">Compte Gestia</span> : <span className="muted small">Sans compte</span>}</td>
                    <td className="right mono">{projectsOf(m.id) || "—"}</td>
                    {personCosts && <td className="right mono">{costOf(m.id) ? `${formatXaf(costOf(m.id))} / h` : <span className="muted">à renseigner</span>}</td>}
                    <td><span className={`badge ${off ? "" : "ok"}`}>{off ? "Inactif" : "Actif"}</span></td>
                    {manage && (
                      <td className="right nowrap">
                        <button className="ghost small" onClick={() => setEditing(m)}>Modifier</button>
                        <button className="ghost small" onClick={() => toggle(m)}>{off ? "Réactiver" : "Désactiver"}</button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!personCosts && <p className="muted small">Le coût horaire de chaque personne est réservé à la direction et au comptable.</p>}
    </div>
  );
}

function PersonForm({ record, cost, showCost, onSave, onClose }: {
  record: SyncRecord | null; cost: number; showCost: boolean;
  onSave: (id: string, patch: Record<string, unknown>, cost: number | null) => Promise<void>; onClose: () => void;
}) {
  const { db, session } = useApp();
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const values = { name: f.name.trim(), job: f.job.trim(), phone: f.phone.trim() };
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if (!record || text(record.data[k]) !== v) patch[k] = v;
    if (!record) Object.assign(patch, { user_id: "", active: true, created_by: session.user.id, created_at: new Date().toISOString() });
    const raw = (f.cost ?? "").replace(/\s/g, "");
    const value = showCost && raw !== "" ? Math.round(Number(raw)) : null;
    if (value !== null && !(value >= 0)) return setError("Coût horaire invalide.");
    try {
      await onSave(record?.id ?? db.newId("tm"), patch, value);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Enregistrement impossible.");
    }
  }
  return (
    <form className="card form-grid section-card person-form" onSubmit={submit}>
      <h3 className="wide">{record ? `Modifier ${text(record.data.name)}` : "Nouvelle personne"}</h3>
      <label>Nom et prénom<input name="name" required defaultValue={text(record?.data.name)} autoFocus={!record} /></label>
      <label>Métier<input name="job" defaultValue={text(record?.data.job)} placeholder="Ex. : Électricien" /></label>
      <label>Téléphone<input name="phone" type="tel" defaultValue={text(record?.data.phone)} placeholder="+241 …" /></label>
      {showCost && <label>Coût horaire (FCFA / h)<input name="cost" inputMode="numeric" defaultValue={cost || ""} placeholder="Ex. : 3500" /></label>}
      {showCost && <p className="wide muted small form-note">Salaire chargé divisé par les heures travaillées. Visible de la direction et du comptable seulement.</p>}
      {error && <p className="error wide">{error}</p>}
      <div className="form-actions">
        <button type="button" className="ghost" onClick={onClose}>Annuler</button>
        <button className="primary">Enregistrer</button>
      </div>
    </form>
  );
}
