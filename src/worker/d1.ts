/**
 * Sous-ensemble de l'API Cloudflare D1 utilisé par le Worker.
 * Déclaré ici pour ne dépendre d'aucun paquet de types, et implémenté
 * localement par dev/d1-local.ts pour les tests sans compte Cloudflare.
 */
export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface Env {
  DB: D1Database;
  /** Base des justificatifs (photos, PDF), séparée pour ne pas alourdir la base principale. */
  FILES?: D1Database;
  /** Entreprise éditrice : ses administrateurs gèrent la plateforme (abonnements, comptes). */
  PLATFORM_COMPANY?: string;
  /** Secret de signature des jetons : `wrangler secret put JWT_SECRET`. */
  JWT_SECRET?: string;
}
