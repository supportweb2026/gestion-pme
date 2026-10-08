/**
 * Serveur local : même comportement que Cloudflare (API du Worker + fichiers
 * statiques de dist/ + base SQLite locale), sans compte ni réseau.
 *   npm run local        puis ouvrir http://localhost:8787
 */
import { createServer } from "node:http";
import { mkdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import worker from "../src/worker/index.ts";
import { createLocalD1 } from "./d1-local.ts";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DB_PATH ?? join(root, "dev", "data", "local.sqlite");
if (dbPath !== ":memory:") mkdirSync(join(dbPath, ".."), { recursive: true });
const env: { DB: ReturnType<typeof createLocalD1>; FILES: ReturnType<typeof createLocalD1>; JWT_SECRET: string; PLATFORM_COMPANY?: string } = {
  DB: createLocalD1(dbPath, join(root, "migrations")),
  FILES: createLocalD1(":memory:"),
  JWT_SECRET: "dev-local-secret-0123456789-0123456789",
  PLATFORM_COMPANY: process.env.PLATFORM_COMPANY,
};

/** En local, la première entreprise créée tient le rôle d'éditeur (comme IDO en production). */
async function resolvePlatform() {
  if (env.PLATFORM_COMPANY) return;
  const first = await env.DB.prepare(`SELECT id FROM companies ORDER BY created_at LIMIT 1`).first<{ id: string }>();
  if (first) env.PLATFORM_COMPANY = first.id;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".png": "image/png",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname.startsWith("/api/")) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const response = await worker.fetch(
      new Request(url, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === "GET" ? undefined : body }),
      env,
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    await resolvePlatform();
    return;
  }
  // Fichiers statiques, avec repli sur index.html (application monopage).
  let file = normalize(join(dist, url.pathname));
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`Gestia en local : http://localhost:${port}`));
