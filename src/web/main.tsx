import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import { installErrorReporting, requestPersistentStorage } from "./device.ts";
import { parseSignPath } from "../shared/publicDoc.ts";
import { parsePortalPath } from "../shared/portal.ts";

const root = createRoot(document.getElementById("root")!);
// Lien de signature envoyé à un client : page publique, sans session, base locale ni service worker.
const signLink = parseSignPath(location.pathname);

const portalLink = parsePortalPath(location.pathname);

if (portalLink) {
  // Espace client en ligne : même principe, en lecture seule.
  void import("./PublicPortal.tsx").then(({ PublicPortal }) =>
    root.render(<PublicPortal api={`/api/public/portal/${portalLink.companyId}/${portalLink.clientId}/${portalLink.token}`} />));
} else if (signLink) {
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
