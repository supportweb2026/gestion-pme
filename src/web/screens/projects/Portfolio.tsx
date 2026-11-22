/**
 * Projets, lot 5 : portefeuille « Tous les projets » (F15).
 *
 * Quatre chiffres (projets en cours, à redresser, reste à facturer, marge estimée), puis une
 * ligne par projet : météo et ses trois critères, avancement réel et prévu, étape en cours,
 * fin prévue et retard estimé, tâches en retard ou bloquées, validations en attente, montants.
 * Tri par urgence (CA5.1), filtres (responsable du projet, client, météo, statut), export CSV
 * (CA5.4). Tableau sur ordinateur, cartes empilées sur téléphone (CA5.5).
 *
 * Qui voit quoi (RG15.2) : direction et comptable, tous les projets ; responsable de projet et
 * commercial, leurs projets. Les montants ne sont calculés que pour les rôles qui les voient.
 */
import { useMemo, useState } from "react";
import { can, formatDate, text, today, useApp } from "../../context.ts";
import { formatXaf } from "../../../shared/invoice.ts";
import { PROJECT_STATUS, type Rec } from "../../../shared/projects.ts";
import { LIGHT_LABELS, type BudgetData, type Light } from "../../../shared/projectBudget.ts";
import {
  EMPTY_PORTFOLIO_FILTER, filterPortfolio, portfolioCsv, portfolioFileName, portfolioRow, portfolioTotals, sortPortfolio, type PortfolioFilter, type PortfolioRow, type PortfolioSort,
} from "../../../shared/portfolio.ts";
import { teamMemberIdOf } from "../../../shared/projectRules.ts";
import type { SyncRecord } from "../../../shared/sync.ts";
import { PIcon } from "../ProjectIcons.tsx";
import { WeatherBadge } from "./Budget.tsx";

const live = (r: SyncRecord) => !r.data._deleted;
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const CRITERIA: [keyof Pick<PortfolioRow["weather"], "schedule" | "budget" | "reserves">, string][] = [["schedule", "Délai"], ["budget", "Budget"], ["reserves", "Vigilance"]];
const filterKey = (userId: string) => `gestia:portefeuille:${userId}`;

/** Mini-pastilles des trois critères : chaque couleur porte aussi son mot. */
function Criteria({ row }: { row: PortfolioRow }) {
  return (
    <span className="pf-criteria">
      {CRITERIA.map(([k, label]) => {
        const c = row.weather[k];
        return <span key={k} className={`pf-crit ${c.light}`} title={`${label} : ${LIGHT_LABELS[c.light]}. ${c.reason}`}><span className="dot" aria-hidden="true" />{label}<span className="sr-only"> : {LIGHT_LABELS[c.light]}</span></span>;
      })}
    </span>
  );
}

