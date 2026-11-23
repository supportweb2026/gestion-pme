/**
 * Recette du module Projets, lot 6 : points de vigilance, clôture et bilan.
 *  - projet lancé depuis un devis accepté de 10 000 000 FCFA HT (forfait 30/50/20 %) ;
 *  - point de vigilance fort sans parade, ajouté depuis l'onglet Étapes : météo « Vigilance » rouge ;
 *  - parade avec échéance : orange ; « C'est arrivé » : tâche « Traiter : … » et rouge ; problème clos ;
 *  - l'employé signale un point, sans aucun montant à l'écran ni sur le réseau ;
 *  - clôture refusée tant qu'une étape n'est pas validée (CA6.3) ;
 *  - trois étapes validées : « Prêt à clôturer », clôture avec motif et bilan ; onglet Bilan ;
 *  - lecture seule à l'écran (Tâches, Temps, Vigilance) et côté serveur (appareil forcé) ;
 *  - réouverture par la direction, avec motif.
 *
 * Prérequis : `npm run build`, Playwright.
 *   node test/e2e/projets-cloture.mjs        (SHOTS_DIR=… pour des captures)
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
const PORT = 8816;
const BASE = `http://localhost:${PORT}`;
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-cloture-"));

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
const PROJECT = "Réfection de l'agence SEEG de Libreville";
const RISK = "Retard de livraison du ciment";

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

/** Envoie une modification au serveur en contournant l'écran et le contrôle de l'appareil. */
async function forceSync(page, build) {
  // Lecture de l'appareil dans la page, calcul de la modification dans Node : pas d'eval sous la CSP de production.
  const { all, session, deviceId } = await page.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open("gestion-pme"); r.onsuccess = () => res(r.result); });
    const get = (store, key) => new Promise((res) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => res(r.result); });
    const all = await new Promise((res) => { const r = db.transaction("records").objectStore("records").getAll(); r.onsuccess = () => res(r.result); });
    return { all, session: await get("meta", "session"), deviceId: await get("meta", "deviceId") };
  });
  const change = build(all, session);
  return page.evaluate(async ({ change, session, deviceId }) => {
    const hlc = `${String(Date.now()).padStart(15, "0")}-00000-${deviceId}`;
    const res = await fetch("/api/sync", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ since: 0, changes: [{ id: crypto.randomUUID(), hlc, device: deviceId, ...change }] }),
    });
    return (await res.json()).rejected?.[0]?.reason ?? "accepté";
  }, { change, session, deviceId });
}

