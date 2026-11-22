/**
 * Recette du module Projets, lot 5 : piloter tous les projets et toutes les tâches
 * (remplacer le tableau Trello « IDO – Pilotage »).
 *  - Réglages du module : catégories par défaut, une catégorie ajoutée, une renommée ;
 *  - tableau de toutes les tâches : ajout rapide avec le projet, la personne et la catégorie,
 *    filtres (bloquées, catégorie, personne, en retard), glisser-déposer vers « En cours » ;
 *  - fiche de la tâche : blocage, échéance, discussion (commentaire modifiable 15 minutes),
 *    lien, historique (déplacée, échéance, bloquée, débloquée) ; archivage et filtre « Archivées » ;
 *  - portefeuille : une ligne par projet, météo, retards, validations, export CSV ;
 *  - employé sur téléphone : rappel des échéances dans « Ma journée » et « À décider », tableau
 *    limité à ses projets, commentaire, pas d'archivage ni de réglages.
 *
 * Prérequis : `npm run build`, Playwright.
 *   node test/e2e/projets-pilotage.mjs        (SHOTS_DIR=… pour des captures)
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
const PORT = 8815;
const BASE = `http://localhost:${PORT}`;
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-pilotage-"));

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
const PILOTAGE = "IDO – Pilotage";
const CLIENT_PROJECT = "Site web de la SEEG";

async function device(name, opts) {
  const context = await browser.newContext({ locale: "fr-FR", deviceScaleFactor: 2, acceptDownloads: true, ...opts });
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => errors.push(`[${name}] ${e.message}`));
  return { name, context, page };
}
// Petite pause avant chaque capture : les onglets et le menu ont de courtes transitions.
const shot = async (p, file, o = {}) => {
  if (!shots) return;
  await p.mouse.move(0, 0);
  await p.waitForTimeout(300);
  // En capture pleine page, la barre du bas du téléphone (fixe) masquerait le milieu de la page :
  // on la masque le temps de la capture.
  const full = o.fullPage !== false;
  const tag = full ? await p.addStyleTag({ content: ".bottom-nav { display: none !important; }" }) : null;
  await p.screenshot({ path: join(shots, file), fullPage: true, ...o });
  if (tag) await tag.evaluate((el) => el.remove());
};
const nav = (p, label) => p.getByRole("navigation").getByRole("button", { name: label, exact: true }).first().click();
const waitSynced = async (p) => {
  // Une pastille par mise en page (menu latéral, en-tête du téléphone) : on prend la visible.
  const pill = p.locator('[data-testid="sync-pill"]:visible, button.sync-dot:visible');
  await pill.click();
  await pill.filter({ hasText: "À jour" }).waitFor({ timeout: 10_000 });
};

let A, J;
try {
  A = await device("direction", { viewport: { width: 1440, height: 900 } });
  const a = A.page;

  step("Inscription d'IDO, une cheffe de projet et un employé");
  await a.goto(BASE);
  await a.getByRole("button", { name: "Créer mon entreprise" }).click();
  await a.getByLabel("Nom de l'entreprise").fill("IDO");
  await a.getByLabel("Votre nom").fill("Jimmy Rerambyha");
  await a.getByLabel("E-mail").fill("jimmy@ido.ga");
  await a.getByLabel("Mot de passe", { exact: true }).fill("motdepasse1");
  await a.getByLabel("Confirmer le mot de passe").fill("motdepasse1");
  await a.getByRole("button", { name: "Démarrer l'essai gratuit" }).click();
  await waitSynced(a);
  await nav(a, "Réglages");
  for (const [name, email, role] of [["Junior Mintsa", "junior@ido.ga", "employee"], ["Ornella Mba", "ornella@ido.ga", "project_manager"]]) {
    await a.getByRole("button", { name: "Ajouter un utilisateur" }).click();
    await a.getByLabel("Nom", { exact: true }).fill(name);
    await a.locator("form.form-grid").getByLabel("E-mail").fill(email);
    await a.locator("form.form-grid select[name=role]").selectOption(role);
    await a.getByLabel("Mot de passe provisoire").fill("provisoire1");
    await a.getByRole("button", { name: "Créer le compte" }).click();
    await a.getByRole("cell", { name: email }).waitFor();
  }

  step("Deux projets : le projet interne « IDO – Pilotage » (Junior dans l'équipe) et un projet client");
  await nav(a, "Projets");
  for (const [name, team] of [[PILOTAGE, true], [CLIENT_PROJECT, false]]) {
    await a.getByRole("button", { name: "Nouveau projet" }).first().click();
    await a.getByLabel("Nom du projet").fill(name);
    await a.getByLabel("Responsable du projet").selectOption({ label: "Ornella Mba" });
    await a.getByLabel(/^Fin prévue/).fill(day(60));
    await a.getByRole("button", { name: "Créer le projet" }).click();
    await a.getByRole("heading", { name }).waitFor();
    if (team) {
      await a.getByRole("tab", { name: "Équipe" }).click();
      await a.getByLabel("Personne à ajouter").selectOption({ label: "Junior Mintsa" });
      await a.getByRole("button", { name: "Ajouter à l'équipe" }).click();
      await a.locator(".member-list").getByText("Junior Mintsa").waitFor();
    }
    await a.getByRole("button", { name: "← Projets" }).click();
  }

  step("Réglages du module : cinq catégories par défaut, « Relances » ajoutée, « Infra » renommée");
  await a.getByRole("tab", { name: "Réglages" }).click();
  const settings = a.getByTestId("task-settings");
  for (const c of ["Client", "Infra", "Sécurité", "Coûts", "Interne"]) await settings.locator(".cat-row .cat-tag", { hasText: new RegExp(`^${c}$`) }).waitFor();
  await settings.getByLabel("Nouvelle catégorie").fill("Relances");
  await settings.getByRole("button", { name: "Ajouter la catégorie" }).click();
  await settings.locator(".cat-tag", { hasText: "Relances" }).waitFor();
  await settings.locator(".cat-row", { hasText: "Infra" }).getByRole("button", { name: "Renommer" }).click();
  await settings.getByLabel("Nouveau nom de la catégorie Infra").fill("Infrastructure");
  await settings.getByRole("button", { name: "Enregistrer" }).click();
  await settings.locator(".cat-tag", { hasText: "Infrastructure" }).waitFor();

  step("Toutes les tâches : ajout rapide en choisissant le projet, la personne et la catégorie");
  await a.getByRole("tab", { name: "Tâches" }).click();
  await a.getByRole("heading", { name: "Toutes les tâches" }).waitFor();
  const add = a.getByRole("form", { name: "Ajouter une tâche" });
  const cards = [
    ["Renouveler le certificat TLS de gestia.ido.ga", PILOTAGE, "Junior Mintsa", "Sécurité"],
    ["Vérifier les sauvegardes D1", PILOTAGE, "Junior Mintsa", "Infrastructure"],
    ["Relancer la SEEG pour la validation des maquettes", CLIENT_PROJECT, "Ornella Mba", "Relances"],
    ["Comparer les offres de stockage", PILOTAGE, "", "Coûts"],
  ];
  for (const [title, project, who, cat] of cards) {
    await add.getByLabel("Nouvelle tâche").fill(title);
    await add.getByLabel("Projet de la tâche").selectOption({ label: project });
    await add.getByLabel("Attribuer à").selectOption(who ? { label: who } : "");
    await add.getByLabel("Catégorie de la tâche").selectOption({ label: cat });
    await add.getByRole("button", { name: "Ajouter la tâche" }).click();
    await a.getByTestId("board-col-todo").getByTestId("board-card").filter({ hasText: title }).waitFor();
  }
  const card = (title) => a.getByTestId("board-card").filter({ hasText: title });
  await card(cards[0][0]).getByTestId("task-category").getByText("Sécurité", { exact: true }).waitFor();
  await card(cards[2][0]).getByText(CLIENT_PROJECT).waitFor();

  step("Fiche de la tâche : échéance d'hier, puis blocage de la relance de la SEEG");
  const panel = a.getByTestId("task-panel");
  const setDue = async (title, date) => {
    await card(title).getByRole("button", { name: title }).click();
    await panel.getByRole("button", { name: "Modifier la tâche" }).click();
    await panel.getByLabel("Échéance").fill(date);
    await panel.getByRole("button", { name: "Enregistrer" }).click();
    await panel.getByRole("button", { name: "Modifier la tâche" }).waitFor();
  };
  await setDue(cards[0][0], day(-1));
  await panel.getByText(/En retard de 1 jour/).waitFor();
  await panel.getByRole("button", { name: "Fermer la tâche" }).click();
  await setDue(cards[1][0], day(1));
  await panel.getByRole("button", { name: "Fermer la tâche" }).click();
  await setDue(cards[2][0], day(2));
  await panel.getByRole("button", { name: "Signaler un blocage" }).click();
  await panel.getByLabel("Motif du blocage").selectOption({ label: "J'attends le client" });
  await panel.getByLabel("Précision (facultatif)").fill("maquettes envoyées le 18/11");
  await panel.getByRole("button", { name: "Signaler le blocage" }).click();
  await panel.getByTestId("tp-blocked").getByText("Bloquée : J'attends le client").waitFor();
  await panel.getByRole("button", { name: "Fermer la tâche" }).click();
  await card(cards[2][0]).locator(".task-blocked").getByText(/Bloquée : J'attends le client/).waitFor();
  assert.ok(await card(cards[2][0]).evaluate((el) => el.classList.contains("blocked")), "liseré « bloquée »");
  // Modifier l'échéance ne fait pas perdre une catégorie ajoutée dans les réglages.
  await card(cards[2][0]).getByTestId("task-category").getByText("Relances", { exact: true }).waitFor();

  step("Filtres : bloquées, catégorie, personne, en retard ; puis tout effacer");
  const visibleTitles = async () => (await a.getByTestId("board").getByTestId("board-card").locator(".task-title").allTextContents()).sort();
  await a.getByRole("button", { name: /^Bloquées/ }).click();
  assert.deepEqual(await visibleTitles(), [cards[2][0]]);
  await a.getByRole("button", { name: /^Bloquées/ }).click();
  await a.getByLabel("Filtrer par catégorie").selectOption({ label: "Sécurité" });
  assert.deepEqual(await visibleTitles(), [cards[0][0]]);
  await a.getByLabel("Filtrer par catégorie").selectOption("");
  await a.getByLabel("Filtrer par personne").selectOption({ label: "Junior Mintsa" });
  assert.deepEqual(await visibleTitles(), [cards[0][0], cards[1][0]].sort());
  await a.getByRole("button", { name: /^En retard/ }).click();
  assert.deepEqual(await visibleTitles(), [cards[0][0]]);
  await a.getByTestId("board-summary").getByText(/1 tâche avec ces filtres/).waitFor();
  await shot(a, "toutes-les-taches-filtres-ordinateur.png", { fullPage: false });
  await a.getByRole("button", { name: "Effacer les filtres" }).first().click();
  assert.equal((await visibleTitles()).length, 4);

  step("Glisser-déposer : le certificat passe « En cours »");
  await card(cards[0][0]).dragTo(a.getByTestId("board-col-doing"));
  await a.getByTestId("board-col-doing").getByTestId("board-card").filter({ hasText: cards[0][0] }).waitFor();

  step("Discussion : commentaire daté et signé, modifiable pendant 15 minutes ; lien ; historique");
  await card(cards[0][0]).getByRole("button", { name: cards[0][0] }).click();
  const talk = panel.getByTestId("task-discussion");
  await talk.getByLabel("Votre commentaire").fill("Certificat commandé chez le registraire, en attente de validation DNS.");
  await talk.getByRole("button", { name: "Publier le commentaire" }).click();
  const c1 = talk.getByTestId("comment").first();
  await c1.getByText("Jimmy Rerambyha").waitFor();
  await c1.getByText(/aujourd'hui à \d{2} h \d{2}/).waitFor();
  await c1.getByText("encore 15 minutes").waitFor();
  await c1.getByRole("button", { name: "Modifier" }).click();
  await talk.getByLabel("Modifier le commentaire").fill("Certificat commandé chez le registraire : validation DNS faite.");
  await talk.getByRole("button", { name: "Enregistrer" }).click();
  await c1.getByText(/validation DNS faite/).waitFor();
  await c1.getByText(/modifié/).waitFor();
  await panel.getByRole("tab", { name: /Pièces jointes/ }).click();
  await panel.getByRole("button", { name: "Ajouter un lien" }).click();
  await panel.getByLabel("Adresse du lien").fill("github.com/supportweb2026/gestion-pme/pull/24");
  await panel.getByLabel("Libellé (facultatif)").fill("Demande de fusion du lot 5");
  await panel.getByRole("button", { name: "Ajouter le lien" }).click();
  const link = panel.getByTestId("attachment").getByRole("link", { name: "Demande de fusion du lot 5" });
  assert.equal(await link.getAttribute("href"), "https://github.com/supportweb2026/gestion-pme/pull/24");
  await panel.getByRole("tab", { name: "Historique" }).click();
  const hist = panel.getByTestId("task-history");
  await hist.getByText("Déplacée de « À faire » vers « En cours »").waitFor();
  await hist.getByText(/^Échéance fixée au/).waitFor();
  await hist.getByText("Tâche créée").waitFor();
  assert.match(await hist.textContent(), /par Jimmy Rerambyha/);
  await panel.getByRole("tab", { name: /Discussion/ }).click();
  await shot(a, "fiche-tache-discussion-ordinateur.png", { fullPage: false });
  await panel.getByRole("button", { name: "Fermer la tâche" }).click();
  await card(cards[0][0]).locator(".fact-ico").first().waitFor();

  step("Débloquer : l'historique le garde ; terminer puis archiver une tâche");
  await card(cards[2][0]).getByRole("button", { name: "Débloquer" }).click();
  await card(cards[2][0]).locator(".task-blocked").waitFor({ state: "detached" });
  await card(cards[2][0]).getByRole("button", { name: cards[2][0] }).click();
  await panel.getByRole("tab", { name: "Historique" }).click();
  await panel.getByTestId("task-history").getByText("Débloquée").waitFor();
  await panel.getByTestId("task-history").getByText("Bloquée : J'attends le client").waitFor();
  await shot(a, "fiche-tache-historique-ordinateur.png", { fullPage: false });
  await panel.getByRole("button", { name: "Fermer la tâche" }).click();
  await card(cards[3][0]).dragTo(a.getByTestId("board-col-done"));
  await a.getByTestId("board-col-done").getByTestId("board-card").filter({ hasText: cards[3][0] }).waitFor();
  await card(cards[3][0]).getByRole("button", { name: cards[3][0] }).click();
  await panel.getByRole("button", { name: "Archiver la tâche" }).click();
  await panel.getByText(/Tâche archivée/).waitFor();
  await panel.getByRole("button", { name: "Fermer la tâche" }).click();
  await card(cards[3][0]).waitFor({ state: "detached" });
  await a.getByRole("button", { name: /^Archivées/ }).click();
  await a.getByTestId("archived-list").getByText(cards[3][0]).waitFor();
  await a.getByRole("button", { name: /^Archivées/ }).click();
  await shot(a, "toutes-les-taches-ordinateur.png", { fullPage: false });
  await waitSynced(a);

  step("Portefeuille : une ligne par projet, retards et blocages, export CSV");
  await a.getByRole("tab", { name: "Portefeuille" }).click();
  await a.getByRole("heading", { name: "Tous les projets" }).waitFor();
  const table = a.getByTestId("portfolio-table");
  const rowP = table.getByTestId("pf-row").filter({ hasText: PILOTAGE });
  await rowP.getByText("Responsable : Ornella Mba").waitFor();
  await rowP.getByText("1 en retard").waitFor();
  assert.equal(await table.getByTestId("pf-row").count(), 2);
  await a.getByTestId("pf-active").getByText("2").waitFor();
  const [download] = await Promise.all([a.waitForEvent("download"), a.getByRole("button", { name: "Exporter en CSV" }).click()]);
  const file = join(out, download.suggestedFilename());
  await download.saveAs(file);
  const csv = readFileSync(file, "utf8").replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(csv.length, 3, "en-tête + une ligne par projet affiché (CA5.4)");
  assert.match(csv[0], /^Projet;Client;Responsable du projet;Statut;Météo/);
  assert.ok(csv.some((l) => l.startsWith(`${PILOTAGE};Projet interne;Ornella Mba;En cours;`)));
  await shot(a, "portefeuille-ordinateur.png", { fullPage: false });
  await rowP.getByRole("button", { name: PILOTAGE }).click();
  await a.getByRole("heading", { name: PILOTAGE }).waitFor();
  // Le tableau du projet montre la catégorie et ouvre la même fiche.
  await a.locator(".task-card", { hasText: cards[0][0] }).getByTestId("task-category").getByText("Sécurité").waitFor();
  await a.getByRole("button", { name: "← Projets" }).click();
  await a.getByTestId("portfolio").waitFor();

  step("Portefeuille sur téléphone : des cartes, sans défilement horizontal (CA5.5)");
  await a.setViewportSize({ width: 360, height: 780 });
  await a.locator(".pf-card", { hasText: PILOTAGE }).waitFor();
  // Le menu latéral se replie avec une courte transition : on attend la mise en page finale.
  await a.waitForFunction(() => document.querySelector(".main")?.getBoundingClientRect().left === 0);
  await a.waitForTimeout(250);
  assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "pas de défilement horizontal");
  await shot(a, "portefeuille-telephone.png");
  await a.setViewportSize({ width: 1440, height: 900 });

  step("Employé sur téléphone : « Ma journée » rappelle l'échéance de demain et le retard");
  J = await device("employé", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const j = J.page;
  await j.goto(BASE);
  await j.getByLabel("E-mail").fill("junior@ido.ga");
  await j.getByLabel("Mot de passe").fill("provisoire1");
  await j.getByRole("button", { name: "Se connecter" }).click();
  await j.getByLabel("Mot de passe provisoire").fill("provisoire1");
  await j.getByLabel("Nouveau mot de passe").fill("junior-2026");
  await j.getByLabel("Confirmer").fill("junior-2026");
  await j.getByRole("button", { name: "Enregistrer" }).click();
  await j.getByRole("heading", { name: "Ma journée" }).waitFor();
  const list = j.getByTestId("day-list");
  await list.getByText(cards[1][0]).waitFor({ timeout: 15_000 });
  const titles = await list.locator(".day-title").allTextContents();
  assert.deepEqual(titles.slice(0, 2), [cards[0][0], cards[1][0]], "en retard, puis due demain");
  await list.locator(".day-task", { hasText: cards[1][0] }).getByText("Échéance demain").waitFor();

  step("Employé : « À décider » rappelle ses échéances ; le tableau ne montre que ses projets");
  await j.getByRole("navigation").getByRole("button", { name: "Projets", exact: true }).click();
  const decide = j.getByTestId("decide-block");
  await decide.getByTestId("decide-deadline").filter({ hasText: cards[0][0] }).getByText("En retard d'1 jour").waitFor();
  await decide.getByTestId("decide-deadline").filter({ hasText: cards[1][0] }).getByText("Échéance demain").waitFor();
  assert.equal(await j.getByRole("tab", { name: "Réglages" }).count(), 0);
  assert.equal(await j.getByRole("tab", { name: "Portefeuille" }).count(), 0);
  await decide.getByTestId("decide-deadline").filter({ hasText: cards[0][0] }).getByRole("button", { name: "Ouvrir la tâche" }).click();
  const jp = j.getByTestId("task-panel");
  await jp.getByRole("heading", { name: cards[0][0] }).waitFor();
  await jp.getByTestId("task-discussion").getByText(/validation DNS faite/).waitFor();
  // Le commentaire de Jimmy n'est pas modifiable par Junior.
  assert.equal(await jp.getByTestId("comment").first().getByRole("button", { name: "Modifier" }).count(), 0);
  await jp.getByLabel("Votre commentaire").fill("Enregistrement DNS vérifié sur le téléphone.");
  await jp.getByRole("button", { name: "Publier le commentaire" }).click();
  await jp.getByTestId("comment").filter({ hasText: "Junior Mintsa" }).getByText("encore 15 minutes").waitFor();
  await shot(j, "fiche-tache-discussion-telephone.png", { fullPage: false });
  await jp.getByRole("tab", { name: "Historique" }).click();
  await shot(j, "fiche-tache-historique-telephone.png", { fullPage: false });
  await jp.getByRole("button", { name: "Fermer la tâche" }).click();
  const jTitles = (await j.getByTestId("board").getByTestId("board-card").locator(".task-title").allTextContents()).sort();
  assert.deepEqual(jTitles, [cards[0][0], cards[1][0]].sort(), "ses tâches par défaut, jamais le projet client");
  await j.getByRole("button", { name: "Mes tâches" }).click();
  const allMine = (await j.getByTestId("board").getByTestId("board-card").locator(".task-title").allTextContents()).sort();
  assert.ok(!allMine.includes(cards[2][0]), "le projet client n'est pas visible");
  await j.getByRole("button", { name: /^Filtres/ }).click();
  await j.getByLabel("Filtrer par catégorie").waitFor();
  await shot(j, "toutes-les-taches-filtres-telephone.png");
  await j.getByRole("button", { name: /^Filtres/ }).click();
  await shot(j, "toutes-les-taches-telephone.png");
  await waitSynced(j);

  step("La direction reçoit le commentaire de l'employé");
  await a.getByRole("tab", { name: "Tâches" }).click();
  await waitSynced(a);
  await card(cards[0][0]).getByRole("button", { name: cards[0][0] }).click();
  await panel.getByTestId("task-discussion").getByText("Enregistrement DNS vérifié sur le téléphone.").waitFor({ timeout: 10_000 });
  assert.equal(await panel.getByTestId("comment").filter({ hasText: "Junior Mintsa" }).getByRole("button", { name: "Modifier" }).count(), 0);

  assert.deepEqual(errors, [], `erreurs de page : ${errors.join(" | ")}`);
  console.log("✓ Recette du lot 5 (pilotage) réussie");
} catch (e) {
  console.error(e);
  if (A) await A.page.screenshot({ path: join(out, "echec-direction.png"), fullPage: true }).catch(() => {});
  if (J) await J.page.screenshot({ path: join(out, "echec-employe.png"), fullPage: true }).catch(() => {});
  console.error(`Captures d'échec : ${out}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
