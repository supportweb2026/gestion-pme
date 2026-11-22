import { createContext, useContext, useEffect, useState } from "react";
import type { LocalDb } from "./local/db.ts";
import type { SyncEngine, SyncStatus } from "./local/sync.ts";
import type { SyncRecord, SyncTable } from "../shared/sync.ts";

export interface Session {
  token: string;
  user: { id: string; name: string; email: string; role: string; platformAdmin?: boolean; mustChangePassword?: boolean };
  company: { id: string; name: string; subscription?: import("../shared/plans.ts").SubscriptionInfo };
}

export interface AppCtx {
  db: LocalDb;
  sync: SyncEngine;
  session: Session;
  logout: () => Promise<void>;
  /** Ouvre un écran, éventuellement sur un document précis. */
  go: (tab: Tab, open?: string) => void;
}

export const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("contexte absent");
  return c;
}

/** Lignes d'une table locale, rechargées à chaque modification (locale ou reçue). */
export function useTable(tbl: SyncTable): SyncRecord[] {
  const { db } = useApp();
  const [rows, setRows] = useState<SyncRecord[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => db.list(tbl).then((r) => alive && setRows(r));
    load();
    const off = db.onChange(load);
    return () => {
      alive = false;
      off();
    };
  }, [db, tbl]);
  return rows;
}

/** Réglages de l'entreprise (une seule ligne synchronisée). */
export function useSettings(): Record<string, unknown> {
  const rows = useTable("settings");
  return rows.find((r) => r.id === "company")?.data ?? {};
}

export function useSyncStatus(): SyncStatus {
  const { sync } = useApp();
  const [status, setStatus] = useState<SyncStatus>(sync.status);
  useEffect(() => sync.subscribe(setStatus), [sync]);
  return status;
}

export type Tab =
  | "dashboard" | "gains" | "quotes" | "invoices" | "credit_notes" | "expenses"
  | "clients" | "articles" | "projects" | "accounting" | "settings" | "platform";

export const TAB_LABELS: Record<Tab, string> = {
  dashboard: "Tableau de bord",
  gains: "Gains",
  quotes: "Devis",
  invoices: "Factures",
  credit_notes: "Avoirs",
  expenses: "Dépenses",
  clients: "Clients",
  articles: "Articles",
  projects: "Projets",
  accounting: "Comptabilité",
  settings: "Réglages",
  platform: "Plateforme",
};

/**
 * Modules pas encore finalisés (le MVP couvre la facturation) : visibles avec
 * une pastille « Bientôt », ils affichent une page d'attente au lieu de l'écran.
 * Retirer une ligne ici suffit pour ouvrir le module.
 */
const COMING_SOON_MODULES: Partial<Record<Tab, { title: string; points: string[] }>> = {
  projects: {
    title: "Projets et suivi du temps",
    points: ["Projets liés aux clients, budget et rentabilité", "Tâches en Kanban et planning", "Temps passés et facturation du temps"],
  },
  expenses: {
    title: "Dépenses",
    points: ["Saisie des dépenses par catégorie", "Justificatifs photographiés, même hors ligne", "Validation par la direction"],
  },
  accounting: {
    title: "Comptabilité SYSCOHADA",
    points: ["Journal, grand livre et balance générés depuis vos factures", "Déclaration de TVA", "Export pour le cabinet comptable"],
  },
};

/** Aperçu interne (recette) : localStorage « gestia:apercu-modules » = « 1 » ouvre tous les modules. */
const previewAll = (() => {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("gestia:apercu-modules") === "1";
  } catch {
    return false;
  }
})();
export const COMING_SOON: Partial<Record<Tab, { title: string; points: string[] }>> = previewAll ? {} : COMING_SOON_MODULES;

/** Écrans visibles selon le rôle (les droits sont aussi vérifiés côté serveur au fil des lots). */
const ALL: Tab[] = ["dashboard", "gains", "quotes", "invoices", "credit_notes", "projects", "expenses", "clients", "articles", "accounting", "settings"];
export const TABS_BY_ROLE: Record<string, Tab[]> = {
  admin: ALL,
  director: ALL,
  accountant: ["dashboard", "gains", "accounting", "invoices", "credit_notes", "quotes", "projects", "expenses", "clients", "articles", "settings"],
  sales: ["dashboard", "gains", "quotes", "invoices", "projects", "clients", "articles", "expenses", "settings"],
  project_manager: ["dashboard", "projects", "quotes", "invoices", "expenses", "clients", "settings"],
  employee: ["projects", "expenses", "settings"],
};

export const can = {
  approveExpenses: (role: string) => ["admin", "director"].includes(role),
  manageCompany: (role: string) => ["admin", "director"].includes(role),
  manageUsers: (role: string) => role === "admin",
  keepBooks: (role: string) => ["admin", "accountant"].includes(role),
  manageProjects: (role: string) => ["admin", "director", "accountant", "sales", "project_manager"].includes(role),
};

export const ROLE_LABELS: Record<string, string> = {
  admin: "Administrateur",
  director: "Directeur",
  accountant: "Comptable",
  sales: "Commercial",
  project_manager: "Chef de projet",
  employee: "Employé",
};

export const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const formatDate = (iso: unknown) =>
  typeof iso === "string" && iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("fr-FR") : "—";

export const text = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** Recherche insensible aux accents et à la casse. */
export const normalize = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
