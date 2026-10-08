/**
 * Chiffrement de la base locale (AES-GCM 256 bits, Web Crypto).
 *
 * Une clé de données aléatoire chiffre chaque ligne. Elle est elle-même
 * chiffrée (« enveloppée ») par une clé dérivée du code PIN (PBKDF2,
 * 310 000 itérations). Sans le PIN, la copie locale est illisible, même
 * en récupérant les fichiers du navigateur. Le PIN ne quitte jamais l'appareil.
 */

export interface Sealed {
  iv: Uint8Array;
  ct: ArrayBuffer;
}

export interface LockInfo {
  salt: Uint8Array;
  iv: Uint8Array;
  wrapped: ArrayBuffer;
  iterations: number;
}

const ITERATIONS = 310_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

async function pinKey(pin: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

/** Nouvelle clé de données, enveloppée par le PIN. */
export async function createVault(pin: string): Promise<{ key: CryptoKey; lock: LockInfo }> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey("raw", key, await pinKey(pin, salt, ITERATIONS), { name: "AES-GCM", iv });
  return { key, lock: { salt, iv, wrapped, iterations: ITERATIONS } };
}

/** Retrouve la clé de données ; échoue si le PIN est faux. */
export async function openVault(pin: string, lock: LockInfo): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    "raw",
    lock.wrapped,
    await pinKey(pin, lock.salt, lock.iterations),
    { name: "AES-GCM", iv: lock.iv as BufferSource },
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

export async function sealBytes(key: CryptoKey, bytes: ArrayBuffer): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, ct: await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes) };
}

export async function openBytes(key: CryptoKey, s: Sealed): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: s.iv as BufferSource }, key, s.ct);
}

export async function seal(key: CryptoKey, value: unknown): Promise<Sealed> {
  return sealBytes(key, enc.encode(JSON.stringify(value)).buffer as ArrayBuffer);
}

export async function open<T>(key: CryptoKey, s: Sealed): Promise<T> {
  return JSON.parse(dec.decode(await openBytes(key, s))) as T;
}
