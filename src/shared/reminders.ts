/**
 * Calendrier de relance des factures (Réglages > Relances).
 *
 * Chaque étape est un décalage en jours par rapport à l'échéance (négatif : avant).
 * Le nombre de relances déjà envoyées (champ `reminders` de la facture) donne l'étape
 * suivante ; elle est due quand son jour est atteint et qu'il reste un montant à payer.
 * Tant que le serveur n'envoie pas d'e-mail, la relance part en un clic (WhatsApp,
 * e-mail, PDF) avec un message adapté à l'étape.
 */

export const DEFAULT_REMINDER_STEPS = [-3, 1, 7, 15, 30];

export type ReminderTone = "courtesy" | "friendly" | "firm" | "final";

export interface ReminderSettings {
  enabled: boolean;
  steps: number[];
}

export function reminderSettings(s: Record<string, unknown>): ReminderSettings {
  const raw = Array.isArray(s.reminder_steps) ? (s.reminder_steps as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n >= -60 && n <= 365) : [];
  return { enabled: s.reminders_enabled !== false, steps: (raw.length ? [...new Set(raw)] : DEFAULT_REMINDER_STEPS).sort((a, b) => a - b) };
}

/** « J-3 », « J+7 », « J0 » */
export const stepLabel = (d: number) => (d === 0 ? "J0" : d > 0 ? `J+${d}` : `J${d}`);

const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

export interface ReminderDue {
  /** Rang de la relance à envoyer (0 pour la première). */
  index: number;
  offset: number;
  label: string;
  tone: ReminderTone;
  /** Jours depuis l'échéance (négatif : avant). */
  days: number;
}

/**
 * Relance à envoyer aujourd'hui pour une facture, ou null.
 * `sent` : relances déjà envoyées ; `lastSent` : date (AAAA-MM-JJ) de la dernière.
 */
export function reminderDue(p: { dueDate: string; amountDue: number; sent: number; lastSent?: string; today: string; settings: ReminderSettings }): ReminderDue | null {
  const { settings: s } = p;
  if (!s.enabled || !p.dueDate || !(p.amountDue > 0)) return null;
  if (p.lastSent && p.lastSent >= p.today) return null;
  const days = dayDiff(p.dueDate, p.today);
  const reached = s.steps.filter((d) => d <= days).length;
  // Étapes déjà dépassées sans relance : on passe directement à la plus récente.
  const index = Math.max(p.sent, reached - 1);
  if (index < 0 || index >= s.steps.length || s.steps[index] > days) return null;
  const offset = s.steps[index];
  // Le ton suit les relances réellement envoyées après l'échéance, pas seulement le calendrier :
  // une facture très en retard jamais relancée reçoit d'abord une relance cordiale.
  const lateSent = Math.max(0, p.sent - s.steps.filter((d) => d <= 0).length);
  const tone: ReminderTone = offset <= 0 ? "courtesy"
    : lateSent === 0 ? "friendly"
    : index === s.steps.length - 1 && lateSent >= 2 ? "final" : "firm";
  return { index, offset, label: stepLabel(offset), tone, days };
}

export const TONE_LABELS: Record<ReminderTone, string> = {
  courtesy: "Rappel avant échéance",
  friendly: "Première relance",
  firm: "Relance",
  final: "Dernière relance",
};

/** Tranches d'ancienneté d'un retard de paiement (balance âgée). */
export type AgeBucket = "current" | "d30" | "d60" | "d90" | "older";
export const AGE_BUCKETS: Record<AgeBucket, string> = {
  current: "Non échu",
  d30: "1 à 30 jours",
  d60: "31 à 60 jours",
  d90: "61 à 90 jours",
  older: "Plus de 90 jours",
};

/** Jours de retard à une date donnée (0 ou moins : pas encore échu ; sans échéance : 0). */
export const daysLate = (dueDate: string, today: string) => (dueDate ? dayDiff(dueDate, today) : 0);

export function ageBucket(days: number): AgeBucket {
  return days <= 0 ? "current" : days <= 30 ? "d30" : days <= 60 ? "d60" : days <= 90 ? "d90" : "older";
}
