/**
 * Module Projets : annuaire d'équipe et outils partagés par les écrans
 * (Ma journée, Projets, Équipe).
 */
import { useEffect, useMemo } from "react";
import { api } from "../api.ts";
import { can, today, useApp, useSettings, useTable, type Session } from "../context.ts";
import type { LocalDb } from "../local/db.ts";
import { guardedWrite, localProjectContext } from "../local/guard.ts";
import { teamSync } from "../../shared/projectControl.ts";
import { financeIdOf, teamMemberIdOf } from "../../shared/projectRules.ts";
import type { Fields, SyncRecord, SyncTable } from "../../shared/sync.ts";

/**
 * Crée les fiches d'annuaire manquantes à partir des comptes (direction seulement,
 * quand le réseau est là). Idempotent : identifiants `tm-{user_id}`.
 */
export async function reconcileTeam(db: LocalDb, session: Session): Promise<void> {
  if (!can.manageTeam(session.user.role)) return;
  const { users } = await api<{ users: { id: string; name: string; active: number }[] }>("/api/users");
  const members = await db.list("team_members");
  const all = [...members, ...(await Promise.all(users.map((u) => db.get("team_members", teamMemberIdOf(u.id))))).filter((r): r is SyncRecord => !!r)];
  for (const { id, patch } of teamSync(users, all, session.user.id, new Date().toISOString())) await db.write("team_members", id, patch);
}

/**
 * Reprise des projets d'avant le lot 1 : les montants des anciens projets sont
 * recopiés dans la ligne protégée `fin-{projet}`, sans effacer les originaux.
 */
export async function migrateFinance(db: LocalDb, session: Session): Promise<void> {
  if (!can.manageTeam(session.user.role)) return;
  const projects = await db.list("projects");
  for (const p of projects) {
    const legacy = { budget: Number(p.data.budget) || 0, hourly_rate: Number(p.data.hourly_rate) || 0, cost_rate: Number(p.data.cost_rate) || 0 };
    if (!legacy.budget && !legacy.hourly_rate && !legacy.cost_rate) continue;
    const id = financeIdOf(p.id);
    if (await db.get("project_finance", id)) continue;
    await db.write("project_finance", id, {
      project_id: p.id, legacy_budget: Math.round(legacy.budget), hourly_rate: Math.round(legacy.hourly_rate), cost_rate: Math.round(legacy.cost_rate),
      created_by: session.user.id, created_at: new Date().toISOString(),
    });
  }
}

export function useTeamReconcile(db: LocalDb, session: Session): void {
  useEffect(() => {
    if (!can.manageTeam(session.user.role)) return;
    let done = false;
    const run = () => {
      if (done || !navigator.onLine) return;
      done = true;
      reconcileTeam(db, session).catch(() => { done = false; });
      migrateFinance(db, session).catch(() => {});
    };
    run();
    window.addEventListener("online", run);
    return () => window.removeEventListener("online", run);
  }, [db, session]);
}

/** Annuaire trié, fiches actives d'abord. */
export function useTeam(): SyncRecord[] {
  const rows = useTable("team_members");
  return useMemo(() => [...rows].sort((a, b) =>
    Number(a.data.active === false) - Number(b.data.active === false) || String(a.data.name ?? "").localeCompare(String(b.data.name ?? ""), "fr")), [rows]);
}

/** Écriture contrôlée avec le contexte projet local (mêmes règles que le serveur). */
export function useGuardedWrite(): (tbl: SyncTable, id: string, patch: Fields) => Promise<void> {
  const { db, session } = useApp();
  const projects = useTable("projects");
  const members = useTable("project_members");
  const closedUntil = String(useSettings().closed_until ?? "");
  return (tbl, id, patch) => guardedWrite(db, { userId: session.user.id, role: session.user.role }, tbl, id, patch, { ctx: localProjectContext(projects, members), closedUntil });
}

/** Mon identifiant dans l'annuaire. */
export const useMyTeamId = () => teamMemberIdOf(useApp().session.user.id);

export const todayIso = today;

/** « 7,5 h » : heures au format français. */
export const hoursFr = (h: number) => `${(Math.round(h * 100) / 100).toLocaleString("fr-FR")} h`;
