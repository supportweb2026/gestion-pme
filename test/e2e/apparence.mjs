/**
 * Recette de l'apparence des documents (lot 8) :
 *  - Réglages > Apparence : couleur, cachet et signature, note par défaut, conditions générales ;
 *  - nouvelle facture : note préremplie ; aperçu et PDF avec couleur, cachet et conditions.
 *
 * Prérequis : `npm run build`, Playwright.
 *   node test/e2e/apparence.mjs        (SHOTS_DIR=… pour des captures)
 */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const root = join(import.meta.dirname, "..", "..");
const PORT = 8803;
const BASE = `http://localhost:${PORT}`;
const YEAR = new Date().getFullYear();
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-app-"));

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
  step("Inscription et client");
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
  await page.getByLabel("Raison sociale").fill("Fête des Cultures");
  await page.getByRole("button", { name: "Enregistrer" }).click();

  step("Réglages > Apparence : vert, cachet, note par défaut, conditions générales");
  await nav("Réglages");
  await page.getByRole("tab", { name: "Documents" }).click();
  const card = page.locator("form.doc-look-card");
  await card.getByRole("button", { name: "Vert" }).click();
  // Cachet : petite image PNG générée dans la page.
  const stampPng = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 200; c.height = 100;
    const g = c.getContext("2d");
    g.strokeStyle = "#1a3d8f"; g.lineWidth = 6; g.beginPath(); g.arc(100, 50, 42, 0, Math.PI * 2); g.stroke();
    return c.toDataURL("image/png").split(",")[1];
  });
  const stampFile = join(out, "cachet.png");
  writeFileSync(stampFile, Buffer.from(stampPng, "base64"));
  await card.locator("input[type=file]").setInputFiles(stampFile);
  await card.getByAltText("Cachet actuel").waitFor();
  await card.getByLabel("Note par défaut des nouvelles factures").fill("Merci de rappeler le numéro de facture lors du paiement.");
  await card.getByLabel("Conditions générales de vente").fill("Pénalités de retard : 1,5 % par mois. Les marchandises restent notre propriété jusqu'au paiement complet.");
  await card.getByRole("button", { name: "Enregistrer l'apparence" }).click();
  await card.getByText("Enregistré").waitFor();
  await shot("reglages-apparence.png");

  step("Nouvelle facture : note préremplie");
  await nav("Factures");
  await page.getByRole("button", { name: "Nouvelle facture" }).first().click();
  await line(0, "Sonorisation", 1, 400_000);
  await page.waitForFunction(() => [...document.querySelectorAll("textarea")].some((t) => t.value.startsWith("Merci de rappeler")));
  await page.getByRole("button", { name: "Valider la facture" }).click();
  await heading(`Facture FA-${YEAR}-00001`);

  step("Aperçu : titre vert, cachet et conditions générales");
  await page.getByRole("button", { name: "Aperçu / imprimer" }).click();
  const color = await page.locator(".ps-doc").evaluate((e) => getComputedStyle(e).color);
  assert.equal(color, "rgb(15, 122, 77)");
  await page.locator(".ps-stamp img").waitFor();
  await page.locator(".ps-terms").getByText(/Pénalités de retard/).waitFor();
  await shot("apercu.png");
  await page.getByRole("button", { name: "Fermer" }).click();

  step("PDF : cachet de l'entreprise, note et conditions générales");
  const pdf = await pdfText("facture.pdf");
  assert.ok(/POUR \S|CACHET ET SIGNATURE/.test(pdf.text), pdf.text);
  assert.ok(pdf.text.includes("CONDITIONS GÉNÉRALES") && pdf.text.includes("Pénalités de retard"), pdf.text);
  assert.ok(pdf.text.includes("Merci de rappeler le numéro de facture"), pdf.text);
  const raw = readFileSync(join(out, "facture.pdf"));
  assert.ok(raw.includes(Buffer.from("/Subtype /Image")), "le cachet est une image du PDF");

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nRecette de l'apparence des documents réussie.");
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  await page.screenshot({ path: join(out, "echec.png"), fullPage: true }).catch(() => {});
  console.error(`Capture : ${join(out, "echec.png")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
