import { createContext, useContext, useEffect, useState } from "react";
import type { LocalDb } from "./local/db.ts";
import type { SyncEngine, SyncStatus } from "./local/sync.ts";
import type { SyncRecord, SyncTable } from "../shared/sync.ts";

export interface Session {
  token: string;
  user: { id: string; name: string; email: string; role: string };
  company: { id: string; name: string };
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
  | "dashboard" | "quotes" | "invoices" | "credit_notes" | "expenses"
  | "clients" | "articles" | "settings";

export const TAB_LABELS: Record<Tab, string> = {
  dashboard: "Tableau de bord",
  quotes: "Devis",
  invoices: "Factures",
  credit_notes: "Avoirs",
  expenses: "Dépenses",
  clients: "Clients",
  articles: "Articles",
  settings: "Réglages",
};

/** Écrans visibles selon le rôle (les droits sont aussi vérifiés côté serveur au fil des lots). */
const ALL: Tab[] = ["dashboard", "quotes", "invoices", "credit_notes", "expenses", "clients", "articles", "settings"];
export const TABS_BY_ROLE: Record<string, Tab[]> = {
  admin: ALL,
  director: ALL,
  accountant: ["dashboard", "invoices", "credit_notes", "quotes", "expenses", "clients", "articles"],
  sales: ["dashboard", "quotes", "invoices", "clients", "articles", "expenses"],
  project_manager: ["dashboard", "quotes", "invoices", "expenses", "clients"],
  employee: ["expenses"],
};

export const can = {
  approveExpenses: (role: string) => ["admin", "director"].includes(role),
  manageCompany: (role: string) => ["admin", "director"].includes(role),
  manageUsers: (role: string) => role === "admin",
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
