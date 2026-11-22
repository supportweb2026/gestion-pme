/**
 * Recette de bout en bout de la facturation (MVP) : un appareil, cycle complet.
 *  - création d'une facture avec remise, calculs HT / TVA / TTC ;
 *  - validation et numérotation continue (FA-AAAA-00001, 00002…) ;
 *  - PDF téléchargé et relu (numéro, client, totaux, montant en lettres, mentions) ;
 *  - envoi : liens WhatsApp et e-mail préremplis, date d'envoi notée ;
 *  - encaissement partiel puis total ; relance d'une facture échue ; duplication.
 *
 * Prérequis : `npm run build`, Playwright, pdftotext (poppler-utils).
 *   node test/e2e/facturation.mjs
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
const PORT = 8798;
const BASE = `http://localhost:${PORT}`;
const YEAR = new Date().getFullYear();
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-pdf-"));

const server = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "dev/server.ts"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), DB_PATH: ":memory:" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("localhost") && resolve()));

const browser = await chromium.launch();
const step = (msg) => console.log(`• ${msg}`);
const errors = [];
const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: "fr-FR", acceptDownloads: true });
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
const txt = async (id) => (await page.getByTestId(id).textContent()).trim();

/** Télécharge le PDF du document ouvert et renvoie son texte. */
async function pdfText(name) {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Télécharger le PDF" }).first().click()]);
  const file = join(out, name);
  await download.saveAs(file);
  assert.equal(readFileSync(file).subarray(0, 5).toString(), "%PDF-", "fichier PDF valide");
  const layout = execFileSync("pdftotext", ["-layout", file, "-"]).toString();
  // Texte en flux (sans mise en page) : les phrases coupées sur plusieurs lignes se recollent.
  const raw = execFileSync("pdftotext", [file, "-"]).toString().replace(/\s+/g, " ");
  return { name: download.suggestedFilename(), text: `${layout}\n${raw}` };
}

