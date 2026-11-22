/**
 * Worker Cloudflare : sert l'API /api/* ; tout le reste (l'application) est
 * servi gratuitement par les « static assets » configurés dans wrangler.jsonc.
 */
import type { D1PreparedStatement, Env } from "./d1.ts";
import { hashPassword, signToken, verifyPassword, verifyToken, type Session } from "./auth.ts";
import {
  applyChange, canRead, checkChange, checkPermission, DATA_EPOCH, MAX_PULL, MAX_PUSH,
  type Change, type SyncRecord, type SyncRequest, type SyncResponse,
} from "../shared/sync.ts";
import { redactPatch, redactRecord, type ProjectContext } from "../shared/projectRules.ts";
import { decodeHlc, encodeHlc } from "../shared/hlc.ts";
import { allows, API_TOKEN_RE, parseScopes, type ApiScopes } from "../shared/apiKeys.ts";
import { extendPaidUntil, PLANS, subscriptionInfo, TRIAL_DAYS, type CompanySubscription } from "../shared/plans.ts";
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from "../shared/totp.ts";

/** Taille d'un bloc de numéros de facture réservé par un appareil. */
const NUMBER_BLOCK_SIZE = 50;
/** Avance d'horloge tolérée pour un appareil (au-delà, la modification est refusée). */
const MAX_CLOCK_AHEAD_MS = 24 * 3600 * 1000;
/** Mot de passe minimal. */
const MIN_PASSWORD = 8;
const ROLES = ["admin", "director", "accountant", "sales", "project_manager", "employee"];
/** Secret de signature des sessions : obligatoire, au moins 32 caractères. */
function secret(env: Env): string {
  const s = env.JWT_SECRET;
  if (!s || s.length < 32) throw new HttpError(500, "secret JWT_SECRET absent ou trop court : configurez-le dans Cloudflare");
  return s;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "corps JSON invalide");
  }
}

function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" || v.trim().length === 0 || v.length > max) throw new HttpError(400, `champ ${field} invalide`);
  return v.trim();
}

function deviceId(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) throw new HttpError(400, "identifiant d'appareil invalide");
  return v;
}

interface Company extends CompanySubscription {
  id: string;
  name: string;
}

interface Auth {
  s: Session;
  company: Company;
}

const today = () => new Date().toISOString().slice(0, 10);

async function authenticate(req: Request, env: Env): Promise<Auth> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = token ? await verifyToken(token, secret(env)) : null;
  if (!session) throw new HttpError(401, "session expirée, reconnectez-vous");
  // Une seule lecture : appareil non révoqué, utilisateur actif, état de l'entreprise.
  const row = await env.DB.prepare(
    `SELECT d.revoked, d.last_seen, u.active, c.id AS cid, c.name, c.plan, c.status, c.trial_ends_at, c.paid_until
     FROM devices d JOIN users u ON u.id = d.user_id JOIN companies c ON c.id = u.company_id
     WHERE d.id = ? AND d.user_id = ?`,
  ).bind(session.dev, session.sub).first<{ revoked: number; last_seen: string; active: number; cid: string; name: string; plan: string; status: string; trial_ends_at: string | null; paid_until: string | null }>();
  if (!row || row.revoked || !row.active || row.cid !== session.cid) throw new HttpError(401, "accès révoqué pour cet appareil");
  // On ne réécrit « vu le » qu'une fois par heure, pour économiser les écritures.
  if (Date.now() - Date.parse(row.last_seen) > 3600_000) {
    await env.DB.prepare(`UPDATE devices SET last_seen = ? WHERE id = ?`).bind(now(), session.dev).run();
  }
  return {
    s: session,
    company: { id: row.cid, name: row.name, plan: row.plan, status: row.status, trial_ends_at: row.trial_ends_at, paid_until: row.paid_until },
  };
}

/** Les administrateurs de l'entreprise éditrice gèrent la plateforme. */
const isPlatformAdmin = (env: Env, companyId: string, role: string) =>
  !!env.PLATFORM_COMPANY && companyId === env.PLATFORM_COMPANY && role === "admin";

async function openSession(
  env: Env,
  user: { id: string; company_id: string; role: string; name: string; email: string; must_change_password?: number },
  dev: string,
  company: Company,
) {
  await env.DB.prepare(
    `INSERT INTO devices (id, company_id, user_id, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, company_id = excluded.company_id, last_seen = excluded.last_seen, revoked = 0`,
  ).bind(dev, user.company_id, user.id, now()).run();
  const pa = isPlatformAdmin(env, user.company_id, user.role);
  const token = await signToken({ sub: user.id, cid: user.company_id, role: user.role, dev, ...(pa ? { pa } : {}) }, secret(env));
  return {
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, platformAdmin: pa, mustChangePassword: !!user.must_change_password },
    company: { id: company.id, name: company.name, subscription: subscriptionInfo(company, today()) },
  };
}

/** Inscriptions par adresse IP et par jour, contre la création de comptes en masse. */
const MAX_SIGNUPS_PER_IP = 5;

