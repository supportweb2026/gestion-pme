/**
 * Module Projets, lot 3 : validation d'étape et facture de jalon (CDC §3.5, §3.6 ;
 * modèle de données §3.7, §3.8, §5.2). Fonctions pures : la date du jour est passée en
 * paramètre, rien n'est écrit ici. L'écriture se fait dans src/web/projectInvoices.ts.
 *
 * Arbitrages appliqués :
 *  - la facture de jalon est calculée sur le MONTANT VENDU (Q1), jamais sur un budget (coût) ;
 *  - Démarrage = facture d'étape ordinaire (arbitrage 1) : pas de `deposit`, rien à déduire au solde ;
 *  - retenue jusqu'à la levée des réserves seulement (Q5), sans ligne négative : la facture
 *    d'étape porte M − retenue sur chaque taux de TVA, la retenue est facturée ensuite par
 *    une facture « Solde après levée des réserves » (TVA et CSS justes sur chaque facture).
 */
import { baseByRate } from "./documents.ts";
import { addDays, computeTotals, docTaxes, roundAmount, type InvoiceLine } from "./invoice.ts";
import { decimalsOf, formatMoney } from "./currency.ts";
import type { Rec } from "./projects.ts";
import { stagesOf } from "./projectControl.ts";
import { approvalBlocker, decisionsOfStage, isApproval } from "./projectRules.ts";

const num = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const live = (r: Rec) => !r.data._deleted;
const pctFr = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 2 });

/** Libellés des décisions, pour l'historique. */
export const DECISION_LABELS: Record<string, string> = {
  stage_approved: "Étape validée",
  stage_approved_with_reserves: "Étape validée avec réserves",
  stage_reopened: "Étape rouverte",
  project_paused: "Projet mis en pause",
  project_resumed: "Projet repris",
  project_stopped: "Projet arrêté",
  // Lot 4 : réponses aux alertes et révisions tracées.
  budget_revised: "Budget révisé",
  deadline_revised: "Date de fin révisée",
  amendment_proposed: "Avenant proposé au client",
  plan_requested: "Plan de redressement demandé",
};

/** Identifiants déterministes (§2.1) : deux appareils produisent la même ligne, jamais un doublon. */
export const stageInvoiceId = (stageId: string, n: number) => `fa-jalon-${stageId}-${n}`;
export const retentionInvoiceId = (stageId: string, n: number) => `fa-retenue-${stageId}-${n}`;
export const reserveTaskId = (decisionId: string, n: number) => `tsk-res-${decisionId}-${n}`;
export const reserveStageId = (projectId: string) => `stg-res-${projectId}`;

/** Une réserve par ligne non vide. */
export const reserveLines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

export interface BillingData {
  quotes?: Rec[];
  project_finance?: Rec[];
  project_stages: Rec[];
  project_decisions?: Rec[];
  invoices?: Rec[];
  credit_notes?: Rec[];
  tasks?: Rec[];
}

/** Statuts de devis qui comptent dans le vendu (RG3.5). */
const SOLD = ["accepted", "invoiced"];
type Bases = { vatRate: number; amount: number }[];

/**
 * Montant vendu HT par taux de TVA, dans la devise du devis principal (CA3.3) : devis acceptés
 * rattachés au projet ; sinon montant saisi à la main (ou ancien forfait), au taux de TVA par défaut.
 */
export function soldBases(project: Rec, d: BillingData, defaultVat = 18): { bases: Bases; V: number; currency: string; rate: number; decimals: number; principal: Rec | null } {
  const main = str(project.data.quote_id);
  const quotes = (d.quotes ?? []).filter((q) => live(q) && (q.id === main || q.data.project_id === project.id) && SOLD.includes(str(q.data.status)));
  if (quotes.length) {
    const principal = quotes.find((q) => q.id === main) ?? quotes[0];
    const currency = str(principal.data.currency) || "XAF";
    const rate = currency === "XAF" ? 1 : num(principal.data.rate) || 1;
    const decimals = decimalsOf(currency);
    const m = new Map<number, number>();
    for (const q of quotes) {
      const qc = str(q.data.currency) || "XAF";
      const qr = qc === "XAF" ? 1 : num(q.data.rate) || 1;
      for (const [vat, base] of baseByRate((q.data.lines as InvoiceLine[]) ?? [], decimalsOf(qc))) {
        const amount = qc === currency ? base : roundAmount((base * qr) / rate, decimals);
        m.set(vat, roundAmount((m.get(vat) ?? 0) + amount, decimals));
      }
    }
    const bases = [...m].filter(([, a]) => a !== 0).sort((a, b) => b[0] - a[0]).map(([vatRate, amount]) => ({ vatRate, amount }));
    return { bases, V: roundAmount(bases.reduce((n, b) => n + b.amount, 0), decimals), currency, rate, decimals, principal };
  }
  const fin = (d.project_finance ?? []).find((f) => live(f) && f.id === `fin-${project.id}`);
  const currency = str(project.data.currency) || "XAF";
  const rate = currency === "XAF" ? 1 : num(project.data.rate) || 1;
  let V = num(fin?.data.sold_manual);
  if (!V && ["fixed", "milestone"].includes(str(project.data.billing))) V = fin && fin.data.legacy_budget !== undefined ? num(fin.data.legacy_budget) : num(project.data.budget);
  const legacy = !num(fin?.data.sold_manual) && V > 0;
  const cur = legacy ? "XAF" : currency;
  return { bases: V > 0 ? [{ vatRate: defaultVat, amount: V }] : [], V, currency: cur, rate: legacy ? 1 : rate, decimals: decimalsOf(cur), principal: null };
}