try {
  step("Inscription, réglages de l'entreprise (mentions légales, règlement), client, article");
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

  await nav("Réglages");
  await page.getByLabel("Raison sociale").fill("IDO SARL");
  await page.getByLabel("NIF").fill("2026 0042 G");
  await page.getByLabel("RCCM").fill("GA-LBV-01-2026-B12-00042");
  await page.getByLabel("Ville").fill("Libreville");
  await page.getByLabel("Mobile money").fill("Airtel Money 077 00 00 00");
  await page.getByRole("button", { name: "Enregistrer" }).first().click();

  await nav("Clients");
  await page.getByRole("button", { name: "Nouveau client" }).click();
  await page.getByLabel("Raison sociale").fill("Comilog");
  await page.getByLabel("Téléphone").fill("+241 01 66 00 00");
  await page.getByLabel("E-mail").fill("compta@comilog.example");
  await page.getByLabel("Ville").fill("Moanda");
  await page.getByRole("button", { name: "Enregistrer" }).click();

  await nav("Articles");
  await page.getByRole("button", { name: "Nouvel article" }).click();
  await page.getByLabel("Désignation").fill("Développement logiciel (jour)");
  await page.getByLabel("Prix unitaire HT (FCFA)").fill("250000");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await waitSynced();

  step("Facture : article du catalogue avec remise 10 %, ligne libre exonérée ; calculs HT / TVA / TTC");
  await nav("Factures");
  await page.getByRole("button", { name: "Nouvelle facture" }).click();
  await page.getByLabel("Désignation").fill("Développement logiciel (jour)");
  await page.getByLabel("Quantité").fill("4");
  await page.getByLabel("Remise").fill("10");
  await page.getByRole("button", { name: "+ Ajouter une ligne" }).click();
  await page.getByLabel("Désignation").nth(1).fill("Frais de déplacement Moanda, billet d'avion aller-retour Libreville – Franceville et hébergement");
  await page.getByLabel("Prix unitaire").nth(1).fill("185000");
  await page.getByLabel("TVA").nth(1).fill("0");
  // 4 × 250 000 = 1 000 000 - 10 % = 900 000 ; TVA 18 % = 162 000 ; + 185 000 exonéré.
  assert.equal(await txt("discount"), "-100 000 FCFA");
  assert.equal(await txt("total-ht"), "1 085 000 FCFA");
  assert.equal(await txt("total-vat"), "162 000 FCFA");
  assert.equal(await txt("total-ttc"), "1 247 000 FCFA");
  await shot("facture-saisie.png");

  step("Remise invalide refusée à la validation");
  await page.getByLabel("Remise").first().fill("120");
  await page.getByRole("button", { name: "Valider la facture" }).click();
  await page.getByRole("alert").filter({ hasText: "entre 0 et 100 %" }).waitFor();
  await page.getByLabel("Remise").first().fill("10");

  step("Validation : numéro FA-AAAA-00001, document figé");
  await page.getByRole("button", { name: "Valider la facture" }).click();
  await page.getByRole("heading", { name: `Facture FA-${YEAR}-00001` }).waitFor();
  assert.equal(await page.getByLabel("Quantité").first().isDisabled(), true, "facture validée non modifiable");

  step("PDF : numéro, client, lignes, remise, TVA ventilée, montant en lettres, mentions légales");
  const pdf1 = await pdfText("facture-1.pdf");
  assert.equal(pdf1.name, `Facture FA-${YEAR}-00001 - Comilog.pdf`);
  for (const expected of [
    "FACTURE", `N° FA-${YEAR}-00001`, "Comilog", "Moanda", "Développement logiciel (jour)", "Franceville",
    "Total brut HT", "1 185 000 FCFA", "Remises", "-100 000 FCFA", "Total HT", "1 085 000 FCFA",
    "TVA 18 % sur 900 000 FCFA", "162 000 FCFA", "TVA 0 % sur 185 000 FCFA", "Total TTC", "1 247 000 FCFA",
    "un million deux cent quarante-sept mille francs CFA", "Airtel Money 077 00 00 00",
    "IDO SARL", "NIF 2026 0042 G", "RCCM GA-LBV-01-2026-B12-00042",
  ]) assert.ok(pdf1.text.includes(expected), `PDF : « ${expected} » absent\n${pdf1.text}`);

  step("Envoi : WhatsApp et e-mail préremplis vers le client, date d'envoi notée");
  const wa = await page.getByRole("link", { name: "WhatsApp" }).getAttribute("href");
  assert.ok(wa.startsWith("https://wa.me/241016600"), wa);
  assert.ok(decodeURIComponent(wa).includes(`notre facture FA-${YEAR}-00001 d'un montant de 1 247 000 FCFA`), wa);
  const mail = await page.getByRole("link", { name: "E-mail" }).getAttribute("href");
  assert.ok(mail.startsWith("mailto:compta%40comilog.example?subject=Facture%20FA-"), mail);
  await page.getByRole("link", { name: "E-mail" }).evaluate((a) => a.addEventListener("click", (e) => e.preventDefault()));
  await page.getByRole("link", { name: "E-mail" }).click();
  await page.getByTestId("sent-info").filter({ hasText: "Envoyé le" }).waitFor();

  step("Encaissement partiel (Airtel Money) puis solde : facture payée, PDF « reste à payer »");
  await page.getByLabel("Montant encaissé").fill("500000");
  await page.getByLabel("Mode").selectOption("airtel");
  await page.getByRole("button", { name: "Enregistrer l'encaissement" }).click();
  await page.getByTestId("due").filter({ hasText: /^747 000 FCFA$/ }).waitFor();
  const pdfPartial = await pdfText("facture-1-partielle.pdf");
  assert.ok(pdfPartial.text.includes("Déjà réglé") && pdfPartial.text.includes("747 000 FCFA"), pdfPartial.text);
  await page.getByRole("button", { name: "Enregistrer l'encaissement" }).click(); // montant vide = reste dû
  await page.getByTestId("due").filter({ hasText: /^0 FCFA$/ }).waitFor();

  step("Duplication : nouveau brouillon, puis numéro suivant FA-AAAA-00002 (numérotation continue)");
  await page.getByRole("button", { name: "Dupliquer" }).click();
  await page.getByRole("heading", { name: "Facture (brouillon)" }).waitFor();
  assert.equal(await txt("total-ttc"), "1 247 000 FCFA", "lignes reprises");
  await page.getByLabel("Échéance").fill(`${YEAR - 1}-01-31`); // déjà échue
  await page.getByLabel("Date", { exact: true }).fill(`${YEAR - 1}-01-02`);
  await page.getByLabel("Échéance").fill(`${YEAR - 1}-01-31`);
  await page.getByRole("button", { name: "Valider la facture" }).click();
  await page.getByRole("heading", { name: `Facture FA-${YEAR}-00002` }).waitFor();

  step("Facture échue : message de relance, relance comptée");
  const waRelance = await page.getByRole("link", { name: "Relancer par WhatsApp" }).getAttribute("href");
  assert.ok(decodeURIComponent(waRelance).includes(`notre facture FA-${YEAR}-00002 échue le 31/01/${YEAR - 1} reste à régler pour 1 247 000 FCFA`), waRelance);
  await page.getByRole("link", { name: "Relancer par e-mail" }).evaluate((a) => a.addEventListener("click", (e) => e.preventDefault()));
  await page.getByRole("link", { name: "Relancer par e-mail" }).click();
  await page.getByTestId("sent-info").filter({ hasText: "Relancé 1 fois" }).waitFor();
  await waitSynced();
  await shot("facture-relance.png");

  step("Liste : statuts Payée / En retard");
  await page.getByRole("button", { name: "← Factures" }).click();
  await page.getByRole("row", { name: new RegExp(`FA-${YEAR}-00001.*Payée`) }).waitFor();
  await page.getByRole("row", { name: new RegExp(`FA-${YEAR}-00002.*En retard`) }).waitFor();

  step("Sans réseau, application rouverte : le PDF se génère quand même");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(4000); // préchargement du générateur de PDF
  await context.setOffline(true);
  await page.reload();
  await nav("Factures");
  await page.getByRole("cell", { name: `FA-${YEAR}-00001` }).click();
  const offline = await pdfText("facture-1-hors-ligne.pdf");
  assert.ok(offline.text.includes(`N° FA-${YEAR}-00001`));
  await context.setOffline(false);

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log(`\nRecette facturation réussie. PDF dans ${out}`);
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  await page.screenshot({ path: join(out, "echec.png"), fullPage: true }).catch(() => {});
  console.error(`Capture : ${join(out, "echec.png")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