/** Inscription d'une nouvelle entreprise : 30 jours d'essai, son créateur en est l'administrateur. */
async function handleSignup(req: Request, env: Env) {
  const body = await readJson<Record<string, unknown>>(req);
  const companyName = str(body.company, "entreprise");
  const name = str(body.name, "nom");
  const email = str(body.email, "e-mail").toLowerCase();
  const password = str(body.password, "mot de passe");
  const phone = typeof body.phone === "string" ? body.phone.trim().slice(0, 40) : "";
  const dev = deviceId(body.deviceId);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "adresse e-mail invalide");
  if (password.length < MIN_PASSWORD) throw new HttpError(400, `mot de passe trop court (${MIN_PASSWORD} caractères minimum)`);
  const taken = await env.DB.prepare(`SELECT 1 AS x FROM users WHERE email = ?`).bind(email).first();
  if (taken) throw new HttpError(409, "cet e-mail a déjà un compte Gestia : connectez-vous");

  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  const limit = await env.DB.prepare(`SELECT count FROM signup_limits WHERE ip = ? AND day = ?`).bind(ip, today()).first<{ count: number }>();
  if ((limit?.count ?? 0) >= MAX_SIGNUPS_PER_IP) throw new HttpError(429, "trop d'inscriptions depuis cette connexion aujourd'hui, réessayez demain");

  const trialEnds = new Date(Date.now() + TRIAL_DAYS * 864e5).toISOString().slice(0, 10);
  const company: Company = { id: uuid(), name: companyName, plan: "trial", status: "active", trial_ends_at: trialEnds, paid_until: null };
  const user = { id: uuid(), company_id: company.id, role: "admin", name, email };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO companies (id, name, created_at, plan, status, trial_ends_at, contact_email, contact_phone) VALUES (?, ?, ?, 'trial', 'active', ?, ?, ?)`,
    ).bind(company.id, companyName, now(), trialEnds, email, phone),
    env.DB.prepare(
      `INSERT INTO users (id, company_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, 'admin', ?, ?)`,
    ).bind(user.id, company.id, email, name, await hashPassword(password), now()),
    env.DB.prepare(
      `INSERT INTO signup_limits (ip, day, count) VALUES (?, ?, 1) ON CONFLICT(ip, day) DO UPDATE SET count = count + 1`,
    ).bind(ip, today()),
  ]);
  return json(await openSession(env, user, dev, company), 201);
}

/** Verrouillage temporaire après des échecs répétés de connexion. */
const MAX_LOGIN_FAILURES = 8;
const LOGIN_WINDOW_MS = 15 * 60_000;

async function handleLogin(req: Request, env: Env) {
  const body = await readJson<Record<string, unknown>>(req);
  const email = str(body.email, "e-mail").toLowerCase();
  const password = str(body.password, "mot de passe");
  const dev = deviceId(body.deviceId);

  const attempt = await env.DB.prepare(`SELECT failures, window_start, locked_until FROM login_attempts WHERE key = ?`)
    .bind(email).first<{ failures: number; window_start: string; locked_until: string | null }>();
  if (attempt?.locked_until && attempt.locked_until > now()) {
    const minutes = Math.ceil((Date.parse(attempt.locked_until) - Date.now()) / 60_000);
    throw new HttpError(429, `trop d'essais : compte bloqué encore ${minutes} min`);
  }

  const user = await env.DB.prepare(
    `SELECT u.id, u.company_id, u.role, u.name, u.email, u.password_hash, u.active, u.must_change_password,
            c.name AS company_name, c.plan, c.status, c.trial_ends_at, c.paid_until
     FROM users u JOIN companies c ON c.id = u.company_id WHERE u.email = ?`,
  ).bind(email).first<{
    id: string; company_id: string; role: string; name: string; email: string; password_hash: string; active: number;
    must_change_password: number; company_name: string; plan: string; status: string; trial_ends_at: string | null; paid_until: string | null;
  }>();

  // Compte des échecs (mot de passe ou code) sur une fenêtre de 15 minutes, puis blocage de 15 minutes.
  const fail = async () => {
    const fresh = !attempt || Date.now() - Date.parse(attempt.window_start) > LOGIN_WINDOW_MS;
    const failures = fresh ? 1 : attempt!.failures + 1;
    const locked = failures >= MAX_LOGIN_FAILURES ? new Date(Date.now() + LOGIN_WINDOW_MS).toISOString() : null;
    await env.DB.prepare(
      `INSERT INTO login_attempts (key, failures, window_start, locked_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, window_start = excluded.window_start, locked_until = excluded.locked_until`,
    ).bind(email, failures, fresh ? now() : attempt!.window_start, locked).run();
  };
  if (!user || !user.active || !(await verifyPassword(password, user.password_hash))) {
    await fail();
    throw new HttpError(401, "e-mail ou mot de passe incorrect");
  }
  // Double authentification : après le mot de passe, le code de l'application (ou un code de secours).
  // Lecture séparée et tolérante : si la migration 0003 n'est pas encore appliquée, la connexion fonctionne sans code.
  const tf = await env.DB.prepare(`SELECT totp_enabled, totp_secret, totp_recovery, totp_last_step FROM users WHERE id = ?`).bind(user.id)
    .first<{ totp_enabled: number; totp_secret: string | null; totp_recovery: string | null; totp_last_step: number }>()
    .catch(() => null);
  if (tf?.totp_enabled && tf.totp_secret) {
    const otp = typeof body.otp === "string" ? body.otp.trim() : "";
    if (!otp) return json({ error: "code de vérification requis", otpRequired: true }, 401);
    const step = await verifyTotp(tf.totp_secret, otp, Date.now(), tf.totp_last_step || 0);
    if (step !== null) {
      await env.DB.prepare(`UPDATE users SET totp_last_step = ? WHERE id = ?`).bind(step, user.id).run();
    } else {
      const left: string[] = JSON.parse(tf.totp_recovery || "[]");
      const h = await hashRecoveryCode(otp);
      if (!/^\d{6}$/.test(otp.replace(/\s/g, "")) && left.includes(h)) {
        await env.DB.prepare(`UPDATE users SET totp_recovery = ? WHERE id = ?`).bind(JSON.stringify(left.filter((x) => x !== h)), user.id).run();
      } else {
        await fail();
        return json({ error: "code de vérification incorrect", otpRequired: true }, 401);
      }
    }
  }
  if (attempt) await env.DB.prepare(`DELETE FROM login_attempts WHERE key = ?`).bind(email).run();
  if (user.status === "suspended") throw new HttpError(403, "compte de l'entreprise suspendu : contactez l'équipe Gestia");

  const company: Company = { id: user.company_id, name: user.company_name, plan: user.plan, status: user.status, trial_ends_at: user.trial_ends_at, paid_until: user.paid_until };
  return json(await openSession(env, user, dev, company));
}

/**
 * Double authentification de son propre compte.
 *  GET    : état ; POST setup : nouveau secret (pas encore actif) ;
 *  POST enable {code} : active et renvoie les codes de secours (une seule fois) ;
 *  POST disable {password} : désactive.
 */
async function handleTwoFactor(req: Request, env: Env, s: Session, action: string) {
  const user = await env.DB.prepare(`SELECT email, password_hash, totp_enabled, totp_secret, totp_recovery FROM users WHERE id = ?`).bind(s.sub)
    .first<{ email: string; password_hash: string; totp_enabled: number; totp_secret: string | null; totp_recovery: string | null }>();
  if (!user) throw new HttpError(404, "utilisateur introuvable");
  if (action === "" && req.method === "GET") {
    return json({ enabled: !!user.totp_enabled, recoveryLeft: user.totp_enabled ? JSON.parse(user.totp_recovery || "[]").length : 0 });
  }
  if (req.method !== "POST") throw new HttpError(405, "méthode non autorisée");
  const body = await readJson<Record<string, unknown>>(req);
  if (action === "setup") {
    if (user.totp_enabled) throw new HttpError(409, "double authentification déjà active");
    const secretKey = newTotpSecret();
    await env.DB.prepare(`UPDATE users SET totp_secret = ? WHERE id = ?`).bind(secretKey, s.sub).run();
    return json({ secret: secretKey, uri: otpauthUri(secretKey, user.email) });
  }
  if (action === "enable") {
    if (user.totp_enabled) throw new HttpError(409, "double authentification déjà active");
    if (!user.totp_secret) throw new HttpError(400, "commencez par scanner le QR code");
    const step = await verifyTotp(user.totp_secret, str(body.code, "code", 20));
    if (step === null) throw new HttpError(400, "code incorrect : vérifiez l'heure du téléphone et réessayez");
    const codes = newRecoveryCodes();
    const hashes = await Promise.all(codes.map(hashRecoveryCode));
    await env.DB.prepare(`UPDATE users SET totp_enabled = 1, totp_recovery = ?, totp_last_step = ? WHERE id = ?`).bind(JSON.stringify(hashes), step, s.sub).run();
    return json({ enabled: true, recoveryCodes: codes });
  }
  if (action === "disable") {
    if (!(await verifyPassword(str(body.password, "mot de passe"), user.password_hash))) throw new HttpError(403, "mot de passe incorrect");
    await env.DB.prepare(`UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery = NULL WHERE id = ?`).bind(s.sub).run();
    return json({ enabled: false });
  }
  throw new HttpError(404, "route inconnue");
}