/** Une facture est annulée si des avoirs validés la couvrent entièrement (RG6.3). */
export function cancelledByCredit(invoice: Rec, creditNotes: Rec[] = []): boolean {
  if (invoice.data.status !== "validated") return false;
  const dec = decimalsOf(str(invoice.data.currency) || "XAF");
  const gross = computeTotals((invoice.data.lines as InvoiceLine[]) ?? [], dec, docTaxes(invoice.data)).gross;
  const credited = creditNotes.filter((c) => live(c) && c.data.invoice_id === invoice.id && c.data.status === "validated")
    .reduce((n, c) => n + computeTotals((c.data.lines as InvoiceLine[]) ?? [], dec, docTaxes(c.data)).gross, 0);
  return gross > 0 && credited >= gross - 1e-9;
}

/** Facture d'étape (ou de retenue) en vigueur : ni supprimée, ni annulée par un avoir total. */
export function invoiceOfStage(stageId: string, origin: "stage" | "retention", d: BillingData): Rec | null {
  return (d.invoices ?? []).find((i) => live(i) && i.data.stage_id === stageId && (str(i.data.origin) || "stage") === origin && !cancelledByCredit(i, d.credit_notes)) ?? null;
}

/** Rang suivant pour l'identifiant : 1 + factures de cette étape annulées par un avoir total (§3.8). */
function nextNumber(stageId: string, origin: string, d: BillingData): number {
  return 1 + (d.invoices ?? []).filter((i) => i.data.stage_id === stageId && (str(i.data.origin) || "stage") === origin && cancelledByCredit(i, d.credit_notes)).length;
}

const basesOf = (v: unknown): Bases => (Array.isArray(v) ? (v as Bases).filter((b) => b && Number.isFinite(Number(b.amount))) : []);

export type InvoiceError = "time_billing" | "no_share" | "no_client" | "no_sold" | "already_invoiced" | "previous_not_validated";

export const INVOICE_ERRORS: Record<InvoiceError, string> = {
  time_billing: "Ce projet est facturé au temps passé : la validation ne prépare pas de facture d'étape.",
  no_share: "Cette étape n'a pas de part du montant vendu : aucune facture n'est préparée.",
  no_client: "Ce projet n'a pas de client : choisissez-en un dans « Modifier le projet » pour préparer la facture.",
  no_sold: "Le montant vendu de ce projet est inconnu : indiquez-le dans « Modifier le projet » pour préparer la facture.",
  already_invoiced: "La facture de cette étape existe déjà.",
  previous_not_validated: "L'étape précédente n'est pas validée : la facture de cette étape attend sa validation.",
};

export interface StageInvoicePlan {
  id: string;
  /** Montant du jalon HT avant retenue (M), retenue, net facturé. */
  M: number;
  retained: number;
  net: number;
  pct: number;
  V: number;
  currency: string;
  quoteNumber: string;
  last: boolean;
  patch: Record<string, unknown>;
}

export interface InvoiceOptions {
  decisionId: string;
  retentionPct: number;
  today: string;
  paymentDays: number;
  user: { id: string; name: string };
  /** Taxes figées à la création, comme un document créé dans Factures (CSS ; la retenue à la source vient du devis). */
  taxes?: { css_rate: number; css_on_zero: boolean };
}

