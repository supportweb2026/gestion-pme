/**
 * Mise en production : en-têtes de sécurité, sonde de disponibilité, connexion sans
 * fuite d'existence de compte, fichier _headers des fichiers statiques.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import worker from "../src/worker/index.ts";
import { createLocalD1 } from "../dev/d1-local.ts";

const env = { DB: createLocalD1(":memory:", join(import.meta.dirname, "..", "migrations")), FILES: createLocalD1(":memory:"), JWT_SECRET: "test-secret-0123456789-0123456789-abc" };
const req = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`http://local${path}`, init), env);

test("toutes les réponses du Worker portent les en-têtes de sécurité (succès, erreur, 404)", async () => {
  for (const res of [await req("/api/health"), await req("/api/inconnue"), await req("/api/sync", { method: "POST", body: "{}" })]) {
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("strict-transport-security") ?? "", /max-age=31536000/);
    assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  }
});

test("une page qui a sa propre CSP la garde (pages OAuth), et les en-têtes CORS du connecteur restent", async () => {
  const meta = await req("/.well-known/oauth-authorization-server");
  assert.equal(meta.status, 200);
  assert.equal(meta.headers.get("access-control-allow-origin"), "*");
  assert.equal(meta.headers.get("x-content-type-options"), "nosniff");
  const page = await req("/oauth/authorize?client_id=inconnu");
  assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'none'/);
});

test("sonde /api/health : vérifie la base, 503 si elle ne répond pas", async () => {
  const ok = await req("/api/health");
  assert.equal(ok.status, 200);
  assert.deepEqual({ ...(await ok.json()) as object, time: 0 }, { ok: true, db: true, time: 0 });
  const broken = { ...env, DB: { prepare: () => ({ first: () => Promise.reject(new Error("D1 indisponible")) }) } };
  const down = await worker.fetch(new Request("http://local/api/health"), broken as never);
  assert.equal(down.status, 503);
  assert.equal(((await down.json()) as { db: boolean }).db, false);
});

test("connexion : e-mail inconnu et mauvais mot de passe donnent la même réponse", async () => {
  const signup = await req("/api/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company: "Prod SA", name: "Admin", email: "admin@prod.ga", password: "motdepasse1", deviceId: "device-prod-0001" }) });
  assert.equal(signup.status, 201);
  const login = (email: string) => req("/api/login", { method: "POST", body: JSON.stringify({ email, password: "mauvais-mdp-1", deviceId: "device-prod-0002" }) });
  const unknown = await login("personne@prod.ga");
  const wrong = await login("admin@prod.ga");
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(await unknown.json(), await wrong.json());
});

test("fichier _headers : CSP, HSTS, anti-cadre et cache long des fichiers à empreinte", () => {
  const h = readFileSync(join(import.meta.dirname, "..", "src", "web", "public", "_headers"), "utf8");
  assert.match(h, /^\/\*$/m);
  assert.match(h, /Content-Security-Policy: default-src 'self'; script-src 'self';/);
  assert.match(h, /frame-ancestors 'none'/);
  assert.match(h, /object-src 'none'/);
  assert.match(h, /Strict-Transport-Security: max-age=31536000/);
  assert.match(h, /X-Frame-Options: DENY/);
  assert.match(h, /^\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/m);
  // La page de l'application ne charge aucun script hors de son origine.
  assert.doesNotMatch(h, /script-src[^;]*(unsafe-inline|unsafe-eval|https:)/);
});

test("/api/errors : limité à 200 rapports par jour et par adresse IP", async () => {
  const send = () => req("/api/errors", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify({ message: "boom" }) });
  for (let i = 0; i < 200; i++) assert.equal((await send()).status, 201);
  assert.equal((await send()).status, 429);
  const other = await req("/api/errors", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" }, body: JSON.stringify({ message: "boom" }) });
  assert.equal(other.status, 201);
});
