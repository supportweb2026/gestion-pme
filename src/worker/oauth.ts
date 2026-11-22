/**
 * Connecteur MCP, partie OAuth 2.1 : ce qu'il faut pour qu'un assistant (Claude…)
 * ajoute Gestia comme « connecteur personnalisé » avec l'adresse https://gestia.ido.ga/mcp.
 *
 *  - métadonnées (RFC 9728 et RFC 8414) ;
 *  - enregistrement dynamique des clients (RFC 7591) ;
 *  - autorisation avec PKCE S256 obligatoire : connexion Gestia (vrai contrôle du mot de passe,
 *    du blocage et de la double authentification, par /api/login), puis écran de consentement ;
 *  - jetons : accès 1 h, rafraîchissement 30 jours à rotation ; révocation (RFC 7009) ;
 *  - Réglages › Connexions : liste et déconnexion.
 *
 * Tout est dans D1 (migration 0005) et seule l'empreinte SHA-256 des codes et jetons est
 * gardée. Chaque connexion a son pseudo-appareil `mcp-…` : ses écritures passent par la
 * synchronisation (applyIncoming) et sont tracées à son nom ; le révoquer coupe tout.
 */
import type { Env } from "./d1.ts";
import { b64url, fromB64url, type Session } from "./auth.ts";
import worker from "./index.ts";
import { handleMcp } from "./mcp.ts";

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 24 * 3600;
export const CODE_TTL_S = 300;
/** Temps laissé pour se connecter puis donner son accord. */
const FORM_TTL_S = 15 * 60;
/** Enregistrements de clients par adresse IP et par jour. */
const MAX_REGISTRATIONS_PER_IP = 30;
export const MCP_SCOPE = "projets";

const enc = new TextEncoder();
const nowIso = () => new Date().toISOString();
const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();

export async function sha256(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** PKCE S256 : BASE64URL(SHA256(code_verifier)) == code_challenge (RFC 7636). */
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return (await sha256(verifier)) === challenge;
}

const REFRESH_GRACE_MS = 60_000;

function secret(env: Env): string {
  const s = env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error("secret JWT_SECRET absent ou trop court");
  return s;
}

