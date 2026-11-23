/**
 * Périodes des filtres de liste : des bornes de dates « AAAA-MM-JJ » incluses.
 * Une borne vide veut dire « sans limite ».
 */
export type PeriodPreset = "all" | "month" | "last_month" | "quarter" | "year" | "last_year" | "custom";

export const PERIOD_LABELS: Record<PeriodPreset, string> = {
  all: "Toute période",
  month: "Ce mois",
  last_month: "Mois dernier",
  quarter: "Ce trimestre",
  year: "Cette année",
  last_year: "Année dernière",
  custom: "Dates au choix",
};

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m : 1 à 12

/** Bornes d'une période, calculées depuis la date du jour. */
export function periodRange(preset: PeriodPreset, today: string, from = "", to = ""): { from: string; to: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const month = (yy: number, mm: number) => ({ from: `${yy}-${pad(mm)}-01`, to: `${yy}-${pad(mm)}-${pad(lastDay(yy, mm))}` });
  switch (preset) {
    case "month": return month(y, m);
    case "last_month": return m === 1 ? month(y - 1, 12) : month(y, m - 1);
    case "quarter": {
      const start = m - ((m - 1) % 3);
      return { from: `${y}-${pad(start)}-01`, to: month(y, start + 2).to };
    }
    case "year": return { from: `${y}-01-01`, to: `${y}-12-31` };
    case "last_year": return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case "custom": return from && to && from > to ? { from: to, to: from } : { from, to };
    default: return { from: "", to: "" };
  }
}

/** Une date (éventuellement suivie d'une heure) tombe-t-elle dans la période ? */
export function inPeriod(date: string, range: { from: string; to: string }): boolean {
  const d = date.slice(0, 10);
  if (!range.from && !range.to) return true;
  if (!d) return false;
  return (!range.from || d >= range.from) && (!range.to || d <= range.to);
}
