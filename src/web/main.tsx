import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import { installErrorReporting, requestPersistentStorage } from "./device.ts";

installErrorReporting();
requestPersistentStorage();

createRoot(document.getElementById("root")!).render(<App />);

// Service worker : l'application s'ouvre même sans réseau.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