/** Changement de son propre mot de passe (obligatoire après un mot de passe provisoire). */
async function handleChangePassword(req: Request, env: Env, s: Session) {
  const body = await readJson<Record<string, unknown>>(req);
  const current = str(body.current, "mot de passe actuel");
  const next = str(body.next, "nouveau mot de passe");
  if (next.length < MIN_PASSWORD) throw new HttpError(400, `mot de passe trop court (${MIN_PASSWORD} caractères minimum)`);
  if (next === current) throw new HttpError(400, "le nouveau mot de passe doit être différent");
  const user = await env.DB.prepare(`SELECT password_hash FROM users WHERE id = ?`).bind(s.sub).first<{ password_hash: string }>();
  if (!user || !(await verifyPassword(current, user.password_hash))) throw new HttpError(403, "mot de passe actuel incorrect");
  await env.DB.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`).bind(await hashPassword(next), s.sub).run();
  return json({ ok: true });
}

/**
 * Mot de passe oublié : l'administrateur de l'entreprise donne un mot de passe
 * provisoire, à changer à la connexion. Les appareils de la personne sont déconnectés.
 */
async function handleResetPassword(req: Request, env: Env, s: Session) {
  if (s.role !== "admin") throw new HttpError(403, "réservé à l'administrateur");
  const body = await readJson<Record<string, unknown>>(req);
  const id = str(body.id, "utilisateur", 64);
  const password = str(body.password, "mot de passe");
  if (password.length < MIN_PASSWORD) throw new HttpError(400, `mot de passe trop court (${MIN_PASSWORD} caractères minimum)`);
  const target = await env.DB.prepare(`SELECT email FROM users WHERE id = ? AND company_id = ?`).bind(id, s.cid).first<{ email: string }>();
  if (!target) throw new HttpError(404, "utilisateur introuvable");
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?`).bind(await hashPassword(password), id),
    env.DB.prepare(`UPDATE devices SET revoked = 1 WHERE user_id = ? AND id != ?`).bind(id, s.dev),
    env.DB.prepare(`DELETE FROM login_attempts WHERE key = ?`).bind(target.email),
  ]);
  // Téléphone perdu : le mot de passe provisoire retire aussi la double authentification.
  await env.DB.prepare(`UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery = NULL WHERE id = ?`).bind(id).run().catch(() => {});
  return json({ ok: true });
}

async function handleCreateUser(req: Request, env: Env, s: Session) {
  if (s.role !== "admin") throw new HttpError(403, "réservé à l'administrateur");
  const body = await readJson<Record<string, unknown>>(req);
  const role = str(body.role, "rôle");
  if (!ROLES.includes(role)) throw new HttpError(400, "rôle inconnu");
  const password = str(body.password, "mot de passe");
  if (password.length < MIN_PASSWORD) throw new HttpError(400, `mot de passe trop court (${MIN_PASSWORD} caractères minimum)`);
  const email = str(body.email, "e-mail").toLowerCase();
  const taken = await env.DB.prepare(`SELECT 1 AS x FROM users WHERE email = ?`).bind(email).first();
  if (taken) throw new HttpError(409, "cet e-mail est déjà utilisé");
  await assertUserQuota(env, s.cid);
  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO users (id, company_id, email, name, role, password_hash, created_at, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  ).bind(id, s.cid, email, str(body.name, "nom"), role, await hashPassword(password), now()).run();
  return json({ id }, 201);
}

/** Nombre d'utilisateurs actifs autorisé par la formule de l'entreprise. */
async function assertUserQuota(env: Env, companyId: string) {
  const row = await env.DB.prepare(
    `SELECT c.plan, (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.active = 1) AS n FROM companies c WHERE c.id = ?`,
  ).bind(companyId).first<{ plan: string; n: number }>();
  const plan = PLANS[row?.plan ?? "trial"] ?? PLANS.trial;
  if ((row?.n ?? 0) >= plan.maxUsers) {
    throw new HttpError(402, `votre formule ${plan.label} est limitée à ${plan.maxUsers} utilisateurs actifs : passez à une formule supérieure`);
  }
}

/** Change le rôle d'un utilisateur ou le désactive (ses appareils sont alors révoqués). */
async function handleUpdateUser(req: Request, env: Env, s: Session) {
  if (s.role !== "admin") throw new HttpError(403, "réservé à l'administrateur");
  const body = await readJson<Record<string, unknown>>(req);
  const id = str(body.id, "utilisateur", 64);
  if (id === s.sub) throw new HttpError(400, "vous ne pouvez pas modifier votre propre compte ici");
  const target = await env.DB.prepare(`SELECT id FROM users WHERE id = ? AND company_id = ?`).bind(id, s.cid).first();
  if (!target) throw new HttpError(404, "utilisateur introuvable");
  const statements: D1PreparedStatement[] = [];
  if (body.role !== undefined) {
    const role = str(body.role, "rôle");
    if (!ROLES.includes(role)) throw new HttpError(400, "rôle inconnu");
    statements.push(env.DB.prepare(`UPDATE users SET role = ? WHERE id = ?`).bind(role, id));
  }
  if (body.active !== undefined) {
    const active = body.active ? 1 : 0;
    if (active) await assertUserQuota(env, s.cid);
    statements.push(env.DB.prepare(`UPDATE users SET active = ? WHERE id = ?`).bind(active, id));
    if (!active) statements.push(env.DB.prepare(`UPDATE devices SET revoked = 1 WHERE user_id = ?`).bind(id));
  }
  if (statements.length === 0) throw new HttpError(400, "rien à modifier");
  await env.DB.batch(statements);
  return json({ ok: true });
}

