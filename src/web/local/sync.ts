/**
 * Moteur de synchronisation côté appareil.
 * Envoie la file d'attente et récupère les modifications des autres appareils
 * dès que le réseau est disponible ; ne bloque jamais le travail local.
 */
import { MAX_PUSH, type SyncRequest, type SyncResponse } from "../../shared/sync.ts";
import { formatInvoiceNumber } from "../../shared/invoice.ts";
import type { LocalDb } from "./db.ts";
import { api, ApiError } from "../api.ts";

export type SyncState = "idle" | "syncing" | "offline" | "error" | "auth";

export interface SyncStatus {
  state: SyncState;
  pending: number;
  lastSync?: string;
  message?: string;
  /** Modifications refusées par le serveur lors de la dernière passe. */
  rejected: { reason: string }[];
}

interface NumberBlock {
  series: string;
  start: number;
  end: number;
  next: number;
}

/** En dessous de ce stock de numéros, l'appareil en réserve d'autres. */
const LOW_NUMBERS = 10;
const PERIODIC_MS = 30_000;
const DEBOUNCE_MS = 1_500;

/** Série de l'année en cours pour un préfixe : FA (factures), AV (avoirs), DV (devis). */
export const seriesFor = (prefix: string, date = new Date()) => `${prefix}-${date.getFullYear()}`;
const PREFIXES = ["FA", "AV", "DV"];

export class SyncEngine {
  private db: LocalDb;
  private listeners = new Set<(s: SyncStatus) => void>();
  private running = false;
  private again = false;
  private timer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  status: SyncStatus = { state: "idle", pending: 0, rejected: [] };

  constructor(db: LocalDb) {
    this.db = db;
  }

  subscribe(fn: (s: SyncStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    this.listeners.forEach((l) => l(this.status));
  }

  start(): void {
    window.addEventListener("online", () => this.syncNow());
    window.addEventListener("offline", () => this.set({ state: "offline" }));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.syncNow();
    });
    this.db.onChange(() => {
      this.refreshPending();
      this.schedule();
    });
    this.interval = setInterval(() => this.syncNow(), PERIODIC_MS);
    this.refreshPending();
    this.syncNow();
  }

  stop(): void {
    clearInterval(this.interval);
    clearTimeout(this.timer);
  }

  private async refreshPending() {
    this.set({ pending: await this.db.pendingCount() });
  }

  /** Regroupe les écritures rapprochées en un seul envoi. */
  schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.syncNow(), DEBOUNCE_MS);
  }

  async syncNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    if (!navigator.onLine) {
      this.set({ state: "offline" });
      return;
    }
    this.running = true;
    this.set({ state: "syncing" });
    const rejected: { reason: string }[] = [];
    try {
      // Au plus 20 passes : 4 000 modifications envoyées, 10 000 reçues.
      for (let pass = 0; pass < 20; pass++) {
        const outbox = await this.db.outbox(MAX_PUSH);
        const since = (await this.db.getMeta<number>("cursor")) ?? 0;
        const body: SyncRequest = { changes: outbox, since };
        const res = await api<SyncResponse>("/api/sync", body);
        await this.db.applySyncResult({
          acknowledged: [...res.accepted, ...res.rejected.map((r) => r.id)],
          serverRecords: res.rejected.map((r) => {
            const sent = outbox.find((c) => c.id === r.id)!;
            return { tbl: sent.tbl, id: sent.row, record: r.record };
          }),
          remote: res.changes,
          cursor: res.cursor,
        });
        rejected.push(...res.rejected.map((r) => ({ reason: r.reason })));
        const remaining = await this.db.pendingCount();
        if (!res.more && (remaining === 0 || outbox.length === 0)) break;
      }
      await this.ensureNumbers();
      this.set({
        state: "idle",
        lastSync: new Date().toISOString(),
        message: undefined,
        rejected,
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        this.set({ state: "auth", message: e.message });
      } else if (e instanceof ApiError) {
        this.set({ state: "error", message: e.message });
      } else {
        // Échec réseau : on reste hors ligne, la file est intacte.
        this.set({ state: "offline", message: undefined });
      }
    } finally {
      this.running = false;
      await this.refreshPending();
      if (this.again) {
        this.again = false;
        this.schedule();
      }
    }
  }

  /** Stock de numéros de facture disponibles hors ligne pour la série en cours. */
  async availableNumbers(series = seriesFor("FA")): Promise<number> {
    const blocks = (await this.db.getMeta<NumberBlock[]>("numberBlocks")) ?? [];
    return blocks.filter((b) => b.series === series).reduce((n, b) => n + (b.end - b.next + 1), 0);
  }

  private async ensureNumbers(): Promise<void> {
    for (const prefix of PREFIXES) {
      const series = seriesFor(prefix);
      if ((await this.availableNumbers(series)) >= LOW_NUMBERS) continue;
      const block = await api<{ series: string; start: number; end: number }>("/api/numbers/reserve", { series });
      await withLock("numbers", async () => {
        const blocks = (await this.db.getMeta<NumberBlock[]>("numberBlocks")) ?? [];
        blocks.push({ ...block, next: block.start });
        await this.db.setMeta("numberBlocks", blocks);
      });
    }
  }

  /**
   * Prend le prochain numéro réservé par cet appareil pour une série (FA, AV, DV).
   * Fonctionne hors ligne ; null si l'appareil n'a plus de numéro en réserve.
   */
  async takeNumber(prefix: string): Promise<string | null> {
    const series = seriesFor(prefix);
    const n = await withLock("numbers", async () => {
      const blocks = (await this.db.getMeta<NumberBlock[]>("numberBlocks")) ?? [];
      const block = blocks.filter((b) => b.series === series && b.next <= b.end).sort((a, b) => a.start - b.start)[0];
      if (!block) return null;
      const value = block.next;
      block.next += 1;
      await this.db.setMeta("numberBlocks", blocks.filter((b) => b.next <= b.end));
      return value;
    });
    this.schedule();
    return n === null ? null : formatInvoiceNumber(series, n);
  }
}

/** Verrou partagé entre onglets : deux fenêtres ne prennent jamais le même numéro. */
async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (navigator as Navigator & { locks?: { request: (n: string, f: () => Promise<T>) => Promise<T> } }).locks;
  return locks ? locks.request(name, fn) : fn();
}
