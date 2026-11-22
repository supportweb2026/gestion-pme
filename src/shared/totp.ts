/**
 * Double authentification par code temporaire (TOTP, RFC 6238) : compatible avec
 * Google Authenticator, Microsoft Authenticator, Authy… Code à 6 chiffres, pas de 30 s,
 * HMAC-SHA1. Fonctionne sur le serveur (Workers) comme dans les tests (WebCrypto).
 */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("secret invalide");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Nouveau secret aléatoire de 160 bits (32 caractères base32). */
export function newTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

/** Code HOTP (RFC 4226) pour un compteur donné. */
export async function hotp(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export const totpStep = (ms = Date.now()) => Math.floor(ms / 1000 / TOTP_STEP);

/**
 * Vérifie un code (tolérance d'un pas avant et après, pour le décalage d'horloge du téléphone).
 * Renvoie le pas accepté, ou null. Un pas déjà utilisé (`lastStep`) est refusé : un code ne sert qu'une fois.
 */
export async function verifyTotp(secret: string, code: string, ms = Date.now(), lastStep = 0): Promise<number | null> {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const now = totpStep(ms);
  for (const step of [now, now - 1, now + 1]) {
    if (step <= lastStep) continue;
    if ((await hotp(secret, step)) === c) return step;
  }
  return null;
}

/** Lien d'inscription lu par les applications (QR code). */
export function otpauthUri(secret: string, account: string, issuer = "Gestia"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP}`;
}

/** Codes de secours : 8 codes « xxxx-xxxx », à usage unique, montrés une seule fois. */
export function newRecoveryCodes(n = 8): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: n }, () => {
    const r = crypto.getRandomValues(new Uint8Array(8));
    const s = [...r].map((b) => alphabet[b % alphabet.length]).join("");
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

export async function hashRecoveryCode(code: string): Promise<string> {
  const norm = code.toLowerCase().replace(/[^a-z0-9]/g, "");
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(norm)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}
