/**
 * Préparation des factures récurrentes sur l'appareil : à l'ouverture de l'appli
 * puis à chaque changement des données, chaque série arrivée à échéance donne un
 * brouillon (identifiant déterministe, donc jamais en double entre appareils).
 */
import { useEffect } from "react";
import type { LocalDb } from "./local/db.ts";
import type { Session } from "./context.ts";
import { today } from "./context.ts";
import { addDays } from "../shared/invoice.ts";
import { isDepositLine } from "../shared/documents.ts";
import { daysBetween, dueOccurrences, occurrenceId, recurrenceOf } from "../shared/recurrence.ts";
import type { Fields, SyncRecord } from "../shared/sync.ts";

/** Rôles qui créent des factures (les autres ne déclenchent rien). */
const INVOICING_ROLES = ["admin", "director", "accountant", "sales", "project_manager"];

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** Contenu du brouillon d'une échéance, d'après la facture modèle. */
export function occurrencePatch(source: SyncRecord, date: string, user: { id: string; name: string }): Fields {
  const d = source.data;
  const term = Math.max(0, daysBetween(str(d.date), str(d.due_date)));
  return {
    status: "draft",
    client_id: d.client_id,
    date,
    due_date: addDays(date, term),
    lines: ((d.lines as { deposit?: boolean; depositInvoiceId?: string }[]) ?? []).filter((l) => !isDepositLine(l as never)),
    notes: str(d.notes),
    currency: str(d.currency) || "XAF",
    rate: Number(d.rate) || 1,
    project_id: str(d.project_id),
    withholding_rate: Number(d.withholding_rate) || 0,
    withholding_label: str(d.withholding_label),
    recurrence_of: source.id,
    recurrence_number: str(d.number),
    created_by: user.id,
    created_by_name: user.name,
    created_auto: true,
  };
}

export async function prepareRecurringInvoices(db: LocalDb, session: Session, day = today()): Promise<number> {
  if (!INVOICING_ROLES.includes(session.user.role)) return 0;
  let created = 0;
  for (const inv of await db.list("invoices")) {
    const rec = recurrenceOf(inv.data);
    if (!rec || inv.data.status !== "validated") continue;
    const { dates, next } = dueOccurrences(rec, str(inv.data.recurrence_next), day);
    if (dates.length === 0) continue;
    for (const date of dates) {
      const id = occurrenceId(inv.id, date);
      // Déjà préparé (ou supprimé volontairement) ici ou sur un autre appareil : on n'y touche pas.
      if (await db.get("invoices", id)) continue;
      await db.write("invoices", id, occurrencePatch(inv, date, session.user));
      created++;
    }
    await db.write("invoices", inv.id, { recurrence_next: next });
  }
  return created;
}

/** Lance la préparation au démarrage (après une première synchronisation) puis à chaque changement. */
export function useRecurringInvoices(db: LocalDb, session: Session): void {
  useEffect(() => {
    if (!INVOICING_ROLES.includes(session.user.role)) return;
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (running) { again = true; return; }
      running = true;
      try {
        await prepareRecurringInvoices(db, session);
      } catch {
        /* nouvel essai au prochain changement */
      } finally {
        running = false;
        if (again) { again = false; schedule(); }
      }
    };
    const schedule = (ms = 1500) => {
      clearTimeout(timer);
      timer = setTimeout(run, ms);
    };
    // Laisse le temps à la première synchronisation d'apporter l'état des autres appareils.
    schedule(4000);
    const off = db.onChange(() => schedule());
    return () => { clearTimeout(timer); off(); };
  }, [db, session]);
}
