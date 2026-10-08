/**
 * Test de bout en bout : deux appareils, coupures réseau, cycle de vente complet.
 *
 * Prérequis : `npm run build` (ou `bun dev/build-bun.ts`), Playwright installé.
 *   node test/e2e/two-devices.mjs
 * Lance le serveur local sur une base en mémoire et ouvre deux navigateurs
 * indépendants (deux appareils).
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
const YEAR = new Date().getFullYear();

const server = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "dev/server.ts"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), DB_PATH: ":memory:" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("localhost") && resolve()));

const browser = await chromium.launch();
const step = (msg) => console.log(`• ${msg}`);
const errors = [];

async function device(name) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 860 }, locale: "fr-FR" });
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => errors.push(`[${name}] ${e.message}`));
  return { name, context, page };
}

const pill = (p) => p.getByTestId("sync-pill");
async function waitSynced(p) {
  await pill(p).click();
  await pill(p).filter({ hasText: "À jour" }).waitFor({ timeout: 10_000 });
}
const nav = (p, label) => p.getByRole("navigation").getByRole("button", { name: label, exact: true }).click();
const shot = async (p, file) => shots && p.screenshot({ path: join(shots, file), fullPage: true });
/** Attend que le reste dû affiché atteigne la valeur attendue (l'écran se met à jour après l'écriture). */
const expectDue = (p, value) => p.getByTestId("due").filter({ hasText: new RegExp(`^${value}$`) }).waitFor({ timeout: 10_000 });

