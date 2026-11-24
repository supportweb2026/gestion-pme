/**
 * Test de bout en bout : changement de compte sur le même navigateur.
 *
 * Incident du 24/11/2026 : l'administrateur crée un compte, s'y connecte pour
 * l'essayer, puis revient sur son propre compte : ses factures et ses articles
 * n'apparaissaient plus, car le serveur ne renvoyait pas à cet appareil ce qui
 * y avait été saisi. Les données, elles, étaient intactes sur le serveur.
 *
 * Prérequis : `npm run build`, Playwright installé.
 *   node test/e2e/changement-compte.mjs
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const root = join(import.meta.dirname, "..", "..");
const PORT = 8812;
const BASE = `http://localhost:${PORT}`;

const server = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "dev/server.ts"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), DB_PATH: ":memory:" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("localhost") && resolve()));

const browser = await chromium.launch();
const step = (msg) => console.log(`• ${msg}`);
const errors = [];

const post = async (path, body, token) => {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return r.json();
};

try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 860 }, locale: "fr-FR" });
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => errors.push(e.message));
  const pill = page.getByTestId("sync-pill");
  const waitSynced = async () => {
    await pill.click();
    await pill.filter({ hasText: "À jour" }).waitFor({ timeout: 15_000 });
  };
  const nav = (label) => page.getByRole("navigation").getByRole("button", { name: label, exact: true }).click();
  const login = async (email, password) => {
    await page.getByRole("heading", { name: "Connexion" }).waitFor();
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Mot de passe").fill(password);
    await page.getByRole("button", { name: "Se connecter" }).click();
  };
  const logout = () => page.getByRole("button", { name: "Se déconnecter" }).first().click();

  step("Administrateur : entreprise, client et article saisis depuis ce navigateur");
  await page.goto(BASE);
  await page.getByRole("button", { name: "Créer mon entreprise" }).click();
  await page.getByLabel("Nom de l'entreprise").fill("Sodepsi");
  await page.getByLabel("Votre nom").fill("Jimmy");
  await page.getByLabel("Téléphone").fill("+241 077 00 00 00");
  await page.getByLabel("E-mail").fill("admin@sodepsi.ga");
  await page.getByLabel("Mot de passe", { exact: true }).fill("motdepasse1");
  await page.getByLabel("Confirmer le mot de passe").fill("motdepasse1");
  await page.getByRole("button", { name: "Démarrer l'essai gratuit" }).click();
  await waitSynced();
  await nav("Clients");
  await page.getByRole("button", { name: "Nouveau client" }).click();
  await page.getByLabel("Raison sociale").fill("Total Gabon");
  await page.getByLabel("Ville").fill("Port-Gentil");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await nav("Articles");
  await page.getByRole("button", { name: "Nouvel article" }).click();
  await page.getByLabel("Désignation").fill("Audit informatique");
  await page.getByLabel("Prix unitaire HT (FCFA)").fill("150000");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await waitSynced();

  step("Création d'un chef de projet (depuis un autre appareil, par l'API)");
  const admin = await post("/api/login", { email: "admin@sodepsi.ga", password: "motdepasse1", deviceId: "device-outil-0001" });
  await post("/api/users", { name: "Nicolas", email: "nicolas@sodepsi.ga", role: "project_manager", password: "provisoire1" }, admin.token);

  step("Déconnexion, essai du nouveau compte sur le même navigateur");
  await logout();
  await login("nicolas@sodepsi.ga", "provisoire1");
  await page.getByLabel("Mot de passe provisoire").fill("provisoire1");
  await page.getByLabel("Nouveau mot de passe").fill("nicolas-2026");
  await page.getByLabel("Confirmer").fill("nicolas-2026");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await waitSynced();

  step("Retour sur le compte administrateur : client et article doivent réapparaître");
  await logout();
  await login("admin@sodepsi.ga", "motdepasse1");
  await waitSynced();
  await nav("Articles");
  await page.getByRole("cell", { name: "Audit informatique" }).waitFor({ timeout: 15_000 });
  await nav("Clients");
  await page.getByText("Total Gabon").first().waitFor({ timeout: 15_000 });

  step("Appareil resté dans l'état de l'incident (copie vide, ancienne version) : rechargé à l'ouverture");
  await page.evaluate(async () => {
    const db = await new Promise((ok, ko) => { const o = indexedDB.open("gestion-pme"); o.onsuccess = () => ok(o.result); o.onerror = ko; });
    const tx = db.transaction(["records", "meta"], "readwrite");
    tx.objectStore("records").clear();
    tx.objectStore("meta").put(1, "dataEpoch");
    tx.objectStore("meta").put(false, "rebuild");
    await new Promise((ok) => { tx.oncomplete = ok; });
    db.close();
  });
  await page.reload();
  await waitSynced();
  await nav("Articles");
  await page.getByRole("cell", { name: "Audit informatique" }).waitFor({ timeout: 15_000 });

  if (errors.length) throw new Error(`erreurs de page : ${errors.join(" | ")}`);
  console.log("✓ changement de compte : les données de l'administrateur sont rechargées");
} finally {
  await browser.close();
  server.kill();
}
