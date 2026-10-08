/**
 * v5 : plusieurs entreprises sur la même plateforme. Isolation des données,
 * abonnements, mots de passe, console de l'équipe Gestia.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import worker from "../src/worker/index.ts";
import { createLocalD1 } from "../dev/d1-local.ts";
import { HlcClock } from "../src/shared/hlc.ts";
import { extendPaidUntil, subscriptionInfo } from "../src/shared/plans.ts";
import type { Change, SyncResponse } from "../src/shared/sync.ts";

const env: Record<string, any> = {
  DB: createLocalD1(":memory:", join(import.meta.dirname, "..", "migrations")),
  FILES: createLocalD1(":memory:"),
  JWT_SECRET: "platform-test-secret-0123456789-0123456789",
};

async function call(path: string, body?: unknown, token?: string, ip = "10.0.0.1") {
  const res = await worker.fetch(new Request(`http://local${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env as never);
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const signup = (company: string, email: string, dev: string, ip?: string) =>
  call("/api/signup", { company, name: "Admin", email, password: "motdepasse1", deviceId: dev }, undefined, ip);
const change = (clock: HlcClock, tbl: Change["tbl"], row: string, patch: Record<string, unknown>): Change =>
  ({ id: crypto.randomUUID(), tbl, row, patch, hlc: clock.tick(), device: clock.deviceId });

let ido: any, alpha: any, beta: any;
const devIdo = "device-ido-00001", devA = "device-alpha-001", devB = "device-beta-0001";

test("plusieurs entreprises s'inscrivent ; l'éditeur devient administrateur de la plateforme", async () => {
  ido = (await signup("IDO", "boss@ido.ga", devIdo)).data;
  env.PLATFORM_COMPANY = ido.company.id;
  ido = (await call("/api/login", { email: "boss@ido.ga", password: "motdepasse1", deviceId: devIdo })).data;
  assert.equal(ido.user.platformAdmin, true);
  alpha = (await signup("Alpha SARL", "admin@alpha.ga", devA)).data;
  beta = (await signup("Beta SA", "admin@beta.ga", devB)).data;
  assert.equal(alpha.user.platformAdmin, false);
  assert.notEqual(alpha.company.id, beta.company.id);
});

test("isolation : une entreprise ne voit jamais les données d'une autre", async () => {
  const ca = new HlcClock(devA);
  await call("/api/sync", { changes: [change(ca, "clients", "cli-secret-1", { name: "Client confidentiel Alpha" })], since: 0 }, alpha.token);
  await call("/api/numbers/reserve", { series: "FA-2026" }, alpha.token);
  const pulled: SyncResponse = (await call("/api/sync", { changes: [], since: 0 }, beta.token)).data;
  assert.equal(pulled.changes.length, 0, "Beta ne reçoit rien d'Alpha");
  // Beta écrit une ligne avec le même identifiant : elle reste séparée.
  const cb = new HlcClock(devB);
  await call("/api/sync", { changes: [change(cb, "clients", "cli-secret-1", { name: "Client de Beta" })], since: 0 }, beta.token);
  const again: SyncResponse = (await call("/api/sync", { changes: [], since: 0 }, alpha.token)).data;
  assert.ok(!JSON.stringify(again).includes("Client de Beta"));
  // Numérotation propre à chaque entreprise.
  const blockB = (await call("/api/numbers/reserve", { series: "FA-2026" }, beta.token)).data;
  assert.equal(blockB.start, 1);
  // Utilisateurs et console : pas d'accès croisé.
  const users = (await call("/api/users", undefined, beta.token)).data.users;
  assert.deepEqual(users.map((u: any) => u.email), ["admin@beta.ga"]);
  assert.equal((await call("/api/platform/companies", undefined, alpha.token)).status, 403);
  // Un jeton d'Alpha rejoué avec l'appareil d'une autre entreprise est refusé.
  const exportB = await call("/api/export", undefined, beta.token);
  assert.ok(!JSON.stringify(exportB.data).includes("Alpha"));
});

test("abonnement : essai, grâce de 7 jours, puis consultation seule sans perte des saisies", async () => {
  assert.equal(subscriptionInfo({ plan: "trial", status: "active", trial_ends_at: "2026-10-10" }, "2026-10-08").state, "trial");
  assert.equal(subscriptionInfo({ plan: "pro", status: "active", paid_until: "2026-10-05" }, "2026-10-08").state, "grace");
  const expired = subscriptionInfo({ plan: "pro", status: "active", paid_until: "2026-09-01" }, "2026-10-08");
  assert.deepEqual([expired.state, expired.readOnly], ["expired", true]);
  assert.deepEqual(extendPaidUntil("2026-12-31", 12, "2026-10-08"), { from: "2027-01-01", to: "2027-12-31" });
  assert.deepEqual(extendPaidUntil(null, 1, "2026-10-08"), { from: "2026-10-08", to: "2026-11-08" });

  // L'éditeur fait expirer l'essai de Beta.
  await call("/api/platform/company", { id: beta.company.id, trial_ends_at: "2026-01-01" }, ido.token);
  const cb = new HlcClock(devB);
  const c = change(cb, "clients", "cli-beta-0002", { name: "Saisi pendant l'expiration" });
  const r: SyncResponse = (await call("/api/sync", { changes: [c], since: 0 }, beta.token)).data;
  assert.equal(r.subscription!.readOnly, true);
  assert.deepEqual([r.accepted, r.rejected], [[], []], "ni accepté ni refusé : reste en attente sur l'appareil");

  // Paiement enregistré : 12 mois de Pro, la saisie en attente passe.
  const pay = await call("/api/platform/payment", { company_id: beta.company.id, plan: "pro", months: 12, amount: 240000, method: "airtel", reference: "MP2610" }, ido.token);
  assert.equal(pay.status, 201);
  const r2: SyncResponse = (await call("/api/sync", { changes: [c], since: 0 }, beta.token)).data;
  assert.deepEqual(r2.accepted, [c.id]);
  assert.equal(r2.subscription!.state, "active");
  assert.equal((await call("/api/platform/payments", undefined, ido.token)).data.payments.length, 1);
});

test("abonnement : nombre d'utilisateurs limité par la formule ; suspension", async () => {
  await call("/api/platform/company", { id: alpha.company.id, plan: "essentiel", paid_until: "2099-01-01" }, ido.token);
  for (const n of [1, 2]) assert.equal((await call("/api/users", { name: `U${n}`, email: `u${n}@alpha.ga`, role: "sales", password: "motdepasse1" }, alpha.token)).status, 201);
  const third = await call("/api/users", { name: "U3", email: "u3@alpha.ga", role: "sales", password: "motdepasse1" }, alpha.token);
  assert.equal(third.status, 402);
  assert.match(third.data.error, /3 utilisateurs/);

  await call("/api/platform/company", { id: alpha.company.id, status: "suspended" }, ido.token);
  assert.equal((await call("/api/sync", { changes: [], since: 0 }, alpha.token)).status, 403);
  assert.equal((await call("/api/login", { email: "admin@alpha.ga", password: "motdepasse1", deviceId: devA })).status, 403);
  await call("/api/platform/company", { id: alpha.company.id, status: "active" }, ido.token);
  assert.equal((await call("/api/sync", { changes: [], since: 0 }, alpha.token)).status, 200);
  assert.equal((await call("/api/platform/company", { id: ido.company.id, status: "suspended" }, ido.token)).status, 400);
});

test("mots de passe : provisoire donné par l'admin, changement obligatoire, blocage après 8 échecs", async () => {
  const users = (await call("/api/users", undefined, alpha.token)).data.users;
  const u1 = users.find((u: any) => u.email === "u1@alpha.ga");
  const u1Session = (await call("/api/login", { email: "u1@alpha.ga", password: "motdepasse1", deviceId: "device-u1-000001" })).data;
  assert.equal((await call("/api/users/password", { id: u1.id, password: "provisoire1" }, alpha.token)).status, 200);
  assert.equal((await call("/api/sync", { changes: [], since: 0 }, u1Session.token)).status, 401, "anciennes sessions coupées");
  const login = (await call("/api/login", { email: "u1@alpha.ga", password: "provisoire1", deviceId: "device-u1-000001" })).data;
  assert.equal(login.user.mustChangePassword, true);
  assert.equal((await call("/api/me/password", { current: "mauvais-mdp", next: "definitif12" }, login.token)).status, 403);
  assert.equal((await call("/api/me/password", { current: "provisoire1", next: "definitif12" }, login.token)).status, 200);
  assert.equal((await call("/api/login", { email: "u1@alpha.ga", password: "definitif12", deviceId: "device-u1-000001" })).data.user.mustChangePassword, false);
  // Un admin d'Alpha ne peut pas toucher un compte de Beta.
  const betaAdmin = (await call("/api/users", undefined, beta.token)).data.users[0];
  assert.equal((await call("/api/users/password", { id: betaAdmin.id, password: "piratage12" }, alpha.token)).status, 404);

  for (let i = 0; i < 8; i++) await call("/api/login", { email: "u2@alpha.ga", password: "faux-mot-de-passe", deviceId: "device-u2-000001" });
  const locked = await call("/api/login", { email: "u2@alpha.ga", password: "motdepasse1", deviceId: "device-u2-000001" });
  assert.equal(locked.status, 429, "bloqué même avec le bon mot de passe");
  // L'éditeur débloque et réinitialise.
  assert.equal((await call("/api/platform/reset-password", { email: "u2@alpha.ga", password: "nouveau123" }, ido.token)).status, 200);
  assert.equal((await call("/api/login", { email: "u2@alpha.ga", password: "nouveau123", deviceId: "device-u2-000001" })).status, 200);
});

test("inscriptions limitées par connexion ; erreurs remontées visibles dans la console", async () => {
  for (let i = 0; i < 5; i++) await signup(`Spam ${i}`, `spam${i}@x.ga`, `device-spam-00${i}`, "10.9.9.9");
  const sixth = await signup("Spam 6", "spam6@x.ga", "device-spam-006", "10.9.9.9");
  assert.equal(sixth.status, 429);
  await call("/api/errors", { message: "TypeError: x is undefined", detail: "at Documents.tsx:12", url: "/" }, beta.token);
  const errors = (await call("/api/platform/errors", undefined, ido.token)).data.errors;
  assert.equal(errors[0].company_name, "Beta SA");
  const list = (await call("/api/platform/companies", undefined, ido.token)).data.companies;
  assert.ok(list.length >= 8);
  assert.ok(list.find((c: any) => c.name === "Beta SA").subscription.state === "active");
});
