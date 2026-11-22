import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHash } from "node:crypto";
import worker from "../src/worker/index.ts";
import { createLocalD1 } from "../dev/d1-local.ts";
import { HlcClock } from "../src/shared/hlc.ts";
import { pkceMatches, validRedirectUri } from "../src/worker/oauth.ts";
import type { Change } from "../src/shared/sync.ts";

const env = { DB: createLocalD1(":memory:", join(import.meta.dirname, "..", "migrations")), FILES: createLocalD1(":memory:"), JWT_SECRET: "test-secret-0123456789-0123456789-mcp" };
const BASE = "http://gestia.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

async function raw(path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`${BASE}${path}`, init), env);
}
async function call(path: string, body?: unknown, token?: string) {
  const res = await raw(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const form = (data: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data).toString() });
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hidden = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1] ?? "";

const DEV = "device-admin-0001";
const clock = new HlcClock(DEV);
const ch = (tbl: Change["tbl"], row: string, patch: Record<string, unknown>): Change => ({ id: crypto.randomUUID(), tbl, row, patch, hlc: clock.tick(), device: DEV });
let admin = { token: "", id: "" };
let employee = { token: "", id: "" };

async function register(method = "none") {
  const r = await call("/oauth/register", { client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: method, grant_types: ["authorization_code", "refresh_token"] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data as { client_id: string; client_secret?: string };
}

/** Flux complet : autorisation (connexion, accord) puis échange du code. */
async function connect(email: string, password = "motdepasse1", opts: { exchange?: boolean } = {}) {
  const client = await register();
  const verifier = b64url(Buffer.from(crypto.getRandomValues(new Uint8Array(32))));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "etat-123", scope: "projets", resource: `${BASE}/mcp` });
  const page = await raw(`/oauth/authorize?${q}`);
  assert.equal(page.status, 200);
  const ctx = hidden(await page.text(), "ctx");
  const login = await raw("/oauth/authorize", form({ step: "login", ctx, email, password }));
  const consentHtml = await login.text();
  assert.equal(login.status, 200, consentHtml.slice(0, 400));
  assert.match(consentHtml, /Autoriser Claude à accéder à Gestia/);
  const back = await raw("/oauth/authorize", form({ step: "consent", auth: hidden(consentHtml, "auth"), decision: "allow" }));
  assert.equal(back.status, 302);
  const loc = new URL(back.headers.get("location")!);
  assert.equal(loc.searchParams.get("state"), "etat-123");
  const code = loc.searchParams.get("code")!;
  if (opts.exchange === false) return { client, code, verifier };
  const tok = await raw("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT }));
  const data = (await tok.json()) as any;
  assert.equal(tok.status, 200, JSON.stringify(data));
  return { client, code, verifier, access: data.access_token as string, refresh: data.refresh_token as string };
}

async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await raw("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return { status: res.status, headers: res.headers, data: (await res.json().catch(() => null)) as any };
}
const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => (await rpc(token, "tools/call", { name, arguments: args })).data.result;

test("préparation : entreprise, employé, projet avec montants, tâches", async () => {
  const s = await call("/api/signup", { company: "IDO", name: "Jimmy Dnt", email: "dnt@ido.ga", password: "motdepasse1", deviceId: DEV });
  admin = { token: s.data.token, id: s.data.user.id };
  const u = await call("/api/users", { name: "Paul Employé", email: "paul@ido.ga", role: "employee", password: "provisoire1" }, admin.token);
  employee.id = u.data.id;
  const l = await call("/api/login", { email: "paul@ido.ga", password: "provisoire1", deviceId: "device-paul-0001" });
  await call("/api/me/password", { current: "provisoire1", next: "motdepasse1" }, l.data.token);
  const r = await call("/api/sync", {
    since: 0,
    changes: [
      ch("team_members", `tm-${admin.id}`, { user_id: admin.id, name: "Jimmy Dnt", active: true }),
      ch("team_members", `tm-${employee.id}`, { user_id: employee.id, name: "Paul Employé", active: true }),
      ch("clients", "cli-1", { name: "SEEG" }),
      ch("projects", "prj-1", { name: "Portail SEEG", client_id: "cli-1", status: "active", budget: 5_432_100, hourly_rate: 25_000, start_date: "2026-11-01", end_date: "2026-12-31" }),
      ch("project_finance", "fin-prj-1", { project_id: "prj-1", legacy_budget: 5_432_100, hourly_rate: 25_000 }),
      ch("project_members", `pm-prj-1-tm-${admin.id}`, { project_id: "prj-1", team_member_id: `tm-${admin.id}`, user_id: admin.id, name: "Jimmy Dnt", role: "manager" }),
      ch("project_stages", "stg-1", { project_id: "prj-1", name: "Cadrage", rank: 1, kind: "start", review_requested_at: "2026-11-20T10:00:00.000Z", review_requested_by_name: "Paul Employé" }),
      ch("tasks", "tsk-1", { project_id: "prj-1", stage_id: "stg-1", title: "Maquettes", status: "doing", priority: "normal", assignee_id: `tm-${employee.id}`, due_date: "2026-11-01" }),
    ],
  }, admin.token);
  assert.equal(r.data.rejected.length, 0, JSON.stringify(r.data.rejected));
});

test("métadonnées OAuth et ressource protégée ; 401 avec resource_metadata ; GET 405", async () => {
  const pr = await call("/.well-known/oauth-protected-resource/mcp");
  assert.equal(pr.data.resource, `${BASE}/mcp`);
  assert.deepEqual(pr.data.authorization_servers, [BASE]);
  const as = await call("/.well-known/oauth-authorization-server");
  assert.deepEqual(as.data.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.data.registration_endpoint, `${BASE}/oauth/register`);
  const r = await rpc("gma_faux-jeton-faux-jeton-faux-jeton-faux", "tools/list");
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate")!, /resource_metadata="http:\/\/gestia\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.equal((await raw("/mcp")).status, 405);
});

test("enregistrement : adresses de retour contrôlées", async () => {
  assert.equal(validRedirectUri("https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(validRedirectUri("http://localhost:6274/cb"), true);
  assert.equal(validRedirectUri("http://evil.example/cb"), false);
  assert.equal(validRedirectUri("javascript:alert(1)"), false);
  const bad = await call("/oauth/register", { client_name: "X", redirect_uris: ["http://evil.example/cb"] });
  assert.equal(bad.status, 400);
  const conf = await register("client_secret_post");
  assert.ok(conf.client_secret?.startsWith("gcs_"));
});

test("PKCE : S256 vérifié ; autorisation sans PKCE renvoyée en erreur", async () => {
  const v = "a".repeat(43);
  const c = b64url(createHash("sha256").update(v).digest());
  assert.equal(await pkceMatches(v, c), true);
  assert.equal(await pkceMatches("b".repeat(43), c), false);
  assert.equal(await pkceMatches("court", c), false);
  const client = await register();
  const res = await raw(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, state: "s" })}`);
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get("location")!).searchParams.get("error"), "invalid_request");
  const wrongUri = await raw(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://evil.example/cb" })}`);
  assert.equal(wrongUri.status, 400, "adresse de retour inconnue : pas de redirection");
});

