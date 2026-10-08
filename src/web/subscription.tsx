/** Affichage de l'abonnement, partagé par les réglages, le bandeau et la console. */
import type { SubscriptionInfo, SubscriptionState } from "../shared/plans.ts";

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

export const STATE_LABELS: Record<SubscriptionState, string> = {
  trial: "Essai",
  active: "Actif",
  grace: "Échéance dépassée",
  expired: "Consultation seule",
  suspended: "Suspendu",
};

const STATE_TONES: Record<SubscriptionState, string> = {
  trial: "",
  active: "ok",
  grace: "warn",
  expired: "danger",
  suspended: "danger",
};

export function SubscriptionBadge({ sub }: { sub: SubscriptionInfo }) {
  return <span className={`badge ${STATE_TONES[sub.state]}`}>{STATE_LABELS[sub.state]}</span>;
}
