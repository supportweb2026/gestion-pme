import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import { installErrorReporting, requestPersistentStorage } from "./device.ts";
import { parseSignPath } from "../shared/publicDoc.ts";

const root = createRoot(document.getElementById("root")!);
// Lien de signature envoyé à un client : page publique, sans session, base locale ni service worker.
const signLink = parseSignPath(location.pathname);

if (signLink) {
  void import("./PublicSign.tsx").then(({ PublicSign }) =>
    root.render(<PublicSign api={`/api/public/sign/${signLink.companyId}/${signLink.docId}/${signLink.token}`} />));
} else {
  installErrorReporting();
  requestPersistentStorage();
  root.render(<App />);
  // Service worker : l'application s'ouvre même sans réseau.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
}
