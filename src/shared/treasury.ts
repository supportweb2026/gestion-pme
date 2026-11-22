/**
 * Trésorerie prévisionnelle et objectifs : calculs purs, sans affichage.
 *
 * Encaissements attendus : reste dû des factures validées, à leur échéance (les factures
 * en retard sont comptées à part), plus les prochaines factures des séries récurrentes.
 * Décaissements prévus : commandes fournisseurs en cours, à leur date de livraison prévue
 * (sinon 30 jours après la commande). Tout est en FCFA ; il n'y a pas de solde bancaire.
 */
import { addMonths, dueOccurrences, recurrenceOf } from "./recurrence.ts";
import { orderTotal, type PurchaseLine } from "./stock.ts";

interface Rec {
  id: string;
  data: Record<string, unknown>;
}

export interface ForecastInput {
  today: string;
  /** Factures avec leur reste dû (en FCFA) et leur montant TTC (en FCFA, pour les séries). */
  invoices: { rec: Rec; due: number; grossXaf: number }[];
  orders: Rec[];
}

export interface ForecastBucket {
  /** Jours après aujourd'hui (30, 60, 90). */
  days: number;
  inflow: number;
  recurring: number;
  outflow: number;
  net: number;
}

export interface Forecast {
  overdue: number;
  overdueCount: number;
  buckets: ForecastBucket[];
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Prévision cumulée à 30, 60 et 90 jours. */
export function forecast(input: ForecastInput, horizons = [30, 60, 90]): Forecast {
  const { today } = input;
  let overdue = 0;
  let overdueCount = 0;
  const dated: { date: string; amount: number; kind: "in" | "rec" | "out" }[] = [];
  for (const { rec, due, grossXaf } of input.invoices) {
    if (rec.data.status !== "validated") continue;
    if (due > 0) {
      const d = str(rec.data.due_date) || str(rec.data.date);
      if (d < today) {
        overdue += due;
        overdueCount++;
      } else dated.push({ date: d, amount: due, kind: "in" });
    }
    const r = recurrenceOf(rec.data);
    const next = str(rec.data.recurrence_next);
    if (r && r.active && next) {
      const end = addDaysIso(today, Math.max(...horizons));
      // Séries : chaque échéance future, encaissée au même délai que la facture modèle.
      const { dates } = dueOccurrences(r, next < today ? today : next, end, 24);
      const term = Math.max(0, Math.round((Date.parse(`${str(rec.data.due_date)}T12:00:00Z`) - Date.parse(`${str(rec.data.date)}T12:00:00Z`)) / 86_400_000) || 0);
      for (const d of dates) dated.push({ date: addDaysIso(d, term), amount: grossXaf, kind: "rec" });
    }
  }
  for (const o of input.orders) {
    if (o.data.status !== "ordered") continue;
    const d = str(o.data.expected_at) || addDaysIso(str(o.data.date) || today, 30);
    dated.push({ date: d < today ? today : d, amount: orderTotal((o.data.lines as PurchaseLine[]) ?? []), kind: "out" });
  }
  const buckets = horizons.map((days) => {
    const end = addDaysIso(today, days);
    const within = dated.filter((x) => x.date <= end);
    const inflow = within.filter((x) => x.kind === "in").reduce((n, x) => n + x.amount, 0);
    const recurring = within.filter((x) => x.kind === "rec").reduce((n, x) => n + x.amount, 0);
    const outflow = within.filter((x) => x.kind === "out").reduce((n, x) => n + x.amount, 0);
    return { days, inflow, recurring, outflow, net: inflow + recurring - outflow };
  });
  return { overdue, overdueCount, buckets };
}

/** Objectif mensuel de chiffre d'affaires HT (Réglages), 0 si absent. */
export const monthlyTarget = (settings: Record<string, unknown>) => Math.max(0, Math.round(Number(settings.monthly_target) || 0));

export interface TargetProgress {
  target: number;
  achieved: number;
  /** 0 à 1 (peut dépasser 1). */
  ratio: number;
  /** Part du mois écoulée (0 à 1), pour savoir si l'on est en avance ou en retard. */
  elapsed: number;
  onTrack: boolean;
}

/** Progression du mois en cours : chiffre d'affaires HT facturé (FCFA) contre l'objectif. */
export function targetProgress(target: number, achieved: number, today: string): TargetProgress | null {
  if (target <= 0) return null;
  const [y, m, d] = today.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const elapsed = d / days;
  const ratio = achieved / target;
  return { target, achieved, ratio, elapsed, onTrack: ratio >= elapsed };
}

/** Premier jour du mois suivant (utile aux bornes de période). */
export const nextMonthStart = (today: string) => addMonths(`${today.slice(0, 7)}-01`, 1, 1);
