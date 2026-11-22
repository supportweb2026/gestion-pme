/**
 * Recette du module Projets, lot 2 : étapes, modèles et lancement depuis un devis.
 *  - devis accepté de 18 000 000 FCFA HT → « Lancer le projet » → modèle « Prestation
 *    au forfait » proposé, 3 étapes à 30/50/20 % et leurs montants (CA2.1) ;
 *  - le devis affiche ensuite « Ouvrir le projet » et ne se relance pas (CA2.2) ;
 *  - tâches rattachées aux étapes, avancement pondéré et prévu à date dans l'en-tête,
 *    frise des étapes sur tous les onglets, étapes sur le planning ;
 *  - priorités de la semaine, « Copier pour WhatsApp », en tête de « Ma journée » ;
 *  - l'employé voit les étapes et leur avancement, jamais de montant ni de part.
 *
 * Prérequis : `npm run build`, Playwright.
 *   node test/e2e/projets-etapes.mjs        (SHOTS_DIR=… pour des captures)
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
const PORT = 8797;
const BASE = `http://localhost:${PORT}`;
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-etapes-"));

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
const TODAY = day(0);
const YEAR = new Date().getFullYear();
const nbsp = (s) => s.replace(/[  ]/g, " ");

async function device(name, opts) {
  const context = await browser.newContext({ locale: "fr-FR", deviceScaleFactor: 2, ...opts });
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => errors.push(`[${name}] ${e.message}`));
  return { name, context, page };
}
const shot = async (p, file, o = {}) => shots && p.screenshot({ path: join(shots, file), fullPage: true, ...o });

let A, J;
try {
  A = await device("direction", { viewport: { width: 1360, height: 900 } });
  await A.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const a = A.page;
  const nav = (label) => a.getByRole("navigation").getByRole("button", { name: label, exact: true }).click();
  const waitSynced = async () => {
    await a.getByTestId("sync-pill").click();
    await a.getByTestId("sync-pill").filter({ hasText: "À jour" }).waitFor({ timeout: 10_000 });
  };

  step("Inscription, un compte employé, un client");
  await a.goto(BASE);
  await a.getByRole("button", { name: "Créer mon entreprise" }).click();
  await a.getByLabel("Nom de l'entreprise").fill("IDO SARL");
  await a.getByLabel("Votre nom").fill("Jimmy Rerambyha");
  await a.getByLabel("E-mail").fill("jimmy@ido.ga");
  await a.getByLabel("Mot de passe", { exact: true }).fill("motdepasse1");
  await a.getByLabel("Confirmer le mot de passe").fill("motdepasse1");
  await a.getByRole("button", { name: "Démarrer l'essai gratuit" }).click();
  await waitSynced();
  await nav("Réglages");
  await a.getByRole("button", { name: "Ajouter un utilisateur" }).click();
  await a.getByLabel("Nom", { exact: true }).fill("Junior Mintsa");
  await a.locator("form.form-grid").getByLabel("E-mail").fill("junior@ido.ga");
  await a.locator("form.form-grid select[name=role]").selectOption("employee");
  await a.getByLabel("Mot de passe provisoire").fill("provisoire1");
  await a.getByRole("button", { name: "Créer le compte" }).click();
  await a.getByRole("cell", { name: "junior@ido.ga" }).waitFor();
  await nav("Clients");
  await a.getByRole("button", { name: "Nouveau client" }).click();
  await a.getByLabel("Raison sociale").fill("Ogooué Logistique");
  await a.getByRole("button", { name: "Enregistrer" }).click();

  step("Devis de 18 000 000 FCFA HT, finalisé puis accepté");
  await nav("Devis");
  await a.getByRole("button", { name: "Nouveau devis" }).first().click();
  await a.getByRole("button", { name: "+ Ajouter un titre" }).click();
  await a.getByLabel("Titre de section").fill("Aménagement de l'entrepôt de Nkok");
  await a.getByLabel("Désignation").nth(0).fill("Études et plans d'exécution");
  await a.getByLabel("Quantité").nth(0).fill("1");
  await a.getByLabel("Prix unitaire").nth(0).fill("3000000");
  await a.getByRole("button", { name: "+ Ajouter une ligne" }).click();
  await a.getByLabel("Désignation").nth(1).fill("Travaux d'aménagement");
  await a.getByLabel("Quantité").nth(1).fill("1");
  await a.getByLabel("Prix unitaire").nth(1).fill("15000000");
  await a.getByRole("button", { name: "Finaliser le devis" }).click();
  await a.getByRole("heading", { name: `Devis DV-${YEAR}-00001` }).waitFor();
  assert.equal(await a.getByTestId("quote-project").count(), 0, "pas de lancement sur un devis seulement envoyé");
  await a.getByRole("button", { name: "Marquer accepté" }).click();
  const banner = a.getByTestId("quote-project");
  await banner.getByText("Devis accepté : lancez le projet").waitFor();

  step("CA2.1 : « Lancer le projet » reprend le client, le nom, le montant vendu et propose le forfait");
  await banner.getByRole("button", { name: "Lancer le projet" }).click();
  await a.getByRole("heading", { name: "Nouveau projet" }).waitFor();
  const quoteRadio = a.getByRole("radiogroup", { name: "Devis accepté" }).getByRole("radio", { name: new RegExp(`DV-${YEAR}-00001`) });
  assert.ok(await quoteRadio.isChecked(), "le devis est déjà choisi");
  assert.ok(await a.getByRole("radio", { name: /Prestation au forfait/ }).isChecked(), "modèle forfait proposé");
  assert.equal(await a.getByLabel("Nom du projet").inputValue(), "Aménagement de l'entrepôt de Nkok");
  assert.ok(await a.getByRole("combobox", { name: /^Client/ }).isDisabled(), "client repris du devis, non modifiable");
  assert.equal(nbsp(await a.getByTestId("np-sold").textContent()), "18 000 000 FCFA HT");
  await a.getByLabel("Début").fill(day(-10));
  await a.getByLabel(/^Fin prévue/).fill(day(20));
  await a.getByRole("button", { name: /^Étapes et facturation/ }).click();
  const aside = a.getByRole("complementary", { name: "Ce que Gestia va créer" });
  for (const [n, amount] of [["Démarrage", "5 400 000"], ["Réalisation", "9 000 000"], ["Réception", "3 600 000"]]) {
    assert.match(nbsp(await aside.locator("li", { hasText: n }).textContent()), new RegExp(amount), `${n} : ${amount}`);
  }
  await shot(a, "creation-depuis-devis.png");
  await a.getByRole("button", { name: "Créer le projet" }).click();
  await a.getByRole("heading", { name: "Aménagement de l'entrepôt de Nkok" }).waitFor();
  const strip = a.getByRole("list", { name: "Frise des étapes" });
  assert.equal(await strip.getByRole("listitem").count(), 3, "3 étapes dans la frise");
  assert.equal(nbsp(await a.getByTestId("project-sold").textContent()), "18 000 000 FCFA");

  step("Étapes : parts 30/50/20 % et montants, livrable de la réception");
  await a.getByRole("tab", { name: /^Étapes/ }).click();
  for (const [n, pct, amount] of [["Démarrage", "30 %", "5 400 000"], ["Réalisation", "50 %", "9 000 000"], ["Réception", "20 %", "3 600 000"]]) {
    const card = a.getByTestId(`stage-${n}`);
    const t = nbsp(await card.textContent());
    assert.ok(t.includes(pct) && t.includes(amount), `${n} : ${pct}, ${amount} (${t})`);
  }
  await a.getByTestId("stage-Réception").click();
  await a.getByText("PV de réception signé").waitFor();
  await a.getByTestId("stage-Réalisation").click();
  await shot(a, "onglet-etapes.png");

  step("CA2.2 : le devis ouvre le projet et ne peut plus en lancer un autre");
  await nav("Devis");
  await a.getByRole("cell", { name: `DV-${YEAR}-00001` }).click();
  await banner.getByText("Projet lancé : Aménagement de l'entrepôt de Nkok").waitFor();
  assert.equal(await banner.getByRole("button", { name: "Lancer le projet" }).count(), 0);
  await nav("Projets");
  await a.getByRole("button", { name: "Nouveau projet" }).click();
  await a.getByText("Aucun devis accepté en attente de projet.", { exact: false }).waitFor();
  await a.getByRole("button", { name: "Annuler" }).click();
  await nav("Devis");
  await a.getByRole("cell", { name: `DV-${YEAR}-00001` }).click();
  await banner.getByRole("button", { name: "Ouvrir le projet" }).click();
  await a.getByRole("heading", { name: "Aménagement de l'entrepôt de Nkok" }).waitFor();

  step("Équipe, tâche ajoutée dans une étape, tâches terminées : avancement pondéré et prévu à date");
  await a.getByRole("tab", { name: "Équipe" }).click();
  await a.getByLabel("Personne à ajouter").selectOption({ label: "Junior Mintsa" });
  await a.getByRole("button", { name: "Ajouter à l'équipe" }).click();
  await a.locator(".member-list").getByText("Junior Mintsa").waitFor();
  await a.getByRole("tab", { name: "Tâches" }).click();
  const filter = a.getByRole("group", { name: "Filtrer par étape" });
  await filter.getByRole("button", { name: /^Réalisation/ }).click();
  await a.getByText("Les tâches ajoutées maintenant vont dans l'étape « Réalisation ».").waitFor();
  await a.getByLabel("Nouvelle tâche").fill("Pose des cloisons du bureau");
  await a.getByRole("button", { name: "Ajouter la tâche", exact: true }).click();
  const pose = a.locator(".task-card", { hasText: "Pose des cloisons du bureau" });
  await pose.waitFor();
  assert.equal(await a.locator(".task-card").count(), 3, "filtre : les 3 tâches de la réalisation");
  await filter.getByRole("button", { name: /^Toutes/ }).click();
  await pose.locator(".stage-tag", { hasText: "Réalisation" }).waitFor();
  for (const title of ["Signature et lancement avec le client", "Préparation et commandes"]) {
    const card = a.locator(".task-card", { hasText: title });
    await card.getByRole("button", { name: "Commencer" }).click();
    await card.getByRole("button", { name: "Terminer" }).click();
    await a.getByTestId("col-done").getByText(title).waitFor();
  }
  // Démarrage 30 % × 95 % (plafond, pas validée) + Réalisation 50 % × 1/3 = 45 %.
  await a.getByTestId("project-progress").filter({ hasText: "45 % fait" }).waitFor();
  // Prévu : Démarrage 30 % × 1 + Réalisation 50 % × 9/24 jours écoulés + Réception 0 = 49 %.
  await a.getByTestId("project-planned").filter({ hasText: "49 % prévu à date" }).waitFor();
  await shot(a, "en-tete-et-frise.png", { fullPage: false });

  step("Priorités de la semaine : épingler, « Copier pour WhatsApp »");
  await pose.getByRole("button", { name: "Pose des cloisons du bureau" }).click();
  const form = a.locator(".task-card form");
  await form.getByLabel("Attribuée à").selectOption({ label: "Junior Mintsa" });
  await form.getByLabel("Échéance").fill(TODAY);
  await form.getByRole("button", { name: "Enregistrer" }).click();
  await pose.getByText("Junior Mintsa").waitFor();
  const week = a.getByTestId("week-priorities");
  await week.getByText("Aucune priorité cette semaine.", { exact: false }).waitFor();
  for (const title of ["Pose des cloisons du bureau", "Exécution des travaux"]) {
    const card = a.locator(".task-card", { hasText: title });
    await card.getByRole("button", { name: "Priorité de la semaine" }).click();
    await week.getByRole("button", { name: title, exact: true }).waitFor();
  }
  await a.locator(".task-card", { hasText: "Pose des cloisons du bureau" }).getByText("Priorité", { exact: true }).waitFor();
  await week.getByText("2 sur 7 au plus", { exact: false }).waitFor();
  await week.getByRole("button", { name: "Copier pour WhatsApp" }).click();
  await week.getByText("Résumé copié", { exact: false }).waitFor();
  const clip = await a.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /^\*Point de la semaine : Aménagement de l'entrepôt de Nkok\*/);
  assert.match(clip, /\*Priorités de la semaine \(2\)\*\n1\. Pose des cloisons du bureau \(Junior Mintsa · .+ · Réalisation\)/);
  assert.ok(!/FCFA|%/.test(clip), "aucun montant ni part dans le résumé");
  await shot(a, "taches-et-priorites.png");

  step("Planning : les étapes et leurs tâches");
  await a.getByRole("tab", { name: "Planning" }).click();
  await a.locator(".gantt-stage", { hasText: "Réalisation" }).waitFor();
  await strip.waitFor();
  await waitSynced();

  step("Employé sur téléphone : la priorité en tête de « Ma journée »");
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
  await list.getByText("Pose des cloisons du bureau").waitFor({ timeout: 15_000 });
  const first = list.locator(".day-task").first();
  await first.getByText("Pose des cloisons du bureau").waitFor();
  await first.getByText("Priorité de la semaine").waitFor();
  await shot(j, "ma-journee-telephone-priorite.png");

  step("Employé : étapes et avancement, sans montant ni part");
  await j.getByRole("navigation").getByRole("button", { name: "Projets", exact: true }).click();
  // « À décider » rappelle aussi l'échéance de sa tâche (lot 5) : on ouvre la carte du projet.
  await j.locator(".project-card", { hasText: "Aménagement de l'entrepôt de Nkok" }).click();
  await j.getByRole("heading", { name: "Aménagement de l'entrepôt de Nkok" }).waitFor();
  await j.getByRole("list", { name: "Frise des étapes" }).waitFor();
  await j.getByTestId("project-progress").filter({ hasText: "45 % fait" }).waitFor();
  assert.equal(await j.getByTestId("project-sold").count(), 0);
  assert.equal(await j.getByTestId("project-margin").count(), 0);
  const stripText = await j.getByRole("list", { name: "Frise des étapes" }).textContent();
  assert.ok(!/\d+ %/.test(stripText), `aucune part dans la frise (${stripText})`);
  await shot(j, "vue-employe-projet.png");
  await j.getByRole("tab", { name: /^Étapes/ }).click();
  await j.getByTestId("stage-Réalisation").waitFor();
  const stagesText = nbsp(await j.locator("main").textContent());
  assert.ok(!stagesText.includes("FCFA"), "aucun montant dans l'onglet Étapes");
  assert.ok(!/Jalon|Démarrage \d|du montant vendu/.test(stagesText), "aucune part dans l'onglet Étapes");
  await shot(j, "vue-employe-etapes.png");
  const bodyText = nbsp(await j.locator("body").textContent());
  assert.ok(!bodyText.includes("FCFA"), "aucun montant à l'écran");
  assert.ok(received.length > 0, "synchronisation observée");
  for (const r of received) {
    assert.ok(!r.includes("project_finance"), "aucune donnée financière reçue");
    assert.ok(!r.includes("18000000"), "le montant vendu n'est jamais reçu");
  }

  step("Téléphone : pas de débordement horizontal");
  const overflow = await j.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `débordement horizontal de ${overflow}px`);

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nRecette Projets lot 2 (étapes, modèles, lancement depuis un devis) réussie.");
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
