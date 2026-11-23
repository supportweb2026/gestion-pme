/**
 * Import et export de clients ou d'articles, au format des tableurs : CSV ou Excel (.xlsx).
 * Les colonnes sont reconnues par leur intitulé, quel que soit le logiciel d'origine, et
 * la correspondance reste modifiable avant d'importer. Ce qui existe déjà est complété,
 * jamais écrasé.
 */
import { useMemo, useState } from "react";
import { text, useApp, useTable } from "./context.ts";
import {
  ARTICLE_EXPORT_FIELDS, ARTICLE_FIELDS, ARTICLE_TEMPLATE, CLIENT_FIELDS, CLIENT_TEMPLATE, mapColumns, parseCsv, planImport,
  rowsToArticles, rowsToClients, toCsv,
} from "../shared/csv.ts";
import { readXlsx } from "../shared/xlsx.ts";

function save(name: string, content: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿", content], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
}

export function ImportCsv({ kind }: { kind: "clients" | "articles" }) {
  const { db } = useApp();
  const existing = useTable(kind);
  const fields = kind === "clients" ? CLIENT_FIELDS : ARTICLE_FIELDS;
  const nameField = kind === "clients" ? "name" : "label";
  const many = kind === "clients" ? "client(s)" : "article(s)";
  const [rows, setRows] = useState<string[][] | null>(null);
  const [map, setMap] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function read(file: File | undefined) {
    setError(null);
    setDone(null);
    setRows(null);
    if (!file) return;
    try {
      const raw = await file.arrayBuffer();
      let parsed: string[][];
      if (/\.xlsx$/i.test(file.name)) parsed = await readXlsx(raw);
      else if (/\.xls$/i.test(file.name)) throw new Error("Ancien format Excel (.xls) : enregistrez le fichier en .xlsx ou en CSV.");
      else {
        // Excel enregistre souvent en Windows-1252 : on retombe dessus si l'UTF-8 est invalide.
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        } catch {
          content = new TextDecoder("windows-1252").decode(raw);
        }
        parsed = parseCsv(content);
      }
      if (parsed.length < 2) throw new Error("Le fichier ne contient aucune ligne à importer.");
      setMap(mapColumns(parsed[0], fields, parsed.slice(1)));
      setRows(parsed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fichier illisible.");
    }
  }

  const plan = useMemo(() => {
    if (!rows) return null;
    const result = kind === "clients" ? rowsToClients(rows, map) : rowsToArticles(rows, map);
    return { missing: result.missing, ...planImport(result.items, existing, nameField) };
  }, [rows, map, existing, kind, nameField]);

  async function run() {
    if (!plan) return;
    setBusy(true);
    for (const item of plan.fresh) await db.write(kind, db.newId(kind === "clients" ? "cli" : "art"), item);
    for (const u of plan.updates) await db.write(kind, u.id, u.patch);
    setBusy(false);
    setDone([
      plan.fresh.length ? `${plan.fresh.length} ${many} ajouté(s)` : "",
      plan.updates.length ? `${plan.updates.length} complété(s)` : "",
    ].filter(Boolean).join(", ") + ".");
    setRows(null);
  }

  const exportAll = () => {
    const sorted = [...existing].sort((a, b) => text(a.data[nameField]).localeCompare(text(b.data[nameField]), "fr"));
    if (kind === "clients") save("clients.csv", toCsv(CLIENT_FIELDS, sorted.map((r) => r.data)));
    else save("articles.csv", toCsv(ARTICLE_EXPORT_FIELDS, sorted.map((r) => ({ ...r.data, kind: r.data.kind === "product" ? "Produit" : "Service" }))));
  };

  const header = rows?.[0] ?? [];
  const sample = (i: number) => rows?.slice(1).find((r) => (r[i] ?? "") !== "")?.[i] ?? "";
  const todo = plan ? plan.fresh.length + plan.updates.length : 0;

  return (
    <div className="import">
      <label className="button">
        Importer
        <input type="file" accept=".csv,.xlsx,.txt,.tsv,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden
          onChange={(e) => { read(e.target.files?.[0]); e.target.value = ""; }} aria-label="Fichier à importer (CSV ou Excel)" />
      </label>
      {existing.length > 0 && <button className="ghost" onClick={exportAll} title="Télécharger la liste au format CSV, lisible par Excel">Exporter</button>}
      <button className="ghost" onClick={() => save(kind === "clients" ? "modele-clients.csv" : "modele-articles.csv", kind === "clients" ? CLIENT_TEMPLATE : ARTICLE_TEMPLATE)} title="Télécharger un fichier modèle à remplir">Modèle</button>
      {error && <span className="error">{error}</span>}
      {done !== null && <span className="ok-text" data-testid="import-done">{done}</span>}
      {rows && plan && (
        <div className="card import-preview" data-testid="import-preview">
          <p className="import-title"><strong>Correspondance des colonnes</strong> <span className="muted small">Les colonnes de votre fichier ont été reconnues. Corrigez si besoin.</span></p>
          <div className="import-map">
            {fields.map((f) => (
              <label key={f.key}>
                <span>{f.label}{f.required ? " *" : ""}</span>
                <select value={map[f.key] ?? ""} aria-label={`Colonne pour ${f.label}`} onChange={(e) => setMap((m) => {
                  const next = { ...m };
                  if (e.target.value === "") delete next[f.key];
                  else next[f.key] = Number(e.target.value);
                  return next;
                })}>
                  <option value="">Ne pas importer</option>
                  {header.map((h, i) => <option key={i} value={i}>{h || `Colonne ${i + 1}`}{sample(i) ? ` (ex. ${sample(i).replace(/\s+/g, " ").slice(0, 24)})` : ""}</option>)}
                </select>
              </label>
            ))}
          </div>
          {plan.missing ? <p className="error">Pour continuer, {plan.missing}.</p> : (
            <>
              <p data-testid="import-summary">
                <strong>{plan.fresh.length}</strong> à ajouter
                {plan.updates.length > 0 && <> · <strong>{plan.updates.length}</strong> à compléter</>}
                {plan.same > 0 && <span className="muted"> · {plan.same} déjà à jour ou en double</span>}
              </p>
              {plan.updates.length > 0 && <p className="muted small">Compléter remplit les champs encore vides des fiches existantes (prix, description, unité…). Rien n'est écrasé.</p>}
              <ul className="plain small">
                {[...plan.fresh, ...plan.updates.map((u) => ({ ...existing.find((e) => e.id === u.id)?.data, ...u.patch }))].slice(0, 5).map((i, n) => (
                  <li key={n}>{String((i as Record<string, unknown>)[nameField])}{kind === "articles" ? ` · ${Number((i as Record<string, unknown>).price ?? 0).toLocaleString("fr-FR")} FCFA HT` : (i as Record<string, unknown>).city ? ` · ${String((i as Record<string, unknown>).city)}` : ""}</li>
                ))}
                {todo > 5 && <li className="muted">… et {todo - 5} autre(s)</li>}
              </ul>
            </>
          )}
          <div className="actions">
            <button className="ghost" onClick={() => setRows(null)}>Annuler</button>
            <button className="primary" onClick={run} disabled={busy || todo === 0 || Boolean(plan.missing)}>
              {busy ? "Import…" : plan.fresh.length && plan.updates.length ? `Importer ${plan.fresh.length} et compléter ${plan.updates.length}` : plan.updates.length ? `Compléter ${plan.updates.length}` : `Importer ${plan.fresh.length}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
