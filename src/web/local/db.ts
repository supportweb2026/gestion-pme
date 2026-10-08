/**
 * Base locale de l'appareil (IndexedDB) : toutes les données utiles y sont
 * copiées, l'application lit et écrit ici, jamais directement sur le serveur.
 *
 * Chaque écriture enregistre dans la même transaction :
 *   - le nouvel état de la ligne (fusion champ par champ),
 *   - la modification dans la file d'envoi (outbox).
 * Une coupure de courant ou de réseau ne peut donc pas perdre de modification.
 *
 * Si un code PIN est défini, lignes, file d'envoi, session et justificatifs
 * sont chiffrés (voir vault.ts). Le chiffrement étant asynchrone, il se fait
 * hors des transactions IndexedDB ; un verrou partagé entre onglets garantit
 * qu'aucune écriture ne s'intercale entre la lecture et l'enregistrement.
 */
import { HlcClock, type Hlc } from "../../shared/hlc.ts";
import { applyChange, DELETED, type Change, type Fields, type SyncRecord, type SyncTable } from "../../shared/sync.ts";
import { createVault, open, openBytes, openVault, seal, sealBytes, type LockInfo, type Sealed } from "./vault.ts";

const DB_NAME = "gestion-pme";
const DB_VERSION = 2;

/** Forme stockée d'une ligne : en clair, ou chiffrée (seuls table et identifiant restent lisibles). */
type StoredRecord = SyncRecord | { tbl: SyncTable; id: string; sealed: Sealed };
type StoredChange = Change | { id: string; hlc: Hlc; sealed: Sealed };
interface StoredFile {
  id: string;
  mime: string;
  uploaded: boolean;
  bytes?: ArrayBuffer;
  sealed?: Sealed;
}

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
    const o = indexedDB.open(DB_NAME, DB_VERSION);
    o.onupgradeneeded = (e) => {
      const db = o.result;
      if (e.oldVersion < 1) {
        const records = db.createObjectStore("records", { keyPath: ["tbl", "id"] });
        records.createIndex("tbl", "tbl");
        db.createObjectStore("outbox", { keyPath: "id" });
        db.createObjectStore("meta");
      }
      if (e.oldVersion < 2) db.createObjectStore("files", { keyPath: "id" });
    };
    o.onsuccess = () => resolve(o.result);
    o.onerror = () => reject(o.error);
  });
}

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

/** Verrou partagé entre onglets (Web Locks), sinon exécution directe. */
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (navigator as Navigator & { locks?: { request: (n: string, f: () => Promise<T>) => Promise<T> } }).locks;
  return locks ? locks.request("gestion-pme-db", fn) : fn();
}

const SECRET_META = new Set(["session"]);

type Listener = () => void;

export class LocalDb {
  private db: IDBDatabase;
  readonly clock: HlcClock;
  private listeners = new Set<Listener>();
  private channel?: BroadcastChannel;
  /** Clé de données, présente une fois le PIN saisi (si un PIN est défini). */
  private key: CryptoKey | null = null;

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

