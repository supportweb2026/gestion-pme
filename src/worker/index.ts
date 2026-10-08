/**
 * Worker Cloudflare : sert l'API /api/* ; tout le reste (l'application) est
 * servi gratuitement par les « static assets » configurés dans wrangler.jsonc.
 */
import type { D1PreparedStatement, Env } from "./d1.ts";
import { hashPassword, signToken, verifyPassword, verifyToken, type Session } from "./auth.ts";
import {
  applyChange, checkChange, checkPermission, MAX_PULL, MAX_PUSH,
  type Change, type SyncRecord, type SyncRequest, type SyncResponse,
} from "../shared/sync.ts";
import { decodeHlc } from "../shared/hlc.ts";

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

async function authenticate(req: Request, env: Env): Promise<Session> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = token ? await verifyToken(token, secret(env)) : null;
  if (!session) throw new HttpError(401, "session expirée, reconnectez-vous");
  // Un seul accès en lecture : appareil non révoqué et utilisateur actif.
  const row = await env.DB.prepare(
    `SELECT d.revoked, d.last_seen, u.active FROM devices d JOIN users u ON u.id = d.user_id
     WHERE d.id = ? AND d.user_id = ?`,
  ).bind(session.dev, session.sub).first<{ revoked: number; last_seen: string; active: number }>();
  if (!row || row.revoked || !row.active) throw new HttpError(401, "accès révoqué pour cet appareil");
  // On ne réécrit « vu le » qu'une fois par heure, pour économiser les écritures.
  if (Date.now() - Date.parse(row.last_seen) > 3600_000) {
    await env.DB.prepare(`UPDATE devices SET last_seen = ? WHERE id = ?`).bind(now(), session.dev).run();
  }
  return session;
}

async function openSession(env: Env, user: { id: string; company_id: string; role: string; name: string; email: string }, dev: string, companyName: string) {
  await env.DB.prepare(
    `INSERT INTO devices (id, company_id, user_id, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, company_id = excluded.company_id, last_seen = excluded.last_seen, revoked = 0`,
  ).bind(dev, user.company_id, user.id, now()).run();
  const token = await signToken({ sub: user.id, cid: user.company_id, role: user.role, dev }, secret(env));
  return {
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    company: { id: user.company_id, name: companyName },
  };
}

