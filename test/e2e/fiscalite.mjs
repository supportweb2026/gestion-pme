/**
 * Recette de la fiscalité gabonaise (lot 3), dans Réglages et l'éditeur de facture :
 *  - Réglages > Fiscalité : CSS 1 %, NIF client exigé, mention de pénalités ;
 *  - facture avec retenue à la source : CSS, TTC, retenue, net à payer ;
 *  - NIF manquant bloquant, levé en complétant la fiche client ;
 *  - encaissement proposé par virement au-delà de 500 000 FCFA, reste dû sur le net ;
 *  - numéro E-Fact saisi après validation et imprimé ; PDF relu.
 *
 * Prérequis : `npm run build`, Playwright, pdftotext (poppler-utils).
 *   node test/e2e/fiscalite.mjs        (SHOTS_DIR=… pour des captures)
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
const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const YEAR = new Date().getFullYear();
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-fisc-"));

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

try {
  step("Inscription et client sans NIF");
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
  await page.getByRole("button", { name: "Enregistrer" }).click();

  step("Réglages > Fiscalité : CSS 1 %, NIF exigé, pénalités de retard");
  await nav("Réglages");
  const fiscal = page.locator(".fiscal-card");
  await fiscal.getByLabel(/Facturer la CSS/).check();
  await fiscal.getByLabel(/numéro fiscal des entreprises/).check();
  await fiscal.getByLabel("Pénalités de retard (mention)").fill("Pénalités de retard : 1,5 % par mois.");
  await fiscal.getByRole("button", { name: "Enregistrer la fiscalité" }).click();
  await fiscal.getByText("Enregistré").waitFor();
  await shot("reglages-fiscalite.png");

  step("Facture d'un million HT avec précompte de 9,5 % : CSS, TTC, retenue, net à payer");
  await nav("Factures");
  await page.getByRole("button", { name: "Nouvelle facture" }).click();
  await line(0, "Audit de sécurité", 1, 1_000_000);
  await page.getByLabel("Retenue à la source").selectOption({ label: "Précompte prestataire local (9,5 %)" });
  assert.equal(await page.getByTestId("total-css").textContent(), "10 000 FCFA");
  assert.equal(await ttc(), "1 190 000 FCFA", "1 000 000 + TVA 180 000 + CSS 10 000");
  assert.equal(await page.getByTestId("total-withholding").textContent(), "-95 000 FCFA");
  assert.equal(await page.getByTestId("total-payable").textContent(), "1 095 000 FCFA");
  await shot("facture-fiscalite.png");

  step("NIF du client manquant : validation refusée, puis fiche complétée");
  await page.getByRole("button", { name: "Valider la facture" }).click();
  await page.getByRole("alert").filter({ hasText: "NIF du client" }).waitFor();
  await page.getByRole("button", { name: "Enregistrer le brouillon" }).click();
  await nav("Clients");
  await page.getByRole("row", { name: /Comilog/ }).getByRole("button", { name: "Modifier" }).click();
  await page.getByLabel("NIF").fill("202301234X");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await nav("Factures");
  await page.locator(".row-link").first().click();
  await page.getByRole("button", { name: "Valider la facture" }).click();
  await heading(`Facture FA-${YEAR}-00001`);

  step("Reste dû = net à payer ; virement proposé au-delà de 500 000 FCFA");
  await page.getByTestId("due").filter({ hasText: "1 095 000 FCFA" }).waitFor();
  assert.equal(await page.getByLabel("Mode").inputValue(), "transfer");

  step("Numéro E-Fact saisi après validation, puis PDF relu");
  await page.getByLabel("N° de validation de la facture normalisée").fill("GA-EF-2026-000123");
  await page.locator("form", { hasText: "E-Fact (DGI)" }).getByRole("button", { name: "Enregistrer" }).click();
  await page.getByText("Enregistré").first().waitFor();
  const pdf = await pdfText("facture.pdf");
  for (const expected of ["CSS 1 %", "10 000 FCFA", "Retenue à la source 9,5 %", "-95 000 FCFA", "Net à payer", "1 095 000 FCFA",
    "espèces non acceptées à partir de 500 000 FCFA", "Pénalités de retard : 1,5 % par mois.", "GA-EF-2026-000123", "NIF : 202301234X"]) {
    assert.ok(pdf.text.includes(expected), `PDF : « ${expected} » absent\n${pdf.text}`);
  }

  step("Encaissement du net à payer : facture soldée");
  await page.getByRole("button", { name: "Enregistrer l'encaissement" }).click();
  await page.getByText("Facture réglée intégralement.").waitFor();

  step("Téléphone : réglages fiscaux sans débordement horizontal");
  await page.setViewportSize({ width: 390, height: 844 });
  await nav("Réglages").catch(async () => {
    await page.getByRole("button", { name: "Plus" }).click();
    await page.getByRole("button", { name: "Réglages" }).click();
  });
  await page.locator(".fiscal-card").waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `débordement horizontal de ${overflow}px`);
  await shot("reglages-fiscalite-mobile.png");

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nRecette de la fiscalité réussie.");
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  await page.screenshot({ path: join(out, "echec.png"), fullPage: true }).catch(() => {});
  console.error(`Capture : ${join(out, "echec.png")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
