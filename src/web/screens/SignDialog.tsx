/**
 * Signature du client sur l'appareil : il lit le rappel du document, saisit son nom,
 * signe au doigt. Sa signature vaut accord (devis, commande) ou réception (bon).
 */
import { useEffect, useState } from "react";
import { SignaturePad } from "../SignaturePad.tsx";

export function SignDialog({ doc, client, amount, mode, defaultName, confirmText, onSign, onClose }: {
  /** « Devis DV-2026-00012 ». */
  doc: string;
  client: string;
  /** Montant TTC à rappeler au signataire (aucun pour un bon sans prix). */
  amount?: string;
  mode: "accept" | "receive";
  defaultName: string;
  /** Ce que le client confirme en signant. */
  confirmText: string;
  onSign: (name: string, image: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.classList.add("dialog-open");
    return () => { window.removeEventListener("keydown", onKey); document.body.classList.remove("dialog-open"); };
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return setError("Indiquez le nom de la personne qui signe.");
    if (!image) return setError("La signature manque : signez dans le cadre.");
    setBusy(true);
    try {
      await onSign(name.trim(), image);
    } catch {
      setError("La signature n'a pas pu être enregistrée. Réessayez.");
      setBusy(false);
    }
  }

  return (
    <>
      <div className="val-backdrop" onClick={onClose} aria-hidden="true" />
      <form className="val-dialog narrow" role="dialog" aria-modal="true" aria-labelledby="sign-title" onSubmit={submit} data-testid="sign-dialog">
        <header className="val-head">
          <div>
            <h3 id="sign-title">{mode === "accept" ? "Signature du client" : "Signature à la réception"}</h3>
            <p className="muted small">Tendez l'appareil au client : il vérifie, écrit son nom et signe.</p>
          </div>
          <button type="button" className="ghost" onClick={onClose} aria-label="Fermer">✕</button>
        </header>
        <div className="val-body">
          <p className="sign-recap"><span>{doc}<br /><span className="muted small">{client}</span></span>{amount && <strong className="mono">{amount}</strong>}</p>
          <label className="val-field"><span>Nom du signataire</span>
            <input value={name} onChange={(e) => { setName(e.target.value); setError(""); }} placeholder="Prénom et nom" autoComplete="off" maxLength={120} />
          </label>
          <SignaturePad onChange={(img) => { setImage(img); setError(""); }} />
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <footer className="val-foot">
          <p className="muted small">{confirmText} La signature est imprimée sur le document et ne se modifie plus.</p>
          <div className="val-foot-actions">
            <button type="button" className="ghost" onClick={onClose}>Annuler</button>
            <button className="primary" disabled={busy}>{mode === "accept" ? "Signer et accepter" : "Signer et confirmer"}</button>
          </div>
        </footer>
      </form>
    </>
  );
}
