-- Connecteur MCP (Claude et autres assistants) : OAuth 2.1 avec PKCE.
-- Aucun jeton ni code n'est stocké en clair : seulement leur empreinte SHA-256.

-- Applications enregistrées dynamiquement (RFC 7591).
CREATE TABLE oauth_clients (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  redirect_uris    TEXT NOT NULL,          -- JSON : liste exacte des adresses de retour
  secret_hash      TEXT,                   -- empreinte du secret ; NULL pour un client public
  created_at       TEXT NOT NULL
);

-- Connexion accordée par un utilisateur à une application (« Réglages › Connexions »).
-- Chaque connexion a son pseudo-appareil (devices.id = device_id) : ses écritures
-- passent par la synchronisation et sont tracées à son nom.
CREATE TABLE oauth_grants (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL,
  company_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  scope         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  revoked_at    TEXT
);
CREATE INDEX oauth_grants_company ON oauth_grants(company_id);

-- Codes d'autorisation : usage unique, quelques minutes.
CREATE TABLE oauth_codes (
  hash            TEXT PRIMARY KEY,
  grant_id        TEXT NOT NULL,
  client_id       TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  used_at         TEXT
);

-- Jetons d'accès (courts) et de rafraîchissement (longs, à rotation).
CREATE TABLE oauth_tokens (
  hash        TEXT PRIMARY KEY,
  grant_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,               -- access, refresh
  expires_at  TEXT NOT NULL,
  used_at     TEXT,                        -- jeton de rafraîchissement déjà échangé
  created_at  TEXT NOT NULL
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
