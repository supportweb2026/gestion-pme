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
const env = { DB: createLocalD1(dbPath, join(root, "migrations")), JWT_SECRET: "dev-local" };

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
    return;
  }
  // Fichiers statiques, avec repli sur index.html (application monopage).
  let file = normalize(join(dist, url.pathname));
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`Gestion PME en local : http://localhost:${port}`));