/** Premier lancement : crée l'entreprise et son administrateur. Refusé ensuite. */
async function handleSetup(req: Request, env: Env) {
  const body = await readJson<Record<string, unknown>>(req);
  const companyName = str(body.company, "entreprise");
  const name = str(body.name, "nom");
  const email = str(body.email, "e-mail").toLowerCase();
  const password = str(body.password, "mot de passe");
  const dev = deviceId(body.deviceId);
  if (password.length < MIN_PASSWORD) throw new HttpError(400, `mot de passe trop court (${MIN_PASSWORD} caractères minimum)`);
  const existing = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) throw new HttpError(403, "l'application est déjà initialisée");
  const companyId = uuid();
  const user = { id: uuid(), company_id: companyId, role: "admin", name, email };
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)`).bind(companyId, companyName, now()),
    env.DB.prepare(
      `INSERT INTO users (id, company_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, 'admin', ?, ?)`,
    ).bind(user.id, companyId, email, name, await hashPassword(password), now()),
  ]);
  return json(await openSession(env, user, dev, companyName), 201);
}

async function handleLogin(req: Request, env: Env) {
  const body = await readJson<Record<string, unknown>>(req);
  const email = str(body.email, "e-mail").toLowerCase();
  const password = str(body.password, "mot de passe");
  const dev = deviceId(body.deviceId);
  const user = await env.DB.prepare(
    `SELECT u.id, u.company_id, u.role, u.name, u.email, u.password_hash, u.active, c.name AS company_name
     FROM users u JOIN companies c ON c.id = u.company_id WHERE u.email = ?`,
  ).bind(email).first<{ id: string; company_id: string; role: string; name: string; email: string; password_hash: string; active: number; company_name: string }>();
  if (!user || !user.active || !(await verifyPassword(password, user.password_hash))) {
    throw new HttpError(401, "e-mail ou mot de passe incorrect");
  }
  return json(await openSession(env, user, dev, user.company_name));
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
  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO users (id, company_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, s.cid, email, str(body.name, "nom"), role, await hashPassword(password), now()).run();
  return json({ id }, 201);
}

/** Change le rôle d'un utilisateur ou le désactive (ses appareils sont alors révoqués). */
async function handleUpdateUser(req: Request, env: Env, s: Session) {
  if (s.role !== "admin") throw new HttpError(403, "réservé à l'administrateur");
  const body = await readJson<Record<string, unknown>>(req);
  const id = str(body.id, "utilisateur", 64);
  if (id === s.sub) throw new HttpError(400, "vous ne pouvez pas modifier votre propre compte ici");
  const target = await env.DB.prepare(`SELECT id FROM users WHERE id = ? AND company_id = ?`).bind(id, s.cid).first();
  if (!target) throw new HttpError(404, "utilisateur introuvable");
  const statements = [];
  if (body.role !== undefined) {
    const role = str(body.role, "rôle");
    if (!ROLES.includes(role)) throw new HttpError(400, "rôle inconnu");
    statements.push(env.DB.prepare(`UPDATE users SET role = ? WHERE id = ?`).bind(role, id));
  }
  if (body.active !== undefined) {
    const active = body.active ? 1 : 0;
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
    `SELECT id, email, name, role, active, created_at FROM users WHERE company_id = ? ORDER BY name`,
  ).bind(s.cid).all();
  return json({ users: results });
}

function parseRecord(row: { tbl: string; id: string; data: string; clocks: string } | undefined): SyncRecord | null {
  if (!row) return null;
  return { tbl: row.tbl as SyncRecord["tbl"], id: row.id, data: JSON.parse(row.data), clocks: JSON.parse(row.clocks) };
}

/**
 * Point d'échange unique : envoie les modifications de l'appareil et reçoit
 * celles des autres en un seul aller-retour (une seule requête facturée).
 */
async function handleSync(req: Request, env: Env, s: Session) {
  const body = await readJson<SyncRequest>(req);
  const since = Number.isInteger(body.since) && body.since >= 0 ? body.since : 0;
  const incoming: Change[] = Array.isArray(body.changes) ? body.changes : [];
  if (incoming.length > MAX_PUSH) throw new HttpError(413, `au plus ${MAX_PUSH} modifications par envoi`);
  for (const c of incoming) {
    if (!c || typeof c.id !== "string" || c.id.length < 8 || c.id.length > 64) throw new HttpError(400, "modification sans identifiant");
  }

  const accepted: string[] = [];
  const rejected: SyncResponse["rejected"] = [];

  if (incoming.length > 0) {
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
      let reason = c.device !== s.dev ? "appareil incohérent" : checkChange(existing, c) ?? checkPermission(actor, existing, c, closedUntil);
      if (!reason && decodeHlc(c.hlc).ms > Date.now() + MAX_CLOCK_AHEAD_MS) {
        reason = "horloge de l'appareil trop en avance : corrigez la date du téléphone";
      }
      if (reason) {
        rejected.push({ id: c.id, reason, record: existing });
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
  }

  // Réception : modifications postérieures au curseur, hors celles de cet appareil.
  const { results } = await env.DB.prepare(
    `SELECT seq, op_id, device_id, tbl, row_id, patch, hlc FROM changes
     WHERE company_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
  ).bind(s.cid, since, MAX_PULL + 1).all<{ seq: number; op_id: string; device_id: string; tbl: string; row_id: string; patch: string; hlc: string }>();
  const more = results.length > MAX_PULL;
  const page = more ? results.slice(0, MAX_PULL) : results;
  const changes: Change[] = page
    .filter((r) => r.device_id !== s.dev)
    .map((r) => ({ id: r.op_id, tbl: r.tbl as Change["tbl"], row: r.row_id, patch: JSON.parse(r.patch), hlc: r.hlc, device: r.device_id }));
  const cursor = page.length > 0 ? page[page.length - 1].seq : since;

  const response: SyncResponse = { accepted, rejected, changes, cursor, more };
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

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;
  if (p === "/api/health") return json({ ok: true, time: now() });
  if (p === "/api/status" && m === "GET") {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
    return json({ initialized: (r?.n ?? 0) > 0 });
  }
  if (p === "/api/setup" && m === "POST") return handleSetup(req, env);
  if (p === "/api/login" && m === "POST") return handleLogin(req, env);
  const session = await authenticate(req, env);
  if (p === "/api/sync" && m === "POST") return handleSync(req, env, session);
  if (p === "/api/numbers/reserve" && m === "POST") return handleReserveNumbers(req, env, session);
  if (p === "/api/users" && m === "GET") return handleListUsers(env, session);
  if (p === "/api/users" && m === "POST") return handleCreateUser(req, env, session);
  if (p === "/api/users/update" && m === "POST") return handleUpdateUser(req, env, session);
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
