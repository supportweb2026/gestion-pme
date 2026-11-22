/**
 * Recette du lot 8d : API à jetons limités.
 *  - Réglages › Accès par API : création d'un jeton (projets et tâches en écriture, clients en lecture) ;
 *  - appels : création d'un projet et d'une tâche, lecture, refus hors portée, tables protégées fermées ;
 *  - le projet créé par l'API arrive dans l'application ; révocation : le jeton ne marche plus.
 *
 * Prérequis : `npm run build`, Playwright.  node test/e2e/api.mjs
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const root = join(import.meta.dirname, "..", "..");
const PORT = 8812;
const BASE = `http://localhost:${PORT}`;
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-api-"));

const server = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "dev/server.ts"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), DB_PATH: ":memory:" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("localhost") && resolve()));

const browser = await chromium.launch();
const step = (msg) => console.log(`• ${msg}`);
const errors = [];
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "fr-FR", acceptDownloads: true });
const page = await context.newPage();
page.on("dialog", (d) => d.accept());
page.on("pageerror", (e) => errors.push(e.message));
const nav = (label) => page.getByRole("navigation").getByRole("button", { name: label, exact: true }).click();
const pill = () => page.getByTestId("sync-pill");
const waitSynced = async () => {
  await pill().click();
  await pill().filter({ hasText: "À jour" }).waitFor({ timeout: 10_000 });
};
const shot = async (file) => shots && page.screenshot({ path: join(shots, file), fullPage: true });
const kpi = (id) => page.getByTestId(id).locator(".kpi-value");
const expectKpi = async (id, value) => {
  await page.getByTestId(id).locator(".kpi-value").filter({ hasText: new RegExp(`^${value}FCFA$`) }).waitFor({ timeout: 5000 })
    .catch(async () => assert.fail(`${id} : attendu ${value}, obtenu ${await kpi(id).textContent()}`));
};

const call = async (method, path, token, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

try {
  step("Inscription, puis Réglages › Accès par API : nouveau jeton");
  await page.goto(BASE);
  await page.getByRole("button", { name: "Créer mon entreprise" }).click();
  await page.getByLabel("Nom de l'entreprise").fill("IDO");
  await page.getByLabel("Votre nom").fill("Jimmy");
  await page.getByLabel("Téléphone").fill("+241 077 00 00 00");
  await page.getByLabel("E-mail").fill("dnt@ido.ga");
  await page.getByLabel("Mot de passe", { exact: true }).fill("motdepasse1");
  await page.getByLabel("Confirmer le mot de passe").fill("motdepasse1");
  await page.getByRole("button", { name: "Démarrer l'essai gratuit" }).click();
  await waitSynced();
  await nav("Réglages");
  const card = page.getByRole("region", { name: "Accès par API" });
  await card.getByText("Aucun jeton actif.").waitFor();
  await card.getByRole("button", { name: "Nouveau jeton" }).click();
  await card.getByLabel("Nom du jeton").fill("Agent projets");
  await card.getByRole("button", { name: "Créer le jeton" }).click();
  await card.getByText("Choisissez au moins une table.").waitFor();
  await card.getByLabel("Accès : Projets", { exact: true }).selectOption("rw");
  await card.getByLabel("Accès : Tâches", { exact: true }).selectOption("rw");
  await card.getByLabel("Accès : Clients", { exact: true }).selectOption("r");
  await card.getByRole("button", { name: "Créer le jeton" }).click();
  const token = (await card.getByTestId("api-token").textContent()).trim();
  assert.match(token, /^gst_[a-z0-9]{12}_[A-Za-z0-9]{32}$/);
  await card.getByText(/Projets \(lecture et écriture\), Tâches \(lecture et écriture\), Clients \(lecture\)/).waitFor();

  step("Sans jeton ou avec un faux : 401");
  assert.equal((await call("GET", "/api/v1/projects")).status, 401);
  assert.equal((await call("GET", "/api/v1/projects", "gst_aaaaaaaaaaaa_" + "x".repeat(32))).status, 401);

  step("Création d'un projet et d'une tâche par l'API, puis lecture");
  let r = await call("PATCH", "/api/v1/projects/prj-api-0001", token, { name: "Migration Trello", status: "active" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.name, "Migration Trello");
  assert.equal(r.body.created_by_name, "API : Agent projets");
  r = await call("PATCH", "/api/v1/tasks/tsk-api-0001", token, { project_id: "prj-api-0001", title: "Importer les cartes", status: "todo" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await call("PATCH", "/api/v1/tasks/tsk-api-0001", token, { status: "done" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.title, "Importer les cartes");
  assert.equal(r.body.status, "done");
  r = await call("GET", "/api/v1/tasks", token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map((t) => t.id), ["tsk-api-0001"]);
  assert.ok(r.body.cursor > 0);
  assert.equal((await call("GET", `/api/v1/tasks?since=${r.body.cursor}`, token)).body.items.length, 0);
  assert.equal((await call("GET", "/api/v1/projects/prj-api-0001", token)).body.name, "Migration Trello");
  assert.equal((await call("GET", "/api/v1/clients", token)).status, 200);

  step("Hors portée : écriture en lecture seule, table non choisie, table protégée, réglages");
  assert.equal((await call("PATCH", "/api/v1/clients/cli-api-0001", token, { name: "X" })).status, 403);
  assert.equal((await call("GET", "/api/v1/invoices", token)).status, 403);
  assert.equal((await call("GET", "/api/v1/cost_rates", token)).status, 403);
  assert.equal((await call("GET", "/api/v1/settings/company", token)).status, 403);
  assert.equal((await call("PATCH", "/api/v1/projects/prj-api-0001", token, [])).status, 400);

  step("Suppression par l'API : l'élément disparaît de la liste");
  await call("PATCH", "/api/v1/tasks/tsk-api-0002", token, { project_id: "prj-api-0001", title: "À supprimer", status: "todo" });
  assert.equal((await call("DELETE", "/api/v1/tasks/tsk-api-0002", token)).status, 200);
  assert.equal((await call("GET", "/api/v1/tasks/tsk-api-0002", token)).status, 404);
  assert.equal((await call("GET", "/api/v1/tasks?deleted=1", token)).body.items.length, 2);

  step("L'application reçoit le projet créé par l'API");
  await waitSynced();
  await nav("Projets");
  await page.getByText("Migration Trello").first().waitFor({ timeout: 10_000 });
  await shot("api-projet.png");

  step("Révocation : le jeton ne fonctionne plus");
  await nav("Réglages");
  await card.getByText("Utilisé le", { exact: false }).waitFor();
  await shot("api-reglages.png");
  await card.getByRole("button", { name: "Révoquer" }).click();
  await card.getByText("Aucun jeton actif.").waitFor();
  assert.equal((await call("GET", "/api/v1/projects", token)).status, 401);

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nRecette de l'API à jetons limités réussie.");
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  await page.screenshot({ path: join(out, "echec.png"), fullPage: true }).catch(() => {});
  console.error(`Capture : ${join(out, "echec.png")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
