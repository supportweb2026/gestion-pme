/**
 * Recette du module Projets, lot 4 : budget par poste, météo, alerte de tolérance, carte de
 * décision, avenant et révision tracée.
 *  - coût horaire moyen de l'équipe : 5 000 FCFA/h (4 000, 5 000 et 6 000) ;
 *  - devis accepté de 250 000 FCFA HT : 10 h de pose (service, unité h) et 50 m de câble
 *    (produit, prix d'achat 1 200) → budget repris du devis : main-d'œuvre 50 000 (10 h × 5 000),
 *    achats 60 000, soit 110 000 ; marge prévue 140 000 (56 %) ;
 *  - 40 h saisies (2 × 20 h) → coût réel 200 000, +90 000 (82 %), au-delà de la tolérance de
 *    10 % : météo « À redresser », alerte dans « À décider » (le module Dépenses est encore fermé) ;
 *  - l'écran de validation de Démarrage montre le coût de l'étape ;
 *  - le responsable du projet voit l'alerte comme une information, la marge et le coût horaire
 *    moyen, jamais le coût de chaque personne (CA4.6) ;
 *  - « Préparer l'avenant » crée un devis brouillon rattaché au projet, l'alerte disparaît (CA4.9) ;
 *  - budget validé avec Démarrage : la révision demande un motif et reste dans l'historique (R7) ;
 *  - l'employé ne reçoit aucune ligne de budget ni aucun montant.
 *
 * Prérequis : `npm run build`, Playwright.
 *   node test/e2e/projets-budget.mjs        (SHOTS_DIR=… pour des captures)
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
const PORT = 8813;
const BASE = `http://localhost:${PORT}`;
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-budget-"));

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
const nbsp = (s) => (s ?? "").replace(/[  ]/g, " ");
const PROJECT = "Câblage du siège de la CNAMGS";

async function device(name, opts) {
  const context = await browser.newContext({ locale: "fr-FR", deviceScaleFactor: 2, ...opts });
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => errors.push(`[${name}] ${e.message}`));
  return { name, context, page };
}
const shot = async (p, file, o = {}) => shots && p.screenshot({ path: join(shots, file), fullPage: true, ...o });
const nav = (p, label) => p.getByRole("navigation").getByRole("button", { name: label, exact: true }).click();
const waitSynced = async (p) => {
  await p.getByTestId("sync-pill").click();
  await p.getByTestId("sync-pill").filter({ hasText: "À jour" }).waitFor({ timeout: 10_000 });
};

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

let A, M, J;
try {
  A = await device("direction", { viewport: { width: 1360, height: 900 } });
  const a = A.page;

  step("Inscription, une responsable de projet, un employé, coût horaire moyen de 5 000 FCFA/h");
  await a.goto(BASE);
  await a.getByRole("button", { name: "Créer mon entreprise" }).click();
  await a.getByLabel("Nom de l'entreprise").fill("Électro Services Gabon");
  await a.getByLabel("Votre nom").fill("Jimmy Rerambyha");
  await a.getByLabel("E-mail").fill("jimmy@esg.ga");
  await a.getByLabel("Mot de passe", { exact: true }).fill("motdepasse1");
  await a.getByLabel("Confirmer le mot de passe").fill("motdepasse1");
  await a.getByRole("button", { name: "Démarrer l'essai gratuit" }).click();
  await waitSynced(a);
  await nav(a, "Réglages");
  await a.getByRole("tab", { name: "Équipe" }).click();
  for (const [name, email, role] of [["Junior Mintsa", "junior@esg.ga", "employee"], ["Ornella Mba", "ornella@esg.ga", "project_manager"]]) {
    await a.getByRole("button", { name: "Ajouter un utilisateur" }).click();
    await a.getByLabel("Nom", { exact: true }).fill(name);
    await a.locator("form.form-grid").getByLabel("E-mail").fill(email);
    await a.locator("form.form-grid select[name=role]").selectOption(role);
    await a.getByLabel("Mot de passe provisoire").fill("provisoire1");
    await a.getByRole("button", { name: "Créer le compte" }).click();
    await a.getByRole("cell", { name: email }).waitFor();
  }
  await nav(a, "Projets");
  await a.getByRole("tab", { name: "Personnes" }).click();
  for (const [n, job, cost] of [["Jimmy Rerambyha", "Gérant", "5000"], ["Junior Mintsa", "Électricien", "4000"], ["Ornella Mba", "Cheffe de projet", "6000"]]) {
    await a.getByRole("row", { name: new RegExp(n) }).getByRole("button", { name: "Modifier" }).click();
    await a.getByLabel("Métier").fill(job);
    await a.getByLabel("Coût horaire (FCFA / h)").fill(cost);
    await a.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await a.getByRole("row", { name: new RegExp(`${n}.*${job}`) }).waitFor();
  }
  await a.locator(".team-stats").getByText("5 000 FCFA").waitFor();

  step("Articles : pose de câblage (service, à l'heure) et câble (produit, prix d'achat 1 200)");
  await nav(a, "Clients");
  await a.getByRole("button", { name: "Nouveau client" }).click();
  await a.getByLabel("Raison sociale").fill("CNAMGS");
  await a.getByRole("button", { name: "Enregistrer" }).click();
  for (const [label, kind, unit, price, cost] of [["Pose de câblage", "service", "h", 15000, null], ["Câble électrique 3G2,5", "product", "m", 2000, 1200]]) {
    await nav(a, "Articles");
    await a.getByRole("button", { name: "Nouvel article" }).click();
    await a.getByLabel("Désignation").fill(label);
    await a.getByLabel("Type").selectOption(kind);
    await a.getByLabel("Unité").fill(unit);
    await a.getByLabel("Prix unitaire HT (FCFA)").fill(String(price));
    if (cost) await a.getByLabel("Prix d'achat HT (FCFA)").fill(String(cost));
    await a.getByRole("button", { name: "Enregistrer" }).click();
    await a.getByRole("cell", { name: label }).waitFor();
  }

  step("Devis accepté de 250 000 FCFA HT, projet lancé avec Ornella Mba comme responsable");
  await nav(a, "Devis");
  await a.getByRole("button", { name: "Nouveau devis" }).first().click();
  await a.getByRole("button", { name: "+ Ajouter un titre" }).click();
  await a.getByLabel("Titre de section").fill(PROJECT);
  await a.getByLabel("Désignation").nth(0).fill("Pose de câblage");
  await a.getByLabel("Quantité").nth(0).fill("10");
  await a.getByRole("button", { name: "+ Ajouter une ligne" }).click();
  await a.getByLabel("Désignation").nth(1).fill("Câble électrique 3G2,5");
  await a.getByLabel("Quantité").nth(1).fill("50");
  await a.getByRole("button", { name: "Finaliser le devis" }).click();
  await a.getByRole("heading", { name: `Devis DV-${YEAR}-00001` }).waitFor();
  await a.getByRole("button", { name: "Marquer accepté" }).click();
  await a.getByTestId("quote-project").getByRole("button", { name: "Lancer le projet" }).click();
  await a.getByRole("heading", { name: "Nouveau projet" }).waitFor();
  await a.getByLabel("Début").fill(day(0));
  await a.getByLabel(/^Fin prévue/).fill(day(45));
  await a.getByLabel("Responsable du projet").selectOption({ label: "Ornella Mba" });
  await a.getByRole("button", { name: "Créer le projet" }).click();
  await a.getByRole("heading", { name: PROJECT }).waitFor();
  await a.getByRole("tab", { name: "Équipe" }).click();
  await a.getByLabel("Personne à ajouter").selectOption({ label: "Junior Mintsa · Électricien" });
  await a.getByRole("button", { name: "Ajouter à l'équipe" }).click();
  await a.locator(".member-list").getByText("Junior Mintsa").waitFor();

  step("Budget repris du devis : 50 000 de main-d'œuvre (10 h × 5 000) + 60 000 d'achats");
  await a.getByRole("tab", { name: "Budget" }).click();
  assert.equal(nbsp(await a.getByTestId("budget-planned").textContent()), "110 000 FCFA");
  const table = nbsp(await a.locator(".budget-table").textContent());
  assert.match(table, /Main-d'œuvre.*50 000/);
  assert.match(table, /Achats et matériel.*60 000/);
  assert.match(nbsp(await a.getByTestId("budget-margin").textContent()), /140 000/, "marge prévue = 250 000 − 110 000");
  assert.match(nbsp(await a.getByTestId("budget-tab").textContent()), /repris du devis, jamais révisé/);
  await a.getByTestId("project-weather").getByTestId("weather-badge").getByText("Tout va bien").waitFor();
  await shot(a, "onglet-budget-repris-du-devis.png");

  step("40 h saisies sur une tâche de Démarrage (2 × 20 h à 5 000 FCFA/h)");
  await a.getByRole("tab", { name: /^Temps/ }).click();
  const timeForm = a.locator("form.time-form");
  const firstTask = await timeForm.locator("select[name=task_id] option").nth(1).textContent();
  for (const [date, total] of [[day(-1), "20"], [day(0), "40"]]) {
    await timeForm.getByLabel("Date").fill(date);
    await timeForm.locator("select[name=task_id]").selectOption({ label: firstTask });
    await timeForm.getByLabel("Durée (heures)").fill("20");
    await timeForm.getByRole("button", { name: "Enregistrer le temps" }).click();
    await a.getByRole("tab", { name: new RegExp(`^Temps\\s*${total} h`) }).waitFor();
  }

  step("Liste des projets : météo « À redresser » et alerte dans « À décider »");
  await a.getByRole("button", { name: "← Projets" }).click();
  const decide = a.getByTestId("decide-block");
  const alertRow = decide.getByTestId("decide-alert");
  await alertRow.getByText(/Le projet dépasse son budget de 82 %/).waitFor();
  await a.locator(".project-card", { hasText: PROJECT }).getByTestId("weather-badge").getByText("À redresser").waitFor();
  await shot(a, "liste-a-decider-alerte.png", { fullPage: false });

  step("Carte de décision : chiffres, quatre options, phrase de la météo");
  await alertRow.getByRole("button", { name: "Décider" }).click();
  const card = a.getByTestId("exception-card");
  await card.waitFor();
  const cardText = nbsp(await card.textContent());
  assert.match(cardText, /110 000/);
  assert.match(cardText, /200 000/);
  assert.match(cardText, /\+90 000/);
  for (const b of ["Préparer l'avenant", "Réviser", "Demander un plan", "Choisir…"]) await card.getByRole("button", { name: b }).waitFor();
  assert.match(nbsp(await a.getByTestId("project-weather").textContent()), /À redresser.*Le coût final estimé dépasse le budget de 90 000 FCFA \(82 %\)/);
  await a.getByTestId("project-weather").getByRole("button", { name: "Voir le détail" }).click();
  await a.getByTestId("weather-detail").getByText("Vigilance", { exact: true }).waitFor();
  await shot(a, "fiche-carte-de-decision.png");
  await a.getByTestId("weather-detail").getByRole("button", { name: "Fermer le détail de la météo" }).click();

  step("Téléphone : la carte de décision tient dans l'écran");
  await a.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  await shot(a, "carte-de-decision-telephone.png", { fullPage: false });
  const overflow = await a.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `débordement horizontal de ${overflow}px`);
  await a.setViewportSize({ width: 1360, height: 900 });

  step("Écran de validation de Démarrage : coût de l'étape ; validation (le budget est validé)");
  await a.getByRole("tab", { name: /^Étapes/ }).click();
  await a.getByTestId("stage-Démarrage").click();
  await a.locator(".stage-decision").getByRole("button", { name: "Valider l'étape" }).click();
  const v = a.getByRole("dialog", { name: "Valider l'étape Démarrage" });
  await v.waitFor();
  const cost = nbsp(await v.getByTestId("val-cost").textContent());
  assert.match(cost, /Budget de l'étape/);
  assert.match(cost, /projet : 200 000 FCFA sur 110 000 FCFA/);
  await shot(a, "validation-cout-etape.png", { fullPage: false });
  await v.getByRole("button", { name: "Valider l'étape" }).click();
  await a.getByTestId("decision-flash").getByText("Étape Démarrage validée.", { exact: false }).waitFor();
  // Démarrage validé : 30 % d'avancement, le coût final estimé prolonge le rythme (200 000 / 0,3).
  await card.getByText("La marge estimée est négative").waitFor();
  await waitSynced(a);

  step("Responsable du projet : alerte en information, marge et coût horaire moyen, sans décision (CA4.6)");
  M = await device("responsable", { viewport: { width: 1360, height: 900 } });
  const m = M.page;
  await login(m, "ornella@esg.ga", "provisoire1", "ornella-2026");
  await nav(m, "Projets");
  const info = m.getByTestId("decide-block").getByTestId("info-alert");
  await info.getByText(/Hors tolérance : (le projet dépasse son budget|la marge estimée est négative)/).waitFor({ timeout: 15_000 });
  assert.equal(await m.getByTestId("decide-alert").count(), 0, "aucune décision pour la responsable");
  await info.getByRole("button", { name: "Voir le projet" }).click();
  await m.getByTestId("alert-notice").waitFor();
  assert.equal(await m.getByTestId("exception-card").count(), 0);
  await m.getByTestId("alert-notice").getByRole("button", { name: "Voir le budget" }).click();
  await m.getByTestId("budget-tab").waitFor();
  const pmText = nbsp(await m.getByTestId("budget-tab").textContent());
  assert.match(pmText, /40 h saisies × coût horaire moyen de 5 000 FCFA\/h/);
  assert.ok(!/4 000 FCFA\/h|6 000 FCFA\/h|chaque personne/.test(pmText), "aucun coût horaire individuel");
  await m.getByTestId("budget-margin").waitFor();
  await shot(m, "responsable-information.png");

  step("« Préparer l'avenant » : devis brouillon rattaché au projet, l'alerte disparaît (CA4.9)");
  await a.getByRole("tab", { name: /^Tâches/ }).click();
  await card.getByRole("button", { name: "Préparer l'avenant" }).click();
  await a.getByRole("heading", { name: /^Devis/ }).waitFor();
  const fields = nbsp(await a.locator("main").evaluate((el) => [...el.querySelectorAll("input, textarea")].map((e) => e.value).join(" | ")));
  assert.match(fields, /Avenant : Travaux supplémentaires/);
  await shot(a, "devis-avenant-brouillon.png", { fullPage: false });
  await nav(a, "Projets");
  await a.getByRole("button", { name: "← Projets" }).click().catch(() => {});
  assert.equal(await a.getByTestId("decide-alert").count(), 0, "alerte répondue par l'avenant");
  await a.locator(".project-card", { hasText: PROJECT }).click();
  assert.equal(await a.getByTestId("exception-card").count(), 0);

  step("Révision du budget après validation de Démarrage : motif obligatoire, historique (R7)");
  await a.getByRole("tab", { name: "Budget" }).click();
  await a.getByRole("button", { name: "Réviser le budget" }).click();
  const editor = a.getByRole("dialog", { name: "Réviser le budget" });
  await editor.getByLabel("Achats et matériel").fill("160000");
  await editor.getByRole("button", { name: "Enregistrer la révision" }).click();
  await editor.getByText("Indiquez le motif de la révision", { exact: false }).waitFor();
  await editor.getByLabel("Motif de la révision").fill("Câble supplémentaire demandé par la CNAMGS, avenant en cours");
  await shot(a, "revision-budget.png", { fullPage: false });
  await editor.getByRole("button", { name: "Enregistrer la révision" }).click();
  await a.getByTestId("project-flash").getByText("Budget révisé", { exact: false }).waitFor();
  assert.equal(nbsp(await a.getByTestId("budget-planned").textContent()), "210 000 FCFA");
  const history = nbsp(await a.getByTestId("budget-history").textContent());
  assert.match(history, /Budget révisé.*110 000 FCFA → 210 000 FCFA.*Motif : Câble supplémentaire/);
  assert.match(history, /Avenant proposé au client/);
  await shot(a, "historique-revisions.png");
  await waitSynced(a);
  assert.equal(await a.getByTestId("sync-pill").filter({ hasText: /refus/i }).count(), 0, "révision acceptée par le serveur");

  step("Employé : aucune ligne de budget ni aucun montant reçus");
  J = await device("employé", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const j = J.page;
  const received = [];
  j.on("response", async (r) => { if (r.url().endsWith("/api/sync")) received.push(await r.text().catch(() => "")); });
  await login(j, "junior@esg.ga", "provisoire1", "junior-2026");
  await j.getByRole("heading", { name: "Ma journée" }).waitFor();
  await j.getByRole("navigation").getByRole("button", { name: "Projets", exact: true }).click();
  await j.getByText(PROJECT).first().click({ timeout: 15_000 });
  await j.getByRole("heading", { name: PROJECT }).waitFor();
  const body = nbsp(await j.locator("body").textContent());
  assert.ok(!body.includes("FCFA"), "aucun montant à l'écran");
  assert.equal(await j.getByRole("tab", { name: "Budget" }).count(), 0);
  assert.equal(await j.getByTestId("alert-notice").count(), 0);
  for (const r of received) {
    assert.ok(!r.includes('"budget_lines"'), "aucune ligne de budget reçue");
    assert.ok(!r.includes("110000") && !r.includes("210000") && !r.includes("old_value"), "aucun montant reçu");
  }
  await shot(j, "vue-employe.png");

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nRecette Projets lot 4 (budget, météo, alertes, avenant) réussie.");
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  for (const d of [A, M, J]) if (d) await d.page.screenshot({ path: join(out, `echec-${d.name}.png`), fullPage: true }).catch(() => {});
  console.error(`Captures : ${out}`);
  if (errors.length) console.error(errors.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