test("connexion : mauvais mot de passe refusé par la vraie vérification ; refus de l'accord", async () => {
  const client = await register();
  const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: "x".repeat(43), code_challenge_method: "S256" });
  const ctx = hidden(await (await raw(`/oauth/authorize?${q}`)).text(), "ctx");
  const bad = await raw("/oauth/authorize", form({ step: "login", ctx, email: "dnt@ido.ga", password: "mauvais-mdp" }));
  assert.equal(bad.status, 401);
  assert.match(await bad.text(), /E-mail ou mot de passe incorrect/);
  const ok = await raw("/oauth/authorize", form({ step: "login", ctx, email: "dnt@ido.ga", password: "motdepasse1" }));
  const deny = await raw("/oauth/authorize", form({ step: "consent", auth: hidden(await ok.text(), "auth"), decision: "deny" }));
  assert.equal(new URL(deny.headers.get("location")!).searchParams.get("error"), "access_denied");
  const forged = await raw("/oauth/authorize", form({ step: "consent", auth: "abc.def", decision: "allow" }));
  assert.equal(forged.status, 400);
});

test("code d'autorisation : usage unique ; un code rejoué coupe la connexion", async () => {
  const c = await connect("dnt@ido.ga");
  assert.equal((await rpc(c.access!, "ping")).status, 200);
  const again = await raw("/oauth/token", form({ grant_type: "authorization_code", code: c.code, code_verifier: c.verifier, client_id: c.client.client_id, redirect_uri: REDIRECT }));
  assert.equal(again.status, 400);
  assert.equal(((await again.json()) as any).error, "invalid_grant");
  assert.equal((await rpc(c.access!, "ping")).status, 401, "jetons retirés après le rejeu");
});

