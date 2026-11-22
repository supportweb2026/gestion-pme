/**
 * Recette du tableau de bord des gains.
 *  - prix d'achat sur un article, marge affichée au catalogue ;
 *  - deux factures (deux clients, un produit avec prix d'achat, un service sans) ;
 *  - encaissements Airtel Money et virement ;
 *  - indicateurs : CA HT, encaissé, marge brute et taux, reste dû ;
 *  - filtres : client, moyen de paiement, type, clic sur une répartition, effacement ;
 *  - comparaison, vue tableau, export CSV relu, affichage téléphone.
 *
 * Prérequis : `npm run build`, Playwright.
 *   node test/e2e/gains.mjs        (SHOTS_DIR=… pour des captures)
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
const PORT = 8797;
const BASE = `http://localhost:${PORT}`;
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-gains-"));

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
  await page.getByRole("button", { name: "Nouvelle facture" }).click();
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
  step("Inscription, deux clients, un produit avec prix d'achat, un service sans");
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

  step("Tableau des gains vide : pas d'erreur, message d'attente");
  await nav("Gains");
  await page.getByRole("heading", { name: "Tableau de bord des gains" }).waitFor();
  await expectKpi("kpi-ca", "0");
  await page.getByText("Aucune vente ni encaissement sur cette période.").waitFor();

  await newClient("Comilog");
  await newClient("Gabon Review");
  await newArticle("Ciment 50 kg", 10_000, "product", 6_000);
  await newArticle("Conseil (jour)", 50_000, "service");
  step("Catalogue : marge unitaire affichée quand le prix d'achat est connu");
  await page.getByRole("row", { name: /Ciment 50 kg.*40 %/ }).waitFor();
  await page.getByRole("row", { name: /Conseil \(jour\).*—/ }).waitFor();

  step("Factures : Comilog 10 ciments (Airtel 50 000), Gabon Review 2 jours de conseil (soldée par virement)");
  await invoice("Comilog", "Ciment 50 kg", 10, [[50_000, "airtel"]]);
  await invoice("Gabon Review", "Conseil (jour)", 2, [[0, "transfer"]]);
  await waitSynced();

  step("Indicateurs du mois : CA 200 000, encaissé 168 000, marge 40 000 (40 % sur la moitié du CA), reste 68 000");
  await nav("Gains");
  await page.getByLabel("Période").selectOption("month");
  await expectKpi("kpi-ca", "200 000");
  await expectKpi("kpi-encaisse", "168 000");
  await expectKpi("kpi-marge", "40 000");
  await expectKpi("kpi-du", "68 000");
  await page.getByTestId("kpi-marge").getByText("Taux de marge 40 % · sur 50 % du CA").waitFor();
  await page.getByTestId("kpi-ca").getByText("236 000 FCFA TTC · TVA 36 000 FCFA").waitFor();
  await page.getByTestId("kpi-ca").getByText(/nouveau/).waitFor();
  await shot("gains-bureau.png");

  step("Filtre client (Comilog) : CA 100 000, une facture");
  await page.getByRole("button", { name: "Plus de filtres" }).click();
  await page.getByLabel("Client : Tous").click();
  await page.getByRole("checkbox", { name: "Comilog" }).check();
  await page.keyboard.press("Escape");
  await expectKpi("kpi-ca", "100 000");
  await page.getByRole("button", { name: "Retirer le filtre Client : Comilog" }).waitFor();
  await page.getByText("1 facture", { exact: true }).waitFor();

  step("Tout effacer, puis filtre moyen de paiement (Virement) : seule la facture Gabon Review");
  await page.getByRole("button", { name: "Tout effacer" }).click();
  await expectKpi("kpi-ca", "200 000");
  await page.getByLabel("Moyen de paiement : Tous").click();
  await page.getByRole("checkbox", { name: "Virement" }).check();
  await page.keyboard.press("Escape");
  await expectKpi("kpi-ca", "100 000");
  await expectKpi("kpi-encaisse", "118 000");
  await page.getByRole("button", { name: "Tout effacer" }).click();

  step("Filtre type (Produits) : marge 40 % sur 100 % du CA");
  await page.getByLabel("Type : Tous").click();
  await page.getByRole("checkbox", { name: "Produits" }).check();
  await page.keyboard.press("Escape");
  await expectKpi("kpi-ca", "100 000");
  await page.getByTestId("kpi-marge").getByText("Taux de marge 40 %", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Tout effacer" }).click();
  await page.getByRole("button", { name: "Plus de filtres" }).click();

  step("Répartition par produit, puis clic = filtre ; moyens de paiement");
  await page.getByRole("tab", { name: "Produits et services" }).click();
  await page.getByRole("row", { name: /Ciment 50 kg.*100 000 FCFA.*50 %.*40 000 FCFA \(40 %\).*10/ }).waitFor();
  await page.getByRole("button", { name: "Conseil (jour)" }).click();
  await expectKpi("kpi-ca", "100 000");
  await page.getByRole("button", { name: "Tout effacer" }).click();
  await page.getByRole("tab", { name: "Moyens de paiement" }).click();
  await page.getByRole("row", { name: /Virement.*118 000 FCFA/ }).waitFor();
  await page.getByRole("row", { name: /Airtel Money.*50 000 FCFA/ }).waitFor();

  step("Balance âgée : 68 000 pas encore échu");
  await page.getByRole("listitem").filter({ hasText: "Pas encore échu" }).filter({ hasText: "68 000 FCFA" }).waitFor();

  step("Comparaison N-1, période personnalisée, vue tableau");
  await page.getByLabel("Comparer à").selectOption("year");
  await page.getByTestId("kpi-ca").getByText(/vs N-1/).waitFor();
  await page.getByLabel("Période").selectOption("custom");
  await page.getByLabel("Du", { exact: true }).waitFor();
  await page.getByLabel("Période").selectOption("12m");
  await page.getByRole("button", { name: "Voir le tableau" }).click();
  await page.getByRole("columnheader", { name: "Marge connue" }).waitFor();
  await page.getByRole("button", { name: "Voir le graphique" }).click();

  step("Export CSV : factures et détail des lignes, avec marge");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exporter (CSV)" }).click()]);
  const file = join(out, "gains.csv");
  await download.saveAs(file);
  const csv = readFileSync(file, "utf8");
  for (const expected of ["Numéro;Date;Échéance;Client", "Comilog", "Gabon Review", ";100000;", "Ciment 50 kg;Produits;10;100000;18000;60000;40000", "Jimmy"]) {
    assert.ok(csv.includes(expected), `CSV : « ${expected} » absent\n${csv}`);
  }

  step("Les filtres sont mémorisés après rechargement");
  await page.reload();
  await nav("Gains");
  assert.equal(await page.getByLabel("Période").inputValue(), "12m");
  assert.equal(await page.getByLabel("Comparer à").inputValue(), "year");

  step("Téléphone : pas de débordement horizontal");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `débordement horizontal de ${overflow}px`);
  await shot("gains-mobile.png");

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nRecette du tableau de bord des gains réussie.");
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  await page.screenshot({ path: join(out, "echec.png"), fullPage: true }).catch(() => {});
  console.error(`Capture : ${join(out, "echec.png")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