async function handleListUsers(env: Env, s: Session) {
  if (s.role !== "admin" && s.role !== "director") throw new HttpError(403, "accès refusé");
  const { results } = await env.DB.prepare(
    `SELECT id, email, name, role, active, must_change_password, created_at FROM users WHERE company_id = ? ORDER BY name`,
  ).bind(s.cid).all();
  return json({ users: results });
}

function parseRecord(row: { tbl: string; id: string; data: string; clocks: string } | undefined): SyncRecord | null {
  if (!row) return null;
  return { tbl: row.tbl as SyncRecord["tbl"], id: row.id, data: JSON.parse(row.data), clocks: JSON.parse(row.clocks) };
}

/**
 * Contexte projet des règles (équipe, statut du projet, étapes et décisions), lu en une
 * seule requête et seulement si l'envoi touche des tâches, des temps, des étapes, des
 * décisions, la délégation d'un projet ou une facture d'étape.
 * Les lignes acceptées plus tôt dans le même envoi (map `records`) priment : une décision
 * acceptée compte pour la suite de l'envoi (R2, R11).
 */
async function loadProjectContext(env: Env, companyId: string, incoming: Change[], records: Map<string, SyncRecord | null>): Promise<ProjectContext | undefined> {
  const ids = new Set<string>();
  for (const c of incoming) {
    let pid: unknown;
    if (["tasks", "time_entries", "project_stages", "project_decisions"].includes(c.tbl)) {
      pid = c.patch.project_id ?? records.get(`${c.tbl}/${c.row}`)?.data.project_id;
    } else if (c.tbl === "projects" && "manager_can_validate" in c.patch) {
      pid = c.row;
    } else if (c.tbl === "invoices" && typeof c.patch.decision_id === "string" && c.patch.decision_id) {
      pid = c.patch.project_id ?? records.get(`${c.tbl}/${c.row}`)?.data.project_id;
    }
    if (typeof pid === "string" && pid) ids.add(pid);
  }
  if (ids.size === 0) return undefined;
  const list = JSON.stringify([...ids]);
  const { results } = await env.DB.prepare(
    `SELECT tbl, id, data, clocks FROM records
     WHERE company_id = ? AND (
       (tbl = 'projects' AND id IN (SELECT value FROM json_each(?)))
       OR (tbl IN ('project_members', 'project_stages', 'project_decisions') AND json_extract(data, '$.project_id') IN (SELECT value FROM json_each(?))))`,
  ).bind(companyId, list, list).all<{ tbl: string; id: string; data: string; clocks: string }>();
  const loaded = new Map<string, SyncRecord>();
  for (const r of results) loaded.set(`${r.tbl}/${r.id}`, parseRecord(r)!);
  const current = (key: string) => (records.has(key) ? records.get(key) ?? null : loaded.get(key) ?? null);
  /** Lignes vivantes d'une table rattachées au projet, chargées ou acceptées dans cet envoi. */
  const rowsOf = (tbl: string, pid: string) => {
    const keys = new Set([...loaded.keys(), ...records.keys()].filter((k) => k.startsWith(`${tbl}/`)));
    const out: SyncRecord[] = [];
    for (const k of keys) {
      const r = current(k);
      if (r && !r.data._deleted && r.data.project_id === pid) out.push(r);
    }
    return out;
  };
  return {
    project: (pid) => current(`projects/${pid}`),
    rolesIn: (pid, uid) => rowsOf("project_members", pid).filter((m) => m.data.user_id === uid).map((m) => String(m.data.role ?? "member")),
    stages: (pid) => rowsOf("project_stages", pid),
    decisions: (pid) => rowsOf("project_decisions", pid),
  };
}

/**
 * Applique un lot de modifications (appareil ou API) : idempotence, règles de droits,
 * fusion champ par champ, puis écriture en une transaction.
 */
