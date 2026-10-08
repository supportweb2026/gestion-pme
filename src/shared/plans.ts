/**
 * Formules d'abonnement Gestia et état de l'abonnement d'une entreprise.
 * Partagé par le serveur (qui l'applique) et l'application (qui l'affiche).
 */

export interface Plan {
  label: string;
  maxUsers: number;
  description: string;
}

export const PLANS: Record<string, Plan> = {
  trial: { label: "Essai gratuit", maxUsers: 5, description: "30 jours, toutes les fonctions" },
  essentiel: { label: "Essentiel", maxUsers: 3, description: "Facturation, dépenses, comptabilité" },
  pro: { label: "Pro", maxUsers: 15, description: "Toutes les fonctions, jusqu'à 15 utilisateurs" },
  entreprise: { label: "Entreprise", maxUsers: 1000, description: "Utilisateurs illimités, accompagnement" },
};

export const TRIAL_DAYS = 30;
/** Après l'échéance, l'entreprise garde un accès complet pendant ce délai. */
export const GRACE_DAYS = 7;

export interface CompanySubscription {
  plan: string;
  status: string;
  trial_ends_at?: string | null;
  paid_until?: string | null;
}

export type SubscriptionState = "trial" | "active" | "grace" | "expired" | "suspended";

export interface SubscriptionInfo {
  plan: string;
  planLabel: string;
  state: SubscriptionState;
  /** Dernier jour d'accès complet (fin d'essai ou de période payée). */
  endsAt: string | null;
  /** Jours restants avant l'échéance (négatif si dépassée). */
  daysLeft: number | null;
  /** Vrai : consultation seule, plus aucune modification acceptée. */
  readOnly: boolean;
  maxUsers: number;
}

const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 864e5);

export function subscriptionInfo(c: CompanySubscription, today: string): SubscriptionInfo {
  const plan = PLANS[c.plan] ? c.plan : "trial";
  const base = { plan, planLabel: PLANS[plan].label, maxUsers: PLANS[plan].maxUsers };
  if (c.status === "suspended") return { ...base, state: "suspended", endsAt: null, daysLeft: null, readOnly: true };
  const endsAt = plan === "trial" ? c.trial_ends_at ?? null : c.paid_until ?? null;
  if (!endsAt) return { ...base, state: plan === "trial" ? "trial" : "active", endsAt: null, daysLeft: null, readOnly: false };
  const daysLeft = dayNumber(endsAt) - dayNumber(today);
  if (daysLeft >= 0) return { ...base, state: plan === "trial" ? "trial" : "active", endsAt, daysLeft, readOnly: false };
  if (daysLeft >= -GRACE_DAYS) return { ...base, state: "grace", endsAt, daysLeft, readOnly: false };
  return { ...base, state: "expired", endsAt, daysLeft, readOnly: true };
}

/** Nouvelle échéance après un paiement de n mois : à partir d'aujourd'hui ou de l'échéance en cours. */
export function extendPaidUntil(current: string | null | undefined, months: number, today: string): { from: string; to: string } {
  const start = current && current >= today ? current : today;
  const d = new Date(`${start}T12:00:00Z`);
  const from = current && current >= today ? new Date(d.getTime() + 864e5).toISOString().slice(0, 10) : start;
  d.setUTCMonth(d.getUTCMonth() + months);
  return { from, to: d.toISOString().slice(0, 10) };
}
