/**
 * Module Projets, lot 3 : écriture d'une décision d'étape et des lignes qui en découlent
 * (tâches de réserve, brouillon de facture de jalon, statut du projet), sur le modèle
 * de recurring.ts : le contenu est calculé par une fonction pure (src/shared/projectDecisions.ts),
 * l'appareil écrit sous un identifiant déterministe. Aucune facture n'est numérotée ici :
 * la numérotation reste le geste « Valider » de l'écran Factures.
 */
import { useEffect } from "react";
import type { Session } from "./context.ts";
import { DEFAULT_PAYMENT_DAYS } from "../shared/invoice.ts";
import { fiscalSettings, newDocTaxFields } from "../shared/taxes.ts";
import {
  INVOICE_ERRORS, reserveLines, reserveTasks, retentionInvoice, stageInvoice, type BillingData,
} from "../shared/projectDecisions.ts";
import type { Rec } from "../shared/projects.ts";
import type { Fields, SyncTable } from "../shared/sync.ts";

type Write = (tbl: SyncTable, id: string, patch: Fields) => Promise<void>;

/** Clé lue par l'écran Factures : ouvrir ce brouillon et lancer sa validation (geste humain, confirmé). */
export const VALIDATE_ON_OPEN = "gestia:valider-facture";

const invoiceOptions = (session: Session, settings: Record<string, unknown>, today: string) => ({
  today,
  paymentDays: Number(settings.payment_days ?? DEFAULT_PAYMENT_DAYS),
  user: { id: session.user.id, name: session.user.name },
  taxes: newDocTaxFields(fiscalSettings(settings)),
});

export type Choice = "approve" | "reserves" | "pause" | "stop";

export interface DecisionInput {
  choice: Choice;
  reserves: string;
  retentionPct: number;
  comment: string;
  signatory: string;
  proofFileId: string;
  snapshot: Record<string, unknown>;
}

export interface DecisionResult { decisionId: string; invoiceId: string | null; invoiceNote: string | null; reserveTasks: number; reserveStage: string | null }

/**
 * Enregistre la décision, puis dans l'ordre (R11 : le serveur accepte les lignes qui en
 * dépendent seulement si la décision l'est) : étape « Levée des réserves » et tâches de réserve,
 * brouillon de facture de jalon, statut du projet.
 */
export async function recordDecision(write: Write, newId: (p: string) => string, session: Session, settings: Record<string, unknown>,
  project: Rec, stage: Rec, d: BillingData, input: DecisionInput, today: string): Promise<DecisionResult> {
  const now = new Date().toISOString();
  const decisionId = newId("dec");
  const kind = { approve: "stage_approved", reserves: "stage_approved_with_reserves", pause: "project_paused", stop: "project_stopped" }[input.choice];
  const withReserves = input.choice === "reserves";
  const approval = input.choice === "approve" || withReserves;
  const decision: Fields = {
    project_id: project.id, stage_id: stage.id, kind,
    decided_by: session.user.id, decided_by_name: session.user.name, decided_at: now,
    snapshot: input.snapshot, created_by: session.user.id, created_at: now,
  };
  if (input.comment.trim()) decision.comment = input.comment.trim();
  if (withReserves) {
    decision.reserves = reserveLines(input.reserves).join("\n");
    decision.retention_pct = Math.max(0, Math.min(100, Math.round(input.retentionPct)));
  }
  if (approval && input.signatory.trim()) decision.client_signatory = input.signatory.trim();
  if (input.proofFileId) decision.proof_file_id = input.proofFileId;
  await write("project_decisions", decisionId, decision);

  const result: DecisionResult = { decisionId, invoiceId: null, invoiceNote: null, reserveTasks: 0, reserveStage: null };
  if (withReserves) {
    const plan = reserveTasks(project, stage, decisionId, input.reserves, d, { userId: session.user.id, now, today });
    if (plan.stage) await write("project_stages", plan.stage.id, plan.stage.patch);
    for (const t of plan.tasks) await write("tasks", t.id, t.patch);
    result.reserveTasks = plan.tasks.length;
    result.reserveStage = plan.target.name;
  }
  if (approval) {
    const decided = { ...d, project_decisions: [...(d.project_decisions ?? []), { id: decisionId, data: decision }] };
    const inv = stageInvoice(project, stage, decided, { ...invoiceOptions(session, settings, today), decisionId, retentionPct: withReserves ? Number(decision.retention_pct) : 0 });
    if ("error" in inv) result.invoiceNote = inv.error === "no_share" || inv.error === "time_billing" ? null : INVOICE_ERRORS[inv.error];
    else {
      await write("invoices", inv.id, inv.patch);
      result.invoiceId = inv.id;
    }
  } else {
    await write("projects", project.id, { status: input.choice === "pause" ? "on_hold" : "cancelled" });
  }
  return result;
}