async function applyIncoming(env: Env, s: Pick<Session, "sub" | "cid" | "role" | "dev">, incoming: Change[]) {
  const accepted: string[] = [];
  const rejected: SyncResponse["rejected"] = [];
  // Lectures groupées : modifications déjà reçues (renvoi après coupure) et lignes concernées.
  const ids = JSON.stringify(incoming.map((c) => c.id));
  const seenRows = await env.DB.prepare(
    `SELECT op_id FROM changes WHERE op_id IN (SELECT value FROM json_each(?))`,
  ).bind(ids).all<{ op_id: string }>();
  const seen = new Set(seenRows.results.map((r) => r.op_id));

  const keys = JSON.stringify(incoming.map((c) => [c.tbl, c.row]));
  const recRows = await env.DB.prepare(
    `SELECT r.tbl, r.id, r.data, r.clocks FROM records r
     JOIN (SELECT DISTINCT json_extract(value, '$[0]') AS tbl, json_extract(value, '$[1]') AS id FROM json_each(?)) k
       ON r.tbl = k.tbl AND r.id = k.id
     WHERE r.company_id = ?`,
  ).bind(keys, s.cid).all<{ tbl: string; id: string; data: string; clocks: string }>();
  const records = new Map<string, SyncRecord | null>();
  for (const r of recRows.results) records.set(`${r.tbl}/${r.id}`, parseRecord(r));

  // Date de clôture comptable, lue une fois par envoi.
  const settingsRow = await env.DB.prepare(
    `SELECT json_extract(data, '$.closed_until') AS closed FROM records WHERE company_id = ? AND tbl = 'settings' AND id = 'company'`,
  ).bind(s.cid).first<{ closed: string | null }>();
  const closedUntil = settingsRow?.closed ?? "";
  const actor = { userId: s.sub, role: s.role };
  const ctx = await loadProjectContext(env, s.cid, incoming, records);

  const statements: D1PreparedStatement[] = [];
  const touched = new Set<string>();
  const receivedAt = now();

  for (const c of incoming) {
    if (seen.has(c.id)) {
      accepted.push(c.id); // déjà appliquée : on confirme sans rien réécrire
      continue;
    }
    const key = `${c.tbl}/${c.row}`;
    const existing = records.get(key) ?? null;
    let reason = c.device !== s.dev ? "appareil incohérent" : checkChange(existing, c) ?? checkPermission(actor, existing, c, closedUntil, ctx);
    if (!reason && decodeHlc(c.hlc).ms > Date.now() + MAX_CLOCK_AHEAD_MS) {
      reason = "horloge de l'appareil trop en avance : corrigez la date du téléphone";
    }
    if (reason) {
      rejected.push({ id: c.id, reason, record: redactRecord(actor, existing) });
      continue;
    }
    const { record } = applyChange(existing, c);
    records.set(key, record);
    touched.add(key);
    seen.add(c.id);
    accepted.push(c.id);
    statements.push(
      env.DB.prepare(
        `INSERT INTO changes (op_id, company_id, device_id, user_id, tbl, row_id, patch, hlc, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(c.id, s.cid, s.dev, s.sub, c.tbl, c.row, JSON.stringify(c.patch), c.hlc, receivedAt),
    );
  }

  // Une seule écriture par ligne touchée, avec son état final fusionné.
  for (const key of touched) {
    const r = records.get(key)!;
    statements.push(
      env.DB.prepare(
        `INSERT INTO records (company_id, tbl, id, data, clocks, updated_seq)
         VALUES (?, ?, ?, ?, ?, (SELECT MAX(seq) FROM changes))
         ON CONFLICT(company_id, tbl, id) DO UPDATE SET data = excluded.data, clocks = excluded.clocks, updated_seq = excluded.updated_seq`,
      ).bind(s.cid, r.tbl, r.id, JSON.stringify(r.data), JSON.stringify(r.clocks)),
    );
  }
  // batch = une transaction : tout est écrit, ou rien.
  if (statements.length > 0) await env.DB.batch(statements);
  return { accepted, rejected };
}

/**
 * Point d'échange unique : envoie les modifications de l'appareil et reçoit
 * celles des autres en un seul aller-retour (une seule requête facturée).
 */
async function handleSync(req: Request, env: Env, s: Session, company: Company) {
  const subscription = subscriptionInfo(company, today());
  const body = await readJson<SyncRequest>(req);
  const since = Number.isInteger(body.since) && body.since >= 0 ? body.since : 0;
  const incoming: Change[] = Array.isArray(body.changes) ? body.changes : [];
  if (incoming.length > MAX_PUSH) throw new HttpError(413, `au plus ${MAX_PUSH} modifications par envoi`);
  for (const c of incoming) {
    if (!c || typeof c.id !== "string" || c.id.length < 8 || c.id.length > 64) throw new HttpError(400, "modification sans identifiant");
  }

  // Abonnement expiré ou suspendu : consultation seule. Les modifications ne sont
  // ni acceptées ni refusées : elles restent en attente sur l'appareil, sans perte,
  // et partiront dès le renouvellement.
  const { accepted, rejected } = incoming.length > 0 && !subscription.readOnly
    ? await applyIncoming(env, s, incoming)
    : { accepted: [] as string[], rejected: [] as SyncResponse["rejected"] };

  // Réception : modifications postérieures au curseur, hors celles de cet appareil,
  // limitées à ce que le rôle de l'utilisateur peut voir.
  const { results } = await env.DB.prepare(
    `SELECT c.seq, c.op_id, c.device_id, c.tbl, c.row_id, c.patch, c.hlc,
            json_extract(r.data, '$.created_by') AS owner
     FROM changes c
     LEFT JOIN records r ON r.company_id = c.company_id AND r.tbl = c.tbl AND r.id = c.row_id
     WHERE c.company_id = ? AND c.seq > ? ORDER BY c.seq LIMIT ?`,
  ).bind(s.cid, since, MAX_PULL + 1).all<{ seq: number; op_id: string; device_id: string; tbl: string; row_id: string; patch: string; hlc: string; owner: string | null }>();
  const more = results.length > MAX_PULL;
  const page = more ? results.slice(0, MAX_PULL) : results;
  const reader = { userId: s.sub, role: s.role };
  // Les montants sont retirés de tout l'historique rejoué (redactPatch, lot 1 Projets).
  const changes: Change[] = [];
  for (const r of page) {
    if (r.device_id === s.dev || !canRead(reader, r.tbl, r.owner, r.row_id)) continue;
    const patch = redactPatch(reader, r.tbl, JSON.parse(r.patch));
    if (patch) changes.push({ id: r.op_id, tbl: r.tbl as Change["tbl"], row: r.row_id, patch, hlc: r.hlc, device: r.device_id });
  }
  const cursor = page.length > 0 ? page[page.length - 1].seq : since;

  const response: SyncResponse = { role: s.role, dataEpoch: DATA_EPOCH, accepted, rejected, changes, cursor, more, subscription };
  return json(response);
}

/** Réserve un bloc de numéros de facture pour cet appareil (ex. FA-2026, 50 numéros). */
async function handleReserveNumbers(req: Request, env: Env, s: Session) {
  const body = await readJson<Record<string, unknown>>(req);
  const series = str(body.series, "série", 20);
  if (!/^[A-Z]{2,4}-\d{4}$/.test(series)) throw new HttpError(400, "série invalide (ex. FA-2026)");
  const [, updated] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO number_counters (company_id, series, next_no) VALUES (?, ?, 1) ON CONFLICT DO NOTHING`).bind(s.cid, series),
    env.DB.prepare(
      `UPDATE number_counters SET next_no = next_no + ? WHERE company_id = ? AND series = ? RETURNING next_no - ? AS start_no`,
    ).bind(NUMBER_BLOCK_SIZE, s.cid, series, NUMBER_BLOCK_SIZE),
  ]);
  const start = Number((updated.results[0] as { start_no: number }).start_no);
  const end = start + NUMBER_BLOCK_SIZE - 1;
  await env.DB.prepare(
    `INSERT INTO number_blocks (company_id, series, device_id, start_no, end_no, reserved_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(s.cid, series, s.dev, start, end, now()).run();
  return json({ series, start, end });
}

/** Export complet des données de l'entreprise (sauvegarde ou départ), sans mots de passe. */
async function handleExport(env: Env, s: Session) {
  if (s.role !== "admin" && s.role !== "director") throw new HttpError(403, "réservé à la direction");
  const company = await env.DB.prepare(`SELECT id, name, plan, status, trial_ends_at, paid_until, created_at FROM companies WHERE id = ?`).bind(s.cid).first();
  const users = await env.DB.prepare(`SELECT id, email, name, role, active, created_at FROM users WHERE company_id = ?`).bind(s.cid).all();
  const { results } = await env.DB.prepare(`SELECT tbl, id, data FROM records WHERE company_id = ? ORDER BY tbl, id`).bind(s.cid).all<{ tbl: string; id: string; data: string }>();
  const tables: Record<string, unknown[]> = {};
  for (const r of results) (tables[r.tbl] ??= []).push({ id: r.id, ...JSON.parse(r.data) });
  const name = `gestia-export-${today()}.json`;
  return new Response(JSON.stringify({ format: "gestia-export", version: 1, exported_at: now(), company, users: users.results, tables }, null, 1), {
    headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" },
  });
}

/** Erreurs de l'application remontées par les appareils (sans données métier). */
async function handleClientError(req: Request, env: Env) {
  const body = await readJson<Record<string, unknown>>(req);
  let who: Session | null = null;
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) who = await verifyToken(header.slice(7), secret(env)).catch(() => null);
  const cut = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null);
  const message = cut(body.message, 500);
  if (!message) throw new HttpError(400, "message manquant");
  const r = await env.DB.prepare(
    `INSERT INTO client_errors (company_id, user_id, at, message, detail, url, agent) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(who?.cid ?? null, who?.sub ?? null, now(), message, cut(body.detail, 4000), cut(body.url, 300), cut(req.headers.get("user-agent"), 300)).run();
  // On garde les 2 000 dernières.
  const last = Number((r.meta as { last_row_id?: number }).last_row_id ?? 0);
  if (last % 200 === 0) await env.DB.prepare(`DELETE FROM client_errors WHERE id <= ?`).bind(last - 2000).run();
  return json({ ok: true }, 201);
}

function requirePlatform(env: Env, s: Session) {
  if (!s.pa || !isPlatformAdmin(env, s.cid, s.role)) throw new HttpError(403, "réservé à l'équipe Gestia");
}

/** Console de la plateforme : entreprises clientes, abonnements, activité. */
async function handlePlatform(req: Request, env: Env, s: Session, path: string) {
  requirePlatform(env, s);
  if (path === "companies" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT c.id, c.name, c.plan, c.status, c.trial_ends_at, c.paid_until, c.contact_email, c.contact_phone, c.note, c.created_at,
              (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.active = 1) AS users,
              (SELECT MAX(d.last_seen) FROM devices d WHERE d.company_id = c.id) AS last_seen,
              (SELECT u.email FROM users u WHERE u.company_id = c.id AND u.role = 'admin' ORDER BY u.created_at LIMIT 1) AS admin_email
       FROM companies c ORDER BY c.created_at DESC`,
    ).all<Company & Record<string, unknown>>();
    const day = today();
    return json({ companies: results.map((c) => ({ ...c, subscription: subscriptionInfo(c, day) })) });
  }
  if (path === "company" && req.method === "POST") {
    const body = await readJson<Record<string, unknown>>(req);
    const id = str(body.id, "entreprise", 64);
    if (id === env.PLATFORM_COMPANY && body.status === "suspended") throw new HttpError(400, "l'entreprise éditrice ne peut pas être suspendue");
    const sets: string[] = [];
    const values: unknown[] = [];
    const date = (v: unknown) => (v === "" || v === null ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : (() => { throw new HttpError(400, "date invalide"); })());
    if (body.plan !== undefined) { if (!PLANS[String(body.plan)]) throw new HttpError(400, "formule inconnue"); sets.push("plan = ?"); values.push(body.plan); }
    if (body.status !== undefined) { if (!["active", "suspended"].includes(String(body.status))) throw new HttpError(400, "statut inconnu"); sets.push("status = ?"); values.push(body.status); }
    if (body.trial_ends_at !== undefined) { sets.push("trial_ends_at = ?"); values.push(date(body.trial_ends_at)); }
    if (body.paid_until !== undefined) { sets.push("paid_until = ?"); values.push(date(body.paid_until)); }
    if (body.note !== undefined) { sets.push("note = ?"); values.push(String(body.note).slice(0, 1000)); }
    if (!sets.length) throw new HttpError(400, "rien à modifier");
    const r = await env.DB.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`).bind(...values, id).run();
    if (!(r.meta as { changes?: number }).changes && (r.meta as { changes?: number }).changes !== undefined) throw new HttpError(404, "entreprise introuvable");
    return json({ ok: true });
  }
  if (path === "payment" && req.method === "POST") {
    const body = await readJson<Record<string, unknown>>(req);
    const id = str(body.company_id, "entreprise", 64);
    const plan = str(body.plan, "formule");
    if (!PLANS[plan] || plan === "trial") throw new HttpError(400, "formule payante inconnue");
    const months = Number(body.months);
    const amount = Math.round(Number(body.amount));
    if (!Number.isInteger(months) || months < 1 || months > 36) throw new HttpError(400, "durée invalide (1 à 36 mois)");
    if (!(amount >= 0)) throw new HttpError(400, "montant invalide");
    const c = await env.DB.prepare(`SELECT paid_until, plan FROM companies WHERE id = ?`).bind(id).first<{ paid_until: string | null; plan: string }>();
    if (!c) throw new HttpError(404, "entreprise introuvable");
    // Un changement de formule repart d'aujourd'hui ; un renouvellement prolonge l'échéance.
    const period = extendPaidUntil(c.plan === plan ? c.paid_until : null, months, today());
    await env.DB.batch([
      env.DB.prepare(`UPDATE companies SET plan = ?, paid_until = ?, status = 'active' WHERE id = ?`).bind(plan, period.to, id),
      env.DB.prepare(
        `INSERT INTO subscription_payments (id, company_id, plan, months, amount, method, reference, period_from, period_to, recorded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(uuid(), id, plan, months, amount, str(body.method, "moyen de paiement", 40), typeof body.reference === "string" ? body.reference.slice(0, 120) : null, period.from, period.to, s.sub, now()),
    ]);
    return json({ ok: true, paid_until: period.to }, 201);
  }
  if (path === "payments" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT p.*, c.name AS company_name FROM subscription_payments p JOIN companies c ON c.id = p.company_id ORDER BY p.created_at DESC LIMIT 200`,
    ).all();
    return json({ payments: results });
  }
  if (path === "reset-password" && req.method === "POST") {
    // Mot de passe oublié par l'administrateur d'une entreprise cliente.
    const body = await readJson<Record<string, unknown>>(req);
    const email = str(body.email, "e-mail").toLowerCase();
    const password = str(body.password, "mot de passe");
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `mot de passe trop court (${MIN_PASSWORD} caractères minimum)`);
    const u = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first<{ id: string }>();
    if (!u) throw new HttpError(404, "aucun compte avec cet e-mail");
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?`).bind(await hashPassword(password), u.id),
      env.DB.prepare(`UPDATE devices SET revoked = 1 WHERE user_id = ?`).bind(u.id),
      env.DB.prepare(`DELETE FROM login_attempts WHERE key = ?`).bind(email),
    ]);
    return json({ ok: true });
  }
  if (path === "errors" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT e.id, e.at, e.message, e.detail, e.url, e.agent, c.name AS company_name FROM client_errors e
       LEFT JOIN companies c ON c.id = e.company_id ORDER BY e.id DESC LIMIT 100`,
    ).all();
    return json({ errors: results });
  }
  throw new HttpError(404, "route inconnue");
}

