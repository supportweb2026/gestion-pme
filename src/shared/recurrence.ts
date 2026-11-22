/**
 * Facturation récurrente (abonnements, loyers, contrats de maintenance).
 *
 * Le modèle est une facture déjà validée : l'utilisateur choisit de la « répéter ».
 * À chaque échéance, Gestia prépare un brouillon identique daté du jour prévu ;
 * il reste à le vérifier (quantités, mois indiqué) puis à le valider, car une
 * facture numérotée est définitive. Le réglage (`recurrence`) et la prochaine date
 * (`recurrence_next`) sont deux champs distincts : un appareil en retard qui avance
 * la date ne peut pas annuler un arrêt décidé ailleurs.
 */

export type RecurrenceFreq = "monthly" | "quarterly" | "semiannual" | "yearly";

export const RECURRENCE_FREQS: Record<RecurrenceFreq, { label: string; months: number; adjective: string }> = {
  monthly: { label: "Chaque mois", months: 1, adjective: "mensuelle" },
  quarterly: { label: "Chaque trimestre", months: 3, adjective: "trimestrielle" },
  semiannual: { label: "Chaque semestre", months: 6, adjective: "semestrielle" },
  yearly: { label: "Chaque année", months: 12, adjective: "annuelle" },
};

export interface Recurrence {
  freq: RecurrenceFreq;
  /** Jour du mois visé (1 à 31) : le 31 devient le dernier jour des mois plus courts. */
  day: number;
  /** Dernière date possible (AAAA-MM-JJ), vide si sans fin. */
  until: string;
  active: boolean;
}

/** Nombre maximal de brouillons rattrapés d'un coup (appli restée fermée longtemps). */
export const MAX_CATCH_UP = 12;

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Ajoute des mois à une date en visant un jour donné, borné à la fin du mois. */
export function addMonths(date: string, months: number, day: number): string {
  const [y, m] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return iso(ny, nm, Math.min(Math.max(1, day), last));
}

export function recurrenceOf(data: Record<string, unknown> | undefined): Recurrence | null {
  const r = data?.recurrence as Partial<Recurrence> | undefined;
  if (!r || typeof r !== "object" || !r.freq || !(r.freq in RECURRENCE_FREQS)) return null;
  return {
    freq: r.freq,
    day: Number(r.day) || 1,
    until: typeof r.until === "string" ? r.until : "",
    active: r.active !== false,
  };
}

/** Date suivante d'une série, après `date`. */
export function nextAfter(rec: Pick<Recurrence, "freq" | "day">, date: string): string {
  return addMonths(date, RECURRENCE_FREQS[rec.freq].months, rec.day);
}

/**
 * Dates à préparer aujourd'hui (de `next` à `today`, bornées par `until`)
 * et prochaine date une fois ces brouillons créés.
 */
export function dueOccurrences(rec: Recurrence, next: string, today: string, max = MAX_CATCH_UP): { dates: string[]; next: string } {
  const dates: string[] = [];
  let d = next;
  if (!rec.active || !d) return { dates, next: d };
  while (d <= today && (!rec.until || d <= rec.until) && dates.length < max) {
    dates.push(d);
    d = nextAfter(rec, d);
  }
  return { dates, next: d };
}

/** Vrai si la série ne produira plus de facture. */
export function isFinished(rec: Recurrence, next: string): boolean {
  return !rec.active || (!!rec.until && !!next && next > rec.until);
}

/** Identifiant du brouillon d'une échéance : le même sur tous les appareils (pas de doublon). */
export const occurrenceId = (sourceId: string, date: string) => `${sourceId}-rec-${date}`;

/** Écart en jours entre deux dates AAAA-MM-JJ. */
export function daysBetween(from: string, to: string): number {
  if (!from || !to) return 0;
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/** « Répétée chaque mois, le 5 » : phrase de résumé d'une série. */
export function describe(rec: Recurrence): string {
  const day = rec.day >= 31 ? "en fin de mois" : rec.day === 1 ? "le 1er" : `le ${rec.day}`;
  return `${RECURRENCE_FREQS[rec.freq].label.toLowerCase()}, ${day}`;
}
