/**
 * Recette du module Projets, lot 3 : validation d'étape et facture de jalon.
 *  - projet lancé depuis un devis accepté de 18 000 000 FCFA HT (forfait 30/50/20 %) ;
 *  - Démarrage validé : brouillon de facture d'étape ordinaire de 5 400 000 HT ;
 *  - « Demander la validation » de Réalisation, bloc « À décider » sur la liste des projets ;
 *  - écran de validation (ordinateur et téléphone) : valider avec 2 réserves, retenue de 5 %,
 *    accord du client et photo du PV ; brouillon de 8 550 000 HT (9 000 000 − 5 %) ;
 *  - réserves devenues tâches de Réception, closes → brouillon de la retenue de 450 000 HT ;
 *  - l'employé voit l'étape validée, sans aucun montant.
 *
 * Prérequis : `npm run build`, Playwright.
 *   node test/e2e/projets-validation.mjs        (SHOTS_DIR=… pour des captures)
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const root = join(import.meta.dirname, "..", "..");
const PORT = 8812;
const BASE = `http://localhost:${PORT}`;
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-validation-"));

const server = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "dev/server.ts"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), DB_PATH: ":memory:" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("localhost") && resolve()));

const browser = await chromium.launch();
const step = (msg) => console.log(`• ${msg}`);
const errors = [];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const day = (n) => iso(new Date(Date.now() + n * 864e5));
const YEAR = new Date().getFullYear();
const nbsp = (s) => (s ?? "").replace(/[  ]/g, " ");
const PROJECT = "Réfection des bureaux de la SEEG";

async function device(name, opts) {
  const context = await browser.newContext({ locale: "fr-FR", deviceScaleFactor: 2, ...opts });
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => errors.push(`[${name}] ${e.message}`));
  return { name, context, page };
}
const shot = async (p, file, o = {}) => shots && p.screenshot({ path: join(shots, file), fullPage: true, ...o });

async function login(page, email, password, fresh) {
  await page.goto(BASE);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  if (fresh) {
    await page.getByLabel("Mot de passe provisoire").fill(password);
    await page.getByLabel("Nouveau mot de passe").fill(fresh);
    await page.getByLabel("Confirmer").fill(fresh);
    await page.getByRole("button", { name: "Enregistrer" }).click();
  }
}

let A, T, J;
try {
  A = await device("direction", { viewport: { width: 1360, height: 900 } });
  const a = A.page;
  const nav = (p, label) => p.getByRole("navigation").getByRole("button", { name: label, exact: true }).click();
  const waitSynced = async (p = a) => {
    await p.getByTestId("sync-pill").click();
    await p.getByTestId("sync-pill").filter({ hasText: "À jour" }).waitFor({ timeout: 10_000 });
  };

  step("Inscription, un employé, un client, un devis accepté de 18 000 000 FCFA HT");
  await a.goto(BASE);
  await a.getByRole("button", { name: "Créer mon entreprise" }).click();
  await a.getByLabel("Nom de l'entreprise").fill("Batiplus Gabon SARL");
  await a.getByLabel("Votre nom").fill("Jimmy Rerambyha");
  await a.getByLabel("E-mail").fill("jimmy@batiplus.ga");
  await a.getByLabel("Mot de passe", { exact: true }).fill("motdepasse1");
  await a.getByLabel("Confirmer le mot de passe").fill("motdepasse1");
  await a.getByRole("button", { name: "Démarrer l'essai gratuit" }).click();
  await waitSynced();
  await nav(a, "Réglages");
  await a.getByRole("button", { name: "Ajouter un utilisateur" }).click();
  await a.getByLabel("Nom", { exact: true }).fill("Junior Mintsa");
  await a.locator("form.form-grid").getByLabel("E-mail").fill("junior@batiplus.ga");
  await a.locator("form.form-grid select[name=role]").selectOption("employee");
  await a.getByLabel("Mot de passe provisoire").fill("provisoire1");
  await a.getByRole("button", { name: "Créer le compte" }).click();
  await a.getByRole("cell", { name: "junior@batiplus.ga" }).waitFor();
  await nav(a, "Clients");
  await a.getByRole("button", { name: "Nouveau client" }).click();
  await a.getByLabel("Raison sociale").fill("SEEG");
  await a.getByRole("button", { name: "Enregistrer" }).click();
  await nav(a, "Devis");
  await a.getByRole("button", { name: "Nouveau devis" }).first().click();
  await a.getByRole("button", { name: "+ Ajouter un titre" }).click();
  await a.getByLabel("Titre de section").fill(PROJECT);
  await a.getByLabel("Désignation").nth(0).fill("Études et plans d'exécution");
  await a.getByLabel("Quantité").nth(0).fill("1");
  await a.getByLabel("Prix unitaire").nth(0).fill("3000000");
  await a.getByRole("button", { name: "+ Ajouter une ligne" }).click();
  await a.getByLabel("Désignation").nth(1).fill("Travaux de réfection");
  await a.getByLabel("Quantité").nth(1).fill("1");
  await a.getByLabel("Prix unitaire").nth(1).fill("15000000");
  await a.getByRole("button", { name: "Finaliser le devis" }).click();
  await a.getByRole("heading", { name: `Devis DV-${YEAR}-00001` }).waitFor();
  await a.getByRole("button", { name: "Marquer accepté" }).click();
  const banner = a.getByTestId("quote-project");
  await banner.getByRole("button", { name: "Lancer le projet" }).click();
  await a.getByRole("heading", { name: "Nouveau projet" }).waitFor();
  await a.getByLabel("Début").fill(day(-20));
  await a.getByLabel(/^Fin prévue/).fill(day(25));
  await a.getByRole("button", { name: "Créer le projet" }).click();
  await a.getByRole("heading", { name: PROJECT }).waitFor();
  await a.getByRole("tab", { name: "Équipe" }).click();
  await a.getByLabel("Personne à ajouter").selectOption({ label: "Junior Mintsa" });
  await a.getByRole("button", { name: "Ajouter à l'équipe" }).click();
  await a.locator(".member-list").getByText("Junior Mintsa").waitFor();

  step("Facturation : l'ancien « jalon % du budget » a disparu, renvoi vers les étapes");
  await a.getByRole("tab", { name: "Facturation" }).click();
  assert.equal(await a.getByText("Part du budget").count(), 0);
  await a.getByText("Les factures d'étape sont préparées à la validation de chaque étape").waitFor();

  step("Démarrage validé : facture d'étape ordinaire de 5 400 000 HT (30 % du vendu)");
  await a.getByRole("tab", { name: /^Étapes/ }).click();
  await a.getByTestId("stage-Démarrage").click();
  await a.locator(".stage-decision").getByRole("button", { name: "Valider l'étape" }).click();
  const dialog = a.getByRole("dialog", { name: "Valider l'étape Démarrage" });
  await dialog.waitFor();
  assert.equal(nbsp(await dialog.getByTestId("val-invoice-net").textContent()), "5 400 000 FCFA");
  await dialog.getByRole("button", { name: "Valider l'étape" }).click();
  const flash = a.getByTestId("decision-flash");
  await flash.getByText("Étape Démarrage validée.", { exact: false }).waitFor();
  assert.match(nbsp(await flash.textContent()), /Brouillon de facture de jalon préparé : 5 400 000 FCFA HT/);
  await a.getByTestId("stage-decided").getByText("Étape validée le", { exact: false }).waitFor();

  step("CA3.7 : la validation de Réception est refusée tant que Réalisation ne l'est pas");
  await a.getByTestId("stage-Réception").click();
  await a.locator(".stage-decision").getByRole("button", { name: "Valider l'étape" }).click();
  const early = a.getByRole("dialog", { name: "Valider l'étape Réception" });
  await early.getByText("Validez d'abord l'étape Réalisation.").waitFor();
  assert.ok(await early.getByRole("button", { name: "Valider l'étape" }).isDisabled());
  await early.getByRole("button", { name: "Annuler" }).click();

  step("« Demander la validation » de Réalisation, avec une note");
  await a.getByTestId("stage-Réalisation").click();
  await a.locator(".stage-decision").getByRole("button", { name: "Demander la validation" }).click();
  await a.getByLabel("Note pour la validation (facultatif)").fill("Visite avec la SEEG mercredi à 10 h");
  await a.locator(".request-form").getByRole("button", { name: "Demander la validation" }).click();
  await a.getByTestId("stage-awaiting").getByText("Validation demandée par Jimmy Rerambyha", { exact: false }).waitFor();
  await a.getByTestId("stage-Réalisation").getByText("À valider").waitFor();
  assert.match(nbsp(await a.getByTestId("project-deadline").textContent()), /Visite avec la SEEG/);
  assert.equal(nbsp(await a.locator(".head-deadline").textContent()), "Validation de Réalisation");
  await shot(a, "onglet-etapes-demande.png");

  step("Bloc « À décider » sur la liste des projets");
  await a.getByRole("button", { name: "← Projets" }).click();
  const decide = a.getByTestId("decide-block");
  await decide.getByText("Valider l'étape Réalisation").waitFor();
  assert.match(nbsp(await decide.textContent()), /demandée par Jimmy Rerambyha aujourd'hui · Visite avec la SEEG/);
  await shot(a, "bloc-a-decider.png", { fullPage: false });
  await waitSynced();

  step("Téléphone du directeur : l'écran de validation tient sur l'écran");
  T = await device("téléphone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const t = T.page;
  await login(t, "jimmy@batiplus.ga", "motdepasse1");
  await t.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Plus" }).click();
  await t.getByRole("navigation", { name: "Autres sections" }).getByRole("button", { name: "Projets", exact: true }).click();
  await t.getByTestId("decide-block").getByRole("button", { name: "Examiner" }).click({ timeout: 15_000 });
  const tdialog = t.getByRole("dialog", { name: "Valider l'étape Réalisation" });
  await tdialog.waitFor();
  await tdialog.getByText("Valider avec réserves", { exact: true }).click();
  await tdialog.getByRole("textbox", { name: "Réserves" }).fill("Joint de carrelage fissuré, bureau 2\nPrise électrique non fixée, bureau 5");
  await tdialog.getByLabel("Pourcentage retenu").fill("5");
  await tdialog.getByRole("checkbox", { name: /^Retenir/ }).check();
  await tdialog.getByLabel("Accord du client donné par").fill("Nadège Ondo, services généraux");
  await shot(t, "validation-telephone.png", { fullPage: false });
  const tOverflow = await t.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(tOverflow <= 1, `débordement horizontal de ${tOverflow}px`);
  await tdialog.getByRole("button", { name: "Annuler" }).click();

  step("Écran de validation : 2 réserves, retenue de 5 %, accord du client et photo du PV");
  await decide.getByRole("button", { name: "Examiner" }).click();
  const v = a.getByRole("dialog", { name: "Valider l'étape Réalisation" });
  await v.waitFor();
  await v.getByText("demandée par Jimmy Rerambyha", { exact: false }).waitFor();
  assert.equal(nbsp(await v.getByTestId("val-invoice-net").textContent()), "9 000 000 FCFA", "50 % du vendu, pas du budget");
  await v.getByText("Valider avec réserves", { exact: true }).click();
  await v.getByRole("textbox", { name: "Réserves" }).fill("Joint de carrelage fissuré, bureau 2\nPrise électrique non fixée, bureau 5");
  await v.getByLabel("Pourcentage retenu").fill("5");
  await v.getByRole("checkbox", { name: /^Retenir/ }).check();
  await v.getByLabel("Accord du client donné par").fill("Nadège Ondo, services généraux");
  const photo = await a.screenshot({ clip: { x: 0, y: 0, width: 300, height: 200 } });
  await v.getByTestId("proof-input").setInputFiles({ name: "PV-realisation-signe.png", mimeType: "image/png", buffer: photo });
  await v.getByText("PV-realisation-signe.png").waitFor();
  assert.equal(nbsp(await v.getByTestId("val-invoice-net").textContent()), "8 550 000 FCFA");
  assert.match(nbsp(await v.getByTestId("val-invoice").textContent()), /9 000 000 − 450 000 retenus/);
  assert.equal(await v.getByRole("checkbox", { name: /Valider la facture tout de suite/ }).isChecked(), false, "décochée par défaut (arbitrage 3)");
  await shot(a, "validation-ordinateur.png", { fullPage: false });
  await v.getByRole("button", { name: "Valider avec réserves" }).click();
  await flash.getByText("Étape Réalisation validée avec réserves", { exact: false }).waitFor();
  assert.match(nbsp(await flash.textContent()), /2 tâches de réserve ajoutées à l'étape Réception\. Brouillon de facture de jalon préparé : 8 550 000 FCFA HT\./);
  const decided = a.getByTestId("stage-decided");
  await decided.getByText("Étape validée avec réserves le", { exact: false }).waitFor();
  assert.match(nbsp(await decided.textContent()), /Accord du client : Nadège Ondo, services généraux\./);
  assert.match(nbsp(await a.getByTestId("stage-invoice").textContent()), /Facture de jalon : brouillon, 8 550 000 FCFA HT, 5 % retenus/);
  assert.match(nbsp(await a.getByTestId("stage-reserves").textContent()), /Réserves : 0 sur 2 close.*Retenue de 450 000 FCFA HT, facturable à la levée des réserves/);
  await a.getByTestId("decision-log").getByText("Étape validée avec réserves").waitFor();
  assert.equal(nbsp(await a.locator(".head-deadline").textContent()), "Validation de Réception", "prochaine échéance : la prochaine validation");

  step("La preuve s'affiche");
  await decided.getByRole("button", { name: "Voir la preuve de l'accord" }).click();
  await a.getByRole("dialog", { name: "Preuve de l'accord du client" }).locator("img").waitFor();
  await a.getByRole("dialog", { name: "Preuve de l'accord du client" }).getByRole("button", { name: "Fermer", exact: true }).click();

  step("Facture de jalon : brouillon au bon montant, lié au projet et à l'étape");
  await flash.getByRole("button", { name: "Ouvrir la facture" }).click();
  await a.getByRole("heading", { name: "Facture (brouillon)" }).waitFor();
  const fields = nbsp(await a.locator("main").evaluate((m) => [...m.querySelectorAll("input, textarea")].map((e) => e.value).join(" | ")));
  assert.ok(fields.includes(`Étape Réalisation : 50 % du devis DV-${YEAR}-00001`), "libellé de la ligne");
  assert.match(fields, /Montant de l'étape : 9 000 000 FCFA HT, moins une retenue de 5 % \(450 000 FCFA HT\) facturée à la levée des réserves/);
  assert.match(nbsp(await a.locator("main").textContent()), /8 550 000/);
  await shot(a, "facture-jalon.png");
  await nav(a, "Factures");
  const rows = nbsp(await a.locator("main table").textContent());
  assert.match(rows, /6 372 000/, "5 400 000 HT + TVA 18 %");
  assert.match(rows, /10 089 000/, "8 550 000 HT + TVA 18 %");

  step("Réserves devenues tâches de Réception, puis closes");
  await nav(a, "Projets");
  await a.getByRole("button", { name: "← Projets" }).click().catch(() => {});
  assert.equal(await a.getByTestId("decide-block").count(), 0, "plus rien à décider");
  await a.getByText(PROJECT).first().click();
  await a.getByRole("tab", { name: /^Tâches/ }).click();
  for (const title of ["Joint de carrelage fissuré, bureau 2", "Prise électrique non fixée, bureau 5"]) {
    const card = a.locator(".task-card", { hasText: title });
    await card.locator(".tag", { hasText: "Réserve" }).waitFor();
    await card.locator(".stage-tag", { hasText: "Réception" }).waitFor();
    await card.getByRole("button", { name: "Commencer" }).click();
    await card.getByRole("button", { name: "Terminer" }).click();
    await a.getByTestId("col-done").getByText(title).waitFor();
  }

  step("Réserves levées : brouillon de facture de la retenue de 450 000 HT");
  await a.getByRole("tab", { name: /^Étapes/ }).click();
  await a.getByTestId("stage-Réalisation").click();
  assert.match(nbsp(await a.getByTestId("stage-reserves").textContent()), /2 sur 2 closes, toutes levées\. La retenue de 450 000 FCFA HT est facturable\./);
  await a.getByRole("button", { name: "Préparer la facture de la retenue" }).click();
  await flash.getByText("Brouillon de facture de la retenue préparé (450 000 FCFA HT).").waitFor();
  assert.match(nbsp(await a.getByTestId("stage-reserves").textContent()), /Retenue facturée : brouillon/);
  await shot(a, "retenue-facturable.png", { fullPage: false });
  await waitSynced();

  step("Employé : l'étape est validée, aucun montant");
  J = await device("employé", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const j = J.page;
  const received = [];
  j.on("response", async (r) => { if (r.url().endsWith("/api/sync")) received.push(await r.text().catch(() => "")); });
  await login(j, "junior@batiplus.ga", "provisoire1", "junior-2026");
  await j.getByRole("heading", { name: "Ma journée" }).waitFor();
  await j.getByRole("navigation").getByRole("button", { name: "Projets", exact: true }).click();
  await j.getByText(PROJECT).first().click({ timeout: 15_000 });
  await j.getByRole("tab", { name: /^Étapes/ }).click();
  await j.getByTestId("stage-Réalisation").click();
  await j.getByTestId("stage-decided").getByText("Étape validée avec réserves le", { exact: false }).waitFor();
  assert.equal(await j.getByTestId("stage-invoice").count(), 0);
  const body = nbsp(await j.locator("body").textContent());
  assert.ok(!body.includes("FCFA"), "aucun montant à l'écran");
  assert.ok(!/retenue/i.test(body), "aucune retenue à l'écran");
  for (const r of received) {
    assert.ok(!r.includes("retention_pct") && !r.includes("jalon_base"), "aucune retenue ni facture reçue");
    assert.ok(!r.includes("8550000") && !r.includes("18000000"), "aucun montant reçu");
  }
  await shot(j, "vue-employe-etape-validee.png");

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nRecette Projets lot 3 (validation d'étape et facture de jalon) réussie.");
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  for (const d of [A, T, J]) if (d) await d.page.screenshot({ path: join(out, `echec-${d.name}.png`), fullPage: true }).catch(() => {});
  console.error(`Captures : ${out}`);
  if (errors.length) console.error(errors.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
