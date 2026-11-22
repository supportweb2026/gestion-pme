/**
 * Recette du connecteur MCP (Claude) :
 *  - découverte : 401 avec resource_metadata, métadonnées OAuth ;
 *  - enregistrement dynamique du client, autorisation PKCE S256 avec la vraie page de connexion
 *    Gestia puis l'écran de consentement, échange du code, rafraîchissement ;
 *  - MCP : initialize, tools/list, create_task (avec sa catégorie) puis update_task, add_comment,
 *    get_task (discussion, historique, catégorie) ;
 *  - la tâche et le commentaire de Claude apparaissent dans l'application ; Réglages › Connexions : déconnexion, jeton refusé.
 *
 * Prérequis : `npm run build`, Playwright.
 *   node test/e2e/connecteur-mcp.mjs        (SHOTS_DIR=… pour des captures)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, createHmac, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const root = join(import.meta.dirname, "..", "..");
const PORT = 8814;
const BASE = `http://localhost:${PORT}`;
const REDIRECT = "http://127.0.0.1:6274/oauth/callback";
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-mcp-"));
const cleanup = [];

const server = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "dev/server.ts"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), DB_PATH: ":memory:" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("localhost") && resolve()));

const browser = await chromium.launch();
const step = (msg) => console.log(`• ${msg}`);
const errors = [];
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "fr-FR" });
const page = await context.newPage();
page.on("dialog", (d) => d.accept());
page.on("pageerror", (e) => errors.push(e.message));
const nav = (label) => page.getByRole("navigation").getByRole("button", { name: label, exact: true }).click();
const pill = () => page.getByTestId("sync-pill");
const waitSynced = async () => {
  await pill().click();
  await pill().filter({ hasText: "À jour" }).waitFor({ timeout: 10_000 });
};
const shot = async (p, file) => shots && p.screenshot({ path: join(shots, file), fullPage: true });
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Code TOTP (RFC 6238) calculé comme le ferait le téléphone. */
function totp(secret, ms = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/\s/g, "")) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(ms / 30000)));
  const h = createHmac("sha1", key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const call = async (method, path, token, body, headers = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
};
let rpcId = 0;
const mcp = (token, method, params = {}) => call("POST", "/mcp", token, { jsonrpc: "2.0", id: ++rpcId, method, params }, { accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" });
const tool = async (token, name, args) => {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.isError, false, r.body.result.content?.[0]?.text);
  return r.body.result.structuredContent;
};

try {
  step("Inscription de l'entreprise, puis un projet synchronisé depuis un autre appareil");
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
  const other = await call("POST", "/api/login", null, { email: "dnt@ido.ga", password: "motdepasse1", deviceId: "device-seed-0001" });
  const me = other.body.user.id;
  const hlc = (n) => `${String(Date.now()).padStart(15, "0")}-${String(n).padStart(5, "0")}-device-seed-0001`;
  const seed = [
    ["projects", "prj-portail", { name: "Portail SEEG", status: "active", start_date: "2026-11-01", end_date: "2027-01-31", created_by: me }],
    ["project_members", `pm-prj-portail-tm-${me}`, { project_id: "prj-portail", team_member_id: `tm-${me}`, user_id: me, name: "Jimmy", role: "manager" }],
    ["tasks", "tsk-maquettes", { project_id: "prj-portail", title: "Maquettes de l'accueil", status: "doing", priority: "normal", assignee_id: `tm-${me}` }],
  ].map(([tbl, row, patch], i) => ({ id: crypto.randomUUID(), tbl, row, patch, hlc: hlc(i), device: "device-seed-0001" }));
  const pushed = await call("POST", "/api/sync", other.body.token, { since: 0, changes: seed });
  assert.equal(pushed.body.rejected.length, 0, JSON.stringify(pushed.body.rejected));

  step("Un employé (Paul) et la double authentification active sur le compte de Jimmy");
  const emp = await call("POST", "/api/users", other.body.token, { name: "Paul", email: "paul@ido.ga", role: "employee", password: "provisoire1" });
  const empLogin = await call("POST", "/api/login", null, { email: "paul@ido.ga", password: "provisoire1", deviceId: "device-paul-0001" });
  await call("POST", "/api/me/password", empLogin.body.token, { current: "provisoire1", next: "motdepasse2" });
  const team = [
    ["team_members", `tm-${emp.body.id}`, { user_id: emp.body.id, name: "Paul", active: true }],
    ["tasks", "tsk-photos", { project_id: "prj-portail", title: "Photos du chantier", status: "todo", priority: "normal", assignee_id: `tm-${emp.body.id}` }],
  ].map(([tbl, row, patch], i) => ({ id: crypto.randomUUID(), tbl, row, patch, hlc: hlc(10 + i), device: "device-seed-0001" }));
  assert.equal((await call("POST", "/api/sync", other.body.token, { since: 0, changes: team })).body.rejected.length, 0);
  const setup = await call("POST", "/api/me/2fa/setup", other.body.token, {});
  const totpSecret = setup.body.secret;
  assert.equal((await call("POST", "/api/me/2fa/enable", other.body.token, { code: totp(totpSecret) })).status, 200);

  step("Découverte : /mcp sans jeton répond 401 avec resource_metadata ; métadonnées OAuth");
  const anon = await mcp(null, "initialize", {});
  assert.equal(anon.status, 401);
  const meta = /resource_metadata="([^"]+)"/.exec(anon.headers.get("www-authenticate"))[1];
  const pr = await (await fetch(meta)).json();
  assert.equal(pr.resource, `${BASE}/mcp`);
  const as = await (await fetch(`${pr.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal((await fetch(`${BASE}/mcp`)).status, 405);

  step("Enregistrement dynamique du client");
  const reg = await call("POST", "/oauth/register", null, { client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const { client_id, client_secret } = reg.body;

  step("Autorisation : page de connexion Gestia, erreur de mot de passe, consentement");
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const auth = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "fr-FR" });
  const ap = await auth.newPage();
  ap.on("pageerror", (e) => errors.push(e.message));
  // Adresse de retour de l'application : un petit serveur local qui note le code reçu.
  let callback = null;
  const receiver = createServer((req, res) => {
    callback = new URL(req.url, REDIRECT);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<p>Retour vers Claude</p>");
  });
  await new Promise((r) => receiver.listen(6274, "127.0.0.1", r));
  cleanup.push(() => receiver.close());
  const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "etat-claude", scope: "projets", resource: `${BASE}/mcp` });
  await ap.goto(`${as.authorization_endpoint}?${q}`);
  await ap.getByRole("heading", { name: "Connecter Claude à Gestia" }).waitFor();
  await ap.evaluate(() => document.fonts.ready);
  await shot(ap, "01-connexion.png");
  await ap.getByLabel("E-mail").fill("dnt@ido.ga");
  await ap.getByLabel("Mot de passe").fill("pas-le-bon");
  await ap.getByRole("button", { name: "Se connecter" }).click();
  await ap.getByRole("alert").getByText("E-mail ou mot de passe incorrect.").waitFor();
  await shot(ap, "02-connexion-erreur.png");
  await ap.getByLabel("Mot de passe").fill("motdepasse1");
  await ap.getByRole("button", { name: "Se connecter" }).click();
  await ap.getByRole("heading", { name: "Vérification en deux étapes" }).waitFor();
  await shot(ap, "03-double-authentification.png");
  await ap.getByLabel("Code de vérification").fill(totp(totpSecret) === "000000" ? "111111" : "000000");
  await ap.getByRole("button", { name: "Vérifier" }).click();
  await ap.getByRole("alert").getByText("Code de vérification incorrect.").waitFor();
  await shot(ap, "04-double-authentification-erreur.png");
  // Code du pas suivant : celui du pas courant a servi à l'activation.
  await ap.getByLabel("Code de vérification").fill(totp(totpSecret, Date.now() + 30_000));
  await ap.getByRole("button", { name: "Vérifier" }).click();
  await ap.getByRole("heading", { name: "Autoriser Claude à accéder à Gestia ?" }).waitFor();
  await ap.getByText("IDO · Administrateur · dnt@ido.ga").waitFor();
  await ap.evaluate(() => document.fonts.ready);
  await shot(ap, "05-consentement.png");
  // Vue téléphone du consentement.
  await ap.setViewportSize({ width: 390, height: 844 });
  await shot(ap, "06-consentement-telephone.png");
  await ap.setViewportSize({ width: 1280, height: 900 });
  await ap.getByRole("button", { name: "Autoriser" }).click();
  await ap.getByText("Retour vers Claude").waitFor();
  assert.equal(callback.searchParams.get("state"), "etat-claude");
  assert.equal(callback.searchParams.get("iss"), BASE);
  const code = callback.searchParams.get("code");
  assert.ok(code);

  step("Échange du code (PKCE), code à usage unique, rafraîchissement");
  const form = (o) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
  const wrong = await fetch(as.token_endpoint, form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: REDIRECT }));
  assert.equal(wrong.status, 401, "secret du client exigé");
  let tok = await (await fetch(as.token_endpoint, form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, client_secret, redirect_uri: REDIRECT }))).json();
  assert.ok(tok.access_token?.startsWith("gma_"), JSON.stringify(tok));
  assert.equal(tok.expires_in, 3600);
  tok = await (await fetch(as.token_endpoint, form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id, client_secret }))).json();
  assert.ok(tok.access_token, JSON.stringify(tok));
  const token = tok.access_token;

  step("MCP : initialize, tools/list");
  const init = await mcp(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1.0" } });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.equal((await call("POST", "/mcp", token, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const tools = (await mcp(token, "tools/list")).body.result.tools;
  assert.equal(tools.length, 11);
  assert.equal(tools.find((t) => t.name === "get_task").annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "add_comment").annotations.readOnlyHint, false);
  assert.equal(tools.find((t) => t.name === "add_comment").annotations.destructiveHint, false);
  assert.equal(tools.find((t) => t.name === "list_projects").annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "update_task").annotations.destructiveHint, false);

  step("Outils : list_projects, create_task, update_task, log_time, my_day");
  const projects = await tool(token, "list_projects", {});
  assert.equal(projects.projects[0].name, "Portail SEEG");
  assert.equal(projects.projects[0].manager, "Jimmy");
  const created = await tool(token, "create_task", { project: "Portail SEEG", title: "Recette avec le client", assignee: "moi", due_date: "2026-12-15", priority: "high", category: "client" });
  const taskId = created.task.id;
  assert.equal(created.task.category, "Client");
  const updated = await tool(token, "update_task", { task_id: taskId, status: "review", description: "Cahier de recette envoyé" });
  assert.equal(updated.task.status_label, "À vérifier");

  step("Outils du lot 5 : list_categories, add_comment, get_task (discussion, historique)");
  const cats = await tool(token, "list_categories", {});
  assert.ok(cats.categories.some((c) => c.id === "cat-client" && c.open_tasks === 1));
  const comment = await tool(token, "add_comment", { task_id: taskId, body: "Recette prévue le 15/12 avec la SEEG, salle de réunion réservée." });
  assert.equal(comment.comment.author, "Jimmy");
  const fiche = await tool(token, "get_task", { task_id: taskId });
  assert.equal(fiche.task.category, "Client");
  assert.equal(fiche.task.comments, 1);
  assert.equal(fiche.comments[0].body, "Recette prévue le 15/12 avec la SEEG, salle de réunion réservée.");
  assert.equal(fiche.comments[0].editable, true);
  assert.ok(fiche.history.some((h) => h.label === "Déplacée de « À faire » vers « À vérifier »"), JSON.stringify(fiche.history));
  assert.equal(fiche.history.at(-1).label, "Tâche créée");
  const inCat = await tool(token, "list_tasks", { category: "Client" });
  assert.deepEqual(inCat.tasks.map((t) => [t.id, t.comments]), [[taskId, 1]]);
  await tool(token, "log_time", { task_id: taskId, hours: 1.5, note: "Préparation" });
  const day = await tool(token, "my_day", {});
  assert.ok(day.today.some((t) => t.id === "tsk-maquettes"));
  assert.ok(day.waiting_review.some((t) => t.id === taskId));

  step("Employé : refus de l'accord, puis accord ; aucun montant ; règle des projets appliquée");
  const authorizeAs = async (email, password, decision) => {
    const v = b64url(randomBytes(32));
    const qs = new URLSearchParams({ response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: b64url(createHash("sha256").update(v).digest()), code_challenge_method: "S256", state: "s2" });
    callback = null;
    await ap.goto(`${as.authorization_endpoint}?${qs}`);
    await ap.getByLabel("E-mail").fill(email);
    await ap.getByLabel("Mot de passe").fill(password);
    await ap.getByRole("button", { name: "Se connecter" }).click();
    await ap.getByRole("heading", { name: "Autoriser Claude à accéder à Gestia ?" }).waitFor();
    await ap.evaluate(() => document.fonts.ready);
    if (decision === "Autoriser") await shot(ap, "07-consentement-employe.png");
    await ap.getByRole("button", { name: decision, exact: true }).click();
    await ap.getByText("Retour vers Claude").waitFor();
    return { cb: callback, verifier: v };
  };
  const denied = await authorizeAs("paul@ido.ga", "motdepasse2", "Refuser");
  assert.equal(denied.cb.searchParams.get("error"), "access_denied");
  const okEmp = await authorizeAs("paul@ido.ga", "motdepasse2", "Autoriser");
  const tokEmp = await (await fetch(as.token_endpoint, form({ grant_type: "authorization_code", code: okEmp.cb.searchParams.get("code"), code_verifier: okEmp.verifier, client_id, client_secret, redirect_uri: REDIRECT }))).json();
  const empProjects = await tool(tokEmp.access_token, "list_projects", {});
  assert.equal(empProjects.projects[0].name, "Portail SEEG");
  assert.ok(!/"budget":\s*\d|hourly_rate|cost_rate|FCFA/.test(JSON.stringify(empProjects)));
  const refusal = await mcp(tokEmp.access_token, "tools/call", { name: "update_task", arguments: { task_id: "tsk-photos", title: "Autre titre" } });
  assert.equal(refusal.body.result.isError, true);
  console.log(`  refus affiché à Claude : « ${refusal.body.result.content[0].text} »`);
  const done = await mcp(tokEmp.access_token, "tools/call", { name: "update_task", arguments: { task_id: "tsk-photos", status: "done" } });
  console.log(`  refus affiché à Claude : « ${done.body.result.content[0].text} »`);
  await tool(tokEmp.access_token, "update_task", { task_id: "tsk-photos", status: "doing" });

  step("Page d'erreur : application inconnue");
  await ap.goto(`${as.authorization_endpoint}?client_id=gcl_inconnu&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`);
  await ap.getByRole("heading", { name: "Application inconnue" }).waitFor();
  await shot(ap, "09-application-inconnue.png");

  step("La tâche apparaît dans l'application, au bon statut");
  await waitSynced();
  await nav("Projets");
  await page.getByText("Portail SEEG", { exact: true }).first().click();
  await page.getByRole("heading", { name: "Portail SEEG" }).waitFor();
  const reviewCard = page.getByTestId("col-review").locator(".task-card", { hasText: "Recette avec le client" });
  await reviewCard.waitFor({ timeout: 10_000 });
  await shot(page, "08-tache-dans-gestia.png");
  step("Le commentaire de Claude est dans la discussion de la tâche, au nom de Jimmy");
  await reviewCard.getByRole("button", { name: "1 commentaire" }).click();
  const talk = page.getByTestId("task-discussion");
  await talk.getByText("Recette prévue le 15/12 avec la SEEG, salle de réunion réservée.").waitFor();
  await talk.getByTestId("comment").first().getByText("Jimmy").first().waitFor();
  await page.getByTestId("task-panel").getByRole("tab", { name: "Historique" }).click();
  await page.getByTestId("task-history").getByText("Déplacée de « À faire » vers « À vérifier »").waitFor();
  await shot(page, "12-commentaire-claude-dans-gestia.png");
  await page.getByRole("button", { name: "Fermer la tâche" }).click();

  step("Réglages › Connexions : l'administrateur voit les deux connexions et les retire");
  await nav("Réglages");
  const card = page.getByRole("region", { name: "Connexions" });
  await card.getByText("Jimmy (vous)", { exact: false }).waitFor();
  await card.getByText("· Paul", { exact: false }).waitFor();
  await card.getByText(/dernier usage le/).first().waitFor();
  await card.scrollIntoViewIfNeeded();
  if (shots) await card.screenshot({ path: join(shots, "10-reglages-connexions.png") });
  await card.locator(".connection-row", { hasText: "Paul" }).getByRole("button", { name: "Déconnecter" }).click();
  await card.locator(".connection-row", { hasText: "Paul" }).waitFor({ state: "detached" });
  assert.equal((await mcp(tokEmp.access_token, "tools/list")).status, 401);
  assert.equal((await mcp(token, "tools/list")).status, 200);
  await card.getByRole("button", { name: "Déconnecter" }).click();
  await card.getByText("Aucune application connectée.").waitFor();
  if (shots) await card.screenshot({ path: join(shots, "11-reglages-connexions-vide.png") });
  const after = await mcp(token, "tools/list");
  assert.equal(after.status, 401);
  assert.match(after.headers.get("www-authenticate"), /invalid_token/);
  // Le jeton de rafraîchissement est retiré aussi : il faut se reconnecter.
  const refreshAfter = await fetch(as.token_endpoint, form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id, client_secret }));
  assert.equal(refreshAfter.status, 400);

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nRecette du connecteur MCP réussie.");
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  await page.screenshot({ path: join(out, "echec.png"), fullPage: true }).catch(() => {});
  console.error(`Capture : ${join(out, "echec.png")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  for (const f of cleanup) f();
  server.kill();
}
