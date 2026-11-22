-- v6 : double authentification (code à 6 chiffres d'une application d'authentification).
ALTER TABLE users ADD COLUMN totp_secret TEXT;                          -- secret base32 (en cours d'activation ou actif)
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_recovery TEXT;                        -- JSON : empreintes SHA-256 des codes de secours restants
ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0; -- dernier pas accepté (pas de réutilisation d'un code)
