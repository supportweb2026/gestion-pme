/**
 * Mots de passe (PBKDF2-SHA256) et jetons de session (JWT HS256),
 * avec l'API Web Crypto native du Worker : aucune dépendance, aucun service payant.
 */

const enc = new TextEncoder();

/**
 * Nombre d'itérations PBKDF2. Le plan gratuit limite le temps de calcul par
 * requête : 50 000 itérations restent sous cette limite tout en ralentissant
 * fortement une attaque par force brute. Le hash stocke son nombre
 * d'itérations, on peut donc l'augmenter plus tard sans casser les comptes.
 */
const PBKDF2_ITERATIONS = 50_000;

/** Durée d'une session : 7 jours de travail hors ligne au maximum. */
export const SESSION_SECONDS = 7 * 24 * 3600;

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  const computed = await pbkdf2(password, fromB64url(salt), Number(iter));
  return timingSafeEqual(computed, fromB64url(hash));
}

export interface Session {
  sub: string;      // utilisateur
  cid: string;      // entreprise
  role: string;
  dev: string;      // appareil
  exp: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signToken(payload: Omit<Session, "exp">, secret: string): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyToken(token: string, secret: string): Promise<Session | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(`${header}.${body}`));
  if (!ok) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Session;
    if (typeof session.exp !== "number" || session.exp < Date.now() / 1000) return null;
    return session;
  } catch {
    return null;
  }
}
