/** Import de clients ou d'articles depuis un fichier CSV (Excel : « Enregistrer sous… CSV »). */
import { useState } from "react";
import { normalize, text, useApp, useTable } from "./context.ts";
import { ARTICLE_TEMPLATE, CLIENT_TEMPLATE, parseCsv, rowsToArticles, rowsToClients } from "../shared/csv.ts";

type Item = Record<string, string | number>;

export function ImportCsv({ kind }: { kind: "clients" | "articles" }) {
  const { db } = useApp();
  const existing = useTable(kind);
  const [items, setItems] = useState<Item[] | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const nameField = kind === "clients" ? "name" : "label";

  async function read(file: File | undefined) {
    setError(null);
    setDone(null);
    setItems(null);
    if (!file) return;
    const raw = await file.arrayBuffer();
    // Excel enregistre souvent en Windows-1252 : on retombe dessus si l'UTF-8 est invalide.
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      content = new TextDecoder("windows-1252").decode(raw);
    }
    const rows = parseCsv(content);
    const result = kind === "clients" ? rowsToClients(rows) : rowsToArticles(rows);
    if (result.missing) return setError(`Fichier non reconnu : ${result.missing}.`);
    // Les doublons (même nom déjà présent) sont ignorés.
    const known = new Set(existing.map((r) => normalize(text(r.data[nameField]))));
    const fresh = (result.items as Item[]).filter((i) => {
      const k = normalize(String(i[nameField]));
      if (known.has(k)) return false;
      known.add(k);
      return true;
    });
    setSkipped(result.items.length - fresh.length);
    setItems(fresh);
  }

  async function run() {
    if (!items) return;
    setBusy(true);
    for (const item of items) await db.write(kind, db.newId(kind === "clients" ? "cli" : "art"), item);
    setBusy(false);
    setDone(items.length);
    setItems(null);
  }

  const template = () => {
    const blob = new Blob(["﻿", kind === "clients" ? CLIENT_TEMPLATE : ARTICLE_TEMPLATE], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = kind === "clients" ? "modele-clients.csv" : "modele-articles.csv";
    a.click();
  };

  return (
    <div className="import">
      <label className="button">
        Importer (CSV)
        <input type="file" accept=".csv,text/csv,text/plain" hidden onChange={(e) => { read(e.target.files?.[0]); e.target.value = ""; }} aria-label="Fichier CSV à importer" />
      </label>
      <button className="link small" onClick={template}>Modèle</button>
      {error && <span className="error">{error}</span>}
      {done !== null && <span className="ok-text">{done} {kind === "clients" ? "client(s)" : "article(s)"} importé(s).</span>}
      {items && (
        <div className="card import-preview">
          <p>
            <strong>{items.length}</strong> {kind === "clients" ? "client(s)" : "article(s)"} à importer
            {skipped > 0 && <span className="muted"> · {skipped} déjà présent(s) ou en double, ignoré(s)</span>}
          </p>
          <ul className="plain small">
            {items.slice(0, 5).map((i, n) => <li key={n}>{String(i[nameField])}{kind === "articles" ? ` · ${i.price} FCFA HT` : i.city ? ` · ${i.city}` : ""}</li>)}
            {items.length > 5 && <li className="muted">… et {items.length - 5} autre(s)</li>}
          </ul>
          <div className="actions">
            <button className="ghost" onClick={() => setItems(null)}>Annuler</button>
            <button className="primary" onClick={run} disabled={busy || items.length === 0}>{busy ? "Import…" : `Importer ${items.length}`}</button>
          </div>
        </div>
      )}
    </div>
  );
}
