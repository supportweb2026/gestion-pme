/**
 * Construction de secours avec Bun, sans `npm install` (environnements sans
 * accès au registre npm). La construction normale reste `npm run build` (Vite).
 *   bun dev/build-bun.ts
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const web = join(root, "src", "web");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "assets"), { recursive: true });

const result = await Bun.build({
  entrypoints: [join(web, "main.tsx")],
  outdir: join(dist, "assets"),
  naming: "[name]-[hash].[ext]",
  minify: true,
  target: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}
const files = readdirSync(join(dist, "assets"));
const js = files.find((f) => f.endsWith(".js"))!;
const css = files.find((f) => f.endsWith(".css"));
const html = readFileSync(join(web, "index.html"), "utf8").replace(
  '<script type="module" src="./main.tsx"></script>',
  `${css ? `<link rel="stylesheet" href="/assets/${css}">` : ""}<script type="module" src="/assets/${js}"></script>`,
);
writeFileSync(join(dist, "index.html"), html);
cpSync(join(web, "public"), dist, { recursive: true });
console.log("dist/ prêt :", files.join(", "));
