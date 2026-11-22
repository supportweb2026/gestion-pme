/**
 * Recette du stock (lot 7) :
 *  - produit suivi avec stock de départ et seuil d'alerte ;
 *  - dans la facture, le stock disponible s'affiche ; la facture validée fait sortir le stock ;
 *  - réception fournisseur : entrée et coût moyen pondéré ;
 *  - alerte « Stock bas », filtre, correction d'inventaire, historique.
 *
 * Prérequis : `npm run build`, Playwright.
 *   node test/e2e/stock.mjs        (SHOTS_DIR=… pour des captures)
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
const PORT = 8802;
const BASE = `http://localhost:${PORT}`;
const YEAR = new Date().getFullYear();
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-stk-"));

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
  step("Inscription, client et produit suivi en stock");
  await page.goto(BASE);
  await page.getByRole("button", { name: "Créer mon entreprise" }).click();
  await page.getByLabel("Nom de l'entreprise").fill("IDO");
  await page.getByLabel("Votre nom").fill("Jimmy");
  await page.getByLabel("Téléphone").fill("+241 077 00 00 00");
  await page.getByLabel("E-mail").fill("dnt@ido.ga");
  await page.getByLabel("Mot de passe", { exact: true }).fill("motdepasse1");
  await page.getByLabel("Confirmer le mot de passe").fill("motdepasse1");
  await page.getByRole("button", { name: "Démarrer l'essai gratuit" }).click();
  await nav("Clients");
  await page.getByRole("button", { name: "Nouveau client" }).click();
  await page.getByLabel("Raison sociale").fill("SOBRAGA");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await nav("Articles");
  await page.getByRole("button", { name: "Nouvel article" }).click();
  await page.getByLabel("Désignation").fill("Routeur Wi-Fi");
  await page.getByLabel("Type").selectOption("product");
  await page.getByLabel("Prix unitaire HT (FCFA)").fill("50000");
  await page.getByLabel("Prix d'achat HT (FCFA)").fill("30000");
  await page.getByLabel("Suivre le stock de ce produit").check();
  await page.getByLabel("Seuil d'alerte").fill("3");
  await page.getByLabel("Stock de départ").fill("10");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  const stockCell = () => page.getByRole("row", { name: /Routeur Wi-Fi/ }).locator(".c-stock");
  await stockCell().getByText("10").waitFor();
  await page.getByText("stock valorisé 300 000 FCFA").waitFor();

  step("Facture : stock disponible affiché, la validation fait sortir 4 routeurs");
  await nav("Factures");
  await page.getByRole("button", { name: "Nouvelle facture" }).first().click();
  await page.locator("#articles-list option").first().waitFor({ state: "attached" });
  await page.getByLabel("Désignation").fill("Routeur Wi-Fi");
  await page.getByTestId("stock-hint").getByText("10 en stock").waitFor();
  await page.getByLabel("Quantité").fill("12");
  await page.getByTestId("stock-hint").getByText("Stock insuffisant : 10 disponibles").waitFor();
  await page.getByLabel("Quantité").fill("4");
  await page.getByRole("button", { name: "Valider la facture" }).click();
  await heading(`Facture FA-${YEAR}-00001`);
  await nav("Articles");
  await stockCell().getByText("6").waitFor();

  step("Réception fournisseur : +5 à 36 000 FCFA, coût moyen recalculé");
  await stockCell().getByRole("button").click();
  const panel = page.getByRole("region", { name: "Stock de Routeur Wi-Fi" });
  await panel.getByRole("button", { name: "Réception fournisseur" }).click();
  await panel.getByLabel("Quantité reçue").fill("5");
  await panel.getByLabel("Coût d'achat unitaire HT (FCFA)").fill("36000");
  await panel.getByLabel("Fournisseur", { exact: true }).fill("Netis Gabon");
  await panel.getByLabel("N° du bon ou de la facture fournisseur").fill("BR-778");
  await panel.getByRole("button", { name: "Enregistrer la réception" }).click();
  await panel.getByTestId("stock-qty").filter({ hasText: /^11$/ }).waitFor();
  // (6 × 30 000 + 5 × 36 000) / 11 = 32 727
  await panel.getByText(/Coût moyen 32\s727 FCFA/).waitFor();
  await panel.getByText("Réception fournisseur · Netis Gabon · BR-778").waitFor();
  await panel.getByRole("button", { name: `Facture FA-${YEAR}-00001` }).waitFor();
  await shot("fiche-stock.png");

  step("Nouvelle vente de 9 : alerte « Stock bas » et filtre");
  await nav("Factures");
  await page.getByRole("button", { name: "Nouvelle facture" }).first().click();
  await page.locator("#articles-list option").first().waitFor({ state: "attached" });
  await page.getByLabel("Désignation").fill("Routeur Wi-Fi");
  await page.getByTestId("stock-hint").getByText("11 en stock").waitFor();
  await page.getByLabel("Quantité").fill("9");
  await page.getByRole("button", { name: "Valider la facture" }).click();
  await heading(`Facture FA-${YEAR}-00002`);
  await nav("Articles");
  await stockCell().getByText("Stock bas").waitFor();
  await page.getByRole("button", { name: /^Stock bas/ }).click();
  assert.equal(await page.locator("tbody tr").count(), 1);
  await shot("stock-bas.png");

  step("Inventaire : 1 routeur compté, l'écart est enregistré");
  await stockCell().getByRole("button").click();
  await panel.getByRole("button", { name: "Corriger le stock" }).click();
  await panel.getByLabel("Quantité comptée").fill("1");
  await panel.getByRole("button", { name: "Enregistrer la correction" }).click();
  await panel.getByTestId("stock-qty").filter({ hasText: /^1$/ }).waitFor();
  await panel.locator(".stock-history li", { hasText: "Inventaire" }).getByText("-1").waitFor();

  step("Synchronisation : le serveur accepte les mouvements de stock");
  await page.getByText("À jour", { exact: true }).first().waitFor({ timeout: 30_000 });

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nRecette du stock réussie.");
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  await page.screenshot({ path: join(out, "echec.png"), fullPage: true }).catch(() => {});
  console.error(`Capture : ${join(out, "echec.png")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