/** Taille maximale d'un justificatif (après compression sur l'appareil). */
const MAX_FILE_BYTES = 1_400_000;
const FILE_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
let filesReady = false;

/** Crée la table des fichiers au premier usage : aucune migration à lancer à la main. */
async function filesDb(env: Env) {
  if (!env.FILES) throw new HttpError(503, "stockage des justificatifs non configuré");
  if (!filesReady) {
    await env.FILES.prepare(
      `CREATE TABLE IF NOT EXISTS files (
         company_id TEXT NOT NULL, id TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
         data TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
         PRIMARY KEY (company_id, id))`,
    ).run();
    filesReady = true;
  }
  return env.FILES;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function handleFile(req: Request, env: Env, s: Session, id: string) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new HttpError(400, "identifiant de fichier invalide");
  const db = await filesDb(env);
  if (req.method === "PUT") {
    const mime = (req.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!FILE_TYPES.includes(mime)) throw new HttpError(415, "format accepté : photo (JPEG, PNG, WebP) ou PDF");
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) throw new HttpError(413, "fichier vide ou trop lourd (1,4 Mo maximum)");
    // Idempotent : un renvoi après coupure ne crée pas de doublon.
    await db.prepare(
      `INSERT OR IGNORE INTO files (company_id, id, mime, size, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(s.cid, id, mime, bytes.length, toBase64(bytes), s.sub, now()).run();
    return json({ id, size: bytes.length }, 201);
  }
  if (req.method === "GET") {
    const row = await db.prepare(`SELECT mime, data FROM files WHERE company_id = ? AND id = ?`).bind(s.cid, id).first<{ mime: string; data: string }>();
    if (!row) throw new HttpError(404, "fichier introuvable");
    return new Response(fromBase64(row.data), { headers: { "content-type": row.mime, "cache-control": "private, max-age=31536000, immutable" } });
  }
  throw new HttpError(405, "méthode non autorisée");
}

// ---------------------------------------------------------------------------
// API publique (lot 8d) : jetons à portée limitée, créés dans Réglages › API.
// ---------------------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomString(n: number, alphabet: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

const apiDevice = (keyId: string) => `api-${keyId}`;

/** Gestion des jetons par les administrateurs : liste, création (jeton montré une fois), révocation. */
async function handleApiKeys(req: Request, env: Env, s: Session, action: string) {
  if (s.role !== "admin") throw new HttpError(403, "réservé aux administrateurs");
  if (action === "" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, name, hint, scopes, created_at, last_used_at, revoked FROM api_keys WHERE company_id = ? ORDER BY created_at DESC`,
    ).bind(s.cid).all<{ id: string; name: string; hint: string; scopes: string; created_at: string; last_used_at: string | null; revoked: number }>();
    return json({ keys: results.map((k) => ({ ...k, scopes: JSON.parse(k.scopes), revoked: !!k.revoked })) });
  }
  if (action === "" && req.method === "POST") {
    const body = await readJson<Record<string, unknown>>(req);
    const name = str(body.name, "nom", 60);
    const scopes = parseScopes(body.scopes);
    if (Object.keys(scopes).length === 0) throw new HttpError(400, "choisissez au moins une table");
    const { n } = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE company_id = ? AND revoked = 0`).bind(s.cid).first<{ n: number }>())!;
    if (n >= 20) throw new HttpError(400, "20 jetons actifs au plus : révoquez-en un");
    const id = randomString(12, "abcdefghijklmnopqrstuvwxyz0123456789");
    const token = `gst_${id}_${randomString(32, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO api_keys (id, company_id, user_id, name, hash, hint, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, s.cid, s.sub, name, await sha256Hex(token), token.slice(-4), JSON.stringify(scopes), now()),
      // Pseudo-appareil du jeton : ses écritures sont redistribuées comme celles d'un appareil.
      env.DB.prepare(`INSERT INTO devices (id, company_id, user_id, last_seen) VALUES (?, ?, ?, ?)`).bind(apiDevice(id), s.cid, s.sub, now()),
    ]);
    return json({ id, name, token, scopes });
  }
  if (action === "revoke" && req.method === "POST") {
    const body = await readJson<Record<string, unknown>>(req);
    const id = str(body.id, "jeton", 20);
    await env.DB.batch([
      env.DB.prepare(`UPDATE api_keys SET revoked = 1 WHERE id = ? AND company_id = ?`).bind(id, s.cid),
      env.DB.prepare(`UPDATE devices SET revoked = 1 WHERE id = ? AND company_id = ?`).bind(apiDevice(id), s.cid),
    ]);
    return json({ ok: true });
  }
  throw new HttpError(404, "route inconnue");
}