async function hmac(env: Env, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(`oauth:${secret(env)}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

/** Petit état signé et daté, porté par les formulaires (aucun stockage côté serveur entre deux pages). */
export async function seal(env: Env, payload: Record<string, unknown>, ttlS = FORM_TTL_S): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ ...payload, exp: Date.now() + ttlS * 1000 })));
  return `${body}.${await hmac(env, body)}`;
}

/** Secret court chiffré (AES-GCM) et daté : le mot de passe ne circule jamais en clair dans la page. */
async function aesKey(env: Env): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`oauth-enc:${secret(env)}`));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(env: Env, value: string, ttlS = 300): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = enc.encode(JSON.stringify({ v: value, exp: Date.now() + ttlS * 1000 }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), data));
  return `${b64url(iv)}.${b64url(ct)}`;
}

export async function decryptSecret(env: Env, value: string): Promise<string | null> {
  const [iv, ct] = value.split(".");
  if (!iv || !ct) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv) }, await aesKey(env), fromB64url(ct));
    const data = JSON.parse(new TextDecoder().decode(plain));
    return typeof data.exp === "number" && data.exp > Date.now() && typeof data.v === "string" ? data.v : null;
  } catch {
    return null;
  }
}

export async function unseal<T = Record<string, unknown>>(env: Env, value: unknown): Promise<T | null> {
  if (typeof value !== "string") return null;
  const [body, sig] = value.split(".");
  if (!body || !sig) return null;
  const expected = await hmac(env, body);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return typeof data.exp === "number" && data.exp > Date.now() ? (data as T) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Réponses
// ---------------------------------------------------------------------------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id",
};

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...headers },
  });
}

const oauthError = (error: string, description: string, status = 400) => jsonResponse({ error, error_description: description }, status);

export const resourceUrl = (origin: string) => `${origin}/mcp`;
export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource/mcp`;

function authServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [MCP_SCOPE],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/`,
  };
}

function protectedResourceMetadata(origin: string) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Gestia",
    resource_documentation: `${origin}/`,
  };
}

// ---------------------------------------------------------------------------
// Point d'entrée : renvoie null si la route n'est pas celle du connecteur.
// ---------------------------------------------------------------------------

export function isConnectorPath(p: string): boolean {
  return p === "/mcp" || p.startsWith("/mcp/") || p.startsWith("/oauth/") || p.startsWith("/.well-known/oauth-") || p === "/.well-known/openid-configuration";
}

export async function handleConnector(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (!isConnectorPath(p)) return null;
  const origin = url.origin;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "access-control-max-age": "86400" } });
  if (p === "/mcp" || p === "/mcp/") return handleMcp(req, env);
  if (p.startsWith("/.well-known/oauth-protected-resource")) return jsonResponse(protectedResourceMetadata(origin), 200, { "cache-control": "public, max-age=3600" });
  if (p.startsWith("/.well-known/oauth-authorization-server") || p === "/.well-known/openid-configuration") {
    return jsonResponse(authServerMetadata(origin), 200, { "cache-control": "public, max-age=3600" });
  }
  if (p === "/oauth/register" && req.method === "POST") return handleRegister(req, env);
  if (p === "/oauth/authorize" && req.method === "GET") return handleAuthorizeGet(req, env);
  if (p === "/oauth/authorize" && req.method === "POST") return handleAuthorizePost(req, env);
  if (p === "/oauth/token" && req.method === "POST") return handleToken(req, env);
  if (p === "/oauth/revoke" && req.method === "POST") return handleRevoke(req, env);
  return jsonResponse({ error: "route inconnue" }, 404);
}

// ---------------------------------------------------------------------------
// Enregistrement dynamique (RFC 7591)
// ---------------------------------------------------------------------------

interface ClientRow { id: string; name: string; redirect_uris: string; secret_hash: string | null }

/** Adresse de retour acceptable : https, http local, ou schéma propre à une application. */
export function validRedirectUri(v: unknown): boolean {
  if (typeof v !== "string" || v.length > 500) return false;
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  return !["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"].includes(u.protocol);
}

async function handleRegister(req: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return oauthError("invalid_client_metadata", "corps JSON invalide"); }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(validRedirectUri)) {
    return oauthError("invalid_redirect_uri", "redirect_uris : une à dix adresses https (ou http://localhost)");
  }
  const grants = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code"];
  if (!grants.every((g) => g === "authorization_code" || g === "refresh_token")) return oauthError("invalid_client_metadata", "grant_types acceptés : authorization_code, refresh_token");
  const responses = Array.isArray(body.response_types) ? body.response_types : ["code"];
  if (!responses.every((r) => r === "code")) return oauthError("invalid_client_metadata", "response_types accepté : code");
  const method = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "client_secret_basic";
  if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) return oauthError("invalid_client_metadata", "token_endpoint_auth_method non pris en charge");
  const name = (typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim() : "Application").slice(0, 80);

  const ip = `oauth:${req.headers.get("cf-connecting-ip") ?? "local"}`;
  const day = nowIso().slice(0, 10);
  const limit = await env.DB.prepare(`SELECT count FROM signup_limits WHERE ip = ? AND day = ?`).bind(ip, day).first<{ count: number }>();
  if ((limit?.count ?? 0) >= MAX_REGISTRATIONS_PER_IP) return oauthError("invalid_client_metadata", "trop d'enregistrements depuis cette connexion aujourd'hui", 429);

  const id = `gcl_${randomToken(16)}`;
  const clientSecret = method === "none" ? null : `gcs_${randomToken(32)}`;
  const issued = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO oauth_clients (id, name, redirect_uris, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(id, name, JSON.stringify(uris), clientSecret ? await sha256(clientSecret) : null, nowIso()),
    env.DB.prepare(`INSERT INTO signup_limits (ip, day, count) VALUES (?, ?, 1) ON CONFLICT(ip, day) DO UPDATE SET count = count + 1`).bind(ip, day),
  ]);
  return jsonResponse({
    client_id: id,
    client_id_issued_at: issued,
    ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
    client_name: name,
    redirect_uris: uris,
    grant_types: grants,
    response_types: ["code"],
    token_endpoint_auth_method: method,
    scope: MCP_SCOPE,
  }, 201);
}

async function getClient(env: Env, id: unknown): Promise<ClientRow | null> {
  if (typeof id !== "string" || id.length > 100) return null;
  return env.DB.prepare(`SELECT id, name, redirect_uris, secret_hash FROM oauth_clients WHERE id = ?`).bind(id).first<ClientRow>();
}

// ---------------------------------------------------------------------------
// Autorisation : connexion puis consentement
// ---------------------------------------------------------------------------

interface AuthRequest {
  client_id: string;
  redirect_uri: string;
  challenge: string;
  state: string;
  scope: string;
  dev: string;
}

interface Consent extends AuthRequest {
  uid: string;
  cid: string;
  role: string;
  name: string;
  email: string;
  company: string;
}

function redirectWith(uri: string, params: Record<string, string>): Response {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
}

async function handleAuthorizeGet(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams;
  const client = await getClient(env, q.get("client_id"));
  if (!client) return errorPage("Application inconnue", "Cette application n'est pas enregistrée auprès de Gestia. Recommencez l'ajout du connecteur depuis l'application.", 400);
  const redirect = q.get("redirect_uri") ?? "";
  const allowed: string[] = JSON.parse(client.redirect_uris);
  const redirectUri = redirect || (allowed.length === 1 ? allowed[0] : "");
  if (!allowed.includes(redirectUri)) return errorPage("Adresse de retour refusée", "L'adresse de retour demandée ne correspond pas à celle de l'application. Par sécurité, la connexion est arrêtée.", 400);
  const state = q.get("state") ?? "";
  const fail = (error: string, description: string) => redirectWith(redirectUri, { error, error_description: description, state, iss: url.origin });
  if (q.get("response_type") !== "code") return fail("unsupported_response_type", "response_type=code attendu");
  const challenge = q.get("code_challenge") ?? "";
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return fail("invalid_request", "PKCE S256 obligatoire");
  const resource = q.get("resource");
  if (resource && ![resourceUrl(url.origin), `${url.origin}`, `${url.origin}/`, `${resourceUrl(url.origin)}/`].includes(resource)) return fail("invalid_target", "ressource inconnue");
  const ctx: AuthRequest = { client_id: client.id, redirect_uri: redirectUri, challenge, state: state.slice(0, 500), scope: MCP_SCOPE, dev: `mcp-${randomToken(12)}` };
  return loginPage(client.name, await seal(env, { ...ctx }), {});
}

const field = (form: FormData, k: string) => String(form.get(k) ?? "");

async function handleAuthorizePost(req: Request, env: Env): Promise<Response> {
  const origin = new URL(req.url).origin;
  let form: FormData;
  try { form = await req.formData(); } catch { return errorPage("Demande invalide", "Le formulaire est incomplet. Recommencez depuis l'application.", 400); }
  const step = field(form, "step");

  if (step === "login") {
    const ctx = await unseal<AuthRequest>(env, field(form, "ctx"));
    if (!ctx) return errorPage("Demande expirée", "Le délai de connexion est dépassé. Recommencez l'ajout du connecteur depuis l'application.", 400);
    const client = await getClient(env, ctx.client_id);
    if (!client) return errorPage("Application inconnue", "Cette application n'est plus enregistrée auprès de Gestia.", 400);
    const email = field(form, "email").trim();
    const sealedPw = field(form, "pw");
    const password = sealedPw ? (await decryptSecret(env, sealedPw)) : field(form, "password");
    if (password === null) return loginPage(client.name, field(form, "ctx"), { email, error: "Le délai est dépassé. Saisissez à nouveau votre mot de passe." });
    const otp = field(form, "otp").trim();
    const sealedCtx = field(form, "ctx");
    // La vraie connexion Gestia : mot de passe, blocage après échecs, double authentification.
    const res = await worker.fetch(new Request(`${origin}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": req.headers.get("cf-connecting-ip") ?? "local" },
      body: JSON.stringify({ email, password, deviceId: ctx.dev, ...(otp ? { otp } : {}) }),
    }), env);
    const data = (await res.json().catch(() => ({}))) as {
      error?: string; otpRequired?: boolean; user?: { id: string; name: string; email: string; role: string; mustChangePassword?: boolean }; company?: { id: string; name: string };
    };
    if (!res.ok) {
      if (data.otpRequired) {
        return otpPage(client.name, sealedCtx, email, await encryptSecret(env, password), otp ? sentence(data.error ?? "code incorrect") : "");
      }
      return loginPage(client.name, sealedCtx, { email, error: sentence(data.error ?? "connexion impossible") });
    }
    const user = data.user!;
    // Pas d'accès tant que l'utilisateur n'a pas donné son accord : le pseudo-appareil reste révoqué.
    await env.DB.prepare(`UPDATE devices SET revoked = 1 WHERE id = ? AND user_id = ?`).bind(ctx.dev, user.id).run();
    if (user.mustChangePassword) {
      return errorPage("Mot de passe provisoire", "Votre mot de passe est provisoire. Ouvrez d'abord Gestia pour le changer, puis recommencez la connexion du connecteur.", 403);
    }
    const consent: Consent = { ...ctx, uid: user.id, cid: data.company!.id, role: user.role, name: user.name, email: user.email, company: data.company!.name };
    return consentPage(client.name, ctx.redirect_uri, consent, await seal(env, { ...consent }, 10 * 60));
  }

  if (step === "consent") {
    const c = await unseal<Consent>(env, field(form, "auth"));
    if (!c?.uid) return errorPage("Demande expirée", "Le délai pour donner votre accord est dépassé. Recommencez l'ajout du connecteur depuis l'application.", 400);
    const already = await env.DB.prepare(`SELECT 1 AS x FROM oauth_grants WHERE device_id = ?`).bind(c.dev).first();
    if (already) return errorPage("Demande déjà traitée", "Cette autorisation a déjà été donnée. Retournez dans l'application.", 400);
    if (field(form, "decision") !== "allow") {
      await env.DB.prepare(`DELETE FROM devices WHERE id = ? AND user_id = ?`).bind(c.dev, c.uid).run();
      return redirectWith(c.redirect_uri, { error: "access_denied", error_description: "accès refusé par l'utilisateur", state: c.state, iss: origin });
    }
    const grantId = randomToken(12);
    const code = randomToken(32);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO oauth_grants (id, client_id, company_id, user_id, device_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(grantId, c.client_id, c.cid, c.uid, c.dev, c.scope, nowIso()),
      env.DB.prepare(`UPDATE devices SET revoked = 0, last_seen = ? WHERE id = ? AND user_id = ?`).bind(nowIso(), c.dev, c.uid),
      env.DB.prepare(`INSERT INTO oauth_codes (hash, grant_id, client_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(await sha256(code), grantId, c.client_id, c.redirect_uri, c.challenge, inSeconds(CODE_TTL_S)),
      env.DB.prepare(`DELETE FROM oauth_codes WHERE expires_at < ?`).bind(inSeconds(-3600)),
    ]);
    return redirectWith(c.redirect_uri, { code, state: c.state, iss: origin });
  }
  return errorPage("Demande invalide", "Recommencez l'ajout du connecteur depuis l'application.", 400);
}

// ---------------------------------------------------------------------------
// Jetons
// ---------------------------------------------------------------------------

async function readParams(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const b = (await req.json()) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, String(v ?? "")]));
    }
    return Object.fromEntries(new URLSearchParams(await req.text()));
  } catch {
    return {};
  }
}

/** Authentification du client au point de jeton : secret (Basic ou corps) s'il en a un, sinon client public. */
async function authenticateClient(req: Request, env: Env, params: Record<string, string>): Promise<ClientRow | Response> {
  let id = params.client_id ?? "";
  let pass = params.client_secret ?? "";
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    try {
      const [u, s] = atob(header.slice(6)).split(":");
      id = decodeURIComponent(u);
      pass = decodeURIComponent(s ?? "");
    } catch { return oauthError("invalid_client", "authentification du client invalide", 401); }
  }
  const client = await getClient(env, id);
  if (!client) return oauthError("invalid_client", "client inconnu", 401);
  if (client.secret_hash && (!pass || (await sha256(pass)) !== client.secret_hash)) return oauthError("invalid_client", "secret du client incorrect", 401);
  return client;
}

/** Retire une connexion : jetons et codes effacés, pseudo-appareil révoqué. */
export async function revokeGrant(env: Env, grantId: string): Promise<void> {
  const g = await env.DB.prepare(`SELECT device_id FROM oauth_grants WHERE id = ?`).bind(grantId).first<{ device_id: string }>();
  if (!g) return;
  await env.DB.batch([
    env.DB.prepare(`UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`).bind(nowIso(), grantId),
    env.DB.prepare(`DELETE FROM oauth_tokens WHERE grant_id = ?`).bind(grantId),
    env.DB.prepare(`DELETE FROM oauth_codes WHERE grant_id = ?`).bind(grantId),
    env.DB.prepare(`UPDATE devices SET revoked = 1 WHERE id = ?`).bind(g.device_id),
  ]);
}

async function issueTokens(env: Env, grantId: string, scope: string): Promise<Response> {
  const access = `gma_${randomToken(32)}`;
  const refresh = `gmr_${randomToken(32)}`;
  const at = nowIso();
  await env.DB.batch([
    // Ménage : jetons expirés, et jetons échangés depuis plus de 7 jours (gardés avant pour repérer un rejeu).
    env.DB.prepare(`DELETE FROM oauth_tokens WHERE grant_id = ? AND (expires_at < ? OR used_at < ?)`).bind(grantId, at, inSeconds(-7 * 86400)),
    env.DB.prepare(`INSERT INTO oauth_tokens (hash, grant_id, kind, expires_at, created_at) VALUES (?, ?, 'access', ?, ?)`).bind(await sha256(access), grantId, inSeconds(ACCESS_TTL_S), at),
    env.DB.prepare(`INSERT INTO oauth_tokens (hash, grant_id, kind, expires_at, created_at) VALUES (?, ?, 'refresh', ?, ?)`).bind(await sha256(refresh), grantId, inSeconds(REFRESH_TTL_S), at),
  ]);
  return jsonResponse({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope }, 200, { pragma: "no-cache" });
}

async function liveGrant(env: Env, grantId: string, clientId: string) {
  return env.DB.prepare(
    `SELECT g.id, g.scope, g.revoked_at, u.active, d.revoked AS drev FROM oauth_grants g
     JOIN users u ON u.id = g.user_id LEFT JOIN devices d ON d.id = g.device_id
     WHERE g.id = ? AND g.client_id = ?`,
  ).bind(grantId, clientId).first<{ id: string; scope: string; revoked_at: string | null; active: number; drev: number | null }>();
}

async function handleToken(req: Request, env: Env): Promise<Response> {
  const params = await readParams(req);
  const client = await authenticateClient(req, env, params);
  if (client instanceof Response) return client;
  const at = nowIso();

  if (params.grant_type === "authorization_code") {
    const code = params.code ?? "";
    const verifier = params.code_verifier ?? "";
    if (!code || !verifier) return oauthError("invalid_request", "code et code_verifier obligatoires");
    const hash = await sha256(code);
    // Usage unique, de façon atomique : le premier échange gagne.
    const { results } = await env.DB.prepare(
      `UPDATE oauth_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL RETURNING grant_id, client_id, redirect_uri, code_challenge, expires_at`,
    ).bind(at, hash).all<{ grant_id: string; client_id: string; redirect_uri: string; code_challenge: string; expires_at: string }>();
    const row = results[0];
    if (!row) {
      // Code rejoué : la connexion obtenue avec ce code est coupée (RFC 6749 §4.1.2).
      const replay = await env.DB.prepare(`SELECT grant_id FROM oauth_codes WHERE hash = ?`).bind(hash).first<{ grant_id: string }>();
      if (replay) await revokeGrant(env, replay.grant_id);
      return oauthError("invalid_grant", "code inconnu ou déjà utilisé");
    }
    if (row.client_id !== client.id) return oauthError("invalid_grant", "code émis pour une autre application");
    if (row.expires_at < at) return oauthError("invalid_grant", "code expiré");
    if ((params.redirect_uri ?? row.redirect_uri) !== row.redirect_uri) return oauthError("invalid_grant", "adresse de retour différente");
    if (!(await pkceMatches(verifier, row.code_challenge))) return oauthError("invalid_grant", "code_verifier incorrect (PKCE)");
    const grant = await liveGrant(env, row.grant_id, client.id);
    if (!grant || grant.revoked_at || !grant.active || grant.drev) return oauthError("invalid_grant", "connexion retirée");
    return issueTokens(env, grant.id, grant.scope);
  }

  if (params.grant_type === "refresh_token") {
    const token = params.refresh_token ?? "";
    if (!token) return oauthError("invalid_request", "refresh_token obligatoire");
    const hash = await sha256(token);
    const { results } = await env.DB.prepare(
      `UPDATE oauth_tokens SET used_at = ? WHERE hash = ? AND kind = 'refresh' AND used_at IS NULL RETURNING grant_id, expires_at`,
    ).bind(at, hash).all<{ grant_id: string; expires_at: string }>();
    const row = results[0];
    if (!row) {
      // Jeton de rafraîchissement déjà échangé puis présenté à nouveau : vol probable, connexion coupée.
      const reused = await env.DB.prepare(`SELECT grant_id, used_at FROM oauth_tokens WHERE hash = ? AND kind = 'refresh'`).bind(hash).first<{ grant_id: string; used_at: string | null }>();
      // Simple nouvelle tentative réseau du client (moins de 60 s) : on renouvelle sans couper la connexion.
      if (reused?.used_at && Date.parse(at) - Date.parse(reused.used_at) < REFRESH_GRACE_MS) {
        const g = await liveGrant(env, reused.grant_id, client.id);
        if (g && !g.revoked_at && g.active && !g.drev) return issueTokens(env, g.id, g.scope);
      }
      if (reused) await revokeGrant(env, reused.grant_id);
      return oauthError("invalid_grant", "jeton de rafraîchissement inconnu ou déjà utilisé");
    }
    if (row.expires_at < at) return oauthError("invalid_grant", "jeton de rafraîchissement expiré");
    const grant = await liveGrant(env, row.grant_id, client.id);
    if (!grant || grant.revoked_at || !grant.active || grant.drev) return oauthError("invalid_grant", "connexion retirée");
    return issueTokens(env, grant.id, grant.scope);
  }

  return oauthError("unsupported_grant_type", "grant_type : authorization_code ou refresh_token");
}

/** RFC 7009 : toujours 200. Un jeton de rafraîchissement retire toute la connexion. */
async function handleRevoke(req: Request, env: Env): Promise<Response> {
  const params = await readParams(req);
  const client = await authenticateClient(req, env, params);
  if (client instanceof Response) return client;
  const token = params.token ?? "";
  if (token) {
    const row = await env.DB.prepare(
      `SELECT t.grant_id, t.kind FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.hash = ? AND g.client_id = ?`,
    ).bind(await sha256(token), client.id).first<{ grant_id: string; kind: string }>();
    if (row?.kind === "refresh") await revokeGrant(env, row.grant_id);
    else if (row) await env.DB.prepare(`DELETE FROM oauth_tokens WHERE hash = ?`).bind(await sha256(token)).run();
  }
  return jsonResponse({});
}

// ---------------------------------------------------------------------------
// Jeton d'accès présenté à /mcp
// ---------------------------------------------------------------------------

export interface McpCaller {
  grantId: string;
  clientName: string;
  s: Pick<Session, "sub" | "cid" | "role" | "dev">;
  userName: string;
  company: { id: string; name: string; plan: string; status: string; trial_ends_at: string | null; paid_until: string | null };
}

/** Utilisateur et entreprise du jeton, lus à chaque appel (rôle à jour, compte actif, connexion non retirée). */
export async function authenticateBearer(req: Request, env: Env): Promise<McpCaller | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!/^gma_[A-Za-z0-9_-]{30,}$/.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT t.expires_at, g.id AS gid, g.device_id, g.last_used_at, g.revoked_at, g.company_id AS gcid, cl.name AS client_name,
            u.id AS uid, u.name AS uname, u.role, u.active, u.company_id AS ucid, d.revoked AS drev,
            c.name AS cname, c.plan, c.status, c.trial_ends_at, c.paid_until
     FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
     JOIN users u ON u.id = g.user_id JOIN companies c ON c.id = g.company_id
     LEFT JOIN devices d ON d.id = g.device_id LEFT JOIN oauth_clients cl ON cl.id = g.client_id
     WHERE t.hash = ? AND t.kind = 'access'`,
  ).bind(await sha256(token)).first<{
    expires_at: string; gid: string; device_id: string; last_used_at: string | null; revoked_at: string | null; gcid: string; client_name: string | null;
    uid: string; uname: string; role: string; active: number; ucid: string; drev: number | null;
    cname: string; plan: string; status: string; trial_ends_at: string | null; paid_until: string | null;
  }>();
  if (!row || row.expires_at < nowIso() || row.revoked_at || !row.active || row.drev !== 0 || row.ucid !== row.gcid) return null;
  // « Dernier usage » réécrit au plus toutes les 5 minutes, pour économiser les écritures.
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 300_000) {
    await env.DB.prepare(`UPDATE oauth_grants SET last_used_at = ? WHERE id = ?`).bind(nowIso(), row.gid).run();
  }
  return {
    grantId: row.gid,
    clientName: row.client_name ?? "Application",
    s: { sub: row.uid, cid: row.gcid, role: row.role, dev: row.device_id },
    userName: row.uname,
    company: { id: row.gcid, name: row.cname, plan: row.plan, status: row.status, trial_ends_at: row.trial_ends_at, paid_until: row.paid_until },
  };
}

