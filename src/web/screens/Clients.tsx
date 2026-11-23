import { ImportCsv } from "../ImportCsv.tsx";
import { useMemo, useState, type FormEvent } from "react";
import { normalize, text, useApp, useTable } from "../context.ts";
import { formatXaf } from "../../shared/invoice.ts";
import type { SyncRecord } from "../../shared/sync.ts";
import { invoiceSituations } from "../ledger.ts";
import { usePaged } from "../Pager.tsx";
import { ClientPage } from "./ClientPage.tsx";

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

export function Clients({ open, setOpen }: { open: string | null; setOpen: (id: string | null) => void }) {
  const { db } = useApp();
  const clients = useTable("clients");
  const invoices = useTable("invoices");
  const payments = useTable("payments");
  const credits = useTable("credit_notes");
  const [editing, setEditing] = useState<SyncRecord | "new" | null>(null);
  const [query, setQuery] = useState("");
  const [onlyDue, setOnlyDue] = useState(false);

  const situations = useMemo(() => invoiceSituations(invoices, payments, credits), [invoices, payments, credits]);
  const dueByClient = useMemo(() => {
    const sit = situations;
    const m = new Map<string, number>();
    for (const inv of invoices) {
      const id = text(inv.data.client_id);
      const st = sit.get(inv.id);
      m.set(id, (m.get(id) ?? 0) + Math.round((st?.due ?? 0) * (st?.rate ?? 1)));
    }
    return m;
  }, [invoices, situations]);

  const q = normalize(query.trim());
  const withDue = clients.filter((c) => (dueByClient.get(c.id) ?? 0) > 0).length;
  const rows = clients
    .filter((c) => !q || normalize(`${text(c.data.name)} ${text(c.data.city)} ${text(c.data.phone)} ${text(c.data.nif)}`).includes(q))
    .filter((c) => !onlyDue || (dueByClient.get(c.id) ?? 0) > 0)
    // Avec le filtre « Reste dû », les plus gros montants d'abord : c'est la liste des relances.
    .sort((a, b) => (onlyDue ? (dueByClient.get(b.id) ?? 0) - (dueByClient.get(a.id) ?? 0) : 0) || text(a.data.name).localeCompare(text(b.data.name), "fr"));
  const { shown, pager } = usePaged(rows, `${q}|${onlyDue}`);
  const sheetClient = open ? clients.find((c) => c.id === open) ?? null : null;
  const dueTotal = rows.reduce((s, c) => s + (dueByClient.get(c.id) ?? 0), 0);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries([...new FormData(e.currentTarget)].map(([k, v]) => [k, String(v).trim()]));
    // Case à cocher : absente du formulaire quand elle est décochée.
    f.individual = f.individual ? "1" : "";
    const isNew = editing === "new";
    await savePatch(db, "clients", isNew ? db.newId("cli") : (editing as SyncRecord).id, isNew ? {} : (editing as SyncRecord).data, f);
    setEditing(null);
  }

  const form = (
    <>
      {editing && (
        <form className="card form-grid" onSubmit={save} key={editing === "new" ? "new" : editing.id}>
          {FIELDS.map((f) => (
            <label key={f.name}>
              {f.label}
              <input name={f.name} type={f.type ?? "text"} required={f.required} placeholder={f.hint}
                defaultValue={editing === "new" ? "" : text(editing.data[f.name])} />
            </label>
          ))}
          <label className="check-inline">
            <input type="checkbox" name="individual" defaultChecked={editing !== "new" && Boolean(editing.data.individual)} />
            Particulier (personne physique)
          </label>
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
    </>
  );

  if (open) {
    if (!sheetClient) return <p className="empty">Client introuvable sur cet appareil.</p>;
    return (
      <>
        {editing && <section>{form}</section>}
        <ClientPage client={sheetClient} onBack={() => { setEditing(null); setOpen(null); }} onEdit={() => { setEditing(sheetClient); window.scrollTo(0, 0); }} />
      </>
    );
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h2>Clients</h2>
          <p className="muted small">{clients.length === 0 ? "Votre répertoire de clients" : `${clients.length} client${clients.length > 1 ? "s" : ""}`}</p>
        </div>
        <div className="actions">
          <ImportCsv kind="clients" />
          <button className="primary" onClick={() => setEditing("new")}>Nouveau client</button>
        </div>
      </div>

      {form}

      <div className="toolbar">
        <input type="search" placeholder="Nom, ville, téléphone ou NIF" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Rechercher un client" />
        {withDue > 0 && (
          <div className="segmented" role="group" aria-label="Filtrer">
            <button className={!onlyDue ? "active" : ""} aria-pressed={!onlyDue} onClick={() => setOnlyDue(false)}>Tous</button>
            <button className={onlyDue ? "active" : ""} aria-pressed={onlyDue} onClick={() => setOnlyDue(true)}>Reste dû<span className="seg-count">{withDue}</span></button>
          </div>
        )}
        {(q || onlyDue) && rows.length > 0 && (
          <p className="list-summary muted small" data-testid="clients-summary">
            <strong>{rows.length} client{rows.length > 1 ? "s" : ""}</strong>{dueTotal > 0 && <> · Reste dû <strong>{formatXaf(dueTotal)}</strong></>}
          </p>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="empty">{clients.length === 0 ? "Aucun client pour l'instant." : "Aucun résultat."}</p>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Raison sociale</th><th>Téléphone</th><th>Ville</th><th>NIF</th><th className="right">Reste dû</th><th className="col-action"><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id}>
                  <td className="strong"><button className="link-name" onClick={() => { setEditing(null); setOpen(c.id); window.scrollTo(0, 0); }} title="Ouvrir la page du client">{text(c.data.name)}</button></td>
                  <td>{text(c.data.phone) || <span className="muted">—</span>}</td>
                  <td>{text(c.data.city) || <span className="muted">—</span>}</td>
                  <td>{text(c.data.nif) || <span className="muted">—</span>}</td>
                  <td className={`right mono${dueByClient.get(c.id) ? " strong" : " muted"}`}>{formatXaf(dueByClient.get(c.id) ?? 0)}</td>
                  <td className="right col-action"><button className="ghost small" onClick={() => setEditing(c)}>Modifier</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {pager}
        </div>
      )}
    </section>
  );
}

