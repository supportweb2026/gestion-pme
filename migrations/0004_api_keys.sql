-- Lot 8d : jetons d'accès à l'API, limités à certaines tables (lecture, ou lecture et écriture).
-- Le jeton n'est jamais stocké : seulement son empreinte SHA-256.
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,           -- créateur : les écritures se font avec ses droits
  name          TEXT NOT NULL,
  hash          TEXT NOT NULL UNIQUE,
  hint          TEXT NOT NULL,           -- 4 derniers caractères, pour reconnaître le jeton
  scopes        TEXT NOT NULL,           -- JSON : table -> "r" | "rw"
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  revoked       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX api_keys_company ON api_keys(company_id);