// ---------------------------------------------------------------------------
// Réglages › Connexions (session de l'application)
// ---------------------------------------------------------------------------

/** GET /api/connections : ses connexions (tout le monde) ; toutes celles de l'entreprise (administrateur). POST /api/connections/revoke {id}. */
export async function handleConnections(req: Request, env: Env, s: Session, action: string): Promise<Response> {
  const admin = s.role === "admin";
  if (action === "" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT g.id, g.created_at, g.last_used_at, g.user_id, u.name AS user_name, COALESCE(cl.name, 'Application') AS client_name
       FROM oauth_grants g JOIN users u ON u.id = g.user_id LEFT JOIN oauth_clients cl ON cl.id = g.client_id
       WHERE g.company_id = ? AND g.revoked_at IS NULL AND (? = 1 OR g.user_id = ?) ORDER BY g.created_at DESC`,
    ).bind(s.cid, admin ? 1 : 0, s.sub).all<{ id: string; created_at: string; last_used_at: string | null; user_id: string; user_name: string; client_name: string }>();
    return jsonResponse({ connections: results.map(({ user_id, ...c }) => ({ ...c, mine: user_id === s.sub })), all: admin });
  }
  if (action === "revoke" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { id?: unknown };
    const id = typeof body.id === "string" ? body.id : "";
    const g = await env.DB.prepare(`SELECT id, user_id FROM oauth_grants WHERE id = ? AND company_id = ?`).bind(id, s.cid).first<{ id: string; user_id: string }>();
    if (!g || (!admin && g.user_id !== s.sub)) return jsonResponse({ error: "connexion introuvable" }, 404);
    await revokeGrant(env, g.id);
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "route inconnue" }, 404);
}

// ---------------------------------------------------------------------------
// Pages (connexion, double authentification, consentement), au design Gestia
// ---------------------------------------------------------------------------

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrateur", director: "Directeur", accountant: "Comptable", sales: "Commercial", project_manager: "Chef de projet", employee: "Employé",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const sentence = (m: string) => {
  const t = m.trim();
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}`;
};

/** Jetons de src/web/styles.css (fond blanc, bleu Gestia pour l'action, Montserrat et Manrope). */
const CSS = `
:root{--ink:#101D36;--ink-2:#3B4760;--ink-3:#5B6579;--line:#E6E9EF;--input-border:#A3ACBB;--hover:#F4F6F9;--subtle:#F8F9FB;
--accent:#0255C6;--accent-hover:#0349AB;--accent-press:#04347D;--accent-soft:#EDF3FD;--danger:#B42318;--danger-soft:#FEEFEE;--ok:#08703F;
--ring:0 0 0 3px rgb(2 85 198 / .22);--font:"Manrope",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--font-display:"Montserrat","Manrope",system-ui,sans-serif;color-scheme:light}
*{box-sizing:border-box}
html,body{margin:0;background:#fff;color:var(--ink);font-family:var(--font);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
main{min-height:100vh;display:grid;place-items:center;padding:24px 16px 64px}
.card{width:100%;max-width:440px;display:flex;flex-direction:column;gap:16px;padding:36px 32px;border:1px solid var(--line);border-radius:16px;background:#fff;
box-shadow:0 1px 2px rgb(16 29 54 / .04),0 12px 40px -12px rgb(16 29 54 / .10)}
@media (max-width:480px){.card{padding:8px 0;border:none;box-shadow:none}}
.logo{height:36px;width:auto;align-self:flex-start}
h1{font-family:var(--font-display);font-size:1.375rem;font-weight:700;letter-spacing:-.015em;margin:8px 0 0;line-height:1.3}
p{margin:0}
.muted{color:var(--ink-3)}.small{font-size:.8125rem}
label{display:flex;flex-direction:column;gap:6px;font-size:.8125rem;font-weight:600;color:var(--ink-2)}
input{font:inherit;font-size:.9375rem;color:inherit;width:100%;min-height:40px;padding:8px 11px;border:1px solid var(--input-border);border-radius:8px;background:#fff;font-weight:400}
input:focus-visible,button:focus-visible{outline:none;box-shadow:var(--ring);border-color:var(--accent)}
button{font:inherit;min-height:44px;padding:0 16px;border-radius:8px;border:1px solid var(--line);background:#fff;color:var(--ink);font-weight:600;font-size:.9375rem;cursor:pointer}
button:hover{background:var(--hover)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
button.primary:active{background:var(--accent-press)}
.actions{display:flex;gap:12px}.actions button{flex:1}
.error{color:var(--danger);background:var(--danger-soft);border-radius:8px;padding:10px 12px;font-weight:500;margin:0}
.who{display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:10px;background:var(--subtle);border:1px solid var(--line)}
.avatar{flex:none;width:36px;height:36px;border-radius:50%;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center;font-weight:700;font-family:var(--font-display)}
.who b{display:block}
h2{font-family:var(--font-display);font-size:.875rem;font-weight:600;margin:4px 0 -6px;color:var(--ink)}
ul.rights{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
ul.rights li{display:flex;gap:10px;align-items:flex-start;color:var(--ink-2)}
ul.rights li::before{content:"";flex:none;width:18px;height:18px;margin-top:1px;border-radius:50%;background:var(--accent-soft) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%230255C6' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m5 12 5 5 9-10'/%3E%3C/svg%3E") no-repeat center}
ul.rights.no li::before{background:var(--danger-soft) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23B42318' stroke-width='3.5' stroke-linecap='round'%3E%3Cpath d='M6 6l12 12M18 6 6 18'/%3E%3C/svg%3E") no-repeat center}
.note{border-top:1px solid var(--line);padding-top:14px}
footer{position:fixed;bottom:16px;left:0;right:0;text-align:center;color:var(--ink-3);font-size:.75rem}
`;

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · Gestia</title>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Montserrat:wght@600;700&display=swap">
<style>${CSS}</style></head><body><main>${body}</main><footer>Gestia · IDO, Libreville</footer></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'; default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'none'",
      "referrer-policy": "no-referrer",
    },
  });
}

