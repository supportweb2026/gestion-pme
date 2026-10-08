/**
 * Test de bout en bout du jalon du lot 0 :
 * « deux appareils se synchronisent sans perte après une coupure ».
 *
 * Prérequis : `npm run build` (ou `bun dev/build-bun.ts`), Playwright installé.
 *   node test/e2e/two-devices.mjs
 * Lance le serveur local sur une base en mémoire, ouvre deux navigateurs
 * indépendants (deux appareils), coupe le réseau de l'un puis de l'autre.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const root = join(import.meta.dirname, "..", "..");
const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const shots = process.env.SHOTS_DIR;

const server = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "dev/server.ts"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), DB_PATH: ":memory:" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("localhost") && resolve()));

const browser = await chromium.launch();
const step = (msg) => console.log(`• ${msg}`);

async function device(name) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, locale: "fr-FR" });
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.error(`[${name}] erreur page :`, e.message));
  return { name, context, page };
}

const pill = (p) => p.getByTestId("sync-pill");
async function waitSynced(p) {
  await pill(p).click();
  await assert.doesNotReject(pill(p).filter({ hasText: "À jour" }).waitFor({ timeout: 10_000 }));
}
const shot = async (p, file) => shots && p.screenshot({ path: join(shots, file), fullPage: true });

try {
  const A = await device("A");
  const B = await device("B");

  step("Appareil A : création de l'entreprise");
  await A.page.goto(BASE);
  await A.page.getByLabel("Nom de l'entreprise").fill("Sodepsi");
  await A.page.getByLabel("Votre nom").fill("Johann");
  await A.page.getByLabel("E-mail").fill("admin@sodepsi.ga");
  await A.page.getByLabel("Mot de passe").fill("motdepasse1");
  await A.page.getByRole("button", { name: "Créer" }).click();
  await waitSynced(A.page);

  step("Appareil A : nouveau client");
  await A.page.getByRole("button", { name: "Clients" }).click();
  await A.page.getByRole("button", { name: "Nouveau client" }).click();
  await A.page.getByLabel("Raison sociale").fill("Total Gabon");
  await A.page.getByLabel("Ville").fill("Port-Gentil");
  await A.page.getByRole("button", { name: "Enregistrer" }).click();
  await waitSynced(A.page);

  step("Appareil B : connexion, le client arrive");
  await B.page.goto(BASE);
  await B.page.getByLabel("E-mail").fill("admin@sodepsi.ga");
  await B.page.getByLabel("Mot de passe").fill("motdepasse1");
  await B.page.getByRole("button", { name: "Se connecter" }).click();
  await waitSynced(B.page);
  await B.page.getByRole("button", { name: "Clients" }).click();
  await B.page.getByRole("cell", { name: "Total Gabon" }).waitFor();
  await B.page.evaluate(() => navigator.serviceWorker.ready);

  step("Coupure réseau sur B : facture créée et validée hors ligne");
  await B.context.setOffline(true);
  await B.page.getByRole("button", { name: "Factures" }).click();
  await B.page.getByRole("button", { name: "Nouvelle facture" }).click();
  await B.page.getByLabel("Désignation").fill("Audit informatique");
  await B.page.getByLabel("Quantité").fill("2");
  await B.page.getByLabel("Prix unitaire").fill("150000");
  assert.equal(await B.page.getByTestId("total-ttc").textContent(), "354 000 FCFA");
  await B.page.getByRole("button", { name: "Valider la facture" }).click();
  await B.page.getByRole("cell", { name: /FA-\d{4}-00051/ }).waitFor();
  await pill(B.page).filter({ hasText: /Hors ligne · \d+ en attente/ }).waitFor();
  await shot(B.page, "b-hors-ligne.png");

  step("B rouvre l'application sans réseau : elle s'ouvre, la facture est là");
  await B.page.reload();
  await B.page.getByRole("button", { name: "Factures" }).click();
  await B.page.getByRole("cell", { name: /FA-\d{4}-00051/ }).waitFor();

  step("Coupure sur A aussi : A modifie le client pendant que B est hors ligne");
  await A.context.setOffline(true);
  await A.page.getByRole("button", { name: "Modifier" }).click();
  await A.page.getByLabel("Téléphone").fill("+241 01 76 00 00");
  await A.page.getByRole("button", { name: "Enregistrer" }).click();

  step("B revient en ligne et envoie sa facture, puis A");
  await B.context.setOffline(false);
  await waitSynced(B.page);
  await A.context.setOffline(false);
  await waitSynced(A.page);
  await waitSynced(B.page);

  step("Vérification croisée : chacun a les données de l'autre");
  await A.page.getByRole("button", { name: "Factures" }).click();
  await A.page.getByRole("cell", { name: /FA-\d{4}-00051/ }).waitFor();
  await A.page.getByRole("cell", { name: "354 000 FCFA" }).waitFor();
  await B.page.getByRole("button", { name: "Clients" }).click();
  await B.page.getByRole("cell", { name: "+241 01 76 00 00" }).waitFor();
  await A.page.getByRole("button", { name: "Tableau de bord" }).click();
  await A.page.getByText("354 000 FCFA").first().waitFor();
  await shot(A.page, "a-tableau-de-bord.png");
  await A.page.getByRole("button", { name: "Factures" }).click();
  await shot(A.page, "a-factures.png");

  console.log("\nOK : deux appareils synchronisés sans perte après coupure.");
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