interface ApiCaller {
  s: Pick<Session, "sub" | "cid" | "role" | "dev">;
  scopes: ApiScopes;
  name: string;
  company: Company;
}

async function authenticateApi(req: Request, env: Env): Promise<ApiCaller> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!API_TOKEN_RE.test(token)) throw new HttpError(401, "jeton d'API manquant ou invalide");
  const row = await env.DB.prepare(
    `SELECT k.id, k.name, k.scopes, k.last_used_at, k.user_id, u.role, u.active, c.id AS cid, c.name AS cname, c.plan, c.status, c.trial_ends_at, c.paid_until
     FROM api_keys k JOIN users u ON u.id = k.user_id JOIN companies c ON c.id = k.company_id
     WHERE k.hash = ? AND k.revoked = 0`,
  ).bind(await sha256Hex(token)).first<{ id: string; name: string; scopes: string; last_used_at: string | null; user_id: string; role: string; active: number; cid: string; cname: string; plan: string; status: string; trial_ends_at: string | null; paid_until: string | null }>();
  // Le jeton s'éteint si son créateur est désactivé ou perd le rôle d'administrateur.
  if (!row || !row.active || row.role !== "admin") throw new HttpError(401, "jeton d'API révoqué ou inconnu");
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 3600_000) {
    await env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).bind(now(), row.id).run();
  }
  return {
    s: { sub: row.user_id, cid: row.cid, role: row.role, dev: apiDevice(row.id) },
    scopes: JSON.parse(row.scopes),
    name: row.name,
    company: { id: row.cid, name: row.cname, plan: row.plan, status: row.status, trial_ends_at: row.trial_ends_at, paid_until: row.paid_until },
  };
}

const apiRecord = (r: SyncRecord) => ({ id: r.id, ...r.data });

/**
 * /api/v1/{table}            GET  : liste (?since=<curseur>, ?deleted=1 pour inclure les suppressions)
 * /api/v1/{table}/{id}       GET  : un élément ; PATCH : fusion de champs (création si nouveau) ; DELETE : suppression
 */
