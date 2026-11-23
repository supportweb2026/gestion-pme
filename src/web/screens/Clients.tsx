import { ImportCsv } from "../ImportCsv.tsx";
import { useMemo, useState, type FormEvent } from "react";
import { formatDate, normalize, text, useApp, useTable } from "../context.ts";
import { formatXaf } from "../../shared/invoice.ts";
import { formatMoney } from "../../shared/currency.ts";
import type { DocTable, SyncRecord } from "../../shared/sync.ts";
import { currencyOf, invoiceSituations, rateOf, totalsOf, type Situation } from "../ledger.ts";
import { docTitle, quoteTypeOf } from "../../shared/documents.ts";
import { docStatus, presetList } from "./Documents.tsx";
import { usePaged } from "../Pager.tsx";
import { PROJECT_STATUS } from "../../shared/projects.ts";

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
  const quotes = useTable("quotes");
  const projects = useTable("projects");
  const [editing, setEditing] = useState<SyncRecord | "new" | null>(null);
  const [query, setQuery] = useState("");
  const [onlyDue, setOnlyDue] = useState(false);
  const [sheet, setSheet] = useState<string | null>(null);

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
  const sheetClient = sheet ? clients.find((c) => c.id === sheet) ?? null : null;
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

      {sheetClient && !editing && (
        <ClientSheet client={sheetClient} projects={projects} quotes={quotes} invoices={invoices} credits={credits} situations={situations}
          due={dueByClient.get(sheetClient.id) ?? 0} onEdit={() => setEditing(sheetClient)} onClose={() => setSheet(null)} />
      )}

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
                <tr key={c.id} className={sheet === c.id ? "selected" : undefined}>
                  <td className="strong"><button className="link-name" onClick={() => { setEditing(null); setSheet(c.id); window.scrollTo(0, 0); }} title="Ouvrir la fiche">{text(c.data.name)}</button></td>
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

const DOC_TABS: { tbl: DocTable; all: string }[] = [
  { tbl: "invoices", all: "Toutes ses factures" },
  { tbl: "quotes", all: "Tous ses devis et bons" },
  { tbl: "credit_notes", all: "Tous ses avoirs" },
];
const SHEET_ROWS = 8;

/** Fiche d'un client : ses coordonnées, ce qu'il doit, et ses derniers documents à portée de clic. */
function ClientSheet({ client, projects, quotes, invoices, credits, situations, due, onEdit, onClose }: {
  client: SyncRecord; projects: SyncRecord[]; quotes: SyncRecord[]; invoices: SyncRecord[]; credits: SyncRecord[];
  situations: Map<string, Situation>; due: number; onEdit: () => void; onClose: () => void;
}) {
  const { go } = useApp();
  const c = client.data;
  const mine = { quotes, invoices, credit_notes: credits } as Record<DocTable, SyncRecord[]>;
  const of = (tbl: DocTable) => mine[tbl].filter((d) => d.data.client_id === client.id);
  const all = DOC_TABS.flatMap(({ tbl }) => of(tbl).map((d) => ({ tbl, d })))
    .sort((a, b) => text(b.d.data.date).localeCompare(text(a.d.data.date)) || text(b.d.data.number).localeCompare(text(a.d.data.number)));
  const validated = of("invoices").filter((d) => d.data.status === "validated");
  const billed = validated.reduce((s, d) => s + Math.round(totalsOf(d).gross * rateOf(d)), 0);
  const sum = (pick: (s: Situation) => number) => validated.reduce((n, d) => {
    const s = situations.get(d.id);
    return n + (s ? Math.round(pick(s) * s.rate) : 0);
  }, 0);
  const paid = sum((s) => s.paid);
  const late = sum((s) => (s.status === "overdue" ? s.due : 0));
  const pending = of("quotes").filter((d) => docStatus("quotes", d, situations).key === "sent").length;
  const myProjects = projects.filter((p) => p.data.client_id === client.id)
    .sort((a, b) => text(b.data.start_date).localeCompare(text(a.data.start_date)));
  const contact = [text(c.phone), text(c.email), [text(c.address), text(c.city)].filter(Boolean).join(", ")].filter(Boolean);
  const legal = [text(c.nif) && `NIF ${text(c.nif)}`, text(c.rccm) && `RCCM ${text(c.rccm)}`].filter(Boolean);

  return (
    <div className="card client-sheet" data-testid="client-sheet">
      <div className="sheet-head">
        <div>
          <h3>{text(c.name)}</h3>
          <p className="muted small">{contact.length ? contact.join(" · ") : "Aucune coordonnée renseignée"}</p>
          {legal.length > 0 && <p className="muted small">{legal.join(" · ")}</p>}
        </div>
        <div className="actions">
          <button className="small" onClick={onEdit}>Modifier</button>
          <button className="ghost small" onClick={onClose}>Fermer</button>
        </div>
      </div>
      <dl className="sheet-kpis">
        <div><dt>Facturé TTC</dt><dd className="mono">{formatXaf(billed)}</dd><p className="muted small">{validated.length} facture{validated.length > 1 ? "s" : ""}</p></div>
        <div><dt>Encaissé</dt><dd className="mono">{formatXaf(paid)}</dd></div>
        <div><dt>Reste dû</dt><dd className="mono">{formatXaf(due)}</dd>{late > 0 && <p className="danger-text small">dont {formatXaf(late)} en retard</p>}</div>
        <div><dt>Devis en attente</dt><dd className="mono">{pending}</dd></div>
      </dl>
      {myProjects.length > 0 && (
        <div className="sheet-projects">
          <h4>Projets</h4>
          <ul>
            {myProjects.slice(0, 6).map((p) => (
              <li key={p.id}>
                <button className="link-name" onClick={() => go("projects", p.id)}>{text(p.data.name)}</button>
                <span className="badge">{PROJECT_STATUS[text(p.data.status)] ?? text(p.data.status)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {all.length > 0 && <h4>Derniers documents</h4>}
      {all.length === 0 ? (
        <p className="muted small">Aucun document pour ce client.</p>
      ) : (
        <>
          <table className="sheet-docs">
            <caption className="sr-only">Derniers documents</caption>
            <tbody>
              {all.slice(0, SHEET_ROWS).map(({ tbl, d }) => {
                const st = docStatus(tbl, d, situations);
                const delivery = tbl === "quotes" && quoteTypeOf(d.data) === "delivery";
                return (
                  <tr key={d.id}>
                    <td><button className="link-name mono" onClick={() => go(tbl, d.id)}>{text(d.data.number) || "Brouillon"}</button></td>
                    <td className="muted">{docTitle(tbl, d.data)}</td>
                    <td className="muted">{formatDate(d.data.date)}</td>
                    <td><span className={`badge ${st.tone}`}>{st.label}</span></td>
                    <td className="right mono">{delivery ? "—" : formatMoney(totalsOf(d).gross, currencyOf(d))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="sheet-more">
            {DOC_TABS.map(({ tbl, all: label }) => {
              const n = of(tbl).length;
              return n > 0 ? (
                <button key={tbl} className="ghost small" onClick={() => { presetList(tbl, { client: client.id }); go(tbl); }}>
                  {label} ({n})
                </button>
              ) : null;
            })}
          </div>
        </>
      )}
    </div>
  );
}
