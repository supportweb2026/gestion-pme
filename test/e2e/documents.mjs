/**
 * Recette du cycle de vente (lot 2), dans les parcours Devis et Factures :
 *  - devis avec titres de section, remise globale, sous-total imprimé ;
 *  - facture d'acompte (30 %) créée depuis le devis, puis facture de solde qui la déduit ;
 *  - bon de livraison depuis la facture : PDF sans prix, signatures ;
 *  - facture pro forma (série PF) convertie en facture.
 *
 * Prérequis : `npm run build`, Playwright, pdftotext (poppler-utils).
 *   node test/e2e/documents.mjs        (SHOTS_DIR=… pour des captures)
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
const out = mkdtempSync(join(tmpdir(), "gestia-docs-"));

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
  await page.getByLabel("Raison sociale").fill("Comilog");
  await page.getByRole("button", { name: "Enregistrer" }).click();

  step("Devis avec un titre de section, deux lignes et 10 % de remise sur toutes les lignes");
  await nav("Devis");
  await page.getByRole("button", { name: "Nouveau devis" }).first().click();
  await page.getByRole("button", { name: "+ Ajouter un titre" }).click();
  // Le titre s'ajoute en fin de tableau : on le saisit puis on remplit les lignes.
  await page.getByLabel("Titre de section").fill("Lot 1 : fournitures et pose");
  await line(0, "Ciment 50 kg", 10, 10_000);
  await page.getByRole("button", { name: "+ Ajouter une ligne" }).click();
  await line(1, "Pose", 1, 100_000);
  await page.getByLabel("Remise globale en %").fill("10");
  await page.getByRole("button", { name: "Appliquer" }).click();
  assert.equal(await ttc(), "212 400 FCFA", "200 000 HT − 10 % + TVA 18 %");
  await page.getByRole("button", { name: "Finaliser le devis" }).click();
  await heading(`Devis DV-${YEAR}-00001`);
  await page.getByText("Lot 1 : fournitures et pose").first().waitFor();

  step("Facture d'acompte de 30 % créée depuis le devis");
  await page.getByRole("button", { name: "Facture d'acompte" }).click();
  await page.getByLabel("Pourcentage d'acompte").fill("30");
  await page.getByRole("button", { name: "Créer la facture d'acompte" }).click();
  await heading("Facture d'acompte (brouillon)");
  await page.getByText(`Issue du devis`).waitFor();
  assert.equal(await ttc(), "63 720 FCFA");
  await page.getByRole("button", { name: "Valider la facture" }).click();
  await heading(`Facture d'acompte FA-${YEAR}-00001`);
  const dep = await pdfText("acompte.pdf");
  assert.ok(dep.text.includes("FACTURE D'ACOMPTE") || dep.text.includes("Facture d'acompte"), dep.text);
  assert.ok(dep.text.includes(`DV-${YEAR}-00001`), "le PDF cite le devis");

  step("Facture de solde : reprend le devis et déduit l'acompte");
  await page.getByRole("button", { name: `DV-${YEAR}-00001` }).click();
  await page.getByRole("list", { name: "Acomptes facturés" }).getByText(`FA-${YEAR}-00001`).waitFor();
  await page.getByRole("button", { name: "Facture de solde" }).click();
  await heading("Facture (brouillon)");
  const labels = await page.getByLabel("Désignation").evaluateAll((els) => els.map((e) => e.value));
  assert.ok(labels.some((l) => l.startsWith(`Déduction de l'acompte FA-${YEAR}-00001`)), labels.join(" | "));
  assert.equal(await ttc(), "148 680 FCFA", "212 400 − 63 720");
  await page.getByRole("button", { name: "Valider la facture" }).click();
  await heading(`Facture FA-${YEAR}-00002`);
  await page.getByTestId("due").filter({ hasText: "148 680 FCFA" }).waitFor();
  await shot("solde.png");

  step("Bon de livraison depuis la facture : quantités seules, signatures");
  await page.getByTestId("next-steps").getByRole("button", { name: "Créer le bon de livraison" }).click();
  await heading("Bon de livraison (brouillon)");
  const blLabels = await page.getByLabel("Désignation").evaluateAll((els) => els.map((e) => e.value));
  assert.ok(!blLabels.some((l) => l.includes("acompte")), `pas d'acompte sur le bon de livraison : ${blLabels.join(" | ")}`);
  await page.getByRole("button", { name: "Finaliser le bon de livraison" }).click();
  await heading(`Bon de livraison BL-${YEAR}-00001`);
  const bl = await pdfText("bl.pdf");
  assert.ok(bl.text.includes("BON DE LIVRAISON") || bl.text.includes("Bon de livraison"), bl.text);
  assert.ok(/REÇU PAR LE CLIENT/i.test(bl.text), "signature du client");
  assert.ok(!bl.text.includes("212 400") && !bl.text.includes("Total TTC") && !bl.text.includes("TOTAL TTC"), `aucun prix sur le bon de livraison\n${bl.text}`);
  await page.getByRole("button", { name: "Marquer livré" }).click();
  await page.getByText("Livraison confirmée.").waitFor();

  step("Facture pro forma (série PF) convertie en facture");
  await nav("Devis");
  await page.getByRole("button", { name: "Nouvelle pro forma" }).click();
  await line(0, "Audit réseau", 1, 500_000);
  await page.getByRole("button", { name: "Finaliser la pro forma" }).click();
  await heading(`Facture pro forma PF-${YEAR}-00001`);
  await page.getByRole("button", { name: "Convertir en facture" }).click();
  await page.getByText("Issue de la pro forma").waitFor();
  await page.getByRole("button", { name: "Valider la facture" }).click();
  await heading(`Facture FA-${YEAR}-00003`);

  step("Liste des devis : le type de chaque document est affiché");
  await nav("Devis");
  await page.locator(".doc-type", { hasText: "Facture pro forma" }).first().waitFor();
  assert.equal(await page.getByRole("row", { name: new RegExp(`BL-${YEAR}-00001`) }).count(), 0, "les bons ont leur propre entrée de menu");
  await nav("Livraisons et prestations");
  await page.locator(".doc-type", { hasText: "Bon de livraison" }).first().waitFor();
  const blRow = page.getByRole("row", { name: new RegExp(`BL-${YEAR}-00001`) });
  await blRow.getByText("Livré", { exact: true }).waitFor();
  assert.equal(await blRow.locator(".c-total").count(), 0, "pas de montant pour un bon de livraison");
  await shot("liste-devis.png");

  step("Chaîne : devis, bon de commande, bon de prestation signé par le client");
  await nav("Devis");
  await page.getByRole("button", { name: "Nouveau devis" }).first().click();
  await line(0, "Formation des équipes", 2, 150_000);
  await page.getByRole("button", { name: "Finaliser le devis" }).click();
  await heading(`Devis DV-${YEAR}-00002`);
  await page.getByTestId("next-steps").getByRole("button", { name: "Créer le bon de commande" }).click();
  await heading("Bon de commande (brouillon)");
  assert.equal(await ttc(), "354 000 FCFA", "le bon de commande reprend les prix du devis");
  await page.getByRole("button", { name: "Finaliser le bon de commande" }).click();
  await heading(`Bon de commande BC-${YEAR}-00001`);
  await page.getByTestId("related-docs").getByText(`DV-${YEAR}-00002`).waitFor();
  await page.getByTestId("next-steps").getByRole("button", { name: "Créer le bon de prestation" }).click();
  await heading("Bon de prestation (brouillon)");
  await page.getByRole("button", { name: "Finaliser le bon de prestation" }).click();
  await heading(`Bon de prestation BP-${YEAR}-00001`);
  const bp = await pdfText("bp.pdf");
  assert.ok(/BON DE PRESTATION/i.test(bp.text), bp.text);
  assert.ok(/PRESTATION CONSTATÉE PAR LE CLIENT/i.test(bp.text), "signature du client");
  assert.ok(!bp.text.includes("354 000"), "aucun prix sur le bon de prestation");
  await page.getByRole("button", { name: "Marquer réalisé" }).click();
  await page.getByText("Prestation constatée par le client.").waitFor();

  step("Facture depuis le bon réalisé : quantités du bon, prix de la commande, pas de double facturation");
  await page.getByTestId("next-steps").getByRole("button", { name: "Créer la facture" }).waitFor();
  await shot("bon-a-facturer.png");
  await page.getByTestId("next-steps").getByRole("button", { name: "Créer la facture" }).click();
  await heading("Facture (brouillon)");
  await page.getByText("Issue du bon de prestation").waitFor();
  assert.equal(await ttc(), "354 000 FCFA", "la facture reprend les prix de la commande");
  await page.getByRole("button", { name: "Valider la facture" }).click();
  await heading(`Facture FA-${YEAR}-00004`);
  await page.getByTestId("related-docs").getByRole("button", { name: new RegExp(`BP-${YEAR}-00001`) }).click();
  await heading(`Bon de prestation BP-${YEAR}-00001`);
  await page.getByRole("button", { name: "Voir la facture" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Créer la facture" }).count(), 0, "un bon ne se facture qu'une fois");
  await page.getByTestId("related-docs").getByRole("button", { name: new RegExp(`BC-${YEAR}-00001`) }).click();
  await heading(`Bon de commande BC-${YEAR}-00001`);
  await page.getByTestId("billed-by-slips").getByText(`FA-${YEAR}-00004`).waitFor();
  assert.equal(await page.getByRole("button", { name: "Convertir en facture" }).count(), 0, "la commande déjà facturée par son bon ne se convertit plus");
  await shot("commande-facturee.png");
  // Le devis d'origine est accepté, et un bon se crée aussi directement depuis la liste.
  await nav("Devis");
  await page.getByRole("row", { name: new RegExp(`DV-${YEAR}-00002`) }).getByText("Accepté", { exact: true }).waitFor();

  step("Menu Ventes : une entrée par étape de la vente");
  await nav("Commandes");
  await page.getByRole("row", { name: new RegExp(`BC-${YEAR}-00001`) }).waitFor();
  assert.equal(await page.locator("tbody tr").count(), 1, "seuls les bons de commande");
  await nav("Livraisons et prestations");
  await page.getByRole("row", { name: new RegExp(`BP-${YEAR}-00001`) }).waitFor();
  await page.getByRole("button", { name: "Nouveau bon de prestation" }).click();
  await heading("Nouveau bon de prestation");
  await page.getByRole("button", { name: /← Livraisons et prestations/ }).click();
  await nav("Acomptes");
  await page.getByRole("row", { name: new RegExp(`FA-${YEAR}-00001`) }).waitFor();
  assert.equal(await page.locator("tbody tr").count(), 1, "seules les factures d'acompte");
  await nav("Factures récurrentes");
  await page.getByText("Aucune facture récurrente pour l'instant").waitFor();
  await nav("Encaissements");
  await page.getByText("Aucun encaissement pour l'instant").waitFor();
  await nav("Relances");
  await page.getByRole("row", { name: new RegExp(`FA-${YEAR}-00002`) }).waitFor();
  const lateRows = await page.locator("tbody tr").count();
  assert.ok(lateRows >= 3, `les factures à encaisser sont listées (${lateRows})`);
  await shot("relances.png");

  step("Signature du client sur l'écran : le devis est accepté, la signature est sur le PDF");
  await nav("Devis");
  await page.getByRole("button", { name: "Nouveau devis" }).first().click();
  await line(0, "Maintenance annuelle", 1, 400_000);
  await page.getByRole("button", { name: "Finaliser le devis" }).click();
  await heading(`Devis DV-${YEAR}-00003`);
  await page.getByRole("button", { name: "Faire signer sur cet écran" }).click();
  const dialog = page.getByTestId("sign-dialog");
  await dialog.getByText("472 000 FCFA TTC").waitFor();
  await dialog.getByRole("button", { name: "Signer et accepter" }).click();
  await dialog.getByText("Indiquez le nom de la personne qui signe.").waitFor();
  await dialog.getByLabel("Nom du signataire").fill("Awa Ndong");
  await dialog.getByRole("button", { name: "Signer et accepter" }).click();
  await dialog.getByText("La signature manque").waitFor();
  const box = await dialog.getByTestId("sign-canvas").boundingBox();
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 40 + i * 18, box.y + box.height / 2 + (i % 2 ? -24 : 24));
  await page.mouse.up();
  await shot("signature.png");
  await dialog.getByRole("button", { name: "Signer et accepter" }).click();
  const signed = page.getByTestId("signed-card");
  await signed.getByText(/Signé par Awa Ndong le/).waitFor();
  await page.getByText("Accepté", { exact: true }).first().waitFor();
  assert.equal(await page.getByRole("button", { name: "Faire signer sur cet écran" }).count(), 0, "un document signé ne se signe plus");
  const signedPdf = await pdfText("devis-signe.pdf");
  assert.ok(/Signé par Awa Ndong le/.test(signedPdf.text), `la signature est sur le PDF\n${signedPdf.text}`);
  await shot("devis-signe.png");

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nRecette du cycle de vente réussie.");
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  await page.screenshot({ path: join(out, "echec.png"), fullPage: true }).catch(() => {});
  console.error(`Capture : ${join(out, "echec.png")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
