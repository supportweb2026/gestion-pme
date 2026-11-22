/**
 * Recette des relances (lot 4) :
 *  - facture échue depuis 10 jours : étape J+7 du calendrier par défaut ;
 *  - Factures > « À relancer » la liste, avec l'étape ;
 *  - jamais relancée : message cordial prérempli (WhatsApp), relance comptée, disparition de la liste ;
 *  - calendrier modifiable dans Réglages.
 *
 * Prérequis : `npm run build`, Playwright.
 *   node test/e2e/relances.mjs        (SHOTS_DIR=… pour des captures)
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
const PORT = 8800;
const BASE = `http://localhost:${PORT}`;
const YEAR = new Date().getFullYear();
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-rel-"));

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
  step("Inscription et client joignable sur WhatsApp");
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
  await page.getByLabel("Raison sociale").fill("Comilog");
  await page.locator("form input[name=phone]").fill("+241 066 11 22 33");
  await page.getByRole("button", { name: "Enregistrer" }).click();

  step("Facture échue depuis 10 jours");
  await nav("Factures");
  await page.getByRole("button", { name: "Nouvelle facture" }).first().click();
  await page.getByLabel("Date", { exact: true }).fill(daysAgo(40));
  await page.getByLabel("Échéance").fill(daysAgo(10));
  await line(0, "Maintenance", 1, 200_000);
  await page.getByRole("button", { name: "Valider la facture" }).click();
  await heading(`Facture FA-${YEAR}-00001`);

  step("Factures > « À relancer » : la facture y est, à l'étape J+7");
  await nav("Factures");
  await page.getByRole("button", { name: /^À relancer/ }).click();
  const row = page.getByRole("row", { name: new RegExp(`FA-${YEAR}-00001`) });
  await row.getByText("À relancer · J+7").waitFor();
  await shot("a-relancer.png");

  step("Première relance (ton cordial) préremplie, envoyée par WhatsApp puis comptée");
  await row.locator(".row-link").click();
  await page.getByText("Relance prévue aujourd'hui", { exact: false }).waitFor();
  const wa = page.getByRole("link", { name: "Relancer par WhatsApp" });
  const href = decodeURIComponent(await wa.getAttribute("href"));
  assert.ok(href.startsWith("https://wa.me/24106611223"), href);
  assert.ok(href.includes("Sauf erreur de notre part") && href.includes("236 000 FCFA"), href);
  await context.route("https://wa.me/**", (r) => r.fulfill({ status: 200, body: "ok" }));
  const [popup] = await Promise.all([context.waitForEvent("page"), wa.click()]);
  await popup.close();
  await page.getByText(/Relancé 1 fois/).waitFor();
  await shot("relance-envoyee.png");

  step("Relancée aujourd'hui : la facture sort de « À relancer »");
  await nav("Factures");
  await page.getByRole("button", { name: /^À relancer/ }).click();
  await page.getByText("Aucun document ne correspond").waitFor();

  step("Réglages > Relances : calendrier modifiable");
  await nav("Réglages");
  const card = page.locator("form", { hasText: "Relances des factures" });
  await card.getByLabel("Étapes, par rapport à l'échéance").fill("J+1 ; j+30 ; J-5");
  await card.getByRole("button", { name: "Enregistrer les relances" }).click();
  await card.getByText("Enregistré").waitFor();
  assert.equal(await card.getByLabel("Étapes, par rapport à l'échéance").inputValue(), "J-5 ; J+1 ; J+30");

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nRecette des relances réussie.");
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  await page.screenshot({ path: join(out, "echec.png"), fullPage: true }).catch(() => {});
  console.error(`Capture : ${join(out, "echec.png")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
