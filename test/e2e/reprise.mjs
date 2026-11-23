/**
 * Recette de bout en bout de la reprise d'historique VosFactures (fichier d'exemple, données fictives) :
 *  - Réglages › Reprise d'historique : aperçu, contrôle par année, année manquante signalée, choix du vendeur ;
 *  - reprise : factures, devis, avoir, clients, encaissements ; numéros et montants d'origine ;
 *  - retenue à la source reprise d'une TVA négative ; facture annulée hors chiffres ;
 *  - relance avec le même fichier : rien à ajouter ;
 *  - la numérotation de Gestia n'est pas touchée : la facture suivante est FA-AAAA-00001.
 *
 * Prérequis : `npm run build`, Playwright.
 *   node test/e2e/reprise.mjs
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const root = join(import.meta.dirname, "..", "..");
const PORT = 8812;
const BASE = `http://localhost:${PORT}`;
const YEAR = new Date().getFullYear();
const shots = process.env.SHOTS_DIR;
const FILE = join(root, "test", "fixtures", "vosfactures-exemple.csv");

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
const shot = async (file) => shots && page.screenshot({ path: join(shots, file), fullPage: true });
const txt = async (id) => (await page.getByTestId(id).textContent()).replace(/\s/g, " ").trim();
const open = async (tab, number) => {
  await nav(tab);
  await page.locator("tbody tr", { hasText: number }).first().click();
  await page.getByTestId("doc-imported").waitFor();
};

try {
  step("Inscription");
  await page.goto(BASE);
  await page.getByRole("button", { name: "Créer mon entreprise" }).click();
  await page.getByLabel("Nom de l'entreprise").fill("ACME");
  await page.getByLabel("Votre nom").fill("Jimmy");
  await page.getByLabel("Téléphone").fill("+241 077 00 00 00");
  await page.getByLabel("E-mail").fill("dnt@acme.example");
  await page.getByLabel("Mot de passe", { exact: true }).fill("motdepasse1");
  await page.getByLabel("Confirmer le mot de passe").fill("motdepasse1");
  await page.getByRole("button", { name: "Démarrer l'essai gratuit" }).click();
  await pill().filter({ hasText: "À jour" }).waitFor({ timeout: 10_000 });

  step("Réglages › Reprise d'historique : aperçu et contrôle par année");
  await nav("Réglages");
  await page.getByLabel("Exports CSV VosFactures").setInputFiles(FILE);
  const preview = page.getByTestId("import-history-preview");
  await preview.waitFor();
  const summary = (await preview.innerText()).replace(/\s/g, " ");
  assert.match(summary, /1 fichier lu : 6 factures, 1 avoir, 3 devis et bons, 4 nouveaux clients, 3 encaissements/);
  assert.match(summary, /1 facture annulée gardée pour mémoire/);
  assert.match(await txt("import-history-missing"), /2021/);
  // Année 2022 : acompte 5 030 000 + facture avec retenue 1 947 000 HT.
  assert.match((await preview.locator("tbody tr", { hasText: "2022" }).innerText()).replace(/\s/g, " "), /2022 2 6 977 000 7 687 700 6 935 400 752 300/);
  // Le vendeur « AUTRE » n'est pas de cette entreprise : décoché.
  await preview.locator(".import-history-sellers label", { hasText: "AUTRE" }).locator("input").uncheck();
  await shot("reprise-apercu.png");

  step("Reprise, puis envoi au serveur");
  await page.getByTestId("import-history-run").click();
  assert.match(await txt("import-history-done"), /Reprise terminée : 15 éléments ajoutés\.$/);
  await pill().filter({ hasText: "À jour" }).waitFor({ timeout: 10_000 });

  step("Relance avec le même fichier : rien à ajouter");
  await page.getByLabel("Exports CSV VosFactures").setInputFiles(FILE);
  await preview.locator(".import-history-sellers label", { hasText: "AUTRE" }).locator("input").uncheck();
  await page.getByTestId("import-history-uptodate").waitFor();

  step("Factures : numéros d'origine, statuts, annulée hors chiffres");
  await nav("Factures");
  const row = (n) => page.locator("tbody tr", { hasText: n }).first();
  assert.match(await row("FALPHA001").innerText(), /Payée/);
  assert.match(await row("FBETA001").innerText(), /Partiellement payée|En retard/);
  assert.match(await row("FALPHA003").innerText(), /Annulée/);
  await shot("reprise-factures.png");

  step("Facture avec retenue à la source : montants d'origine");
  await open("Factures", "FBETA001");
  assert.equal(await txt("total-ht"), "1 947 000 FCFA");
  assert.equal(await txt("total-vat"), "0 FCFA");
  assert.equal(await txt("total-withholding"), "-194 700 FCFA");
  assert.equal(await txt("total-payable"), "1 752 300 FCFA");
  await shot("reprise-facture-retenue.png");

  step("Facture à décimales : total d'origine arrondi au franc, avoir déduit du reste dû");
  await open("Factures", "FALPHA002");
  assert.equal(await txt("total-ht"), "450 444 FCFA");
  assert.equal(await txt("total-ttc"), "531 524 FCFA");
  await open("Avoirs", "AALPHA001");
  assert.equal(await txt("total-ttc"), "236 000 FCFA");

  step("Devis facturé et bon d'intervention");
  await nav("Devis");
  assert.match(await row("DALPHA001").innerText(), /Facturé/);
  assert.equal(await row("DOMEGA001").count(), 0);
  await open("Devis", "BIALPHA001");
  assert.match(await page.locator("h2").first().innerText(), /Bon d'intervention BIALPHA001/);

  step("La numérotation de Gestia n'est pas touchée");
  await nav("Factures");
  await page.getByRole("button", { name: "Nouvelle facture" }).first().click();
  await page.getByLabel("Désignation").fill("Prestation");
  await page.getByLabel("Prix unitaire").first().fill("1000");
  await page.getByRole("button", { name: "Valider la facture" }).click();
  await page.locator("h2", { hasText: `FA-${YEAR}-00001` }).waitFor({ timeout: 10_000 });

  assert.deepEqual(errors, []);
  console.log("OK : reprise d'historique VosFactures");
} finally {
  await browser.close();
  server.kill();
}
