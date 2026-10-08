/** Justificatifs : photo compressée sur l'appareil, consultable hors ligne. */
import { useEffect, useState } from "react";
import { useApp } from "./context.ts";
import { downloadFile } from "./api.ts";

const MAX_SIDE = 1600;
const MAX_BYTES = 1_400_000;

/** Réduit une photo (≤ 1 600 px, JPEG) ; un PDF est gardé tel quel s'il est assez léger. */
export async function prepareReceipt(file: File): Promise<Blob> {
  if (file.type === "application/pdf") {
    if (file.size > MAX_BYTES) throw new Error("PDF trop lourd (1,4 Mo maximum) : photographiez plutôt le reçu.");
    return file;
  }
  if (!file.type.startsWith("image/")) throw new Error("Format non pris en charge : photo ou PDF.");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Image illisible."));
      i.src = url;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.75, 0.6, 0.45]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
      if (blob && blob.size <= MAX_BYTES) return blob;
    }
    throw new Error("Photo trop lourde, même compressée.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Affiche un justificatif : copie locale, sinon téléchargé puis gardé pour la suite. */
export function ReceiptViewer({ id, onClose }: { id: string; onClose: () => void }) {
  const { db } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  const [type, setType] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    (async () => {
      let blob = await db.getFile(id);
      if (!blob) {
        if (!navigator.onLine) return setError("Justificatif pris sur un autre appareil : connexion nécessaire pour l'afficher la première fois.");
        try {
          blob = await downloadFile(id);
          await db.putFile(id, blob, true);
        } catch (e) {
          return setError(e instanceof Error ? e.message : "Téléchargement impossible.");
        }
      }
      objectUrl = URL.createObjectURL(blob);
      setType(blob.type);
      setUrl(objectUrl);
    })();
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [db, id]);
  return (
    <div className="print-overlay" role="dialog" aria-label="Justificatif" onClick={onClose}>
      <div className="print-toolbar" onClick={(e) => e.stopPropagation()}>
        <span>Justificatif</span>
        {url && <a className="button" href={url} download={`justificatif-${id}`}>Télécharger</a>}
        <button onClick={onClose}>Fermer</button>
      </div>
      <div className="receipt-view" onClick={(e) => e.stopPropagation()}>
        {error ? <p className="notice">{error}</p> : !url ? <p className="muted">Chargement…</p>
          : type === "application/pdf" ? <iframe src={url} title="Justificatif PDF" />
          : <img src={url} alt="Justificatif de dépense" />}
      </div>
    </div>
  );
}
