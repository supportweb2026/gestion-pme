/**
 * Intégration à l'appareil : remontée des erreurs, stockage persistant,
 * installation de l'application sur l'écran d'accueil.
 */
import { useEffect, useState } from "react";
import { getToken } from "./api.ts";

const MAX_REPORTS = 10;
let reported = 0;
const seen = new Set<string>();

function report(message: string, detail?: string) {
  if (reported >= MAX_REPORTS || !navigator.onLine) return;
  const key = message.slice(0, 200);
  if (seen.has(key)) return;
  seen.add(key);
  reported++;
  const token = getToken();
  fetch("/api/errors", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ message, detail, url: location.pathname }),
    keepalive: true,
  }).catch(() => {});
}

/** Les erreurs imprévues sont envoyées à l'équipe Gestia (sans données métier). */
export function installErrorReporting(): void {
  window.addEventListener("error", (e) => {
    if (!e.message) return; // ressource introuvable : pas une erreur de l'application
    report(e.message, e.error instanceof Error ? e.error.stack : `${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    // Les coupures réseau sont normales hors ligne.
    if (r instanceof TypeError && /fetch|network|load failed/i.test(r.message)) return;
    if (r && typeof r === "object" && "status" in r) return; // ApiError déjà affichée
    report(r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : undefined);
  });
}

/** Demande au navigateur de ne pas effacer la base locale quand l'espace manque (téléphones). */
export async function requestPersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    // navigateur sans cette fonction
  }
}

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferred = e as InstallEvent;
  listeners.forEach((l) => l());
});
window.addEventListener("appinstalled", () => {
  deferred = null;
  listeners.forEach((l) => l());
});

const standalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

/** Bouton « Installer » : invite native (Android, ordinateur) ou explication (iPhone). */
export function useInstall(): { available: boolean; install: () => Promise<void>; iosHint: boolean } {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  if (standalone()) return { available: false, install: async () => {}, iosHint: false };
  if (deferred) {
    return {
      available: true,
      iosHint: false,
      install: async () => {
        const d = deferred!;
        deferred = null;
        await d.prompt();
        await d.userChoice.catch(() => null);
        listeners.forEach((l) => l());
      },
    };
  }
  return { available: isIos(), iosHint: isIos(), install: async () => {} };
}
