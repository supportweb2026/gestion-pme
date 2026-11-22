/**
 * Écriture contrôlée du module Projets : l'appareil applique les mêmes règles
 * que le serveur (checkChange, checkPermission) avant d'écrire, pour refuser
 * tout de suite, même hors ligne. `db.write` reste inchangé pour le reste de l'application.
 */
import { encodeHlc } from "../../shared/hlc.ts";
import { checkChange, checkPermission, type Actor, type Fields, type SyncRecord, type SyncTable } from "../../shared/sync.ts";
import type { ProjectContext } from "../../shared/projectRules.ts";
import type { LocalDb } from "./db.ts";

export class GuardError extends Error {}

/** Contexte projet calculé sur les données locales (équipe et statut des projets). */
export function localProjectContext(projects: SyncRecord[], members: SyncRecord[]): ProjectContext {
  return {
    project: (pid) => projects.find((p) => p.id === pid) ?? null,
    rolesIn: (pid, uid) => members.filter((m) => !m.data._deleted && m.data.project_id === pid && m.data.user_id === uid).map((m) => String(m.data.role ?? "member")),
  };
}

const sentence = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);

export async function guardedWrite(db: LocalDb, actor: Actor, tbl: SyncTable, id: string, patch: Fields, opts: { ctx?: ProjectContext; closedUntil?: string } = {}): Promise<void> {
  const existing = await db.get(tbl, id);
  const change = { id: "local-check", tbl, row: id, patch, hlc: encodeHlc(Date.now(), 0, db.deviceId), device: db.deviceId };
  const reason = checkChange(existing, change) ?? checkPermission(actor, existing, change, opts.closedUntil ?? "", opts.ctx);
  if (reason) throw new GuardError(sentence(reason));
  await db.write(tbl, id, patch);
}