/** Reprise d'un projet en pause : décision `project_resumed` portée sur l'étape en pause. */
export async function resumeProject(write: Write, newId: (p: string) => string, session: Session, project: Rec, stage: Rec, comment: string): Promise<void> {
  const now = new Date().toISOString();
  await write("project_decisions", newId("dec"), {
    project_id: project.id, stage_id: stage.id, kind: "project_resumed", ...(comment.trim() ? { comment: comment.trim() } : {}),
    decided_by: session.user.id, decided_by_name: session.user.name, decided_at: now, created_by: session.user.id, created_at: now,
  });
  await write("projects", project.id, { status: "active" });
}

/** Réouverture d'une étape (direction) : une nouvelle ligne du journal, la facture éventuelle reste (RG4.5). */
export async function reopenStage(write: Write, newId: (p: string) => string, session: Session, project: Rec, stage: Rec, comment: string): Promise<void> {
  const now = new Date().toISOString();
  await write("project_decisions", newId("dec"), {
    project_id: project.id, stage_id: stage.id, kind: "stage_reopened", comment: comment.trim(),
    decided_by: session.user.id, decided_by_name: session.user.name, decided_at: now, created_by: session.user.id, created_at: now,
  });
}

/** « Préparer la facture » d'une étape validée dont le brouillon a été supprimé (CA3.8). */
export async function prepareStageInvoice(write: Write, session: Session, settings: Record<string, unknown>, project: Rec, stage: Rec, decision: Rec, d: BillingData, today: string): Promise<string> {
  const inv = stageInvoice(project, stage, d, { ...invoiceOptions(session, settings, today), decisionId: decision.id, retentionPct: Number(decision.data.retention_pct) || 0 });
  if ("error" in inv) throw new Error(INVOICE_ERRORS[inv.error]);
  await write("invoices", inv.id, inv.patch);
  return inv.id;
}

/** Brouillon de la facture de la retenue, une fois les réserves levées. */
export async function prepareRetentionInvoice(write: Write, session: Session, settings: Record<string, unknown>, project: Rec, stage: Rec, d: BillingData, today: string): Promise<string> {
  const inv = retentionInvoice(project, stage, d, invoiceOptions(session, settings, today));
  if ("error" in inv) {
    throw new Error(inv.error === "reserves_open" ? "Des réserves sont encore ouvertes : la retenue sera facturable quand elles seront closes."
      : inv.error === "already_invoiced" ? "La facture de la retenue existe déjà." : "Aucune retenue à facturer sur cette étape.");
  }
  await write("invoices", inv.id, inv.patch);
  return inv.id;
}

/** Ouvre le brouillon dans Factures et lance sa validation (confirmation demandée par l'écran Factures). */
export function validateOnOpen(invoiceId: string): void {
  try { sessionStorage.setItem(VALIDATE_ON_OPEN, invoiceId); } catch { /* stockage indisponible : le brouillon s'ouvre seulement */ }
}

/**
 * Écran Factures : si ce brouillon vient d'une validation d'étape avec « Valider la facture
 * tout de suite », lance la validation habituelle de l'écran (contrôles, confirmation, numéro).
 */
export function useValidateOnOpen(invoiceId: string | undefined, validate: () => unknown): void {
  useEffect(() => {
    if (!invoiceId) return;
    let wanted: string | null = null;
    try { wanted = sessionStorage.getItem(VALIDATE_ON_OPEN); } catch { return; }
    if (wanted !== invoiceId) return;
    try { sessionStorage.removeItem(VALIDATE_ON_OPEN); } catch { /* rien */ }
    void validate();
  }, [invoiceId]);
}
