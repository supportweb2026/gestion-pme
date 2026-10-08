import { useState, type FormEvent } from "react";
import { useApp, useTable } from "../context.ts";
import type { SyncRecord } from "../../shared/sync.ts";

export function Clients() {
  const { db } = useApp();
  const clients = useTable("clients").sort((a, b) => String(a.data.name).localeCompare(String(b.data.name), "fr"));
  const [editing, setEditing] = useState<SyncRecord | "new" | null>(null);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const id = editing && editing !== "new" ? editing.id : db.newId("cli");
    const before = editing && editing !== "new" ? editing.data : {};
    // On n'envoie que les champs réellement modifiés : moins de conflits, moins d'écritures.
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(f)) if ((before[k] ?? "") !== v) patch[k] = v.trim();
    if (Object.keys(patch).length > 0) await db.write("clients", id, patch);
    setEditing(null);
  }

  return (
    <section>
      <div className="section-head">
        <h2>Clients</h2>
        <button className="primary" onClick={() => setEditing("new")}>Nouveau client</button>
      </div>

      {editing && (
        <form className="card form-grid" onSubmit={save} key={editing === "new" ? "new" : editing.id}>
          <label>Raison sociale<input name="name" required defaultValue={editing === "new" ? "" : String(editing.data.name ?? "")} /></label>
          <label>Téléphone<input name="phone" defaultValue={editing === "new" ? "" : String(editing.data.phone ?? "")} /></label>
          <label>Ville<input name="city" defaultValue={editing === "new" ? "" : String(editing.data.city ?? "")} /></label>
          <label>NIF<input name="nif" defaultValue={editing === "new" ? "" : String(editing.data.nif ?? "")} /></label>
          <div className="form-actions">
            <button type="button" className="ghost" onClick={() => setEditing(null)}>Annuler</button>
            <button className="primary">Enregistrer</button>
          </div>
        </form>
      )}

      {clients.length === 0 ? (
        <p className="empty">Aucun client pour l'instant.</p>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Raison sociale</th><th>Téléphone</th><th>Ville</th><th>NIF</th><th /></tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id}>
                  <td>{String(c.data.name ?? "")}</td>
                  <td>{String(c.data.phone ?? "")}</td>
                  <td>{String(c.data.city ?? "")}</td>
                  <td>{String(c.data.nif ?? "")}</td>
                  <td className="right"><button className="ghost small" onClick={() => setEditing(c)}>Modifier</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
