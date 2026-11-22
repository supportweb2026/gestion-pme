/**
 * Télécharger ou partager le PDF d'un document. Le générateur (pdf-lib) est
 * chargé à la demande, puis gardé en cache par le service worker.
 */
import type { PdfInput } from "./pdf.ts";

const load = () => import("./pdf.ts");

/** Précharge le générateur en tâche de fond, pour qu'il marche ensuite hors ligne. */
export function preloadPdf(): void {
  const run = () => void load().catch(() => undefined);
  if ("requestIdleCallback" in window) (window as Window & { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(run);
  else setTimeout(run, 3000);
}

export async function makePdfFile(input: PdfInput): Promise<File> {
  const { buildPdf, pdfFileName } = await load();
  const bytes = await buildPdf(input);
  return new File([bytes as BlobPart], pdfFileName(input.kind, input.doc, input.client), { type: "application/pdf" });
}

export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Vrai si l'appareil sait partager un fichier (téléphones Android / iPhone, Safari, Edge…). */
export function canShareFiles(): boolean {
  try {
    const probe = new File([new Uint8Array(1)], "test.pdf", { type: "application/pdf" });
    return typeof navigator.canShare === "function" && navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/**
 * Partage le PDF avec le message (WhatsApp, Gmail, Outlook… au choix de l'utilisateur).
 * Retourne false si l'utilisateur annule.
 */
export async function shareFile(file: File, title: string, text: string): Promise<boolean> {
  try {
    await navigator.share({ files: [file], title, text });
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return false;
    throw e;
  }
}
