/**
 * Base locale de l'appareil (IndexedDB) : toutes les données utiles y sont
 * copiées, l'application lit et écrit ici, jamais directement sur le serveur.
 *
 * Chaque écriture enregistre dans la même transaction :
 *   - le nouvel état de la ligne (fusion champ par champ),
 *   - la modification dans la file d'envoi (outbox).
 * Une coupure de courant ou de réseau ne peut donc pas perdre de modification.
 */
import { HlcClock, type Hlc } from "../../shared/hlc.ts";
import { applyChange, DELETED, type Change, type Fields, type SyncRecord, type SyncTable } from "../../shared/sync.ts";

const DB_NAME = "gestion-pme";
const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction annulée"));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      const records = db.createObjectStore("records", { keyPath: ["tbl", "id"] });
      records.createIndex("tbl", "tbl");
      db.createObjectStore("outbox", { keyPath: "id" });
      db.createObjectStore("meta");
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

type Listener = () => void;

export class LocalDb {
  private db: IDBDatabase;
  readonly clock: HlcClock;
  private listeners = new Set<Listener>();

  private constructor(db: IDBDatabase, clock: HlcClock) {
    this.db = db;
    this.clock = clock;
  }

  static async open(): Promise<LocalDb> {
    const db = await openDb();
    const tx = db.transaction("meta", "readwrite");
    const meta = tx.objectStore("meta");
    let deviceId = (await req(meta.get("deviceId"))) as string | undefined;
    if (!deviceId) {
      deviceId = `dev-${randomId()}`;
      meta.put(deviceId, "deviceId");
    }
    const lastHlc = (await req(meta.get("hlc"))) as Hlc | undefined;
    await done(tx);
    const local = new LocalDb(db, new HlcClock(deviceId, Date.now, lastHlc));
    // Une autre fenêtre de l'application a écrit : on rafraîchit l'affichage.
    if ("BroadcastChannel" in self) {
      const channel = new BroadcastChannel("gestion-pme-data");
      channel.onmessage = () => local.listeners.forEach((l) => l());
      local.channel = channel;
    }
    return local;
  }

  private channel?: BroadcastChannel;

  get deviceId(): string {
    return this.clock.deviceId;
  }

  /** Prévient l'interface (et les autres onglets) que les données ont changé. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(broadcast = true): void {
    this.listeners.forEach((l) => l());
    if (broadcast) this.channel?.postMessage("changed");
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await req(this.db.transaction("meta").objectStore("meta").get(key))) as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction("meta", "readwrite");
    tx.objectStore("meta").put(value, key);
    await done(tx);
  }

  async get(tbl: SyncTable, id: string): Promise<SyncRecord | null> {
    return ((await req(this.db.transaction("records").objectStore("records").get([tbl, id]))) as SyncRecord) ?? null;
  }

  /** Lignes d'une table, hors lignes supprimées. */
  async list(tbl: SyncTable): Promise<SyncRecord[]> {
    const all = (await req(this.db.transaction("records").objectStore("records").index("tbl").getAll(tbl))) as SyncRecord[];
    return all.filter((r) => !r.data[DELETED]);
  }

  /** Écrit des champs sur une ligne (création si besoin) et met la modification en file d'envoi. */
  async write(tbl: SyncTable, id: string, patch: Fields): Promise<Change> {
    const change: Change = { id: crypto.randomUUID(), tbl, row: id, patch, hlc: this.clock.tick(), device: this.deviceId };
    const tx = this.db.transaction(["records", "outbox", "meta"], "readwrite");
    const records = tx.objectStore("records");
    const existing = ((await req(records.get([tbl, id]))) as SyncRecord) ?? null;
    records.put(applyChange(existing, change).record);
    tx.objectStore("outbox").put(change);
    tx.objectStore("meta").put(change.hlc, "hlc");
    await done(tx);
    this.notify();
    return change;
  }

  async remove(tbl: SyncTable, id: string): Promise<void> {
    await this.write(tbl, id, { [DELETED]: true });
  }

  newId(prefix: string): string {
    return `${prefix}-${randomId()}`;
  }

  /** Modifications en attente d'envoi, dans l'ordre où elles ont été faites. */
  async outbox(limit = Infinity): Promise<Change[]> {
    const all = (await req(this.db.transaction("outbox").objectStore("outbox").getAll())) as Change[];
    all.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
    return all.slice(0, limit);
  }

  async pendingCount(): Promise<number> {
    return req(this.db.transaction("outbox").objectStore("outbox").count());
  }

  /**
   * Applique la réponse du serveur en une transaction : retire de la file ce
   * qui est confirmé, remplace les lignes refusées par la version du serveur,
   * fusionne les modifications des autres appareils et avance le curseur.
   */
  async applySyncResult(input: {
    acknowledged: string[];
    serverRecords: { tbl: SyncTable; id: string; record: SyncRecord | null }[];
    remote: Change[];
    cursor: number;
  }): Promise<void> {
    const tx = this.db.transaction(["records", "outbox", "meta"], "readwrite");
    const records = tx.objectStore("records");
    const outbox = tx.objectStore("outbox");
    for (const id of input.acknowledged) outbox.delete(id);
    for (const r of input.serverRecords) {
      if (r.record) records.put(r.record);
      else records.delete([r.tbl, r.id]);
    }
    for (const c of input.remote) {
      this.clock.observe(c.hlc);
      const existing = ((await req(records.get([c.tbl, c.row]))) as SyncRecord) ?? null;
      records.put(applyChange(existing, c).record);
    }
    // Les modifications locales encore en file restent prioritaires si plus récentes :
    // on les réapplique par-dessus l'état du serveur pour les lignes remplacées.
    if (input.serverRecords.length > 0) {
      const pending = (await req(outbox.getAll())) as Change[];
      for (const r of input.serverRecords) {
        let rec = r.record;
        for (const c of pending.filter((p) => p.tbl === r.tbl && p.row === r.id)) rec = applyChange(rec, c).record;
        if (rec) records.put(rec);
      }
    }
    const meta = tx.objectStore("meta");
    meta.put(input.cursor, "cursor");
    meta.put(this.clock.current(), "hlc");
    await done(tx);
    if (input.remote.length > 0 || input.serverRecords.length > 0) this.notify();
  }

  /** Efface toutes les données locales (déconnexion, appareil révoqué). */
  async wipe(): Promise<void> {
    const deviceId = this.deviceId;
    const tx = this.db.transaction(["records", "outbox", "meta"], "readwrite");
    tx.objectStore("records").clear();
    tx.objectStore("outbox").clear();
    tx.objectStore("meta").clear();
    tx.objectStore("meta").put(deviceId, "deviceId");
    await done(tx);
    this.notify();
  }
}
