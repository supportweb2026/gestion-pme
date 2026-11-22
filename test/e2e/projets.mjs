/**
 * Recette du module Projets, lot 1 : équipe et Ma journée.
 *  - module ouvert (plus de « Bientôt »), « Ma journée » dans le menu ;
 *  - annuaire rempli depuis les comptes, personne sans compte, coût horaire ;
 *  - projet avec chef de projet choisi dans l'annuaire, équipe, tâches attribuées ;
 *  - employé sur téléphone : Ma journée en premier écran (CA1.1), saisie en 2 gestes
 *    hors ligne (CA1.2), chronomètre qui survit au rechargement, plafond de 24 h (CA1.3),
 *    « Je suis bloqué » (CA1.7), « J'ai terminé cette tâche » ;
 *  - aucun montant reçu par l'employé, ni à l'écran (CA1.4) ;
 *  - À vérifier → Terminé : refusé à l'employé (écran et serveur), fait par la direction (CA1.5).
 *
 * Prérequis : `npm run build`, Playwright.
 *   node test/e2e/projets.mjs        (SHOTS_DIR=… pour des captures)
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
const PORT = 8796;
const BASE = `http://localhost:${PORT}`;
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-projets-"));

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
const TODAY = iso(new Date());
const YESTERDAY = iso(new Date(Date.now() - 864e5));
const TOMORROW = iso(new Date(Date.now() + 864e5));

async function device(name, opts) {
  const context = await browser.newContext({ locale: "fr-FR", deviceScaleFactor: 2, ...opts });
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => errors.push(`[${name}] ${e.message}`));
  return { name, context, page };
}
const shot = async (p, file) => shots && p.screenshot({ path: join(shots, file), fullPage: true });

let A, J;
try {
  A = await device("direction", { viewport: { width: 1360, height: 900 } });
  const a = A.page;
  const nav = (label) => a.getByRole("navigation").getByRole("button", { name: label, exact: true }).click();
  const waitSynced = async () => {
    await a.getByTestId("sync-pill").click();
    await a.getByTestId("sync-pill").filter({ hasText: "À jour" }).waitFor({ timeout: 10_000 });
  };

  step("Inscription de la direction ; module Projets ouvert, « Ma journée » dans le menu");
  await a.goto(BASE);
  await a.getByRole("button", { name: "Créer mon entreprise" }).click();
  await a.getByLabel("Nom de l'entreprise").fill("IDO SARL");
  await a.getByLabel("Votre nom").fill("Jimmy Rerambyha");
  await a.getByLabel("E-mail").fill("jimmy@ido.ga");
  await a.getByLabel("Mot de passe", { exact: true }).fill("motdepasse1");
  await a.getByLabel("Confirmer le mot de passe").fill("motdepasse1");
  await a.getByRole("button", { name: "Démarrer l'essai gratuit" }).click();
  await waitSynced();
  assert.equal(await a.getByRole("navigation").getByRole("button", { name: "Projets", exact: true }).count(), 1, "Projets sans pastille « Bientôt »");
  await a.getByRole("navigation").getByRole("button", { name: "Ma journée", exact: true }).waitFor();

  step("Comptes : un employé et une cheffe de projet ; l'annuaire se remplit tout seul");
  await nav("Réglages");
  for (const [name, email, role] of [["Junior Mintsa", "junior@ido.ga", "employee"], ["Ornella Mba", "ornella@ido.ga", "project_manager"]]) {
    await a.getByRole("button", { name: "Ajouter un utilisateur" }).click();
    await a.getByLabel("Nom", { exact: true }).fill(name);
    await a.locator("form.form-grid").getByLabel("E-mail").fill(email);
    await a.locator("form.form-grid select[name=role]").selectOption(role);
    await a.getByLabel("Mot de passe provisoire").fill("provisoire1");
    await a.getByRole("button", { name: "Créer le compte" }).click();
    await a.getByRole("cell", { name: email }).waitFor();
  }
  await nav("Projets");
  await a.getByRole("tab", { name: "Personnes" }).click();
  for (const n of ["Jimmy Rerambyha", "Junior Mintsa", "Ornella Mba"]) await a.getByRole("row", { name: new RegExp(n) }).getByText("Compte Gestia").waitFor();

  step("Annuaire : personne sans compte, métiers et coûts horaires (coût moyen recalculé)");
  await a.getByRole("button", { name: "Ajouter une personne" }).click();
  await a.getByLabel("Nom et prénom").fill("Steeve Obame");
  await a.getByLabel("Métier").fill("Électricien");
  await a.getByLabel("Téléphone").fill("+241 077 12 34 56");
  await a.getByLabel("Coût horaire (FCFA / h)").fill("4000");
  await a.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await a.getByRole("row", { name: /Steeve Obame/ }).getByText("Sans compte").waitFor();
  for (const [n, job, cost] of [["Junior Mintsa", "Technicien", "3000"], ["Ornella Mba", "Cheffe de projet", "6000"]]) {
    await a.getByRole("row", { name: new RegExp(n) }).getByRole("button", { name: "Modifier" }).click();
    await a.getByLabel("Métier").fill(job);
    await a.getByLabel("Coût horaire (FCFA / h)").fill(cost);
    await a.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await a.getByRole("row", { name: new RegExp(`${n}.*${job}`) }).waitFor();
  }
  await a.locator(".team-stats").getByText("4 333 FCFA").waitFor();
  await shot(a, "annuaire-ordinateur.png");

  step("Projet : responsable choisi dans l'annuaire, site, montants protégés, équipe");
  await a.getByRole("tab", { name: "Projets" }).click();
  await a.getByRole("button", { name: "Nouveau projet" }).click();
  await a.getByLabel("Nom du projet").fill("Rénovation agence BGFI Owendo");
  await a.getByLabel("Responsable du projet").selectOption({ label: "Ornella Mba" });
  await a.getByLabel("Adresse ou site").fill("Agence BGFI, carrefour SNI, Owendo");
  await a.getByLabel("Budget HT (FCFA)").fill("5000000");
  await a.getByLabel("Taux de facturation (FCFA / h)").fill("25000");
  await a.getByLabel("Coût horaire interne (FCFA / h)").fill("9000");
  await a.getByRole("button", { name: "Créer le projet" }).click();
  await a.getByRole("heading", { name: "Rénovation agence BGFI Owendo" }).waitFor();
  await a.getByText("Responsable : Ornella Mba").waitFor();
  await a.getByRole("tab", { name: "Équipe" }).click();
  for (const [n, job] of [["Junior Mintsa", "Technicien"], ["Steeve Obame", "Électricien"]]) {
    await a.getByLabel("Personne à ajouter").selectOption({ label: `${n} · ${job}` });
    await a.getByRole("button", { name: "Ajouter à l'équipe" }).click();
    await a.locator(".member-list").getByText(n).waitFor();
  }

  step("Tâches attribuées dans l'annuaire : une échue hier, une pour aujourd'hui, une à un autre");
  await a.getByRole("tab", { name: "Tâches" }).click();
  const tasks = [
    ["Dépose des anciennes cloisons, hall", "Junior Mintsa", YESTERDAY],
    ["Protection des sols du hall", "Junior Mintsa", TODAY],
    ["Reprise des saignées, bureau 2", "Junior Mintsa", TOMORROW],
    ["Plan électrique détaillé", "Steeve Obame", TOMORROW],
  ];
  for (const [title, who, due] of tasks) {
    await a.getByLabel("Nouvelle tâche").fill(title);
    await a.getByRole("button", { name: "Ajouter la tâche", exact: true }).click();
    await a.locator(".task-card", { hasText: title }).getByRole("button", { name: title }).click();
    const form = a.locator(".task-card form");
    await form.getByLabel("Attribuée à").selectOption({ label: who });
    await form.getByLabel("Échéance").fill(due);
    await form.getByLabel("Estimation (h)").fill("6");
    await form.getByRole("button", { name: "Enregistrer" }).click();
    await a.locator(".task-card", { hasText: title }).getByText(who).waitFor();
  }
  await waitSynced();

  step("Employé sur téléphone : « Ma journée » en premier écran, ses tâches, la plus en retard d'abord (CA1.1)");
  J = await device("employé", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const j = J.page;
  const received = [];
  j.on("response", async (r) => { if (r.url().endsWith("/api/sync")) received.push(await r.text().catch(() => "")); });
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
  await list.getByText("Protection des sols du hall").waitFor({ timeout: 15_000 });
  const titles = await list.locator(".day-title").allTextContents();
  assert.deepEqual(titles.slice(0, 2), ["Dépose des anciennes cloisons, hall", "Protection des sols du hall"]);
  assert.ok(!titles.includes("Plan électrique détaillé"), "pas la tâche d'un autre");
  await list.locator(".day-task").first().getByText("En retard d'1 jour").waitFor();
  await list.locator(".day-task").first().getByText("Agence BGFI, carrefour SNI, Owendo").waitFor();

  step("Hors ligne : toucher la tâche, puis « 2 h » ; 1 modification en attente (CA1.2)");
  await J.context.setOffline(true);
  await list.getByRole("button", { name: /Protection des sols du hall : saisir du temps/ }).click();
  await j.getByRole("group", { name: "Durée travaillée aujourd'hui" }).getByRole("button", { name: "2 h", exact: true }).click();
  await j.getByTestId("saved-bar").getByText("2 h enregistrées").waitFor();
  await shot(j, "ma-journee-saisie-2-gestes.png");
  await j.getByRole("dialog").getByRole("button", { name: "Fermer" }).click();
  await j.getByTestId("pending-banner").getByText("1 saisie sera envoyée au retour du réseau").waitFor();
  await j.getByTestId("hours-today").filter({ hasText: /^2 h$/ }).waitFor();

  step("Chronomètre : un seul à la fois, il survit au rechargement de l'application");
  await list.getByRole("button", { name: "Démarrer le chronomètre : Dépose des anciennes cloisons, hall" }).click();
  await j.getByTestId("chrono").getByText("Dépose des anciennes cloisons, hall").waitFor();
  assert.ok(await list.getByRole("button", { name: /Démarrer le chronomètre : Reprise/ }).isDisabled(), "un seul chronomètre");
  await shot(j, "ma-journee-telephone.png");
  await j.reload();
  await j.getByTestId("chrono").getByText("Dépose des anciennes cloisons, hall").waitFor();
  await j.getByRole("button", { name: "Arrêter" }).click();
  await j.getByTestId("chrono").getByRole("button", { name: "0,5 h" }).click();
  await j.getByTestId("hours-today").filter({ hasText: /^2,5 h$/ }).waitFor();

  step("Plafond : pas plus de 24 h par jour (CA1.3)");
  await list.getByRole("button", { name: /Reprise des saignées, bureau 2 : saisir du temps/ }).click();
  await j.getByRole("button", { name: "Autre durée" }).click();
  await j.getByLabel("Durée (heures)").fill("22");
  await j.getByRole("button", { name: "Enregistrer" }).click();
  await j.getByRole("alert").filter({ hasText: "Pas plus de 24 h par jour" }).waitFor();
  await j.getByRole("dialog").getByRole("button", { name: "Fermer" }).click();

  step("« Je suis bloqué » avec motif, visible sur la carte (CA1.7)");
  await j.getByRole("button", { name: "Je suis bloqué" }).click();
  await j.getByRole("dialog").getByRole("button", { name: /Dépose des anciennes cloisons/ }).click();
  await j.getByRole("radio", { name: "J'attends du matériel" }).click();
  await j.getByLabel("Précision (facultatif)").fill("plâtre en rupture");
  await shot(j, "ma-journee-bloque.png");
  await j.getByRole("button", { name: "Signaler le blocage" }).click();
  await list.locator(".day-task", { hasText: "Dépose" }).getByText("Bloquée : J'attends du matériel (plâtre en rupture)").waitFor();

  step("« J'ai terminé cette tâche » : la tâche passe À vérifier");
  await list.getByRole("button", { name: /Protection des sols du hall : saisir du temps/ }).click();
  await j.getByRole("button", { name: "J'ai terminé cette tâche" }).click();
  await j.getByRole("dialog").waitFor({ state: "detached" });
  await j.locator(".day-list.review").getByText("Protection des sols du hall").waitFor();

  step("Retour du réseau : tout est envoyé");
  await J.context.setOffline(false);
  await j.locator(".sync-dot").click();
  await j.getByTestId("pending-banner").waitFor({ state: "detached", timeout: 15_000 });
  await j.reload();
  await j.getByTestId("day-list").waitFor();
  await j.evaluate(() => document.fonts.ready);
  await shot(j, "ma-journee-telephone-a-jour.png");

  step("Aucun montant pour l'employé : ni dans les réponses du serveur, ni sur l'appareil, ni à l'écran (CA1.4)");
  const wire = received.join("\n");
  for (const f of ["budget", "hourly_rate", "cost_rate", "hourly_cost", "legacy_budget", "project_finance", "cost_rates"]) assert.ok(!wire.includes(`"${f}"`), `« ${f} » reçu par l'employé`);
  const local = await j.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open("gestion-pme"); r.onsuccess = () => res(r.result); });
    const all = await new Promise((res) => { const r = db.transaction("records").objectStore("records").getAll(); r.onsuccess = () => res(r.result); });
    return JSON.stringify(all);
  });
  assert.ok(!/"(budget|hourly_rate|cost_rate|hourly_cost|legacy_budget)"/.test(local), "aucun montant dans la base de l'appareil");
  await j.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Projets" }).click();
  await j.getByRole("button", { name: /Rénovation agence BGFI Owendo/ }).click();
  await j.getByRole("heading", { name: "Rénovation agence BGFI Owendo" }).waitFor();
  assert.ok(!(await j.locator("main").innerText()).includes("FCFA"), "aucun montant affiché");
  assert.equal(await j.getByRole("tab", { name: "Facturation" }).count(), 0);

  step("CA1.5 : l'employé ne peut pas passer À vérifier → Terminé, ni à l'écran ni en forçant le serveur");
  const review = j.getByTestId("col-review").locator(".task-card", { hasText: "Protection des sols du hall" });
  await review.getByText("En attente de vérification").waitFor();
  assert.equal(await review.getByRole("button", { name: "Clore la tâche" }).count(), 0);
  const forced = await j.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open("gestion-pme"); r.onsuccess = () => res(r.result); });
    const get = (store, key) => new Promise((res) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => res(r.result); });
    const all = await new Promise((res) => { const r = db.transaction("records").objectStore("records").getAll(); r.onsuccess = () => res(r.result); });
    const task = all.find((x) => x.tbl === "tasks" && x.data.title === "Protection des sols du hall");
    const session = await get("meta", "session");
    const deviceId = await get("meta", "deviceId");
    const hlc = `${String(Date.now()).padStart(15, "0")}-00000-${deviceId}`;
    const res = await fetch("/api/sync", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ since: 0, changes: [{ id: crypto.randomUUID(), tbl: "tasks", row: task.id, patch: { status: "done" }, hlc, device: deviceId }] }),
    });
    return (await res.json()).rejected?.[0]?.reason ?? "accepté";
  });
  assert.match(forced, /vous ne pouvez pas passer cette tâche à Terminé : elle sera close après vérification/);
  await shot(j, "fiche-projet-telephone-employe.png");

  step("Direction : carte bloquée lisible, filtre par personne, vérification À vérifier → Terminé");
  await waitSynced();
  await a.getByRole("button", { name: "← Projets" }).click();
  await a.getByRole("button", { name: /Rénovation agence BGFI Owendo/ }).getByText("1 tâche bloquée").waitFor();
  await a.getByRole("button", { name: /Rénovation agence BGFI Owendo/ }).click();
  const blocked = a.locator(".task-card.blocked", { hasText: "Dépose des anciennes cloisons, hall" });
  await blocked.getByText("Bloquée : J'attends du matériel (plâtre en rupture)").waitFor();
  await a.getByTestId("col-review").getByText("Protection des sols du hall").waitFor();
  await shot(a, "fiche-projet-taches-ordinateur.png");
  await a.getByLabel("Filtrer par personne").selectOption({ label: "Steeve Obame" });
  assert.equal(await a.locator(".task-card").count(), 1);
  await a.getByLabel("Filtrer par personne").selectOption({ label: "Toutes les tâches" });
  await a.getByTestId("col-review").locator(".task-card", { hasText: "Protection des sols du hall" }).getByRole("button", { name: "Clore la tâche" }).click();
  await a.getByTestId("col-done").getByText("Protection des sols du hall").waitFor();
  step("Marge : le temps de Junior compte à son coût horaire (3 000 FCFA/h × 2,5 h)");
  await a.getByRole("tab", { name: "Facturation" }).click();
  await a.getByTestId("project-margin").filter({ hasText: /^-7 500 FCFA$/ }).waitFor();
  await waitSynced();

  step("Téléphone : pas de débordement horizontal");
  const overflow = await j.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `débordement horizontal de ${overflow}px`);

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nRecette Projets lot 1 (équipe et Ma journée) réussie.");
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  for (const d of [A, J]) if (d) await d.page.screenshot({ path: join(out, `echec-${d.name}.png`), fullPage: true }).catch(() => {});
  console.error(`Captures : ${out}`);
  if (errors.length) console.error(errors.join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