  get deviceId(): string {
    return this.clock.deviceId;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(broadcast = true): void {
    this.listeners.forEach((l) => l());
    if (broadcast) this.channel?.postMessage("changed");
  }

  // ---- Code PIN et chiffrement ----

  /** Vrai si un code PIN protège cet appareil. */
  async isProtected(): Promise<boolean> {
    return (await this.rawMeta<LockInfo>("lock")) !== undefined;
  }

  get unlocked(): boolean {
    return this.key !== null;
  }

  /** Déverrouille avec le PIN ; faux si le PIN est incorrect. */
  async unlock(pin: string): Promise<boolean> {
    const lock = await this.rawMeta<LockInfo>("lock");
    if (!lock) return true;
    try {
      this.key = await openVault(pin, lock);
      return true;
    } catch {
      return false;
    }
  }

  /** Active le PIN : toutes les données locales sont rechiffrées en une transaction. */
  async enablePin(pin: string): Promise<void> {
    await exclusive(async () => {
      if (await this.isProtected()) throw new Error("un code PIN est déjà défini");
      const snapshot = await this.snapshot();
      const { key, lock } = await createVault(pin);
      this.key = key;
      await this.rewrite(snapshot, lock);
    });
  }

  /** Retire le PIN (appareil déverrouillé) : les données redeviennent en clair. */
  async disablePin(): Promise<void> {
    await exclusive(async () => {
      if (!this.key) throw new Error("appareil verrouillé");
      const snapshot = await this.snapshot();
      this.key = null;
      await this.rewrite(snapshot, null);
    });
  }

  /** Lit et déchiffre tout le contenu de la base. */
  private async snapshot() {
    const tx = this.db.transaction(["records", "outbox", "files", "meta"]);
    const [records, outbox, files, session] = await Promise.all([
      req(tx.objectStore("records").getAll()) as Promise<StoredRecord[]>,
      req(tx.objectStore("outbox").getAll()) as Promise<StoredChange[]>,
      req(tx.objectStore("files").getAll()) as Promise<StoredFile[]>,
      req(tx.objectStore("meta").get("session")),
    ]);
    return {
      records: await Promise.all(records.map((r) => this.unpackRecord(r))),
      outbox: await Promise.all(outbox.map((c) => this.unpackChange(c))),
      files: await Promise.all(files.map(async (f) => ({ ...f, bytes: await this.fileBytes(f), sealed: undefined }))),
      session: await this.unpackSecret(session),
    };
  }

  /** Réécrit tout le contenu avec la clé courante (ou en clair), en une transaction. */
  private async rewrite(s: Awaited<ReturnType<LocalDb["snapshot"]>>, lock: LockInfo | null) {
    const records = await Promise.all(s.records.map((r) => this.packRecord(r)));
    const outbox = await Promise.all(s.outbox.map((c) => this.packChange(c)));
    const files = await Promise.all(s.files.map((f) => this.packFile(f.id, f.mime, f.uploaded, f.bytes!)));
    const session = s.session === undefined ? undefined : await this.packSecret(s.session);
    const tx = this.db.transaction(["records", "outbox", "files", "meta"], "readwrite");
    for (const name of ["records", "outbox", "files"]) tx.objectStore(name).clear();
    records.forEach((r) => tx.objectStore("records").put(r));
    outbox.forEach((c) => tx.objectStore("outbox").put(c));
    files.forEach((f) => tx.objectStore("files").put(f));
    const meta = tx.objectStore("meta");
    if (session !== undefined) meta.put(session, "session");
    if (lock) meta.put(lock, "lock");
    else meta.delete("lock");
    await done(tx);
  }

  private async packRecord(r: SyncRecord): Promise<StoredRecord> {
    return this.key ? { tbl: r.tbl, id: r.id, sealed: await seal(this.key, { data: r.data, clocks: r.clocks }) } : r;
  }

  private async unpackRecord(s: StoredRecord): Promise<SyncRecord> {
    if (!("sealed" in s)) return s;
    if (!this.key) throw new Error("appareil verrouillé");
    const { data, clocks } = await open<{ data: Fields; clocks: SyncRecord["clocks"] }>(this.key, s.sealed);
    return { tbl: s.tbl, id: s.id, data, clocks };
  }

  private async packChange(c: Change): Promise<StoredChange> {
    return this.key ? { id: c.id, hlc: c.hlc, sealed: await seal(this.key, c) } : c;
  }

  private async unpackChange(s: StoredChange): Promise<Change> {
    if (!("sealed" in s)) return s;
    if (!this.key) throw new Error("appareil verrouillé");
    return open<Change>(this.key, s.sealed);
  }

  private async packSecret(value: unknown): Promise<unknown> {
    return this.key && value !== undefined ? { sealed: await seal(this.key, value) } : value;
  }

  private async unpackSecret<T>(value: unknown): Promise<T | undefined> {
    if (value && typeof value === "object" && "sealed" in value) {
      if (!this.key) return undefined;
      return open<T>(this.key, (value as { sealed: Sealed }).sealed);
    }
    return value as T | undefined;
  }

  // ---- Réglages locaux ----

  private async rawMeta<T>(key: string): Promise<T | undefined> {
    return (await req(this.db.transaction("meta").objectStore("meta").get(key))) as T | undefined;
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    const v = await this.rawMeta<unknown>(key);
    return SECRET_META.has(key) ? this.unpackSecret<T>(v) : (v as T | undefined);
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const stored = SECRET_META.has(key) ? await this.packSecret(value) : value;
    const tx = this.db.transaction("meta", "readwrite");
    tx.objectStore("meta").put(stored, key);
    await done(tx);
  }

  // ---- Lignes ----

  async get(tbl: SyncTable, id: string): Promise<SyncRecord | null> {
    const s = (await req(this.db.transaction("records").objectStore("records").get([tbl, id]))) as StoredRecord | undefined;
    return s ? this.unpackRecord(s) : null;
  }

  /** Lignes d'une table, hors lignes supprimées. */
  async list(tbl: SyncTable): Promise<SyncRecord[]> {
    const all = (await req(this.db.transaction("records").objectStore("records").index("tbl").getAll(tbl))) as StoredRecord[];
    const rows = await Promise.all(all.map((r) => this.unpackRecord(r)));
    return rows.filter((r) => !r.data[DELETED]);
  }

  /** Écrit des champs sur une ligne (création si besoin) et met la modification en file d'envoi. */
  async write(tbl: SyncTable, id: string, patch: Fields): Promise<Change> {
    const change = await exclusive(async () => {
      const c: Change = { id: crypto.randomUUID(), tbl, row: id, patch, hlc: this.clock.tick(), device: this.deviceId };
      const existing = await this.get(tbl, id);
      const record = await this.packRecord(applyChange(existing, c).record);
      const queued = await this.packChange(c);
      const tx = this.db.transaction(["records", "outbox", "meta"], "readwrite");
      tx.objectStore("records").put(record);
      tx.objectStore("outbox").put(queued);
      tx.objectStore("meta").put(c.hlc, "hlc");
      await done(tx);
      return c;
    });
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
    const all = (await req(this.db.transaction("outbox").objectStore("outbox").getAll())) as StoredChange[];
    all.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
    return Promise.all(all.slice(0, limit).map((c) => this.unpackChange(c)));
  }

  async pendingCount(): Promise<number> {
    return req(this.db.transaction("outbox").objectStore("outbox").count());
  }

  /**
   * Applique la réponse du serveur : retire de la file ce qui est confirmé,
   * remplace les lignes refusées par la version du serveur, fusionne les
   * modifications des autres appareils et avance le curseur — le tout écrit
   * en une seule transaction.
   */
  async applySyncResult(input: {
    acknowledged: string[];
    serverRecords: { tbl: SyncTable; id: string; record: SyncRecord | null }[];
    remote: Change[];
    cursor: number;
  }): Promise<void> {
    await exclusive(async () => {
      const acked = new Set(input.acknowledged);
      const pending = (await this.outbox()).filter((c) => !acked.has(c.id));
      const key = (tbl: string, id: string) => `${tbl}\u0000${id}`;
      const rows = new Map<string, SyncRecord | null>();
      const load = async (tbl: SyncTable, id: string) => {
        const k = key(tbl, id);
        if (!rows.has(k)) rows.set(k, await this.get(tbl, id));
        return k;
      };
      // Lignes refusées : version du serveur, puis nos modifications encore en attente.
      for (const r of input.serverRecords) {
        let rec = r.record;
        for (const c of pending.filter((p) => p.tbl === r.tbl && p.row === r.id)) rec = applyChange(rec, c).record;
        rows.set(key(r.tbl, r.id), rec);
      }
      for (const c of input.remote) {
        this.clock.observe(c.hlc);
        const k = await load(c.tbl, c.row);
        rows.set(k, applyChange(rows.get(k) ?? null, c).record);
      }
      const packed = await Promise.all([...rows.entries()].map(async ([k, r]) => ({ k, r: r ? await this.packRecord(r) : null })));
      const tx = this.db.transaction(["records", "outbox", "meta"], "readwrite");
      const records = tx.objectStore("records");
      for (const id of acked) tx.objectStore("outbox").delete(id);
      for (const { k, r } of packed) {
        if (r) records.put(r);
        else records.delete(k.split("\u0000"));
      }
      tx.objectStore("meta").put(input.cursor, "cursor");
      tx.objectStore("meta").put(this.clock.current(), "hlc");
      await done(tx);
    });
    if (input.remote.length > 0 || input.serverRecords.length > 0) this.notify();
  }

  // ---- Justificatifs (photos, PDF) ----

  private async packFile(id: string, mime: string, uploaded: boolean, bytes: ArrayBuffer): Promise<StoredFile> {
    return this.key ? { id, mime, uploaded, sealed: await sealBytes(this.key, bytes) } : { id, mime, uploaded, bytes };
  }

  private async fileBytes(f: StoredFile): Promise<ArrayBuffer> {
    if (f.bytes) return f.bytes;
    if (!this.key || !f.sealed) throw new Error("appareil verrouillé");
    return openBytes(this.key, f.sealed);
  }

  async putFile(id: string, blob: Blob, uploaded: boolean): Promise<void> {
    const stored = await this.packFile(id, blob.type, uploaded, await blob.arrayBuffer());
    const tx = this.db.transaction("files", "readwrite");
    tx.objectStore("files").put(stored);
    await done(tx);
  }

  async getFile(id: string): Promise<Blob | null> {
    const f = (await req(this.db.transaction("files").objectStore("files").get(id))) as StoredFile | undefined;
    return f ? new Blob([await this.fileBytes(f)], { type: f.mime }) : null;
  }

  /** Justificatifs pris sur cet appareil et pas encore envoyés. */
  async pendingFiles(): Promise<string[]> {
    const all = (await req(this.db.transaction("files").objectStore("files").getAll())) as StoredFile[];
    return all.filter((f) => !f.uploaded).map((f) => f.id);
  }

  async markUploaded(id: string): Promise<void> {
    const tx = this.db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    const f = (await req(store.get(id))) as StoredFile | undefined;
    if (f) store.put({ ...f, uploaded: true });
    await done(tx);
  }

  // ---- Remises à zéro ----

  /**
   * Le rôle a changé : on vide la copie locale (sauf les modifications pas encore
   * envoyées) pour la recharger entièrement avec les données du nouveau rôle.
   */
  async resetForRole(role: string): Promise<void> {
    await exclusive(async () => {
      const tx = this.db.transaction(["records", "meta"], "readwrite");
      tx.objectStore("records").clear();
      tx.objectStore("meta").put(0, "cursor");
      tx.objectStore("meta").put(role, "role");
      await done(tx);
    });
    this.notify();
  }

  /** Efface toutes les données locales, PIN compris (déconnexion, révocation, PIN oublié). */
  async wipe(): Promise<void> {
    const deviceId = this.deviceId;
    await exclusive(async () => {
      const tx = this.db.transaction(["records", "outbox", "files", "meta"], "readwrite");
      for (const name of ["records", "outbox", "files", "meta"]) tx.objectStore(name).clear();
      tx.objectStore("meta").put(deviceId, "deviceId");
      await done(tx);
    });
    this.key = null;
    this.notify();
  }
}
