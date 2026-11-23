/**
 * Carnet de contacts d'un client : les personnes à qui l'on s'adresse dans
 * l'entreprise (achats, comptabilité, direction…). Les contacts sont rangés dans
 * la fiche du client (champ `contacts`) ; un seul est le contact principal.
 */
export interface Contact {
  id: string;
  name: string;
  role: string;
  phone: string;
  email: string;
  main?: boolean;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Contacts d'une fiche client, le principal en premier puis par nom. */
export function contactsOf(data: Record<string, unknown> | undefined): Contact[] {
  const raw = Array.isArray(data?.contacts) ? (data!.contacts as Record<string, unknown>[]) : [];
  const list = raw
    .filter((c) => c && typeof c === "object" && str(c.id) && str(c.name))
    .map((c) => ({ id: str(c.id), name: str(c.name), role: str(c.role), phone: str(c.phone), email: str(c.email), main: c.main === true }));
  // Un seul contact principal, même si deux appareils en ont désigné un chacun.
  const main = list.find((c) => c.main)?.id ?? list[0]?.id;
  return list
    .map((c) => ({ ...c, main: c.id === main }))
    .sort((a, b) => Number(b.main) - Number(a.main) || a.name.localeCompare(b.name, "fr"));
}

/** Ajoute ou remplace un contact ; `main` le désigne comme principal à la place de l'ancien. */
export function saveContact(list: Contact[], contact: Contact): Contact[] {
  const others = list.filter((c) => c.id !== contact.id).map((c) => (contact.main ? { ...c, main: false } : c));
  const next = [...others, { ...contact, name: contact.name.trim(), role: contact.role.trim(), phone: contact.phone.trim(), email: contact.email.trim() }];
  return next.some((c) => c.main) ? next : next.map((c, i) => ({ ...c, main: i === 0 }));
}

export function removeContact(list: Contact[], id: string): Contact[] {
  const next = list.filter((c) => c.id !== id);
  return next.length && !next.some((c) => c.main) ? next.map((c, i) => ({ ...c, main: i === 0 })) : next;
}

/** Texte de recherche : noms, fonctions, téléphones et e-mails des contacts. */
export const contactsSearchText = (data: Record<string, unknown> | undefined) =>
  contactsOf(data).map((c) => `${c.name} ${c.role} ${c.phone} ${c.email}`).join(" ");
