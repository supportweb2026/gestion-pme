import test from "node:test";
import assert from "node:assert/strict";
import { base32Decode, base32Encode, hashRecoveryCode, hotp, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from "../src/shared/totp.ts";

// Vecteurs de la RFC 6238 (SHA-1, secret « 12345678901234567890 »), sur 6 chiffres.
const RFC = base32Encode(new TextEncoder().encode("12345678901234567890"));

test("totp : vecteurs de test de la RFC 6238", async () => {
  assert.equal(await hotp(RFC, Math.floor(59 / 30)), "287082");
  assert.equal(await hotp(RFC, Math.floor(1111111109 / 30)), "081804");
  assert.equal(await hotp(RFC, Math.floor(1234567890 / 30)), "005924");
  assert.equal(await hotp(RFC, Math.floor(2000000000 / 30)), "279037");
});

test("totp : base32 aller-retour, secret de 160 bits", () => {
  const s = newTotpSecret();
  assert.equal(s.length, 32);
  assert.deepEqual([...base32Decode(base32Encode(new Uint8Array([1, 2, 3, 250])))], [1, 2, 3, 250]);
});

test("totp : tolérance d'un pas, code à usage unique, format", async () => {
  const t = 1234567890 * 1000;
  const step = Math.floor(1234567890 / 30);
  assert.equal(await verifyTotp(RFC, "005924", t), step);
  assert.equal(await verifyTotp(RFC, "005 924", t + 30_000), step, "pas précédent accepté");
  assert.equal(await verifyTotp(RFC, "005924", t, step), null, "déjà utilisé");
  assert.equal(await verifyTotp(RFC, "005924", t + 120_000), null, "trop ancien");
  assert.equal(await verifyTotp(RFC, "12345", t), null);
  assert.match(otpauthUri(RFC, "dnt@ido.ga"), /^otpauth:\/\/totp\/Gestia:dnt%40ido\.ga\?secret=/);
});

test("totp : codes de secours uniques, empreinte insensible à la casse et aux tirets", async () => {
  const codes = newRecoveryCodes();
  assert.equal(new Set(codes).size, 8);
  assert.match(codes[0], /^[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.equal(await hashRecoveryCode("ABCD-efgh"), await hashRecoveryCode("abcdefgh"));
});
