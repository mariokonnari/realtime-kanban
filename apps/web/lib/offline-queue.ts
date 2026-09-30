import type { ClientMessage } from "@realtime-kanban/shared-types";

// Only messages that change shared state are worth holding across a
// disconnect. SYNC_REQUEST is re-sent fresh on every connect, and PRESENCE is
// a live "who's editing what" hint that's meaningless once stale.
export type DurableMessage = Extract<ClientMessage, { type: "MUTATE" | "CREATE" | "DELETE" | "CRDT_UPDATE" }>;

export function isDurable(message: ClientMessage): message is DurableMessage {
  return (
    message.type === "MUTATE" ||
    message.type === "CREATE" ||
    message.type === "DELETE" ||
    message.type === "CRDT_UPDATE"
  );
}

export interface QueueEntry {
  key: number;
  message: DurableMessage;
}

const STORE = "outbox";

/**
 * Durable FIFO of outbound messages, backed by an IndexedDB object store with
 * an auto-incrementing key: keys only ever grow, so a cursor walk returns
 * entries in insertion order, including entries written by a previous page
 * load. Every method rejects if IndexedDB is unavailable (private mode,
 * blocked storage, SSR) — callers decide how to degrade.
 */
export class OfflineQueue {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory | undefined = globalThis.indexedDB,
    private readonly dbName = "realtime-kanban-offline",
  ) {}

  private open(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new Error("IndexedDB is not available"));
    this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory!.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { autoIncrement: true });
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab upgrading/deleting the database must not be blocked by us.
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      this.dbPromise = null; // let the next call retry instead of caching the failure
      throw error;
    });
    return this.dbPromise;
  }

  /** Appends a message. Resolves with its key once the write has committed. */
  async add(message: DurableMessage): Promise<number> {
    const db = await this.open();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const request = tx.objectStore(STORE).add(message);
      tx.oncomplete = () => resolve(request.result as number);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /** Every queued entry, oldest first, read via a cursor. */
  async readAll(): Promise<QueueEntry[]> {
    const db = await this.open();
    return new Promise<QueueEntry[]>((resolve, reject) => {
      const entries: QueueEntry[] = [];
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        entries.push({ key: cursor.key as number, message: cursor.value as DurableMessage });
        cursor.continue();
      };
      tx.oncomplete = () => resolve(entries);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /** Removes one entry. Removing a key that's already gone is a no-op. */
  async remove(key: number): Promise<void> {
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /** Releases the connection (used by tests to simulate a page unload). */
  async close(): Promise<void> {
    const pending = this.dbPromise;
    this.dbPromise = null;
    if (pending) (await pending.catch(() => null))?.close();
  }
}
