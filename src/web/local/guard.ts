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

/** Contexte projet calculé sur les données locales (équipe, statut des projets, étapes et décisions). */
export function localProjectContext(projects: SyncRecord[], members: SyncRecord[], stages?: SyncRecord[], decisions?: SyncRecord[]): ProjectContext {
  return {
    project: (pid) => projects.find((p) => p.id === pid) ?? null,
    rolesIn: (pid, uid) => members.filter((m) => !m.data._deleted && m.data.project_id === pid && m.data.user_id === uid).map((m) => String(m.data.role ?? "member")),
    ...(stages ? { stages: (pid: string) => stages.filter((s) => !s.data._deleted && s.data.project_id === pid) } : {}),
    ...(decisions ? { decisions: (pid: string) => decisions.filter((d) => !d.data._deleted && d.data.project_id === pid) } : {}),
  };
}

/**
 * Messages généraux de `checkPermission` (partagés avec les autres modules),
 * reformulés pour l'écran : dire ce qui se passe, sans renvoyer vers un rôle.
 */
const ON_SCREEN: Record<string, string> = {
  "votre rôle ne permet pas cette modification": "vous ne pouvez pas faire cette modification",
  "un employé ne saisit que ses propres temps": "vous pouvez saisir ou supprimer seulement votre propre temps",
};

/** Raison de refus présentée comme une phrase : majuscule initiale, point final. */
export const sentence = (m: string) => {
  const t = (ON_SCREEN[m] ?? m).trim();
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}`;
};

export async function guardedWrite(db: LocalDb, actor: Actor, tbl: SyncTable, id: string, patch: Fields, opts: { ctx?: ProjectContext; closedUntil?: string } = {}): Promise<void> {
  const existing = await db.get(tbl, id);
  // Décisions lues au moment de l'écriture : une décision écrite juste avant dans le même geste compte (R11).
  if (opts.ctx?.decisions && (tbl === "tasks" || tbl === "invoices" || tbl === "project_decisions")) {
    const all = await db.list("project_decisions");
    opts = { ...opts, ctx: { ...opts.ctx, decisions: (pid: string) => all.filter((d) => !d.data._deleted && d.data.project_id === pid) } };
  }
  const change = { id: "local-check", tbl, row: id, patch, hlc: encodeHlc(Date.now(), 0, db.deviceId), device: db.deviceId };
  const reason = checkChange(existing, change) ?? checkPermission(actor, existing, change, opts.closedUntil ?? "", opts.ctx);
  if (reason) throw new GuardError(sentence(reason));
  await db.write(tbl, id, patch);
}
