import { useMemo, useState, type FormEvent } from "react";
import { normalize, text, useApp, useTable } from "../context.ts";
import { formatXaf } from "../../shared/invoice.ts";
import type { SyncRecord } from "../../shared/sync.ts";
import { invoiceSituations } from "../ledger.ts";

const FIELDS: { name: string; label: string; required?: boolean; type?: string; hint?: string }[] = [
  { name: "name", label: "Raison sociale", required: true },
  { name: "phone", label: "Téléphone", hint: "Format international pour WhatsApp : +241 …" },
  { name: "email", label: "E-mail", type: "email" },
  { name: "address", label: "Adresse" },
  { name: "city", label: "Ville" },
  { name: "nif", label: "NIF" },
  { name: "rccm", label: "RCCM" },
];

/** Formulaire de fiche (clients ou articles) : n'enregistre que les champs modifiés. */
export async function savePatch(
  db: ReturnType<typeof useApp>["db"], tbl: "clients" | "articles", id: string, before: Record<string, unknown>, values: Record<string, unknown>,
) {
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if ((before[k] ?? "") !== v) patch[k] = v;
  if (Object.keys(patch).length > 0) await db.write(tbl, id, patch);
}

export function Clients() {
  const { db } = useApp();
  const clients = useTable("clients");
  const invoices = useTable("invoices");
  const payments = useTable("payments");
  const credits = useTable("credit_notes");
  const [editing, setEditing] = useState<SyncRecord | "new" | null>(null);
  const [query, setQuery] = useState("");

  const dueByClient = useMemo(() => {
    const sit = invoiceSituations(invoices, payments, credits);
    const m = new Map<string, number>();
    for (const inv of invoices) {
      const id = text(inv.data.client_id);
      const st = sit.get(inv.id);
      m.set(id, (m.get(id) ?? 0) + Math.round((st?.due ?? 0) * (st?.rate ?? 1)));
    }
    return m;
  }, [invoices, payments, credits]);

  const q = normalize(query.trim());
  const rows = clients
    .filter((c) => !q || normalize(`${text(c.data.name)} ${text(c.data.city)} ${text(c.data.phone)}`).includes(q))
    .sort((a, b) => text(a.data.name).localeCompare(text(b.data.name), "fr"));

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries([...new FormData(e.currentTarget)].map(([k, v]) => [k, String(v).trim()]));
    const isNew = editing === "new";
    await savePatch(db, "clients", isNew ? db.newId("cli") : (editing as SyncRecord).id, isNew ? {} : (editing as SyncRecord).data, f);
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
          {FIELDS.map((f) => (
            <label key={f.name}>
              {f.label}
              <input name={f.name} type={f.type ?? "text"} required={f.required} placeholder={f.hint}
                defaultValue={editing === "new" ? "" : text(editing.data[f.name])} />
            </label>
          ))}
          <div className="form-actions">
            {editing !== "new" && (
              <button type="button" className="ghost danger" onClick={async () => {
                if (confirm("Supprimer ce client ? Ses documents restent conservés.")) {
                  await db.remove("clients", editing.id);
                  setEditing(null);
                }
              }}>Supprimer</button>
            )}
            <button type="button" className="ghost" onClick={() => setEditing(null)}>Annuler</button>
            <button className="primary">Enregistrer</button>
          </div>
        </form>
      )}

      <div className="toolbar">
        <input type="search" placeholder="Rechercher un client" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Rechercher un client" />
      </div>

      {rows.length === 0 ? (
        <p className="empty">{clients.length === 0 ? "Aucun client pour l'instant." : "Aucun résultat."}</p>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Raison sociale</th><th>Téléphone</th><th>Ville</th><th>NIF</th><th className="right">Reste dû</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>{text(c.data.name)}</td>
                  <td>{text(c.data.phone)}</td>
                  <td>{text(c.data.city)}</td>
                  <td>{text(c.data.nif)}</td>
                  <td className="right mono">{dueByClient.get(c.id) ? formatXaf(dueByClient.get(c.id)!) : ""}</td>
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