test("code d'autorisation : mauvais code_verifier et code expiré refusés", async () => {
  const a = await connect("dnt@ido.ga", "motdepasse1", { exchange: false });
  const wrong = await raw("/oauth/token", form({ grant_type: "authorization_code", code: a.code, code_verifier: "z".repeat(43), client_id: a.client.client_id, redirect_uri: REDIRECT }));
  assert.match(((await wrong.json()) as any).error_description, /PKCE/);
  const b = await connect("dnt@ido.ga", "motdepasse1", { exchange: false });
  await env.DB.prepare(`UPDATE oauth_codes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE used_at IS NULL`).run();
  const late = await raw("/oauth/token", form({ grant_type: "authorization_code", code: b.code, code_verifier: b.verifier, client_id: b.client.client_id, redirect_uri: REDIRECT }));
  assert.match(((await late.json()) as any).error_description, /expiré/);
});

test("rafraîchissement : rotation ; nouvelle tentative < 60 s tolérée ; rejeu tardif = connexion coupée ; jeton d'accès expiré refusé", async () => {
  const c = await connect("dnt@ido.ga");
  const r1 = await raw("/oauth/token", form({ grant_type: "refresh_token", refresh_token: c.refresh!, client_id: c.client.client_id }));
  const t1 = (await r1.json()) as any;
  assert.equal(r1.status, 200);
  assert.notEqual(t1.refresh_token, c.refresh);
  assert.equal((await rpc(t1.access_token, "ping")).status, 200);
  // Nouvelle tentative réseau dans les 60 s : renouvelée sans couper la connexion.
  const retry = await raw("/oauth/token", form({ grant_type: "refresh_token", refresh_token: c.refresh!, client_id: c.client.client_id }));
  assert.equal(retry.status, 200);
  assert.equal((await rpc(t1.access_token, "ping")).status, 200);
  // Rejeu tardif (au-delà de 60 s) : vol probable, connexion coupée.
  await env.DB.prepare(`UPDATE oauth_tokens SET used_at = '2000-01-01T00:00:00.000Z' WHERE kind = 'refresh' AND used_at IS NOT NULL`).run();
  const replay = await raw("/oauth/token", form({ grant_type: "refresh_token", refresh_token: c.refresh!, client_id: c.client.client_id }));
  assert.equal(replay.status, 400);
  assert.equal((await rpc(t1.access_token, "ping")).status, 401);
  const d = await connect("dnt@ido.ga");
  await env.DB.prepare(`UPDATE oauth_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE kind = 'access'`).run();
  assert.equal((await rpc(d.access!, "ping")).status, 401);
});

test("Réglages › Connexions : liste, déconnexion par soi-même ou l'administrateur seulement", async () => {
  const mine = await connect("dnt@ido.ga");
  const emp = await connect("paul@ido.ga");
  const l = await call("/api/login", { email: "paul@ido.ga", password: "motdepasse1", deviceId: "device-paul-0002" });
  employee.token = l.data.token;
  const own = await call("/api/connections", undefined, employee.token);
  assert.equal(own.data.connections.length, 1);
  assert.equal(own.data.connections[0].client_name, "Claude");
  const all = await call("/api/connections", undefined, admin.token);
  assert.ok(all.data.connections.length >= 2);
  const adminGrant = all.data.connections.find((c: any) => c.mine);
  assert.equal((await call("/api/connections/revoke", { id: adminGrant.id }, employee.token)).status, 404, "pas celle d'un autre");
  await call("/api/connections/revoke", { id: own.data.connections[0].id }, employee.token);
  assert.equal((await rpc(emp.access!, "ping")).status, 401, "déconnecté");
  // Révocation RFC 7009 par le client : le jeton de rafraîchissement retire la connexion.
  await raw("/oauth/revoke", form({ token: mine.refresh!, client_id: mine.client.client_id }));
  assert.equal((await rpc(mine.access!, "ping")).status, 401);
});

