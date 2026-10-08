/**
 * Imitation locale de Cloudflare D1 au-dessus de node:sqlite (même moteur SQLite).
 * Sert uniquement au développement et aux tests, sans compte Cloudflare.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1PreparedStatement, D1Result } from "../src/worker/d1.ts";

type Value = null | number | bigint | string | Uint8Array;

function normalize(v: unknown): Value {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v as Value;
}

class LocalStatement implements D1PreparedStatement {
  private db: DatabaseSync;
  private sql: string;
  private params: Value[] = [];

  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    const s = new LocalStatement(this.db, this.sql);
    s.params = values.map(normalize);
    return s;
  }

  execute(): D1Result {
    const rows = this.db.prepare(this.sql).all(...this.params) as Record<string, unknown>[];
    return { results: rows.map((r) => ({ ...r })), success: true, meta: {} };
  }

  async first<T>(): Promise<T | null> {
    return (this.execute().results[0] as T) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return this.execute() as D1Result<T>;
  }

  async run(): Promise<D1Result> {
    return this.execute();
  }
}

export function createLocalD1(path = ":memory:", migrationsDir?: string): D1Database {
  const db = new DatabaseSync(path);
  if (migrationsDir) {
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)`);
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      const done = db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get(file);
      if (done) continue;
      db.exec(readFileSync(join(migrationsDir, file), "utf8"));
      db.prepare(`INSERT INTO _migrations (name) VALUES (?)`).run(file);
    }
  }
  return {
    prepare: (sql: string) => new LocalStatement(db, sql),
    async batch(statements: D1PreparedStatement[]) {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => (s as LocalStatement).execute());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