async function handlePublicApi(req: Request, env: Env, path: string) {
  const caller = await authenticateApi(req, env);
  const { s, scopes } = caller;
  if (caller.company.status === "suspended") throw new HttpError(403, "compte de l'entreprise suspendu");
  const [tbl, rowId, extra] = path.split("/");
  if (extra !== undefined || !tbl) throw new HttpError(404, "route inconnue");
  const write = req.method === "PATCH" || req.method === "DELETE";
  if (!["GET", "PATCH", "DELETE"].includes(req.method)) throw new HttpError(405, "méthode non autorisée");
  if (!allows(scopes, tbl, write)) throw new HttpError(403, write ? `ce jeton ne peut pas modifier « ${tbl} »` : `ce jeton ne peut pas lire « ${tbl} »`);
  const reader = { userId: s.sub, role: s.role };

  if (req.method === "GET" && !rowId) {
    const url = new URL(req.url);
    const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
    const deleted = url.searchParams.get("deleted") === "1";
    const { results } = await env.DB.prepare(
      `SELECT tbl, id, data, clocks, updated_seq FROM records WHERE company_id = ? AND tbl = ? AND updated_seq > ? ORDER BY updated_seq LIMIT ?`,
    ).bind(s.cid, tbl, since, MAX_PULL + 1).all<{ tbl: string; id: string; data: string; clocks: string; updated_seq: number }>();
    const more = results.length > MAX_PULL;
    const page = more ? results.slice(0, MAX_PULL) : results;
    const items = [];
    for (const r of page) {
      const rec = redactRecord(reader, parseRecord(r))!;
      if (!deleted && rec.data._deleted) continue;
      items.push(apiRecord(rec));
    }
    return json({ items, cursor: page.length ? page[page.length - 1].updated_seq : since, more });
  }

  if (!rowId || rowId.length < 3 || rowId.length > 96) throw new HttpError(400, "identifiant invalide");
  const row = await env.DB.prepare(`SELECT tbl, id, data, clocks FROM records WHERE company_id = ? AND tbl = ? AND id = ?`)
    .bind(s.cid, tbl, rowId).first<{ tbl: string; id: string; data: string; clocks: string }>();
  const existing = parseRecord(row ?? undefined);

  if (req.method === "GET") {
    if (!existing || existing.data._deleted) throw new HttpError(404, "élément introuvable");
    return json(apiRecord(redactRecord(reader, existing)!));
  }

  if (subscriptionInfo(caller.company, today()).readOnly) throw new HttpError(403, "abonnement expiré : consultation seule");
  let patch: Record<string, unknown>;
  if (req.method === "DELETE") {
    if (!existing || existing.data._deleted) throw new HttpError(404, "élément introuvable");
    patch = { _deleted: true };
  } else {
    const body = await readJson<unknown>(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "corps JSON attendu : un objet de champs");
    patch = { ...(body as Record<string, unknown>) };
    delete patch.id;
    if (Object.keys(patch).length === 0) throw new HttpError(400, "aucun champ à modifier");
    if (!existing) {
      patch.created_by ??= s.sub;
      patch.created_by_name ??= `API : ${caller.name}`;
    }
  }
  // Horodatage postérieur à toute écriture connue de la ligne : la modification de l'API l'emporte.
  const latest = Math.max(0, ...Object.values(existing?.clocks ?? {}).map((h) => decodeHlc(String(h)).ms));
  const change: Change = {
    id: crypto.randomUUID(), tbl: tbl as Change["tbl"], row: rowId, patch,
    hlc: encodeHlc(Math.max(Date.now(), latest + 1), 0, s.dev), device: s.dev,
  };
  const { rejected } = await applyIncoming(env, s, [change]);
  if (rejected.length) throw new HttpError(422, rejected[0].reason);
  const after = await env.DB.prepare(`SELECT tbl, id, data, clocks FROM records WHERE company_id = ? AND tbl = ? AND id = ?`)
    .bind(s.cid, tbl, rowId).first<{ tbl: string; id: string; data: string; clocks: string }>();
  return json(req.method === "DELETE" ? { ok: true } : apiRecord(redactRecord(reader, parseRecord(after ?? undefined))!), existing ? 200 : 201);
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;
  if (p === "/api/health") return json({ ok: true, time: now() });
  if (p === "/api/status" && m === "GET") {
    // Coordonnées du support Gestia : celles saisies dans les réglages de l'entreprise éditrice.
    let support: Record<string, unknown> = {};
    if (env.PLATFORM_COMPANY) {
      const row = await env.DB.prepare(`SELECT data FROM records WHERE company_id = ? AND tbl = 'settings' AND id = 'company'`)
        .bind(env.PLATFORM_COMPANY).first<{ data: string }>();
      if (row) {
        const d = JSON.parse(row.data);
        support = { name: d.name ?? "Gestia", email: d.email ?? "", phone: d.phone ?? "" };
      }
    }
    return json({ signup: true, support });
  }
  if (p === "/api/signup" && m === "POST") return handleSignup(req, env);
  if (p === "/api/login" && m === "POST") return handleLogin(req, env);
  if (p === "/api/errors" && m === "POST") return handleClientError(req, env);
  if (p.startsWith("/api/v1/")) return handlePublicApi(req, env, p.slice("/api/v1/".length));
  const { s: session, company } = await authenticate(req, env);
  if (company.status === "suspended" && p !== "/api/export") throw new HttpError(403, "compte de l'entreprise suspendu : contactez l'équipe Gestia");
  if (p === "/api/sync" && m === "POST") return handleSync(req, env, session, company);
  if (p === "/api/numbers/reserve" && m === "POST") return handleReserveNumbers(req, env, session);
  if (p === "/api/me/password" && m === "POST") return handleChangePassword(req, env, session);
  if (p === "/api/me/2fa" || p.startsWith("/api/me/2fa/")) return handleTwoFactor(req, env, session, p.slice("/api/me/2fa".length).replace(/^\//, ""));
  if (p === "/api/users" && m === "GET") return handleListUsers(env, session);
  if (p === "/api/users" && m === "POST") return handleCreateUser(req, env, session);
  if (p === "/api/users/update" && m === "POST") return handleUpdateUser(req, env, session);
  if (p === "/api/users/password" && m === "POST") return handleResetPassword(req, env, session);
  if (p === "/api/export" && m === "GET") return handleExport(env, session);
  if (p === "/api/keys" || p.startsWith("/api/keys/")) return handleApiKeys(req, env, session, p.slice("/api/keys".length).replace(/^\//, ""));
  if (p.startsWith("/api/platform/")) return handlePlatform(req, env, session, p.slice("/api/platform/".length));
  if (p.startsWith("/api/files/")) return handleFile(req, env, session, p.slice("/api/files/".length));
  throw new HttpError(404, "route inconnue");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      const message = e instanceof Error ? e.message : String(e);
      // Plan gratuit : quota D1 du jour atteint. Les appareils continuent hors ligne.
      if (/daily row (read|write) limit/i.test(message)) {
        return json({ error: "quota du jour atteint, synchronisation reprise après 1 h (heure de Libreville)", quota: true }, 503);
      }
      console.error(e);
      return json({ error: "erreur serveur" }, 500);
    }
  },
};
