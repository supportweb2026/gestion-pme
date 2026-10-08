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

export function useSyncStatus(): SyncStatus {
  const { sync } = useApp();
  const [status, setStatus] = useState<SyncStatus>(sync.status);
  useEffect(() => sync.subscribe(setStatus), [sync]);
  return status;
}

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