/**
 * Brouillon de la facture de jalon (§3.8, CA3.1 à CA3.3, CA3.6, CA3.8) :
 *  - M = arrondi(V × p / 100), une ligne par taux de TVA (écart d'arrondi sur la dernière) ;
 *  - dernière étape qui facture (parts = 100 %, autres étapes facturées) : M = V − jalons déjà facturés,
 *    taux par taux, pour que la somme vaille exactement V (CA3.2) ;
 *  - retenue r : chaque ligne porte M_taux − arrondi(M_taux × r / 100) ; la retenue est notée sur la facture.
 */
export function stageInvoice(project: Rec, stage: Rec, d: BillingData, o: InvoiceOptions, defaultVat = 18): StageInvoicePlan | { error: InvoiceError } {
  const billing = str(project.data.billing) || "time";
  if (billing === "time" || billing === "none") return { error: "time_billing" };
  const p = num(stage.data.billing_pct);
  if (p <= 0) return { error: "no_share" };
  if (!str(project.data.client_id)) return { error: "no_client" };
  const sold = soldBases(project, d, defaultVat);
  if (sold.V <= 0 || sold.bases.length === 0) return { error: "no_sold" };
  if (invoiceOfStage(stage.id, "stage", d)) return { error: "already_invoiced" };
  const stages = stagesOf(project.id, d.project_stages);
  if (approvalBlocker(stage.id, stages, (d.project_decisions ?? []).filter((x) => !(isApproval(x.data.kind) && x.data.stage_id === stage.id)))) {
    return { error: "previous_not_validated" };
  }
  const dec = sold.decimals;
  const billingStages = stages.filter((s) => num(s.data.billing_pct) > 0);
  const share = Math.round(billingStages.reduce((n, s) => n + num(s.data.billing_pct), 0) * 100) / 100;
  const others = billingStages.filter((s) => s.id !== stage.id).map((s) => invoiceOfStage(s.id, "stage", d));
  const last = Math.abs(share - 100) < 1e-9 && billingStages.at(-1)?.id === stage.id && others.every(Boolean);

  // M par taux de TVA.
  let perRate: Bases;
  if (last) {
    const given = new Map<number, number>();
    for (const inv of others) for (const b of basesOf(inv!.data.jalon_base)) given.set(b.vatRate, (given.get(b.vatRate) ?? 0) + num(b.amount));
    perRate = sold.bases.map((b) => ({ vatRate: b.vatRate, amount: roundAmount(b.amount - (given.get(b.vatRate) ?? 0), dec) }));
  } else {
    perRate = sold.bases.map((b) => ({ vatRate: b.vatRate, amount: roundAmount((b.amount * p) / 100, dec) }));
    const M = roundAmount((sold.V * p) / 100, dec);
    const gap = roundAmount(M - perRate.reduce((n, b) => n + b.amount, 0), dec);
    if (gap !== 0) perRate[perRate.length - 1].amount = roundAmount(perRate[perRate.length - 1].amount + gap, dec);
  }
  perRate = perRate.filter((b) => b.amount > 0);
  if (perRate.length === 0) return { error: "no_sold" };
  const r = Math.min(100, Math.max(0, num(o.retentionPct)));
  const retention = perRate.map((b) => ({ vatRate: b.vatRate, amount: roundAmount((b.amount * r) / 100, dec) }));
  const M = roundAmount(perRate.reduce((n, b) => n + b.amount, 0), dec);
  const retained = roundAmount(retention.reduce((n, b) => n + b.amount, 0), dec);

  const name = str(stage.data.name);
  const quoteNumber = str(sold.principal?.data.number);
  const ref = quoteNumber ? `du devis ${quoteNumber}` : "du montant vendu";
  const lines: InvoiceLine[] = perRate.map((b, i) => ({
    label: `Étape ${name} : ${pctFr(p)} % ${ref}${perRate.length > 1 ? ` (TVA ${pctFr(b.vatRate)} %)` : ""}`,
    qty: 1,
    unitPrice: roundAmount(b.amount - retention[i].amount, dec),
    vatRate: b.vatRate,
    unit: "forfait",
  }));
  const fm = (n: number) => formatMoney(n, sold.currency);
  const notes = [
    `Projet ${str(project.data.name)}, étape ${name} validée.`,
    r > 0 ? `Montant de l'étape : ${fm(M)} HT, moins une retenue de ${pctFr(r)} % (${fm(retained)} HT) facturée à la levée des réserves.` : "",
  ].filter(Boolean).join("\n");
  const principal = sold.principal;
  const patch: Record<string, unknown> = {
    status: "draft",
    client_id: str(project.data.client_id),
    date: o.today,
    due_date: addDays(o.today, o.paymentDays),
    lines,
    notes,
    currency: sold.currency,
    rate: sold.currency === "XAF" ? 1 : sold.rate,
    ...(o.taxes ?? {}),
    withholding_rate: num(principal?.data.withholding_rate),
    withholding_label: str(principal?.data.withholding_label),
    project_id: project.id,
    stage_id: stage.id,
    decision_id: o.decisionId,
    origin: "stage",
    ...(principal ? { quote_id: principal.id, quote_number: quoteNumber } : {}),
    jalon_pct: p,
    jalon_base: perRate,
    retention_pct: r,
    retention_base: r > 0 ? retention : [],
    created_by: o.user.id,
    created_by_name: o.user.name,
    _deleted: false,
  };
  return { id: stageInvoiceId(stage.id, nextNumber(stage.id, "stage", d)), M, retained, net: roundAmount(M - retained, dec), pct: p, V: sold.V, currency: sold.currency, quoteNumber, last, patch };
}

