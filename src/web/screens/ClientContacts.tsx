/**
 * Carnet de contacts d'un client (onglet de sa page) : les personnes de l'entreprise,
 * leur fonction, leur téléphone et leur e-mail ; une seule est le contact principal.
 */
import { useState } from "react";
import { useApp } from "../context.ts";
import type { SyncRecord } from "../../shared/sync.ts";
import { contactsOf, removeContact, saveContact, type Contact } from "../../shared/contacts.ts";

const EMPTY: Contact = { id: "", name: "", role: "", phone: "", email: "", main: false };

export function ClientContacts({ client }: { client: SyncRecord }) {
  const { db } = useApp();
  const list = contactsOf(client.data);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const write = (contacts: Contact[]) => db.write("clients", client.id, { contacts });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    if (!editing.name.trim()) return setError("Indiquez le nom du contact.");
    if (editing.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editing.email.trim())) return setError("L'adresse e-mail n'est pas valide.");
    await write(saveContact(list, { ...editing, id: editing.id || db.newId("ct") }));
    setEditing(null);
    setError(null);
  }
  async function remove(c: Contact) {
    if (!confirm(`Retirer ${c.name} des contacts de ce client ?`)) return;
    await write(removeContact(list, c.id));
  }
  const field = (key: "name" | "role" | "phone" | "email", label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label>{label}<input value={editing![key]} onChange={(e) => setEditing({ ...editing!, [key]: e.target.value })} {...props} /></label>
  );

  if (editing) {
    return (
      <form className="contact-form" onSubmit={submit} data-testid="contact-form">
        <h3>{editing.id ? "Modifier le contact" : "Nouveau contact"}</h3>
        <div className="contact-fields">
          {field("name", "Nom et prénom", { required: true, autoFocus: true })}
          {field("role", "Fonction", { placeholder: "Achats, comptabilité, direction…" })}
          {field("phone", "Téléphone", { type: "tel", placeholder: "+241 …" })}
          {field("email", "E-mail", { type: "email" })}
        </div>
        <label className="check-inline">
          <input type="checkbox" checked={Boolean(editing.main) || list.length === 0} disabled={list.length === 0 || (list.length === 1 && Boolean(editing.id))} onChange={(e) => setEditing({ ...editing, main: e.target.checked })} />
          Contact principal : la personne à qui s'adressent d'abord les devis et les factures
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" className="ghost" onClick={() => { setEditing(null); setError(null); }}>Annuler</button>
          <button className="primary">Enregistrer le contact</button>
        </div>
      </form>
    );
  }

  return (
    <div data-testid="client-contacts">
      <div className="contacts-head">
        <p className="muted small">{list.length === 0 ? "Les personnes à qui vous vous adressez chez ce client." : `${list.length} contact${list.length > 1 ? "s" : ""} chez ce client`}</p>
        <button className={list.length === 0 ? "primary" : ""} onClick={() => setEditing({ ...EMPTY })}>Ajouter un contact</button>
      </div>
      {list.length === 0 ? (
        <p className="empty">Aucun contact pour l'instant. Ajoutez par exemple la personne des achats et celle de la comptabilité : vous saurez qui relancer.</p>
      ) : (
        <ul className="contact-list">
          {list.map((c) => (
            <li key={c.id}>
              <span className="client-avatar small" aria-hidden="true">{c.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}</span>
              <div className="contact-id">
                <strong>{c.name}</strong>{c.main && <span className="badge info">Contact principal</span>}
                <div className="muted small">{c.role || "Fonction non renseignée"}</div>
              </div>
              <div className="contact-reach">
                {c.phone ? <a href={`tel:${c.phone.replace(/\s/g, "")}`}>{c.phone}</a> : <span className="muted">Pas de téléphone</span>}
                {c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : <span className="muted">Pas d'e-mail</span>}
              </div>
              <div className="contact-actions">
                {!c.main && <button className="ghost small" onClick={() => write(saveContact(list, { ...c, main: true }))}>Rendre principal</button>}
                <button className="ghost small" onClick={() => setEditing(c)}>Modifier</button>
                <button className="ghost small" onClick={() => remove(c)} aria-label={`Retirer ${c.name}`}>Retirer</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