test("MCP : initialize, tools/list avec annotations, notification", async () => {
  const c = await connect("dnt@ido.ga");
  const init = await rpc(c.access!, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.data.result.protocolVersion, "2025-06-18");
  assert.equal(init.data.result.serverInfo.name, "gestia");
  const list = await rpc(c.access!, "tools/list");
  const names = list.data.result.tools.map((t: any) => t.name);
  assert.deepEqual(names.sort(), ["add_comment", "add_watch_point", "create_project", "create_task", "get_project", "get_task", "list_categories", "list_people", "list_projects", "list_tasks", "log_time", "my_day", "update_task"]);
  for (const t of list.data.result.tools) {
    assert.equal(typeof t.annotations.readOnlyHint, "boolean");
    assert.equal(t.annotations.destructiveHint, false);
  }
  const hint = (n: string) => list.data.result.tools.find((t: any) => t.name === n).annotations.readOnlyHint;
  assert.equal(hint("get_task"), true);
  assert.equal(hint("list_categories"), true);
  assert.equal(hint("add_comment"), false);
  const note = await raw("/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${c.access}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(note.status, 202);
});

test("droits : un employé ne voit aucun montant et ses écritures interdites sont refusées", async () => {
  const c = await connect("paul@ido.ga");
  for (const [name, args] of [["list_projects", {}], ["get_project", { project: "prj-1" }], ["list_tasks", {}], ["my_day", {}]] as const) {
    const r = await tool(c.access!, name, args);
    const text = JSON.stringify(r);
    assert.equal(r.isError, false, text);
    assert.ok(!text.includes("5432100") && !text.includes("25000") && !/"budget":\s*\d|hourly_rate|cost_rate|FCFA/.test(text), `${name} sans montant`);
  }
  const proj = await tool(c.access!, "list_projects");
  assert.equal(proj.structuredContent.projects[0].client, undefined, "l'employé ne lit pas les clients");
  const day = await tool(c.access!, "my_day", { date: "2026-11-22" });
  assert.equal(day.structuredContent.today[0].id, "tsk-1");
  assert.equal(day.structuredContent.today[0].why, "en retard");
  const rename = await tool(c.access!, "update_task", { task_id: "tsk-1", title: "Autre titre" });
  assert.equal(rename.isError, true);
  assert.match(rename.content[0].text, /seulement l'avancement et la description/);
  const close = await tool(c.access!, "update_task", { task_id: "tsk-1", status: "done" });
  assert.equal(close.isError, true);
  assert.match(close.content[0].text, /Terminé/);
  const other = await tool(c.access!, "create_task", { project: "Portail", title: "Pour Jimmy", assignee: "Jimmy" });
  assert.equal(other.isError, true);
  assert.match(other.content[0].text, /seulement à vous-même/);
  const block = await tool(c.access!, "update_task", { task_id: "tsk-1", blocked: true, block_reason: "client", block_note: "Logo attendu" });
  assert.equal(block.isError, false, block.content[0].text);
  assert.equal(block.structuredContent.task.blocked, true);
  const t = await tool(c.access!, "log_time", { task_id: "tsk-1", hours: 2, date: "2026-11-21" });
  assert.equal(t.isError, false, t.content[0].text);
  const tooMuch = await tool(c.access!, "log_time", { task_id: "tsk-1", hours: 23, date: "2026-11-21" });
  assert.equal(tooMuch.isError, true);
  // Compte désactivé : jeton refusé tout de suite.
  await call("/api/users/update", { id: employee.id, active: false }, admin.token);
  assert.equal((await rpc(c.access!, "ping")).status, 401);
  await call("/api/users/update", { id: employee.id, active: true }, admin.token);
});

test("écritures : chemin de la synchronisation, auteur tracé, reçues par les appareils", async () => {
  const c = await connect("dnt@ido.ga");
  // Budget par poste (lot 4) : table protégée, jamais lue par le connecteur, même pour la direction.
  await env.DB.prepare(`INSERT INTO records (company_id, tbl, id, data, clocks, updated_seq) SELECT company_id, 'budget_lines', 'bl-1', ?, '{}', 0 FROM records WHERE id = 'prj-1'`)
    .bind(JSON.stringify({ project_id: "prj-1", stage_id: "stg-1", poste: "labour", amount: 7_777_777 })).run();
  const pr = await tool(c.access!, "get_project", { project: "Portail SEEG" });
  assert.ok(!JSON.stringify(pr).includes("7777777") && !JSON.stringify(pr).includes("5432100"), "aucun montant pour la direction non plus");
  assert.equal(pr.structuredContent.weather.delay.light !== undefined, true);
  assert.match(pr.structuredContent.weather.budget, /non transmis/);
  assert.equal(pr.structuredContent.to_decide.length, 1, "validation demandée à décider");
  assert.equal(pr.structuredContent.stages[0].state, "awaiting");
  const created = await tool(c.access!, "create_task", { project: "prj-1", title: "Recette client", assignee: "Paul", due_date: "2026-12-05", priority: "high", stage: "Cadrage" });
  assert.equal(created.isError, false, created.content[0].text);
  const id = created.structuredContent.task.id;
  const upd = await tool(c.access!, "update_task", { task_id: id, status: "review", due_date: "2026-12-10" });
  assert.deepEqual(upd.structuredContent.changed.sort(), ["due_date", "status"]);
  const log = await env.DB.prepare(`SELECT device_id, user_id, hlc FROM changes WHERE row_id = ? ORDER BY seq`).bind(id).all<{ device_id: string; user_id: string; hlc: string }>();
  assert.equal(log.results.length, 2);
  assert.ok(log.results.every((r) => r.device_id.startsWith("mcp-") && r.user_id === admin.id));
  const pull = await call("/api/sync", { changes: [], since: 0 }, admin.token);
  const got = pull.data.changes.filter((x: Change) => x.row === id);
  assert.equal(got.length, 2, "l'appareil reçoit la création et la modification");
  const tasks = await tool(c.access!, "list_tasks", { person: "Paul", status: "review" });
  assert.equal(tasks.structuredContent.tasks[0].title, "Recette client");
});

test("lot 5 : catégorie par nom, commentaire ajouté puis lu, historique et archivage", async () => {
  const c = await connect("dnt@ido.ga");
  const cats = await tool(c.access!, "list_categories");
  assert.deepEqual(cats.structuredContent.categories.map((x: any) => x.name), ["Client", "Infra", "Sécurité", "Coûts", "Interne"]);
  // Catégorie par son nom, sans accent ni majuscule.
  const created = await tool(c.access!, "create_task", { project: "Portail SEEG", title: "Pare-feu du portail", category: "securite", assignee: "moi" });
  assert.equal(created.isError, false, created.content[0].text);
  const id = created.structuredContent.task.id;
  assert.equal(created.structuredContent.task.category_id, "cat-securite");
  assert.equal(created.structuredContent.task.category, "Sécurité");
  assert.equal(created.structuredContent.task.comments, 0);
  const unknown = await tool(c.access!, "create_task", { project: "Portail SEEG", title: "X", category: "Marketing" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Catégorie « Marketing » introuvable.*Client, Infra/);
  // Filtre par catégorie, par identifiant ou par nom.
  const bySec = await tool(c.access!, "list_tasks", { category: "Sécurité" });
  assert.deepEqual(bySec.structuredContent.tasks.map((t: any) => t.id), [id]);
  assert.deepEqual((await tool(c.access!, "list_tasks", { category: "cat-securite" })).structuredContent.tasks.map((t: any) => t.id), [id]);
  assert.ok((await tool(c.access!, "list_tasks", { category: "aucune" })).structuredContent.tasks.every((t: any) => t.category_id === ""));
  // Commentaire au nom de l'utilisateur connecté, relu par get_task et compté par list_tasks.
  const com = await tool(c.access!, "add_comment", { task_id: id, body: "Règles d'ouverture validées avec la SEEG." });
  assert.equal(com.isError, false, com.content[0].text);
  assert.equal(com.structuredContent.comment.author, "Jimmy Dnt");
  const empty = await tool(c.access!, "add_comment", { task_id: id, body: "   " });
  assert.equal(empty.isError, true);
  const row = await env.DB.prepare(`SELECT data FROM records WHERE tbl = 'task_comments' AND id = ?`).bind(com.structuredContent.comment.id).first<{ data: string }>();
  assert.equal(JSON.parse(row!.data).author_id, admin.id);
  const listed = await tool(c.access!, "list_tasks", { category: "Sécurité" });
  assert.equal(listed.structuredContent.tasks[0].comments, 1);
  // Historique : déplacement et échéance écrits par le serveur pour le connecteur.
  await tool(c.access!, "update_task", { task_id: id, status: "doing", due_date: "2026-12-20", category: "Infra" });
  const done = await tool(c.access!, "update_task", { task_id: id, status: "done" });
  assert.equal(done.isError, false, done.content[0].text);
  await env.DB.prepare(`INSERT INTO records (company_id, tbl, id, data, clocks, updated_seq) SELECT company_id, 'attachments', 'att-1', ?, '{}', 0 FROM records WHERE id = 'prj-1'`)
    .bind(JSON.stringify({ tbl: "tasks", row_id: id, project_id: "prj-1", kind: "link", url: "https://seeg.ga/specs", label: "Cahier des charges", created_by: admin.id, created_at: "2026-11-22T10:00:00.000Z" })).run();
  const fiche = await tool(c.access!, "get_task", { task_id: id });
  assert.equal(fiche.isError, false, fiche.content[0].text);
  const f = fiche.structuredContent;
  assert.equal(f.task.category, "Infra");
  assert.equal(f.comments.length, 1);
  assert.equal(f.comments[0].body, "Règles d'ouverture validées avec la SEEG.");
  assert.equal(f.comments[0].author, "Jimmy Dnt");
  assert.equal(f.comments[0].editable, true);
  const labels = f.history.map((h: any) => h.label);
  assert.ok(labels.includes("Déplacée de « À faire » vers « En cours »"), labels.join(" | "));
  assert.ok(labels.includes("Déplacée de « En cours » vers « Terminé »"));
  assert.ok(labels.includes("Échéance fixée au 20/12/2026"));
  assert.equal(labels.at(-1), "Tâche créée");
  assert.ok(f.history.every((h: any) => h.by.startsWith("Jimmy Dnt")), JSON.stringify(f.history));
  assert.deepEqual(f.attachments, [{ id: "att-1", kind: "link", name: "Cahier des charges", url: "https://seeg.ga/specs", added_at: "2026-11-22T10:00:00.000Z" }]);
  // Archivage : seulement une tâche terminée ; masquée par défaut, visible avec include_archived.
  const notDone = await tool(c.access!, "update_task", { task_id: "tsk-1", archived: true });
  assert.equal(notDone.isError, true);
  assert.match(notDone.content[0].text, /seule une tâche terminée/i);
  const arch = await tool(c.access!, "update_task", { task_id: id, archived: true });
  assert.equal(arch.isError, false, arch.content[0].text);
  assert.equal(arch.structuredContent.task.archived, true);
  assert.ok(!(await tool(c.access!, "list_tasks", { status: "all" })).structuredContent.tasks.some((t: any) => t.id === id), "archivée masquée");
  const withArch = await tool(c.access!, "list_tasks", { status: "all", include_archived: true });
  assert.ok(withArch.structuredContent.tasks.some((t: any) => t.id === id && t.archived));
  assert.ok((await tool(c.access!, "get_task", { task_id: id })).structuredContent.history.some((h: any) => h.label === "Archivée"));
  const back = await tool(c.access!, "update_task", { task_id: id, archived: false });
  assert.deepEqual(back.structuredContent.changed, ["archived"]);
  // Aucun montant dans la fiche.
  assert.ok(!/5432100|25000|budget/.test(JSON.stringify(fiche)));
});

test("lot 5 : l'employé commente, mais ne reclasse pas une tâche d'un projet qu'il ne dirige pas", async () => {
  const c = await connect("paul@ido.ga");
  const com = await tool(c.access!, "add_comment", { task_id: "tsk-1", body: "Logo reçu, je reprends." });
  assert.equal(com.isError, false, com.content[0].text);
  assert.equal(com.structuredContent.comment.author, "Paul Employé");
  const fiche = await tool(c.access!, "get_task", { task_id: "tsk-1" });
  assert.ok(fiche.structuredContent.comments.some((x: any) => x.body === "Logo reçu, je reprends." && x.author === "Paul Employé"));
  assert.ok(fiche.structuredContent.history.some((h: any) => h.label.startsWith("Bloquée")), "blocage du test précédent dans l'historique");
  // Règle des projets : l'employé ne modifie que l'avancement et la description.
  const cat = await tool(c.access!, "update_task", { task_id: "tsk-1", category: "Client" });
  assert.equal(cat.isError, true);
  assert.match(cat.content[0].text, /seulement l'avancement et la description/);
  const arch = await tool(c.access!, "update_task", { task_id: "tsk-1", archived: true });
  assert.equal(arch.isError, true);
  // Sa nouvelle tâche peut porter une catégorie.
  const mine = await tool(c.access!, "create_task", { project: "prj-1", title: "Photos du local", category: "Interne", assignee: "moi" });
  assert.equal(mine.isError, false, mine.content[0].text);
  assert.equal(mine.structuredContent.task.category, "Interne");
  const cats = await tool(c.access!, "list_categories");
  assert.equal(cats.isError, false);
  assert.equal((await tool(c.access!, "list_tasks", { category: "inconnue" })).isError, true);
});

test("create_project : projet interne sans montant ; refusé à un employé ; doublon refusé", async () => {
  const c = await connect("dnt@ido.ga");
  const r = await tool(c.access!, "create_project", { name: "IDO – Pilotage", description: "Remplace Trello", end_date: "2026-12-31" });
  assert.equal(r.isError, false, JSON.stringify(r));
  const id = r.structuredContent.project.id;
  const list = await tool(c.access!, "list_projects");
  assert.ok(JSON.stringify(list).includes("IDO – Pilotage"));
  const t = await tool(c.access!, "create_task", { project: id, title: "Première carte", category: "Infra" });
  assert.equal(t.isError, false, JSON.stringify(t));
  const dup = await tool(c.access!, "create_project", { name: "ido – pilotage" });
  assert.equal(dup.isError, true);
  const bad = await tool(c.access!, "create_project", { name: "Chantier", template: "forfait" });
  assert.equal(bad.isError, true);
  const e = await connect("paul@ido.ga");
  const emp = await tool(e.access!, "create_project", { name: "Projet perso" });
  assert.equal(emp.isError, true, "un employé ne crée pas de projet");
});

test("lot 6 : points de vigilance par le connecteur (sans montant) ; projet clôturé en lecture seule", async () => {
  const c = await connect("paul@ido.ga");
  const added = await tool(c.access!, "add_watch_point", { project: "Portail", title: "Accès client non fournis", probability: "forte", impact: "moyen", owner: "moi" });
  assert.equal(added.isError, false, added.content[0].text);
  assert.equal(added.structuredContent.watch_point.score, 6);
  assert.equal(added.structuredContent.watch_point.level, "Fort");
  assert.equal(added.structuredContent.watch_point.owner, "Paul Employé");
  assert.match(added.structuredContent.note, /À redresser/);
  assert.equal((await tool(c.access!, "add_watch_point", { project: "Portail", title: "X", probability: "énorme" })).isError, true);
  const pr = await tool(c.access!, "get_project", { project: "prj-1" });
  const wp = pr.structuredContent.watch_points.find((x: any) => x.title === "Accès client non fournis");
  assert.equal(wp.status_label, "Ouvert");
  assert.equal(wp.response, "");
  assert.equal(pr.structuredContent.weather.reserves.light, "red");
  assert.match(pr.structuredContent.weather.reserves.reason, /sans parade.*score 6/);
  assert.ok(!/5432100|25000/.test(JSON.stringify(pr)));
  // Lisible par l'appareil de l'employé (sync), sans aucun montant.
  const l = await call("/api/login", { email: "paul@ido.ga", password: "motdepasse1", deviceId: "device-paul-0002" });
  const pulled = await call("/api/sync", { since: 0, changes: [] }, l.data.token);
  assert.ok(pulled.data.changes.some((x: Change) => x.tbl === "watch_points" && x.patch.title === "Accès client non fournis"));

  // Clôture refusée par le serveur tant que l'étape Cadrage n'est pas validée (CA6.3) ; Terminé direct refusé (RG1.3).
  const now = "2026-11-24T10:00:00.000Z";
  const closing = ch("project_decisions", "dec-close-1", { project_id: "prj-1", kind: "project_closed", decided_by: admin.id, decided_by_name: "Jimmy Dnt", decided_at: now });
  let r = await call("/api/sync", { since: 0, changes: [closing, ch("projects", "prj-1", { status: "done" })] }, admin.token);
  assert.equal(r.data.rejected.length, 2);
  assert.match(r.data.rejected[0].reason, /l'étape Cadrage n'est pas validée/);
  assert.match(r.data.rejected[1].reason, /seulement par sa clôture/);
  // Étape validée, clôture et passage à Terminé dans le même envoi : acceptés.
  const approve = ch("project_decisions", "dec-ok-1", { project_id: "prj-1", stage_id: "stg-1", kind: "stage_approved", decided_by: admin.id, decided_by_name: "Jimmy Dnt", decided_at: "2026-11-24T09:00:00.000Z" });
  r = await call("/api/sync", { since: 0, changes: [approve, { ...closing, id: crypto.randomUUID(), hlc: clock.tick() }, ch("projects", "prj-1", { status: "done", closed_at: now })] }, admin.token);
  assert.equal(r.data.rejected.length, 0, JSON.stringify(r.data.rejected));
  // Projet clôturé : le connecteur ne peut plus rien y écrire (CA6.4), même la direction.
  const boss = await connect("dnt@ido.ga");
  for (const [name, args] of [
    ["log_time", { task_id: "tsk-1", hours: 1, date: "2026-11-24" }],
    ["create_task", { project: "prj-1", title: "Après la clôture" }],
    ["update_task", { task_id: "tsk-1", status: "todo" }],
    ["add_comment", { task_id: "tsk-1", body: "Encore un mot" }],
    ["add_watch_point", { project: "prj-1", title: "Trop tard" }],
  ] as const) {
    const res = await tool(boss.access!, name, args);
    assert.equal(res.isError, true, `${name} refusé : ${JSON.stringify(res).slice(0, 300)}`);
    assert.match(res.content[0].text, /clôturé/, name);
  }
  assert.equal((await tool(boss.access!, "get_project", { project: "prj-1" })).structuredContent.closed, true);
  // Seule la réouverture (direction, avec motif) rend le projet modifiable.
  const reopen = ch("project_decisions", "dec-reopen-1", { project_id: "prj-1", kind: "project_reopened", comment: "Défaut signalé", decided_by: admin.id, decided_by_name: "Jimmy Dnt", decided_at: "2026-11-24T11:00:00.000Z" });
  r = await call("/api/sync", { since: 0, changes: [reopen, ch("projects", "prj-1", { status: "active" })] }, admin.token);
  assert.equal(r.data.rejected.length, 0, JSON.stringify(r.data.rejected));
  assert.equal((await tool(boss.access!, "add_comment", { task_id: "tsk-1", body: "Repris" })).isError, false);
});