let A, J;
try {
  A = await device("direction", { viewport: { width: 1360, height: 900 } });
  const a = A.page;
  const nav = (p, label) => p.getByRole("navigation").getByRole("button", { name: label, exact: true }).click();
  const waitSynced = async (p = a) => {
    await p.getByTestId("sync-pill").click();
    await p.getByTestId("sync-pill").filter({ hasText: "À jour" }).waitFor({ timeout: 10_000 });
  };
  const vigilanceRow = async () => {
    const detail = a.getByTestId("weather-detail");
    if (!(await detail.isVisible())) await a.getByTestId("project-weather").getByRole("button", { name: "Voir le détail" }).click();
    const row = detail.locator(".weather-rows > div", { has: a.locator("dt", { hasText: /^Vigilance$/ }) });
    return { light: await row.locator(".weather-badge").getAttribute("class"), text: nbsp(await row.textContent()) };
  };

  step("Inscription, un employé, un client, un devis accepté de 10 000 000 FCFA HT");
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
  await a.getByRole("tab", { name: "Équipe" }).click();
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
  await a.getByLabel("Désignation").nth(0).fill("Travaux de réfection");
  await a.getByLabel("Quantité").nth(0).fill("1");
  await a.getByLabel("Prix unitaire").nth(0).fill("10000000");
  await a.getByRole("button", { name: "Finaliser le devis" }).click();
  await a.getByRole("heading", { name: `Devis DV-${YEAR}-00001` }).waitFor();
  await a.getByRole("button", { name: "Marquer accepté" }).click();
  await a.getByTestId("quote-project").getByRole("button", { name: "Lancer le projet" }).click();
  await a.getByRole("heading", { name: "Nouveau projet" }).waitFor();
  await a.getByLabel("Début").fill(day(-20));
  await a.getByLabel(/^Fin prévue/).fill(day(25));
  await a.getByRole("button", { name: "Créer le projet" }).click();
  await a.getByRole("heading", { name: PROJECT }).waitFor();
  await a.getByRole("tab", { name: "Équipe" }).click();
  await a.getByLabel("Personne à ajouter").selectOption({ label: "Junior Mintsa" });
  await a.getByRole("button", { name: "Ajouter à l'équipe" }).click();
  await a.locator(".member-list").getByText("Junior Mintsa").waitFor();

  step("Point de vigilance fort sans parade, ajouté depuis l'onglet Étapes : Vigilance rouge");
  await a.getByRole("tab", { name: /^Étapes/ }).click();
  await a.getByTestId("add-watch-from-stages").click();
  const wd = a.getByTestId("watch-dialog");
  await wd.waitFor();
  await wd.getByRole("button", { name: RISK }).click(); // suggestion BTP
  assert.equal(await wd.getByLabel("Ce qui peut mal tourner").inputValue(), RISK);
  await wd.getByRole("radiogroup", { name: "Probabilité" }).getByText("Forte").click();
  await wd.getByRole("radiogroup", { name: "Impact" }).getByText("Fort").click();
  assert.match(nbsp(await wd.getByTestId("watch-level").textContent()), /Fort · 9.*indiquez une parade/);
  await wd.getByLabel("Responsable").selectOption({ label: "Jimmy Rerambyha" });
  await shot(a, "point-vigilance-ajout.png", { fullPage: false });
  await wd.getByRole("button", { name: "Ajouter le point" }).click();
  await wd.waitFor({ state: "detached" });
  await a.getByRole("tab", { name: /^Vigilance/ }).click();
  const card = a.getByTestId(`watch-${RISK}`);
  await card.waitFor();
  await a.getByTestId("watch-alert").waitFor();
  let row = await vigilanceRow();
  assert.match(row.light, /red/, row.text);
  assert.match(row.text, new RegExp(`Point de vigilance fort sans parade : « ${RISK} » \\(score 9\\)`));
  await shot(a, "vigilance-rouge-sans-parade.png");

  step("Parade avec échéance : Vigilance orange");
  await card.getByRole("button", { name: "Modifier" }).click();
  await wd.getByLabel("Parade : ce que vous faites pour l'éviter").fill("Commander chez un second fournisseur si rien n'est livré jeudi");
  await wd.getByLabel("Échéance de la parade").fill(day(5));
  await wd.getByRole("button", { name: "Enregistrer le point" }).click();
  await wd.waitFor({ state: "detached" });
  assert.equal(await a.getByTestId("watch-alert").count(), 0, "plus d'alerte : la parade est à jour");
  row = await vigilanceRow();
  assert.match(row.light, /orange/, row.text);
  assert.match(row.text, /Point de vigilance fort suivi/);

  step("« C'est arrivé » : tâche « Traiter : … » et Vigilance rouge ; puis problème clos");
  await card.getByRole("button", { name: "C'est arrivé" }).click();
  await a.getByTestId("watch-flash").waitFor();
  await card.getByText("Survenu").first().waitFor();
  row = await vigilanceRow();
  assert.match(row.light, /red/, row.text);
  assert.match(row.text, new RegExp(`Problème ouvert : ${RISK}`));
  await shot(a, "vigilance-probleme-survenu.png");
  await a.getByRole("tab", { name: /^Tâches/ }).click();
  const issueTask = a.locator(".task-card", { hasText: `Traiter : ${RISK}` });
  await issueTask.waitFor();
  await a.getByRole("tab", { name: /^Vigilance/ }).click();
  await card.getByRole("button", { name: "Clore le problème" }).click();
  await card.getByText("Clos").first().waitFor();
  row = await vigilanceRow();
  assert.match(row.light, /green/, row.text);
  await a.getByTestId("weather-detail").getByRole("button", { name: "Fermer le détail de la météo" }).click();
  await waitSynced();

  step("Employé : il signale un point de vigilance, sans aucun montant");
  J = await device("employé", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const j = J.page;
  const received = [];
  j.on("response", async (r) => { if (r.url().endsWith("/api/sync")) received.push(await r.text().catch(() => "")); });
  await login(j, "junior@batiplus.ga", "provisoire1", "junior-2026");
  await j.getByRole("heading", { name: "Ma journée" }).waitFor();
  await j.getByRole("navigation").getByRole("button", { name: "Projets", exact: true }).click();
  await j.getByText(PROJECT).first().click({ timeout: 15_000 });
  await j.getByRole("tab", { name: /^Vigilance/ }).click();
  await j.getByTestId(`watch-${RISK}`).waitFor();
  await j.getByTestId("vigilance-tab").getByRole("button", { name: "Ajouter un point de vigilance" }).click();
  const jd = j.getByTestId("watch-dialog");
  await jd.getByLabel("Ce qui peut mal tourner").fill("Accès au chantier fermé le samedi");
  await jd.getByRole("radiogroup", { name: "Impact" }).getByText("Moyen").click();
  await jd.getByLabel("Responsable").selectOption({ label: "Junior Mintsa" });
  assert.equal(await jd.getByLabel("Responsable").locator("option").count(), 2, "l'employé ne confie un point qu'à lui-même");
  await shot(j, "vigilance-employe-ajout.png", { fullPage: false });
  await jd.getByRole("button", { name: "Ajouter le point" }).click();
  await jd.waitFor({ state: "detached" });
  await j.getByTestId("watch-Accès au chantier fermé le samedi").waitFor();
  const jbody = nbsp(await j.locator("body").textContent());
  assert.ok(!jbody.includes("FCFA"), "aucun montant à l'écran");
  const jOverflow = await j.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(jOverflow <= 1, `débordement horizontal de ${jOverflow}px`);
  await shot(j, "vigilance-employe-telephone.png");

  step("CA6.3 : la clôture est refusée tant qu'une étape n'est pas validée");
  await a.getByRole("tab", { name: /^Vigilance/ }).click();
  for (let i = 0; i < 10 && !(await a.getByTestId("watch-Accès au chantier fermé le samedi").count()); i++) {
    await waitSynced();
    await a.waitForTimeout(1000);
  }
  await a.getByTestId("watch-Accès au chantier fermé le samedi").waitFor({ timeout: 5_000 });
  await a.getByTestId("close-project").click();
  const cd = a.getByTestId("closure-dialog");
  await cd.waitFor();
  const stagesCheck = nbsp(await cd.getByTestId("check-stages").textContent());
  assert.match(stagesCheck, /Démarrage/, stagesCheck);
  assert.ok(await cd.getByTestId("confirm-closure").isDisabled(), "clôture désactivée");
  await shot(a, "cloture-bloquee.png", { fullPage: false });
  await cd.getByRole("button", { name: "Voir l'étape" }).click();
  await cd.waitFor({ state: "detached" });

  step("Les trois étapes validées : « Prêt à clôturer »");
  for (const name of ["Démarrage", "Réalisation", "Réception"]) {
    await a.getByTestId(`stage-${name}`).click();
    await a.locator(".stage-decision").getByRole("button", { name: "Valider l'étape" }).click();
    const v = a.getByRole("dialog", { name: `Valider l'étape ${name}` });
    await v.getByRole("button", { name: "Valider l'étape" }).click();
    await a.getByTestId("decision-flash").getByText(`Étape ${name} validée.`, { exact: false }).waitFor();
  }
  const ready = a.getByTestId("ready-to-close");
  await ready.getByText("Prêt à clôturer.").waitFor();
  await shot(a, "pret-a-cloturer.png", { fullPage: false });

  step("Clôture : liste de vérification, motif et bilan");
  await ready.getByTestId("close-project").click();
  await cd.waitFor();
  assert.match(nbsp(await cd.getByTestId("check-stages").textContent()), /validées/i);
  assert.ok(await cd.getByTestId("check-drafts").count(), "les brouillons de facture sont signalés");
  assert.equal(await cd.getByTestId("check-issues").count(), 0, "le problème survenu a été clos");
  await cd.getByLabel("Pourquoi clôturer malgré les points à vérifier ?").fill("Factures envoyées cette semaine par la comptabilité");
  await cd.getByLabel(/Ce qui a bien marché/).fill("Second fournisseur de ciment prêt à l'avance");
  await cd.getByLabel(/Ce qu'on ferait autrement/).fill("Visiter le site avant de signer le devis");
  await shot(a, "cloture-liste-verification.png", { fullPage: false });
  await cd.getByTestId("confirm-closure").click();
  await cd.waitFor({ state: "detached" });
  await a.getByTestId("project-closed").getByText("Projet clôturé", { exact: false }).waitFor();
  await a.getByTestId("review-tab").waitFor();
  assert.match(nbsp(await a.getByTestId("review-result").textContent()), /Marge/);
  assert.match(nbsp(await a.getByTestId("review-lessons").textContent()), /Second fournisseur de ciment/);
  await a.getByTestId("decision-log").getByText("Projet clôturé").waitFor().catch(() => {});
  await shot(a, "bilan-ordinateur.png");

  step("Lecture seule à l'écran : Tâches, Temps, Vigilance");
  assert.equal(await a.getByRole("button", { name: "Modifier le projet" }).count(), 0);
  await a.getByRole("tab", { name: /^Tâches/ }).click();
  await issueTask.waitFor();
  assert.equal(await a.locator("form.kanban-add").count(), 0, "pas d'ajout de tâche");
  assert.equal(await issueTask.getByRole("button", { name: "Commencer" }).count(), 0);
  await a.getByRole("tab", { name: /^Temps/ }).click();
  await a.getByText("Projet clôturé : plus aucun temps ne peut y être saisi.").waitFor();
  await a.getByRole("tab", { name: /^Vigilance/ }).click();
  assert.equal(await a.getByTestId("vigilance-tab").getByRole("button", { name: "Ajouter un point de vigilance" }).count(), 0);
  assert.equal(await a.getByRole("button", { name: "C'est arrivé" }).count(), 0);
  await waitSynced();

  step("Lecture seule côté serveur : l'employé force un temps et un point de vigilance");
  await j.getByRole("button", { name: "← Projets" }).click().catch(() => {});
  await j.getByRole("navigation").getByRole("button", { name: "Projets", exact: true }).click();
  await j.getByRole("button", { name: "Afficher tous les projets" }).click({ timeout: 15_000 });
  await j.getByText(PROJECT).first().click({ timeout: 15_000 });
  await j.getByTestId("project-closed").waitFor({ timeout: 15_000 });
  await j.getByTestId("review-tab").waitFor();
  assert.equal(await j.getByTestId("review-budget").count(), 0, "pas de budget pour l'employé");
  assert.ok(!nbsp(await j.locator("body").textContent()).includes("FCFA"), "aucun montant dans le bilan de l'employé");
  await shot(j, "bilan-employe-telephone.png");
  const time = await forceSync(j, (all, session) => {
    const p = all.find((x) => x.tbl === "projects");
    return { tbl: "time_entries", row: crypto.randomUUID(), patch: { project_id: p.id, user_id: session.user.id, date: new Date().toISOString().slice(0, 10), hours: 2 } };
  });
  assert.match(time, /ce projet est clôturé : vous ne pouvez plus y saisir de temps/);
  const point = await forceSync(j, (all, session) => {
    const p = all.find((x) => x.tbl === "projects");
    return { tbl: "watch_points", row: crypto.randomUUID(), patch: { project_id: p.id, title: "Ajout forcé", probability: 2, impact: 2, status: "open", created_by: session.user.id } };
  });
  assert.match(point, /ce projet est clôturé : il est en lecture seule/);
  for (const r of received) assert.ok(!r.includes("10000000") && !r.includes("hourly_rate"), "aucun montant reçu");

  step("Réouverture par la direction, avec motif");
  await a.getByTestId("reopen-project").click();
  const rd = a.getByRole("dialog", { name: "Rouvrir le projet" });
  await rd.getByLabel("Motif").fill("Le client signale une fuite couverte par le devis");
  await rd.getByRole("button", { name: "Rouvrir le projet" }).click();
  await rd.waitFor({ state: "detached" });
  await a.getByTestId("project-closed").waitFor({ state: "detached" });
  await a.getByRole("button", { name: "Modifier le projet" }).waitFor();
  await shot(a, "projet-rouvert.png", { fullPage: false });

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nRecette Projets lot 6 (vigilance, clôture et bilan) réussie.");
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