const LOGO = `<img class="logo" src="/brand/gestia-logo-sans-slogan.png" alt="Gestia" width="147" height="36">`;

function loginPage(client: string, ctx: string, o: { email?: string; error?: string }): Response {
  return page("Connexion", `<form class="card" method="post" action="/oauth/authorize" autocomplete="on">
${LOGO}
<h1>Connecter ${esc(client)} à Gestia</h1>
<p class="muted">Connectez-vous avec votre compte Gestia. Vous verrez ensuite exactement ce que ${esc(client)} pourra faire, avant de donner votre accord.</p>
<input type="hidden" name="step" value="login"><input type="hidden" name="ctx" value="${esc(ctx)}">
<label>E-mail<input name="email" type="email" required autocomplete="username" value="${esc(o.email ?? "")}" ${o.email ? "" : "autofocus"}></label>
<label>Mot de passe<input name="password" type="password" required autocomplete="current-password" ${o.email ? "autofocus" : ""}></label>
${o.error ? `<p class="error" role="alert">${esc(o.error)}</p>` : ""}
<button class="primary">Se connecter</button>
<p class="muted small note">Rien n'est autorisé tant que vous n'avez pas confirmé à l'étape suivante. Vous pourrez retirer l'accès à tout moment dans Réglages › Connexions.</p>
</form>`, o.error ? 401 : 200);
}

