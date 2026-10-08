import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// L'application (src/web) est construite dans dist/, que le Worker sert
// comme fichiers statiques gratuits (voir wrangler.jsonc).
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    target: "es2020",
  },
  server: {
    // En développement, l'API est servie par `npm run local` sur le port 8787.
    proxy: { "/api": "http://localhost:8787" },
  },
});