/** Décision de validation en vigueur d'une étape (la dernière, si c'est une validation). */
export function approvalOf(stageId: string, decisions: Rec[] = []): Rec | null {
  const last = decisionsOfStage(stageId, decisions).at(-1);
  return last && isApproval(last.data.kind) ? last : null;
}

/** Validation avec réserves d'une étape, la plus récente (même si l'étape a été rouverte depuis). */
function reservesDecisionOf(stageId: string, decisions: Rec[] = []): Rec | null {
  return decisionsOfStage(stageId, decisions).filter((x) => x.data.kind === "stage_approved_with_reserves").at(-1) ?? null;
}

export interface ReservesStatus {
  decision: Rec;
  tasks: Rec[];
  done: number;
  total: number;
  /** Toutes les tâches de réserve sont closes. */
  lifted: boolean;
  /** Retenue jusqu'à la levée (montant HT, devise de la facture), 0 sans retenue ou sans facture. */
  retained: number;
  currency: string;
  stageInvoice: Rec | null;
  retentionInvoice: Rec | null;
}

/** Réserves d'une étape et retenue associée (F5, Q5) : levées quand toutes leurs tâches sont closes. */
export function reservesOf(stageId: string, d: BillingData): ReservesStatus | null {
  const decision = reservesDecisionOf(stageId, d.project_decisions);
  if (!decision) return null;
  const tasks = (d.tasks ?? []).filter((t) => live(t) && t.data.decision_id === decision.id);
  const done = tasks.filter((t) => t.data.status === "done").length;
  const inv = invoiceOfStage(stageId, "stage", d);
  const retention = inv && inv.data.decision_id === decision.id ? basesOf(inv.data.retention_base) : [];
  const currency = str(inv?.data.currency) || "XAF";
  const retained = roundAmount(retention.reduce((n, b) => n + num(b.amount), 0), decimalsOf(currency));
  return { decision, tasks, done, total: tasks.length, lifted: done === tasks.length, retained, currency, stageInvoice: inv, retentionInvoice: invoiceOfStage(stageId, "retention", d) };
}

/**
 * Brouillon de la facture de la retenue, une fois les réserves levées (« Solde après levée
 * des réserves ») : une ligne par taux, montants retenus sur la facture d'étape.
 */
export function retentionInvoice(project: Rec, stage: Rec, d: BillingData, o: Omit<InvoiceOptions, "decisionId" | "retentionPct">): { id: string; amount: number; currency: string; patch: Record<string, unknown> } | { error: "no_retention" | "reserves_open" | "already_invoiced" } {
  const status = reservesOf(stage.id, d);
  if (!status || status.retained <= 0 || !status.stageInvoice) return { error: "no_retention" };
  if (!status.lifted) return { error: "reserves_open" };
  if (status.retentionInvoice) return { error: "already_invoiced" };
  const src = status.stageInvoice;
  const bases = basesOf(src.data.retention_base).filter((b) => num(b.amount) > 0);
  const r = num(src.data.retention_pct);
  const name = str(stage.data.name);
  const lines: InvoiceLine[] = bases.map((b) => ({
    label: `Solde après levée des réserves : étape ${name}, retenue de ${pctFr(r)} %${src.data.number ? ` (facture ${str(src.data.number)})` : ""}${bases.length > 1 ? ` (TVA ${pctFr(b.vatRate)} %)` : ""}`,
    qty: 1, unitPrice: num(b.amount), vatRate: b.vatRate, unit: "forfait",
  }));
  return {
    id: retentionInvoiceId(stage.id, nextNumber(stage.id, "retention", d)),
    amount: status.retained,
    currency: status.currency,
    patch: {
      status: "draft",
      client_id: str(src.data.client_id) || str(project.data.client_id),
      date: o.today,
      due_date: addDays(o.today, o.paymentDays),
      lines,
      notes: `Projet ${str(project.data.name)} : réserves de l'étape ${name} levées.`,
      currency: status.currency,
      rate: num(src.data.rate) || 1,
      ...(o.taxes ?? {}),
      withholding_rate: num(src.data.withholding_rate),
      withholding_label: str(src.data.withholding_label),
      project_id: project.id,
      stage_id: stage.id,
      decision_id: status.decision.id,
      origin: "retention",
      ...(src.data.quote_id ? { quote_id: src.data.quote_id, quote_number: src.data.quote_number } : {}),
      created_by: o.user.id,
      created_by_name: o.user.name,
      _deleted: false,
    },
  };
}