function otpPage(client: string, ctx: string, email: string, sealedPw: string, error: string): Response {
  return page("Vérification en deux étapes", `<form class="card" method="post" action="/oauth/authorize" autocomplete="off">
${LOGO}
<h1>Vérification en deux étapes</h1>
<p class="muted">Saisissez le code à 6 chiffres affiché par votre application d'authentification pour ${esc(email)}, ou un de vos codes de secours.</p>
<input type="hidden" name="step" value="login"><input type="hidden" name="ctx" value="${esc(ctx)}">
<input type="hidden" name="email" value="${esc(email)}"><input type="hidden" name="pw" value="${esc(sealedPw)}">
<label>Code de vérification<input name="otp" required autofocus inputmode="numeric" autocomplete="one-time-code" maxlength="12" placeholder="123 456"></label>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<button class="primary">Vérifier</button>
<p class="muted small note">Connexion demandée par ${esc(client)}.</p>
</form>`, error ? 401 : 200);
}

function consentPage(client: string, redirectUri: string, c: Consent, sealed: string): Response {
  const initials = c.name.trim().split(/\s+/).filter(Boolean).map((w) => w[0]).filter(Boolean);
  const avatar = ((initials[0] ?? "") + (initials.length > 1 ? initials[initials.length - 1] : "")).toUpperCase() || "?";
  let host = redirectUri;
  try { host = new URL(redirectUri).host || redirectUri; } catch { /* adresse déjà validée */ }
  return page("Autoriser l'accès", `<form class="card" method="post" action="/oauth/authorize">
${LOGO}
<h1>Autoriser ${esc(client)} à accéder à Gestia&nbsp;?</h1>
<div class="who"><span class="avatar" aria-hidden="true">${esc(avatar)}</span><span><b>${esc(c.name)}</b><span class="muted small">${esc(c.company)} · ${esc(ROLE_LABELS[c.role] ?? c.role)} · ${esc(c.email)}</span></span></div>
<h2>${esc(client)} pourra, en votre nom&nbsp;:</h2>
<ul class="rights">
<li>consulter les projets, leurs étapes, leurs tâches et l'annuaire de l'équipe ;</li>
<li>créer et modifier des tâches : statut, échéance, personne, priorité, blocage ;</li>
<li>saisir du temps passé sur les tâches.</li>
</ul>
<h2>Il ne pourra pas&nbsp;:</h2>
<ul class="rights no">
<li>supprimer quoi que ce soit ;</li>
<li>voir les montants : budgets, coûts, factures ;</li>
<li>faire plus que ce que votre rôle permet dans Gestia.</li>
</ul>
<p class="muted small">Les modifications apparaîtront dans Gestia à votre nom. Vous serez ensuite renvoyé vers ${esc(host)}.</p>
<input type="hidden" name="step" value="consent"><input type="hidden" name="auth" value="${esc(sealed)}">
<div class="actions"><button name="decision" value="deny">Refuser</button><button class="primary" name="decision" value="allow" autofocus>Autoriser</button></div>
<p class="muted small note">Vous pouvez retirer cet accès à tout moment dans Gestia, Réglages › Connexions.</p>
</form>`);
}

function errorPage(title: string, message: string, status: number): Response {
  return page(title, `<div class="card">${LOGO}<h1>${esc(title)}</h1><p class="muted">${esc(message)}</p></div>`, status);
}