export function Portfolio({ projects, data, members, clients, onOpen }: {
  projects: SyncRecord[]; data: BudgetData; members: SyncRecord[]; clients: SyncRecord[]; onOpen: (projectId: string) => void;
}) {
  const { session } = useApp();
  const role = session.user.role;
  const amounts = can.seeAmounts(role);
  const me = teamMemberIdOf(session.user.id);
  const day = today();
  const [filter, setFilterState] = useState<PortfolioFilter>(() => {
    try { return { ...EMPTY_PORTFOLIO_FILTER, ...JSON.parse(localStorage.getItem(filterKey(session.user.id)) ?? "{}"), q: "" }; } catch { return EMPTY_PORTFOLIO_FILTER; }
  });
  const [sort, setSort] = useState<PortfolioSort>("urgency");
  const setFilter = (f: Partial<PortfolioFilter>) => setFilterState((prev) => {
    const next = { ...prev, ...f };
    try { localStorage.setItem(filterKey(session.user.id), JSON.stringify({ ...next, q: "" })); } catch { /* reste en mémoire */ }
    return next;
  });

  // RG15.2 : direction et comptable voient tout ; les autres, les projets de leur équipe.
  const all = ["admin", "director", "accountant"].includes(role);
  const mine = (p: SyncRecord) => all || members.some((m) => live(m) && m.data.project_id === p.id && m.data.team_member_id === me);
  const clientName = (id: string) => text(clients.find((c) => c.id === id)?.data.name);
  const managerOf = (p: Rec) => {
    const m = members.find((x) => live(x) && x.data.project_id === p.id && x.data.role === "manager");
    if (m) return { id: text(m.data.team_member_id), name: text(m.data.name) };
    return p.data.manager ? { id: "", name: text(p.data.manager) } : null;
  };
  const rows = useMemo(() => projects.filter((p) => live(p) && mine(p))
    .map((p) => portfolioRow(p, data, day, { client: clientName, manager: managerOf }, amounts)), [projects, data, members, clients, day, amounts]);
  const shown = sortPortfolio(filterPortfolio(rows, filter), sort);
  const totals = portfolioTotals(shown);
  const managers = [...new Map(rows.filter((r) => r.managerId).map((r) => [r.managerId, r.manager])).entries()].sort((a, b) => a[1].localeCompare(b[1], "fr"));
  const clientList = [...new Map(rows.filter((r) => text(r.project.data.client_id)).map((r) => [text(r.project.data.client_id), r.client])).entries()].sort((a, b) => a[1].localeCompare(b[1], "fr"));
  const filtered = filter.manager || filter.client || filter.light || filter.status !== "open" || filter.q.trim();

  function exportCsv() {
    const blob = new Blob(["﻿", portfolioCsv(shown, day)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = portfolioFileName(day);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (rows.length === 0) {
    return (
      <div className="card empty-state">
        <span className="empty-ico" aria-hidden="true"><PIcon name="layers" /></span>
        <h3 className="empty-title">Aucun projet dans le portefeuille</h3>
        <p className="muted">{all ? "Le portefeuille montre chaque projet avec sa météo, ses retards et ses validations en attente." : "Le portefeuille montre les projets dont vous faites partie de l'équipe."}</p>
      </div>
    );
  }

  return (
    <div className="portfolio" data-testid="portfolio">
      <div className="kpis pf-kpis">
        <div className="kpi"><div className="kpi-label">Projets en cours</div><div className="kpi-value" data-testid="pf-active">{totals.active}</div><div className="kpi-sub">{plural(shown.length, "projet affiché", "projets affichés")}</div></div>
        <div className={`kpi${totals.red ? " danger" : ""}`}><div className="kpi-label">À redresser</div><div className="kpi-value" data-testid="pf-red">{totals.red}</div><div className="kpi-sub">{totals.orange ? `${totals.orange} à surveiller` : "aucun à surveiller"}</div></div>
        {amounts && totals.toInvoice !== null ? (
          <div className="kpi"><div className="kpi-label">Reste à facturer</div><div className="kpi-value mono">{formatXaf(totals.toInvoice)}</div><div className="kpi-sub">HT, sur le montant vendu</div></div>
        ) : (
          <div className="kpi"><div className="kpi-label">Validations en attente</div><div className="kpi-value">{totals.validations}</div><div className="kpi-sub">étapes à valider</div></div>
        )}
        {amounts && totals.margin !== null ? (
          <div className={`kpi${totals.margin < 0 ? " danger" : ""}`}><div className="kpi-label">Marge estimée</div><div className="kpi-value mono" data-testid="pf-margin">{formatXaf(totals.margin)}</div><div className="kpi-sub">{totals.marginPct !== null ? `${totals.marginPct.toLocaleString("fr-FR")} % du vendu` : "sur les projets chiffrés"}</div></div>
        ) : (
          <div className="kpi"><div className="kpi-label">Tâches en retard</div><div className="kpi-value">{shown.reduce((n, r) => n + r.lateTasks, 0)}</div><div className="kpi-sub">{plural(shown.reduce((n, r) => n + r.blockedTasks, 0), "tâche bloquée", "tâches bloquées")}</div></div>
        )}
      </div>

      <div className="toolbar pf-toolbar">
        <input type="search" placeholder="Rechercher un projet, un client ou une personne" value={filter.q} onChange={(e) => setFilter({ q: e.target.value })} aria-label="Rechercher dans le portefeuille" />
        <select value={filter.manager} onChange={(e) => setFilter({ manager: e.target.value })} aria-label="Responsable du projet">
          <option value="">Tous les responsables</option>
          {managers.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
        </select>
        <select value={filter.client} onChange={(e) => setFilter({ client: e.target.value })} aria-label="Client">
          <option value="">Tous les clients</option>
          <option value="none">Projets internes</option>
          {clientList.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
        </select>
        <select value={filter.light} onChange={(e) => setFilter({ light: e.target.value as "" | Light })} aria-label="Météo">
          <option value="">Toutes les météos</option>
          {(["red", "orange", "green", "grey"] as Light[]).map((l) => <option key={l} value={l}>{LIGHT_LABELS[l]}</option>)}
        </select>
        <select value={filter.status} onChange={(e) => setFilter({ status: e.target.value })} aria-label="Statut">
          <option value="open">En cours et planifiés</option>
          <option value="all">Tous les projets</option>
          {Object.entries(PROJECT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as PortfolioSort)} aria-label="Trier">
          <option value="urgency">Trier par urgence</option>
          <option value="end">Trier par fin prévue</option>
          <option value="name">Trier par nom</option>
        </select>
        <button className="ghost" onClick={exportCsv} disabled={shown.length === 0}><PIcon name="download" />Exporter en CSV</button>
      </div>

      {shown.length === 0 ? (
        <div className="card empty-state">
          <h3 className="empty-title">Aucun projet ne correspond</h3>
          <p className="muted">Changez les filtres pour revoir les projets.</p>
          {filtered && <button onClick={() => setFilter({ ...EMPTY_PORTFOLIO_FILTER })}>Afficher tous les projets en cours</button>}
        </div>
      ) : (
        <>
          <div className="card table-wrap pf-table-wrap">
            <table className="pf-table" data-testid="portfolio-table">
              <thead>
                <tr>
                  <th>Projet</th><th>Météo</th><th>Avancement</th><th>Étape</th><th>Fin prévue</th><th>Retards</th><th>Validations</th>
                  {amounts && <><th className="num">Vendu · facturé</th><th className="num">Marge estimée</th></>}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.project.id} onClick={() => onOpen(r.project.id)} className="pf-row" data-testid="pf-row">
                    <td>
                      <button className="link pf-name" onClick={(e) => { e.stopPropagation(); onOpen(r.project.id); }}>{r.name}</button>
                      <span className="muted small pf-sub">{[r.client || (amounts ? "Projet interne" : ""), r.manager ? `Responsable : ${r.manager}` : ""].filter(Boolean).join(" · ")}</span>
                    </td>
                    <td><WeatherBadge light={r.light} /><Criteria row={r} /></td>
                    <td className="pf-progress">
                      <span className="mono">{r.progress} %</span>{r.planned !== null && <span className="muted small"> / {r.planned} % prévu</span>}
                      <span className="pf-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, r.progress)}%` }} />{r.planned !== null && <i style={{ left: `${Math.min(100, r.planned)}%` }} />}</span>
                    </td>
                    <td>{r.stage ? <>{r.stage.name}{r.stage.state === "awaiting" && <span className="tag warn pf-tag">à valider</span>}</> : <span className="muted">—</span>}</td>
                    <td>
                      {r.endDate ? formatDate(r.endDate) : <span className="muted">—</span>}
                      {r.delayDays > 0 && <span className={`small pf-sub ${r.weather.schedule.light === "red" ? "danger-text" : "warn-text"}`}>retard estimé {r.delayDays} j</span>}
                    </td>
                    <td>
                      {r.lateTasks + r.blockedTasks === 0 ? <span className="muted small">Aucun</span> : (
                        <span className="pf-late">
                          {r.lateTasks > 0 && <span className="danger-text">{plural(r.lateTasks, "en retard", "en retard")}</span>}
                          {r.blockedTasks > 0 && <span className="danger-text">{plural(r.blockedTasks, "bloquée", "bloquées")}</span>}
                        </span>
                      )}
                    </td>
                    <td>{r.validations.count ? <span className="warn-text" data-testid="pf-validation">{plural(r.validations.count, "étape", "étapes")}<span className="small pf-sub">depuis {plural(r.validations.days, "jour", "jours")}</span></span> : <span className="muted small">Aucune</span>}</td>
                    {amounts && r.money && (
                      <>
                        <td className="num">{r.money.sold ? <><span className="mono">{formatXaf(r.money.sold)}</span><span className="muted small pf-sub">facturé {Math.round((r.money.invoiced / r.money.sold) * 100)} %</span></> : <span className="muted">—</span>}</td>
                        <td className="num">{r.money.margin === null ? <span className="muted">—</span> : <><span className={`mono${r.money.margin < 0 ? " danger-text" : ""}`}>{formatXaf(r.money.margin)}</span>{r.money.marginPct !== null && <span className={`small pf-sub${r.money.margin < 0 ? " danger-text" : " muted"}`}>{r.money.marginPct.toLocaleString("fr-FR")} %</span>}</>}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="pf-cards" aria-label="Projets du portefeuille">
            {shown.map((r) => (
              <li key={r.project.id}>
                <button className="card pf-card" onClick={() => onOpen(r.project.id)}>
                  <span className="pf-card-head"><strong>{r.name}</strong><WeatherBadge light={r.light} /></span>
                  <span className="muted small">{[r.client || (amounts ? "Projet interne" : ""), r.manager ? `Responsable : ${r.manager}` : ""].filter(Boolean).join(" · ")}</span>
                  <Criteria row={r} />
                  <span className="pf-card-facts small">
                    <span>{r.progress} % fait{r.planned !== null ? ` · ${r.planned} % prévu` : ""}</span>
                    {r.endDate && <span>Fin prévue le {formatDate(r.endDate)}{r.delayDays > 0 ? ` · retard estimé ${r.delayDays} j` : ""}</span>}
                    {r.stage && <span>Étape : {r.stage.name}{r.stage.state === "awaiting" ? ", à valider" : ""}</span>}
                    {r.validations.count > 0 && <span className="warn-text">Validation en attente depuis {plural(r.validations.days, "jour", "jours")}</span>}
                    {(r.lateTasks > 0 || r.blockedTasks > 0) && <span className="danger-text">{[r.lateTasks ? plural(r.lateTasks, "tâche en retard", "tâches en retard") : "", r.blockedTasks ? plural(r.blockedTasks, "tâche bloquée", "tâches bloquées") : ""].filter(Boolean).join(" · ")}</span>}
                    {amounts && r.money && r.money.margin !== null && <span className={r.money.margin < 0 ? "danger-text" : ""}>Marge estimée : {formatXaf(r.money.margin)}{r.money.marginPct !== null ? ` (${r.money.marginPct.toLocaleString("fr-FR")} %)` : ""}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted small pf-foot">Ordre : à redresser, à surveiller, puis tout va bien ; dans chaque groupe, la fin prévue la plus proche d'abord. La météo est calculée, jamais saisie.</p>
    </div>
  );
}
