-- v5 : plateforme multi-entreprises, abonnements, sécurité des comptes.

-- Abonnement de chaque entreprise.
ALTER TABLE companies ADD COLUMN plan TEXT NOT NULL DEFAULT 'trial';      -- trial, essentiel, pro, entreprise
ALTER TABLE companies ADD COLUMN status TEXT NOT NULL DEFAULT 'active';   -- active, suspended
ALTER TABLE companies ADD COLUMN trial_ends_at TEXT;                      -- AAAA-MM-JJ
ALTER TABLE companies ADD COLUMN paid_until TEXT;                         -- AAAA-MM-JJ
ALTER TABLE companies ADD COLUMN contact_email TEXT;
ALTER TABLE companies ADD COLUMN contact_phone TEXT;
ALTER TABLE companies ADD COLUMN note TEXT;

-- Entreprises existantes (créées avant la v5) : formule Pro jusqu'à fin 2027.
UPDATE companies SET plan = 'pro', paid_until = '2027-12-31';

-- Mot de passe provisoire à changer à la prochaine connexion.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;

-- Protection contre les essais de mots de passe en série.
CREATE TABLE login_attempts (
  key           TEXT PRIMARY KEY,   -- e-mail
  failures      INTEGER NOT NULL,
  window_start  TEXT NOT NULL,
  locked_until  TEXT
);

-- Limite des inscriptions par adresse IP et par jour.
CREATE TABLE signup_limits (
  ip     TEXT NOT NULL,
  day    TEXT NOT NULL,
  count  INTEGER NOT NULL,
  PRIMARY KEY (ip, day)
);

-- Paiements d'abonnement enregistrés par l'équipe Gestia.
CREATE TABLE subscription_payments (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  plan         TEXT NOT NULL,
  months       INTEGER NOT NULL,
  amount       INTEGER NOT NULL,
  method       TEXT NOT NULL,
  reference    TEXT,
  period_from  TEXT NOT NULL,
  period_to    TEXT NOT NULL,
  recorded_by  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX subscription_payments_company ON subscription_payments(company_id);

-- Erreurs remontées par les appareils, pour corriger avant qu'on nous appelle.
CREATE TABLE client_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  TEXT,
  user_id     TEXT,
  at          TEXT NOT NULL,
  message     TEXT NOT NULL,
  detail      TEXT,
  url         TEXT,
  agent       TEXT
);