/**
 * Tâches de réserve (F5) : une par ligne, dans l'étape suivante non arrêtée, attribuées à
 * son responsable ; si l'étape validée est la dernière, une étape « Levée des réserves » est créée.
 */
export function reserveTasks(project: Rec, stage: Rec, decisionId: string, reserves: string, d: BillingData, o: { userId: string; now: string; today: string }):
  { stage: { id: string; patch: Record<string, unknown> } | null; tasks: { id: string; patch: Record<string, unknown> }[]; target: { id: string; name: string } } {
  const stages = stagesOf(project.id, d.project_stages);
  const idx = stages.findIndex((s) => s.id === stage.id);
  const stopped = (s: Rec) => (d.project_decisions ?? []).some((x) => live(x) && x.data.stage_id === s.id && x.data.kind === "project_stopped");
  const next = stages.slice(idx + 1).find((s) => !stopped(s)) ?? null;
  let created: { id: string; patch: Record<string, unknown> } | null = null;
  let target: Rec;
  if (next) target = next;
  else {
    const id = reserveStageId(project.id);
    const rank = Math.max(0, ...stages.map((s) => num(s.data.rank))) + 1;
    const patch = {
      project_id: project.id, name: "Levée des réserves", rank, kind: "reserves", billing_pct: 0,
      owner_id: str(stage.data.owner_id), owner_name: str(stage.data.owner_name), start_date: o.today, _deleted: false,
      created_by: o.userId, created_at: o.now,
    };
    created = { id, patch };
    target = { id, data: patch };
  }
  const tasks = reserveLines(reserves).map((title, i) => ({
    id: reserveTaskId(decisionId, i + 1),
    patch: {
      project_id: project.id, stage_id: target.id, title, status: "todo", priority: "high", kind: "reserve", decision_id: decisionId,
      assignee_id: str(target.data.owner_id), rank: i + 1, created_by: o.userId, created_at: o.now,
    },
  }));
  return { stage: created, tasks, target: { id: target.id, name: str(target.data.name) } };
}

/** Ligne du bloc « À décider » : une validation demandée, ou une retenue devenue facturable. */
export interface DecisionItem { kind: "review" | "retention"; project: Rec; stage: Rec; since: string; by: string; note: string; days: number }

/**
 * Bloc « À décider » minimal (lot 3) : les validations demandées sur les projets où le
 * lecteur décide, les plus anciennes d'abord ; puis les retenues à facturer (réserves levées).
 */
export function decisionsToMake(projects: Rec[], d: BillingData, decides: (project: Rec) => boolean, today: string, withRetentions: boolean): DecisionItem[] {
  const out: DecisionItem[] = [];
  const days = (iso: string) => (iso ? Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)) / 864e5)) : 0);
  for (const p of projects) {
    if (!live(p) || ["done", "cancelled"].includes(str(p.data.status)) || !decides(p)) continue;
    for (const s of stagesOf(p.id, d.project_stages)) {
      const decisions = decisionsOfStage(s.id, d.project_decisions ?? []);
      const last = decisions.at(-1);
      const asked = str(s.data.review_requested_at);
      if (asked && (!last || asked > str(last.data.decided_at))) {
        out.push({ kind: "review", project: p, stage: s, since: asked, by: str(s.data.review_requested_by_name), note: str(s.data.review_note), days: days(asked) });
      } else if (withRetentions) {
        const r = reservesOf(s.id, d);
        if (r && r.lifted && r.retained > 0 && !r.retentionInvoice && r.total > 0) out.push({ kind: "retention", project: p, stage: s, since: "", by: "", note: "", days: 0 });
      }
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.since.localeCompare(b.since) : a.kind === "review" ? -1 : 1));
}
