/**
 * Recette du lot 8c : objectif mensuel de chiffre d'affaires et trésorerie à venir.
 *  - sans objectif, rien ne s'affiche ; Réglages > Objectif mensuel le fixe ;
 *  - une facture partiellement encaissée : objectif à 50 %, reste dû dans les colonnes 30/60/90 j ;
 *  - téléphone : colonnes empilées, pas de débordement.
 *
 * Prérequis : `npm run build`, Playwright.  node test/e2e/tresorerie.mjs
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const root = join(import.meta.dirname, "..", "..");
const PORT = 8811;
const BASE = `http://localhost:${PORT}`;
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-tresorerie-"));

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
const pill = () => page.getByTestId("sync-pill");
const waitSynced = async () => {
  await pill().click();
  await pill().filter({ hasText: "À jour" }).waitFor({ timeout: 10_000 });
};
const shot = async (file) => shots && page.screenshot({ path: join(shots, file), fullPage: true });
const kpi = (id) => page.getByTestId(id).locator(".kpi-value");
const expectKpi = async (id, value) => {
  await page.getByTestId(id).locator(".kpi-value").filter({ hasText: new RegExp(`^${value}FCFA$`) }).waitFor({ timeout: 5000 })
    .catch(async () => assert.fail(`${id} : attendu ${value}, obtenu ${await kpi(id).textContent()}`));
};

async function newClient(name) {
  await nav("Clients");
  await page.getByRole("button", { name: "Nouveau client" }).click();
  await page.getByLabel("Raison sociale").fill(name);
  await page.getByRole("button", { name: "Enregistrer" }).click();
}
async function newArticle(label, price, kind, cost) {
  await nav("Articles");
  await page.getByRole("button", { name: "Nouvel article" }).click();
  await page.getByLabel("Désignation").fill(label);
  await page.getByLabel("Type").selectOption(kind);
  await page.getByLabel("Prix unitaire HT (FCFA)").fill(String(price));
  if (cost !== undefined) await page.getByLabel("Prix d'achat HT (FCFA)").fill(String(cost));
  await page.getByRole("button", { name: "Enregistrer" }).click();
}
async function invoice(client, label, qty, payments) {
  await nav("Factures");
  await page.getByRole("button", { name: "Nouvelle facture" }).first().click();
  await page.locator(".doc-fields label").filter({ hasText: /^\s*Client/ }).locator("select").selectOption({ label: client });
  await page.getByLabel("Désignation").fill(label);
  await page.getByLabel("Quantité").fill(String(qty));
  await page.getByRole("button", { name: "Valider la facture" }).click();
  await page.getByRole("heading", { name: /^Facture FA-/ }).waitFor();
  for (const [amount, method] of payments) {
    await page.getByLabel("Montant encaissé").fill(amount ? String(amount) : "");
    await page.getByLabel("Mode").selectOption(method);
    await page.getByRole("button", { name: "Enregistrer l'encaissement" }).click();
    await page.waitForTimeout(150);
  }
}

try {
  step("Inscription : tableau de bord sans objectif, trésorerie vide");
  await page.goto(BASE);
  await page.getByRole("button", { name: "Créer mon entreprise" }).click();
  await page.getByLabel("Nom de l'entreprise").fill("IDO");
  await page.getByLabel("Votre nom").fill("Jimmy");
  await page.getByLabel("Téléphone").fill("+241 077 00 00 00");
  await page.getByLabel("E-mail").fill("dnt@ido.ga");
  await page.getByLabel("Mot de passe", { exact: true }).fill("motdepasse1");
  await page.getByLabel("Confirmer le mot de passe").fill("motdepasse1");
  await page.getByRole("button", { name: "Démarrer l'essai gratuit" }).click();
  await waitSynced();
  await nav("Tableau de bord");
  await page.getByRole("heading", { name: "Trésorerie à venir" }).waitFor();
  await page.getByText("Aucune échéance de facture ni commande fournisseur dans les 90 prochains jours.").waitFor();
  assert.equal(await page.getByTestId("target").count(), 0, "pas d'objectif affiché tant qu'il n'est pas fixé");

  step("Réglages : objectif mensuel de 200 000 FCFA HT");
  await nav("Réglages");
  await page.getByRole("tab", { name: "Entreprise" }).click();
  await page.getByLabel("Objectif de chiffre d'affaires HT (FCFA)").fill("200000");
  await page.getByRole("form", { name: "Objectif mensuel" }).getByRole("button", { name: "Enregistrer" }).click();
  await page.getByRole("form", { name: "Objectif mensuel" }).getByText("Enregistré").waitFor();

  step("Une facture de 100 000 HT (118 000 TTC), 50 000 encaissés : 68 000 attendus à l'échéance");
  await newClient("Comilog");
  await newArticle("Ciment 50 kg", 10_000, "product", 6_000);
  await invoice("Comilog", "Ciment 50 kg", 10, [[50_000, "airtel"]]);
  await waitSynced();

  step("Tableau de bord : objectif à 50 %, entrées et solde à 30, 60 et 90 jours");
  await nav("Tableau de bord");
  const target = page.getByTestId("target");
  await target.filter({ hasText: /Objectif de \S+ : 100 000 \/ 200 000 FCFA HT/ }).waitFor();
  await target.getByText("50 %").waitFor();
  for (const d of [30, 60, 90]) {
    const col = page.getByTestId(`cash-${d}`);
    await col.filter({ hasText: `D'ici ${d} jours` }).waitFor();
    assert.match((await col.textContent()).replace(/\s/g, " "), /Entrées68 000 FCFA.*Solde prévu68 000 FCFA/, `colonne ${d} j`);
  }
  await page.getByText(/Entrées : reste dû des factures à leur échéance/).waitFor();
  await shot("tresorerie-bureau.png");

  step("Téléphone : colonnes empilées, pas de débordement horizontal");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `débordement horizontal de ${overflow}px`);
  const [a, b] = await Promise.all([page.getByTestId("cash-30").boundingBox(), page.getByTestId("cash-60").boundingBox()]);
  assert.ok(b.y > a.y, "colonnes empilées sur téléphone");
  await shot("tresorerie-mobile.png");

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nRecette de la trésorerie à venir et de l'objectif mensuel réussie.");
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  await page.screenshot({ path: join(out, "echec.png"), fullPage: true }).catch(() => {});
  console.error(`Capture : ${join(out, "echec.png")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
