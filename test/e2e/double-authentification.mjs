/**
 * Recette de la double authentification (lot 8) :
 *  - Réglages > Mon compte : activation par QR code / clé et code à 6 chiffres, codes de secours ;
 *  - connexion sur un autre appareil : code demandé, code faux refusé, bon code accepté ;
 *  - connexion avec un code de secours (à usage unique) ; désactivation avec le mot de passe.
 *
 * Prérequis : `npm run build`, Playwright.
 *   node test/e2e/double-authentification.mjs        (SHOTS_DIR=… pour des captures)
 */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "playwright");

const root = join(import.meta.dirname, "..", "..");
const PORT = 8804;
const BASE = `http://localhost:${PORT}`;
const YEAR = new Date().getFullYear();
const shots = process.env.SHOTS_DIR;
const out = mkdtempSync(join(tmpdir(), "gestia-2fa-"));

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

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 86_400_000));

/** Code TOTP (RFC 6238) calculé comme le ferait le téléphone. */
function totp(secret, ms = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/\s/g, "")) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(ms / 30000)));
  const h = createHmac("sha1", key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function loginPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "fr-FR" });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(BASE);
  await p.getByLabel("E-mail").fill("dnt@ido.ga");
  await p.getByLabel("Mot de passe").fill("motdepasse1");
  await p.getByRole("button", { name: "Se connecter" }).click();
  return p;
}

try {
  step("Inscription");
  await page.goto(BASE);
  await page.getByRole("button", { name: "Créer mon entreprise" }).click();
  await page.getByLabel("Nom de l'entreprise").fill("IDO");
  await page.getByLabel("Votre nom").fill("Jimmy");
  await page.getByLabel("Téléphone").fill("+241 077 00 00 00");
  await page.getByLabel("E-mail").fill("dnt@ido.ga");
  await page.getByLabel("Mot de passe", { exact: true }).fill("motdepasse1");
  await page.getByLabel("Confirmer le mot de passe").fill("motdepasse1");
  await page.getByRole("button", { name: "Démarrer l'essai gratuit" }).click();

  step("Réglages > Mon compte : activation de la double authentification");
  await nav("Réglages");
  const box = page.getByTestId("two-factor");
  await box.getByRole("button", { name: "Activer" }).click();
  await box.getByRole("img", { name: /QR code/ }).waitFor();
  const secret = (await box.getByTestId("totp-secret").textContent()).replace(/\s/g, "");
  assert.equal(secret.length, 32);
  await box.getByLabel("Code à 6 chiffres").fill("000000" === totp(secret) ? "111111" : "000000");
  await box.getByRole("button", { name: "Confirmer et activer" }).click();
  await box.getByRole("alert").getByText(/Code incorrect/).waitFor();
  await box.getByLabel("Code à 6 chiffres").fill(totp(secret));
  await box.getByRole("button", { name: "Confirmer et activer" }).click();
  const codes = (await box.getByTestId("recovery-codes").locator("li").allTextContents()).map((c) => c.trim());
  assert.equal(codes.length, 8);
  await shot("codes-de-secours.png");
  await box.getByRole("button", { name: "J'ai noté les codes" }).click();
  await box.getByText(/Active : un code de l'application est demandé/).waitFor();

  step("Autre appareil : le code est demandé, un code faux est refusé, le bon code ouvre la session");
  let other = await loginPage();
  await other.getByRole("heading", { name: "Vérification en deux étapes" }).waitFor();
  if (shots) await other.screenshot({ path: join(shots, "etape-code.png") });
  await other.getByLabel("Code de vérification").fill("123456" === totp(secret) ? "654321" : "123456");
  await other.getByRole("button", { name: "Vérifier" }).click();
  await other.getByRole("alert").getByText(/Code incorrect/).waitFor();
  // Le code du pas suivant (le précédent a pu servir à l'activation).
  await other.getByLabel("Code de vérification").fill(totp(secret, Date.now() + 30_000));
  await other.getByRole("button", { name: "Vérifier" }).click();
  await other.getByRole("navigation").waitFor();
  await other.context().close();

  step("Code de secours : accepté une fois, refusé ensuite");
  other = await loginPage();
  await other.getByLabel("Code de vérification").fill(codes[0].toUpperCase());
  await other.getByRole("button", { name: "Vérifier" }).click();
  await other.getByRole("navigation").waitFor();
  await other.context().close();
  other = await loginPage();
  await other.getByLabel("Code de vérification").fill(codes[0]);
  await other.getByRole("button", { name: "Vérifier" }).click();
  await other.getByRole("alert").getByText(/Code incorrect/).waitFor();
  await other.context().close();

  step("Désactivation avec le mot de passe : connexion sans code");
  await page.reload();
  await nav("Réglages");
  await box.getByText("7 codes de secours restants", { exact: false }).waitFor();
  await box.getByRole("button", { name: "Désactiver" }).click();
  await box.getByLabel("Votre mot de passe").fill("motdepasse1");
  await box.getByRole("button", { name: "Désactiver la double authentification" }).click();
  await box.getByRole("button", { name: "Activer" }).waitFor();
  other = await loginPage();
  await other.getByRole("navigation").waitFor();
  await other.context().close();

  assert.deepEqual(errors, [], "aucune erreur JavaScript");
  console.log("\nRecette de la double authentification réussie.");
} catch (e) {
  console.error("\nÉCHEC :", e.message);
  await page.screenshot({ path: join(out, "echec.png"), fullPage: true }).catch(() => {});
  console.error(`Capture : ${join(out, "echec.png")}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
