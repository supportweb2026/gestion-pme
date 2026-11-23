/**
 * Recette des factures récurrentes (lot 5) :
 *  - une facture validée est répétée chaque mois depuis sa fiche ;
 *  - à l'échéance, un brouillon identique est préparé (une seule fois, même après rechargement) ;
 *  - le brouillon renvoie à la facture modèle, se valide normalement ;
 *  - filtre « Récurrentes », arrêt de la série.
 *
 * Prérequis : `npm run build`, Playwright.
 *   node test/e2e/recurrence.mjs        (SHOTS_DIR=… pour des captures)
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
const PORT = 8801;
const BASE = `http://localhost:${PORT}`;
const YEAR = new Date().getFullYear();
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-rec-"));

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
  step("Inscription, client et facture d'abonnement validée");
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
  await page.getByLabel("Raison sociale").fill("Gabon Review");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await nav("Factures");
  await page.getByRole("button", { name: "Nouvelle facture" }).first().click();
  await page.getByLabel("Date", { exact: true }).fill(daysAgo(31));
  await line(0, "Hébergement et maintenance du site", 1, 150_000);
  await page.getByRole("button", { name: "Valider la facture" }).click();
  await heading(`Facture FA-${YEAR}-00001`);
  const total = await ttc();

  step("Répéter la facture chaque mois, à partir d'aujourd'hui");
  const card = page.locator(".recurrence-card");
  await card.getByText("Pour un abonnement").waitFor();
  await card.getByLabel("Fréquence").selectOption("monthly");
  await card.getByLabel("Prochaine facture le").fill(iso(new Date()));
  await card.getByRole("button", { name: "Activer la répétition" }).click();

  step("Le brouillon du jour est préparé et la prochaine date avance d'un mois");
  await card.getByText(/Brouillon du/).waitFor({ timeout: 15_000 });
  const status = await card.getByTestId("recur-status").textContent();
  assert.match(status, /Répétée chaque mois/);
  assert.ok(!status.includes(new Date().toLocaleDateString("fr-FR")), `la prochaine date a avancé : ${status}`);
  await shot("serie-active.png");

  step("Factures : tag « Récurrente », entrée « Factures récurrentes », un seul brouillon même après rechargement");
  await page.reload();
  await nav("Factures");
  await page.waitForTimeout(6000);
  await page.getByRole("button", { name: /^Brouillons/ }).click();
  assert.equal(await page.locator("tbody tr").count(), 1, "un seul brouillon préparé");
  await page.locator("tbody tr").first().getByText("Récurrente", { exact: true }).waitFor();
  await nav("Factures récurrentes");
  await page.getByRole("row", { name: new RegExp(`FA-${YEAR}-00001`) }).getByText("Récurrente · mensuelle").waitFor();
  assert.equal(await page.locator("tbody tr").count(), 2, "le modèle et la facture préparée");
  await shot("liste.png");

  step("Le brouillon reprend la facture modèle et se valide normalement");
  await page.getByRole("button", { name: /^Brouillons/ }).click();
  await page.locator("tbody tr .row-link").first().click();
  await page.getByText("Préparée automatiquement d'après la facture récurrente").waitFor();
  assert.equal(await page.getByLabel("Désignation").first().inputValue(), "Hébergement et maintenance du site");
  assert.equal(await ttc(), total);
  await page.getByRole("button", { name: "Valider la facture" }).click();
  await heading(`Facture FA-${YEAR}-00002`);
  await page.getByText("Facture récurrente, d'après").waitFor();
  await shot("occurrence-validee.png");

  step("Arrêt de la série : les factures restent");
  await page.getByRole("button", { name: `FA-${YEAR}-00001` }).click();
  await heading(`Facture FA-${YEAR}-00001`);
  await card.getByRole("button", { name: "Arrêter la répétition" }).click();
  await card.getByText(/Répétition arrêtée après 1 facture/).waitFor();
  await nav("Factures");
  await page.getByRole("button", { name: "Tous", exact: true }).click();
  await page.getByRole("row", { name: new RegExp(`FA-${YEAR}-00002`) }).waitFor();
  assert.equal(await page.locator("tbody tr").count(), 2);

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nRecette des factures récurrentes réussie.");
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  await page.screenshot({ path: join(out, "echec.png"), fullPage: true }).catch(() => {});
  console.error(`Capture : ${join(out, "echec.png")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
