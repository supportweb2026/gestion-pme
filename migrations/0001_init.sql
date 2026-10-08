-- Schéma initial de la base centrale (Cloudflare D1, SQLite).
-- Le serveur ne stocke que ce qu'il faut pour échanger et sauvegarder ;
-- les calculs (états comptables, tableau de bord) se font sur les appareils.

CREATE TABLE companies (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'XAF',
  created_at  TEXT NOT NULL
);

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id),
  email          TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL,          -- admin, director, accountant, sales, project_manager, employee
  password_hash  TEXT NOT NULL,          -- pbkdf2$<itérations>$<sel b64>$<hash b64>
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL
);

CREATE TABLE devices (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0
);

-- Journal de toutes les modifications acceptées, dans l'ordre de réception.
-- Sert à la fois de file de redistribution (curseur = seq) et de journal d'audit.
CREATE TABLE changes (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id        TEXT NOT NULL UNIQUE,     -- identifiant de la modification : idempotence
  company_id   TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  tbl          TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  patch        TEXT NOT NULL,            -- JSON
  hlc          TEXT NOT NULL,
  received_at  TEXT NOT NULL
);
CREATE INDEX changes_company_seq ON changes(company_id, seq);

-- État courant de chaque ligne, fusionné champ par champ.
CREATE TABLE records (
  company_id   TEXT NOT NULL,
  tbl          TEXT NOT NULL,
  id           TEXT NOT NULL,
  data         TEXT NOT NULL,            -- JSON des valeurs
  clocks       TEXT NOT NULL,            -- JSON : champ -> HLC de la dernière écriture
  updated_seq  INTEGER NOT NULL,
  PRIMARY KEY (company_id, tbl, id)
);

-- Numérotation continue des factures : chaque appareil réserve un bloc à l'avance.
CREATE TABLE number_counters (
  company_id  TEXT NOT NULL,
  series      TEXT NOT NULL,             -- ex. FA-2026
  next_no     INTEGER NOT NULL,
  PRIMARY KEY (company_id, series)
);

CREATE TABLE number_blocks (
  company_id   TEXT NOT NULL,
  series       TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  start_no     INTEGER NOT NULL,
  end_no       INTEGER NOT NULL,
  reserved_at  TEXT NOT NULL,
  PRIMARY KEY (company_id, series, start_no)
);
