/**
 * Jetons d'accès à l'API : portée par table, en lecture (« r ») ou en lecture et écriture (« rw »).
 * Les tables protégées et les réglages ne sont jamais ouverts à l'API.
 */
import { SYNC_TABLES, type SyncTable } from "./sync.ts";

export type ApiMode = "r" | "rw";
export type ApiScopes = Partial<Record<SyncTable, ApiMode>>;

/** Coûts horaires, données financières et budgets des projets, réglages : jamais par l'API. */
export const API_FORBIDDEN: readonly string[] = ["cost_rates", "project_finance", "budget_lines", "settings"];

export const API_TABLES = SYNC_TABLES.filter((t) => !API_FORBIDDEN.includes(t));

export const API_TABLE_LABELS: Record<string, string> = {
  clients: "Clients", articles: "Articles", quotes: "Devis et bons de livraison", invoices: "Factures",
  credit_notes: "Avoirs", payments: "Encaissements", expenses: "Dépenses", journal_entries: "Écritures comptables",
  projects: "Projets", tasks: "Tâches", time_entries: "Temps passés", team_members: "Annuaire de l'équipe",
  project_members: "Équipes des projets", stock_moves: "Mouvements de stock", purchase_orders: "Commandes fournisseurs",
  project_stages: "Étapes des projets", project_decisions: "Décisions des projets",
};

/** Nettoie une portée reçue : tables connues et ouvertes, modes valides. Vide si rien de valable. */
export function parseScopes(input: unknown): ApiScopes {
  const out: ApiScopes = {};
  if (!input || typeof input !== "object") return out;
  for (const [t, m] of Object.entries(input as Record<string, unknown>)) {
    if ((API_TABLES as readonly string[]).includes(t) && (m === "r" || m === "rw")) out[t as SyncTable] = m;
  }
  return out;
}

export function allows(scopes: ApiScopes, tbl: string, write: boolean): boolean {
  if (API_FORBIDDEN.includes(tbl)) return false;
  const m = scopes[tbl as SyncTable];
  return write ? m === "rw" : m === "r" || m === "rw";
}

/** Format du jeton : gst_<identifiant>_<secret>. */
export const API_TOKEN_RE = /^gst_([a-z0-9]{12})_([A-Za-z0-9]{32})$/;