let A, B;
try {
  A = await device("A");
  B = await device("B");

  step("A : création de l'entreprise, réglages, client et article");
  await A.page.goto(BASE);
  await A.page.getByLabel("Nom de l'entreprise").fill("Sodepsi");
  await A.page.getByLabel("Votre nom").fill("Johann");
  await A.page.getByLabel("E-mail").fill("admin@sodepsi.ga");
  await A.page.getByLabel("Mot de passe").fill("motdepasse1");
  await A.page.getByRole("button", { name: "Créer" }).click();
  await waitSynced(A.page);

  await nav(A.page, "Réglages");
  await A.page.getByLabel("Raison sociale").fill("Sodepsi SARL");
  await A.page.getByLabel("NIF").fill("2026 0001 G");
  await A.page.getByLabel("Ville").fill("Libreville");
  await A.page.getByLabel("Mobile money").fill("Airtel Money 077 00 00 00");
  await A.page.getByRole("button", { name: "Enregistrer" }).first().click();

  await nav(A.page, "Clients");
  await A.page.getByRole("button", { name: "Nouveau client" }).click();
  await A.page.getByLabel("Raison sociale").fill("Total Gabon");
  await A.page.getByLabel("Téléphone").fill("+241 01 55 00 00");
  await A.page.getByLabel("Ville").fill("Port-Gentil");
  await A.page.getByRole("button", { name: "Enregistrer" }).click();

  await nav(A.page, "Articles");
  await A.page.getByRole("button", { name: "Nouvel article" }).click();
  await A.page.getByLabel("Désignation").fill("Audit informatique");
  await A.page.getByLabel("Prix unitaire HT (FCFA)").fill("150000");
  await A.page.getByRole("button", { name: "Enregistrer" }).click();
  await waitSynced(A.page);

  step("B : connexion, reçoit client, article et réglages");
  await B.page.goto(BASE);
  await B.page.getByLabel("E-mail").fill("admin@sodepsi.ga");
  await B.page.getByLabel("Mot de passe").fill("motdepasse1");
  await B.page.getByRole("button", { name: "Se connecter" }).click();
  await waitSynced(B.page);
  await nav(B.page, "Articles");
  await B.page.getByRole("cell", { name: "Audit informatique" }).waitFor();
  await B.page.evaluate(() => navigator.serviceWorker.ready);

  step("B hors ligne : devis depuis le catalogue, conversion en facture, encaissement partiel");
  await B.context.setOffline(true);
  await nav(B.page, "Devis");
  await B.page.getByRole("button", { name: "Nouveau devis" }).click();
  await B.page.getByLabel("Désignation").fill("Audit informatique");
  await B.page.getByLabel("Quantité").fill("2");
  assert.equal(await B.page.getByTestId("total-ttc").textContent(), "354 000 FCFA", "prix repris du catalogue");
  await B.page.getByRole("button", { name: "Finaliser le devis" }).click();
  await B.page.getByRole("heading", { name: `Devis DV-${YEAR}-00051` }).waitFor();
  await B.page.getByRole("button", { name: "Marquer accepté" }).click();
  await B.page.getByRole("button", { name: "Convertir en facture" }).click();
  await B.page.getByText(`Issue du devis`).waitFor();
  await B.page.getByRole("button", { name: "Valider la facture" }).click();
  await B.page.getByRole("heading", { name: `Facture FA-${YEAR}-00051` }).waitFor();
  await B.page.getByLabel("Montant encaissé").fill("100000");
  await B.page.getByLabel("Mode").selectOption("airtel");
  await B.page.getByRole("button", { name: "Enregistrer l'encaissement" }).click();
  await expectDue(B.page, "254 000 FCFA");
  await pill(B.page).filter({ hasText: /Hors ligne · \d+ en attente/ }).waitFor();

  step("B rouvre l'application sans réseau : tout est là");
  await B.page.reload();
  await nav(B.page, "Factures");
  await B.page.getByRole("cell", { name: `FA-${YEAR}-00051` }).waitFor();

  step("Retour du réseau : A reçoit la facture et crée un avoir partiel");
  await B.context.setOffline(false);
  await waitSynced(B.page);
  await waitSynced(A.page);
  await nav(A.page, "Factures");
  await A.page.getByRole("cell", { name: `FA-${YEAR}-00051` }).click();
  await expectDue(A.page, "254 000 FCFA");
  await A.page.getByRole("button", { name: "Créer un avoir" }).click();
  await A.page.getByLabel("Quantité").fill("1");
  await A.page.getByRole("button", { name: "Valider l'avoir" }).click();
  await A.page.getByRole("heading", { name: `Avoir AV-${YEAR}-00001` }).waitFor();
  await A.page.getByRole("button", { name: `FA-${YEAR}-00051` }).click();
  await expectDue(A.page, "77 000 FCFA");

  step("Encaissements simultanés hors ligne sur les deux appareils : aucun ne se perd");
  await waitSynced(A.page);
  await waitSynced(B.page);
  await B.page.getByRole("cell", { name: `FA-${YEAR}-00051` }).click();
  await B.context.setOffline(true);
  await A.context.setOffline(true);
  for (const p of [A.page, B.page]) {
    await p.getByLabel("Montant encaissé").fill("10000");
    await p.getByRole("button", { name: "Enregistrer l'encaissement" }).click();
  }
  await B.context.setOffline(false);
  await A.context.setOffline(false);
  await waitSynced(B.page);
  await waitSynced(A.page);
  await waitSynced(B.page);
  await expectDue(A.page, "57 000 FCFA");
  await expectDue(B.page, "57 000 FCFA");

  step("Impression : en-tête entreprise, montant en lettres");
  await A.page.getByRole("button", { name: "Imprimer / PDF" }).click();
  await A.page.getByText("trois cent cinquante-quatre mille francs CFA").waitFor();
  await A.page.getByText("NIF 2026 0001 G").waitFor();
  await shot(A.page, "facture-apercu.png");
  await A.page.getByRole("button", { name: "Fermer" }).click();
  await shot(A.page, "facture.png");

  step("Tableau de bord");
  await nav(A.page, "Tableau de bord");
  await A.page.getByText("Chiffre d'affaires et dépenses").waitFor();
  await shot(A.page, "tableau-de-bord.png");
  await nav(A.page, "Factures");
  await shot(A.page, "factures.png");

  assert.deepEqual(errors, [], "aucune erreur JavaScript dans les pages");
  console.log("\nOK : cycle de vente complet sur deux appareils, avec coupures, sans perte.");
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  if (shots) for (const d of [A, B]) if (d) await d.page.screenshot({ path: join(shots, `echec-${d.name}.png`), fullPage: true }).catch(() => {});
  if (errors.length) console.error(errors.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
