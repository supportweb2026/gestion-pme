/**
 * Recette des commandes fournisseurs (suite du lot 7) :
 *  - Articles > « Commander » : les produits en stock bas sont proposés avec la quantité à recommander ;
 *  - commande enregistrée : liste « en cours », message WhatsApp prérempli, « en commande » dans le stock ;
 *  - réception : entrée en stock, coût moyen recalculé, commande close.
 *
 * Prérequis : `npm run build`, Playwright.
 *   node test/e2e/commandes.mjs        (SHOTS_DIR=… pour des captures)
 */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const root = join(import.meta.dirname, "..", "..");
const PORT = 8805;
const BASE = `http://localhost:${PORT}`;
const YEAR = new Date().getFullYear();
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-cf-"));

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
const shot = async (file) => shots && page.screenshot({ path: join(shots, file), fullPage: true });
const ttc = () => page.getByTestId("total-ttc").first().textContent();
const heading = (name) => page.getByRole("heading", { name }).waitFor();

async function pdfText(name) {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Télécharger le PDF" }).first().click()]);
  const file = join(out, name);
  await download.saveAs(file);
  const raw = execFileSync("pdftotext", [file, "-"]).toString().replace(/\s+/g, " ");
  return { name: download.suggestedFilename(), text: raw };
}
async function line(i, label, qty, price) {
  await page.getByLabel("Désignation").nth(i).fill(label);
  await page.getByLabel("Quantité").nth(i).fill(String(qty));
  await page.getByLabel("Prix unitaire").nth(i).fill(String(price));
}

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 86_400_000));

try {
  step("Inscription et produit en stock bas (2 en stock, alerte à 5)");
  await page.goto(BASE);
  await page.getByRole("button", { name: "Créer mon entreprise" }).click();
  await page.getByLabel("Nom de l'entreprise").fill("IDO");
  await page.getByLabel("Votre nom").fill("Jimmy");
  await page.getByLabel("Téléphone").fill("+241 077 00 00 00");
  await page.getByLabel("E-mail").fill("dnt@ido.ga");
  await page.getByLabel("Mot de passe", { exact: true }).fill("motdepasse1");
  await page.getByLabel("Confirmer le mot de passe").fill("motdepasse1");
  await page.getByRole("button", { name: "Démarrer l'essai gratuit" }).click();
  await nav("Articles");
  await page.getByRole("button", { name: "Nouvel article" }).click();
  await page.getByLabel("Désignation").fill("Sac de ciment");
  await page.getByLabel("Type").selectOption("product");
  await page.getByLabel("Prix unitaire HT (FCFA)").fill("6500");
  await page.getByLabel("Prix d'achat HT (FCFA)").fill("4000");
  await page.getByLabel("Suivre le stock de ce produit").check();
  await page.getByLabel("Seuil d'alerte").fill("5");
  await page.getByLabel("Stock de départ").fill("2");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  const stockCell = () => page.getByRole("row", { name: /Sac de ciment/ }).locator(".c-stock");
  await stockCell().getByText("Stock bas").waitFor();

  step("Commander : 8 sacs proposés pour remonter au double du seuil");
  await page.getByRole("button", { name: "Commander (1 en stock bas)" }).click();
  const form = page.getByRole("form", { name: "Nouvelle commande fournisseur" });
  assert.equal(await form.getByLabel("Quantité à commander").inputValue(), "8");
  assert.equal(await form.getByLabel("Coût unitaire HT").inputValue(), "4000");
  await form.getByLabel("Fournisseur", { exact: true }).fill("CIMGABON");
  await form.getByLabel("WhatsApp du fournisseur").fill("+241 011 22 33 44");
  await form.getByLabel("Coût unitaire HT").fill("4600");
  await form.getByTestId("order-total").getByText("36 800 FCFA").waitFor();
  await shot("commande.png");
  await form.getByRole("button", { name: "Enregistrer la commande" }).click();

  step("Commande en cours : message WhatsApp, quantité « en commande »");
  const orders = page.getByRole("region", { name: "Commandes fournisseurs en cours" });
  await orders.getByText("CIMGABON").waitFor();
  const href = decodeURIComponent(await orders.getByRole("link", { name: "Envoyer par WhatsApp" }).getAttribute("href"));
  assert.ok(href.startsWith("https://wa.me/24101122334"), href);
  assert.ok(href.includes("- 8 × Sac de ciment") && /commande CF-\d{6}-1/.test(href), href);
  await stockCell().getByText("+8 en commande").waitFor();
  await shot("en-cours.png");

  step("Réception : 10 en stock, coût moyen (2 × 4 000 + 8 × 4 600) / 10 = 4 480");
  await orders.getByRole("button", { name: "Réceptionner" }).click();
  await stockCell().getByText("10", { exact: true }).waitFor();
  assert.equal(await stockCell().getByText("Stock bas").count(), 0);
  assert.equal(await page.getByRole("region", { name: "Commandes fournisseurs en cours" }).count(), 0);
  await stockCell().getByRole("button").click();
  const panel = page.getByRole("region", { name: "Stock de Sac de ciment" });
  await panel.getByText(/Coût moyen 4\s480 FCFA/).waitFor();
  await panel.getByText(/Réception fournisseur · CIMGABON · CF-\d{6}-1/).waitFor();

  step("Synchronisation : commandes et mouvements acceptés par le serveur");
  await page.getByText("À jour", { exact: true }).first().waitFor({ timeout: 30_000 });

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nRecette des commandes fournisseurs réussie.");
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  await page.screenshot({ path: join(out, "echec.png"), fullPage: true }).catch(() => {});
  console.error(`Capture : ${join(out, "echec.png")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
