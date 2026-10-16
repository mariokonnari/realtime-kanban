"use client";

import type { AckMessage, ClientMessage, ServerMessage, LamportClock } from "@realtime-kanban/shared-types";
import { OfflineQueue, isDurable, type DurableMessage, type QueueEntry } from "./offline-queue";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4001";

// Stable per-tab identity for the lifetime of the page. A real deployment
// would persist this in sessionStorage so a refresh doesn't reset it —
// left as module state for now since the demo doesn't depend on it
// surviving a reload.
const clientId = crypto.randomUUID();
let lamport = 0;

export function nextClock(): LamportClock {
  lamport += 1;
  return { lamport, clientId };
}

// Queued messages outlive the page, but `lamport` restarts at 0 on every
// load. Without this, an edit made after a reload would stamp a *lower*
// clock than an already-queued edit to the same field and lose to it on
// replay. Only ever moves the counter forward.
export function observeClock(seen: number) {
  if (seen > lamport) lamport = seen;
}

function observeServerClocks(message: ServerMessage) {
  if (message.type === "SYNC_RESPONSE") {
    for (const clock of Object.values(message.fieldClocks ?? {})) observeClock(clock.lamport);
  } else if ("clock" in message) {
    observeClock(message.clock.lamport);
  }
}

export function getClientId() {
  return clientId;
}

// No real auth: just enough that two open tabs are visually
// distinguishable in a demo. Picked once per tab, same lifetime as
// clientId above.
const PRESENCE_NAMES = [
  "Otter", "Falcon", "Lynx", "Panda", "Heron", "Fox", "Wren", "Orca",
  "Ibis", "Newt", "Puffin", "Badger", "Mantis", "Gecko", "Raven", "Stoat",
];
const PRESENCE_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
];

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

export const presenceIdentity = { name: pick(PRESENCE_NAMES), color: pick(PRESENCE_COLORS) };

type Listener = (message: ServerMessage) => void;

export interface ConnectionStatus {
  connected: boolean;
  // Durable messages not yet handed to an open socket (queued in IndexedDB).
  pending: number;
  // True from the moment a connection drops or fails until the next one opens —
  // distinguishes "never connected yet" (page just loaded) from "offline".
  interrupted: boolean;
}

// In-memory mirror of one OfflineQueue row. `key` is undefined while the
// IndexedDB write is in flight and null if it failed (no IndexedDB): such an
// entry still replays this session, it just won't survive a reload.
interface OutboxEntry {
  message: DurableMessage;
  key?: number | null;
  written: Promise<void>; // settles (never rejects) once `key` is known
  // The socket this entry was sent on and has not been ACKed on yet. An entry
  // leaves the outbox (and IndexedDB) when the server ACKs its messageId, not
  // when it is sent; if the socket closes first this is cleared and the entry
  // is sent again on the next one, with the same messageId.
  awaitingAck?: WebSocket;
}

// Held for the whole of a drain — until every entry that drain sent has been
// ACKed or the socket has closed — so two tabs sharing one IndexedDB never
// send the same entry at once. See flush().
const DRAIN_LOCK = "realtime-kanban-offline-drain";

export class WsClient {
  private socket: WebSocket | null = null;
  private connecting = false;
  private connected = false;
  private interrupted = false;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<() => void>();
  private status: ConnectionStatus = { connected: false, pending: 0, interrupted: false };

  // PRESENCE only: ephemeral, memory-only, sent on open (never persisted).
  private volatile: ClientMessage[] = [];
  // Every queued durable message, oldest first. Mirrors the IndexedDB store.
  private outbox: OutboxEntry[] = [];
  private loading: Promise<void> | null = null;
  private loaded = false;
  private draining = false;
  // One bucket per in-flight SYNC_REQUEST: durable messages sent after that
  // request. The server handles a socket's messages in order, so its
  // SYNC_RESPONSE cannot include them — see takeUnsynced().
  private sentSince: DurableMessage[][] = [];
  // Resolvers for flush() while it waits on ACKs: woken by an ACK, a close, or a new entry.
  private progressWaiters: Array<() => void> = [];
  // Whether the server on the CURRENT socket ACKs messages. Assumed true until
  // that socket's first SYNC_RESPONSE says otherwise; decided once per socket
  // (later responses never flip it) and reset whenever a socket opens or closes.
  private serverAcks = true;
  private acksDecided = false;

  constructor(private readonly queue = new OfflineQueue()) {}

  connect() {
    if (this.socket || this.connecting) return;
    this.connecting = true;
    // Read whatever a previous session left behind before opening the
    // socket, so it replays on open like anything queued live.
    void this.loadPending().then(() => {
      this.connecting = false;
      this.openSocket();
    });
  }

  private openSocket() {
    const socket = new WebSocket(WS_URL);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.connected = true;
      this.interrupted = false;
      this.sentSince = [];
      this.resetAckSupport();
      // Sync first, so local Yjs docs merge the server's current state
      // before pending local ops replay on top of it.
      this.requestSync();
      const volatile = this.volatile;
      this.volatile = [];
      volatile.forEach((message) => this.rawSend(message));
      this.publish();
      // Nothing queued (the initial read already ran): stay on the direct
      // path instead of routing the first live edits through the drain.
      if (this.outbox.length > 0) void this.drain();
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as ServerMessage;
      if (message.type === "ACK") {
        this.handleAck(message); // transport bookkeeping, not board state: listeners never see it
        return;
      }
      // Decided before any listener runs, so takeUnsynced() (called from the
      // SYNC_RESPONSE listener) already sees the entries this may discard.
      if (message.type === "SYNC_RESPONSE") this.decideAckSupport(message.acks === true);
      // Any clock we see, ours must end up above: otherwise an edit made
      // after seeing someone else's would stamp a lower clock and lose to it.
      observeServerClocks(message);
      this.listeners.forEach((listener) => listener(message));
    });

    socket.addEventListener("close", () => {
      this.socket = null;
      this.connected = false;
      this.interrupted = true;
      this.sentSince = []; // responses to this socket's requests will never arrive
      for (const entry of this.outbox) entry.awaitingAck = undefined; // unACKed: replay on the next socket
      this.resetAckSupport();
      this.notifyProgress();
      this.publish();
      // Naive fixed-delay reconnect, no exponential backoff yet —
      // acceptable for a demo, a real gap for production.
      setTimeout(() => this.connect(), 1000);
    });
  }

  private isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private rawSend(message: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private requestSync() {
    this.sentSince.push([]);
    this.rawSend({ type: "SYNC_REQUEST" });
  }

  private noteSent(message: DurableMessage) {
    for (const bucket of this.sentSince) bucket.push(message);
  }

  send(message: ClientMessage) {
    if (!isDurable(message)) {
      // SYNC_REQUEST is re-sent on every connect, so it is never queued.
      if (message.type === "SYNC_REQUEST") this.rawSend(message);
      else if (!this.rawSend(message)) this.volatile.push(message);
      return;
    }
    // Send straight through only when nothing older is waiting: a live
    // message must never overtake a queued one (a MUTATE arriving before
    // the CREATE it depends on is dropped by the server).
    if (this.loaded && !this.draining && this.outbox.length === 0 && this.rawSend(message)) {
      this.noteSent(message);
      return;
    }
    this.enqueue(message);
    if (this.isOpen()) void this.drain();
  }

  private enqueue(message: DurableMessage) {
    // The id is made once, here, and stored with the entry: a replay after a
    // reconnect or a reload reuses it, which is what lets the server tell a
    // replay from a new message.
    const queued: DurableMessage = message.messageId ? message : { ...message, messageId: crypto.randomUUID() };
    const entry: OutboxEntry = { message: queued, written: Promise.resolve() };
    // Wait for the initial read so this write can't also show up in it.
    entry.written = this.loadPending()
      .then(() => this.queue.add(queued))
      .then(
        (key) => {
          entry.key = key;
        },
        () => {
          entry.key = null;
        },
      );
    this.outbox.push(entry);
    this.publish();
    this.notifyProgress();
  }

  private loadPending(): Promise<void> {
    this.loading ??= this.queue
      .readAll()
      .then(
        (entries) => {
          for (const { message } of entries) {
            if ("clock" in message) observeClock(message.clock.lamport);
          }
          const stored = entries.map(({ key, message }): OutboxEntry => ({ message, key, written: Promise.resolve() }));
          this.outbox = [...stored, ...this.outbox]; // earlier sessions' messages go first
        },
        () => {
          // No IndexedDB: degrade to an in-memory queue for this session.
        },
      )
      .then(() => {
        this.loaded = true;
        this.publish();
      });
    return this.loading;
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    let completed = false;
    try {
      await this.withDrainLock(() => this.flush());
      completed = true;
    } catch (error) {
      console.error("offline queue drain failed", error);
    } finally {
      this.draining = false;
    }
    // A send() that landed while the lock was being released saw `draining`
    // and queued instead of sending; pick it up rather than strand it.
    if (completed && this.isOpen() && this.outbox.length > 0) void this.drain();
  }

  private async withDrainLock(fn: () => Promise<void>): Promise<void> {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (locks) await locks.request(DRAIN_LOCK, fn);
    else await fn();
  }

  /**
   * Sends every entry not yet sent on this socket, then holds the drain lock
   * until all of them are ACKed (or the socket closes).
   *
   * Why hold the lock rather than mark entries "in flight" in IndexedDB: the
   * lock is released by the browser the moment this tab dies, so a crashed or
   * closed tab can never leave an entry stuck as "somebody else's"; a marker
   * would need a lease and a clock to expire it. The cost is that another tab
   * can't drain while this one waits on ACKs — normally one round trip.
   * If this socket closes with entries unACKed, the lock is released and
   * whichever tab drains next (re)sends them; the server's handlers are
   * idempotent, so that is safe.
   */
  private async flush() {
    await this.reconcile();
    let sent = 0;
    for (;;) {
      for (const entry of [...this.outbox]) {
        if (!this.isOpen()) break;
        if (this.isAwaiting(entry)) continue;
        await entry.written;
        if (!this.isOpen() || !this.rawSend(entry.message)) break;
        this.noteSent(entry.message);
        sent += 1;
        if (entry.message.messageId === undefined || !this.serverAcks) {
          // No ACK will ever come — the entry was written by an older client,
          // or this socket's server doesn't ACK — so keep the old behavior and
          // drop it as soon as it is sent.
          this.outbox = this.outbox.filter((e) => e !== entry);
          this.publish();
          if (typeof entry.key === "number") await this.queue.remove(entry.key).catch(() => {});
        } else {
          entry.awaitingAck = this.socket ?? undefined;
        }
      }
      if (!this.isOpen() || !this.outbox.some((e) => this.isAwaiting(e))) break;
      await this.progress();
    }
    // Replayed edits can lose to newer ones. One more sync hands back the
    // authoritative result of the whole replay (it runs after the ACKs, so the
    // server has handled everything it covers).
    if (sent > 0 && this.isOpen()) this.requestSync();
  }

  private isAwaiting(entry: OutboxEntry) {
    return entry.awaitingAck !== undefined && entry.awaitingAck === this.socket;
  }

  private progress(): Promise<void> {
    return new Promise((resolve) => this.progressWaiters.push(resolve));
  }

  private notifyProgress() {
    const waiters = this.progressWaiters;
    this.progressWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  // The server has dealt with this message (applied, rejected, or recognized
  // it as a duplicate) — or, with `error`, can never accept it. Either way
  // there is nothing left to replay.
  private handleAck(ack: AckMessage) {
    const entry = this.outbox.find((e) => e.message.messageId === ack.messageId);
    if (!entry) return; // already gone: a repeated ACK
    if (ack.error) console.error(`server refused queued ${entry.message.type} for good (${ack.error}); dropping it`);
    this.discard([entry]);
  }

  private resetAckSupport() {
    this.serverAcks = true;
    this.acksDecided = false;
  }

  // Called with the first SYNC_RESPONSE on a socket. The server handles a
  // socket's messages in order and answers SYNC_REQUEST synchronously, while
  // an ACK always waits on at least a microtask, so the response is guaranteed
  // to arrive before any ACK: if it carries no `acks` flag, this server will
  // never ACK, and waiting for one would hold the drain lock and keep the
  // entries "pending" forever.
  private decideAckSupport(supported: boolean) {
    if (this.acksDecided) return;
    this.acksDecided = true;
    if (supported) return;
    this.serverAcks = false;
    // What was already sent on this socket counts as delivered, like it did
    // before ACKs existed. Discarding wakes flush(), which then releases the lock.
    this.discard(this.outbox.filter((entry) => this.isAwaiting(entry)));
  }

  // Removes entries from the outbox and, once their write has landed, from IndexedDB.
  private discard(entries: OutboxEntry[]) {
    if (entries.length === 0) return;
    this.outbox = this.outbox.filter((e) => !entries.includes(e));
    this.publish();
    this.notifyProgress();
    // If a delete is lost (tab closes first) the entry just replays once more.
    for (const entry of entries) {
      void entry.written.then(() =>
        typeof entry.key === "number" ? this.queue.remove(entry.key).catch(() => {}) : undefined,
      );
    }
  }

  // Re-reads the store (cursor, insertion order) under the drain lock: another
  // tab may have sent some of these since we last looked, and may have queued
  // rows we've never seen. Keyed so entries we already hold keep their identity.
  private async reconcile() {
    await Promise.all(this.outbox.map((entry) => entry.written));
    const known = new Set(this.outbox.flatMap((e) => (typeof e.key === "number" ? [e.key] : [])));
    let stored: QueueEntry[];
    try {
      stored = await this.queue.readAll();
    } catch {
      return; // store unreadable: trust the in-memory mirror
    }
    const byKey = new Map(this.outbox.flatMap((e) => (typeof e.key === "number" ? [[e.key, e] as const] : [])));
    const storedKeys = new Set(stored.map((s) => s.key));
    const fromStore = stored.map(
      (s): OutboxEntry => byKey.get(s.key) ?? { message: s.message, key: s.key, written: Promise.resolve() },
    );
    // Not in `stored` by definition: writes that started or committed after the read.
    const newer = this.outbox.filter(
      (e) => typeof e.key !== "number" || (!known.has(e.key) && !storedKeys.has(e.key)),
    );
    this.outbox = [...fromStore, ...newer];
    this.publish();
  }

  /**
   * Durable messages the server's latest SYNC_RESPONSE does not reflect: those
   * sent after the matching SYNC_REQUEST, plus those still queued. (Entries
   * sent earlier on this socket and awaiting their ACK are already in the
   * response — the server handles a socket's messages in order — so they are
   * not repeated here; re-applying a CREATE would clobber later edits.) The caller
   * re-applies them on top of the synced state so optimistic local edits
   * don't vanish on reconnect (the server never echoes a message to its sender).
   */
  takeUnsynced(): ClientMessage[] {
    const sent = this.sentSince.shift() ?? [];
    const queued = this.outbox.filter((entry) => !this.isAwaiting(entry)).map((entry) => entry.message);
    return [...sent, ...queued];
  }

  private publish() {
    const { connected, interrupted } = this;
    const pending = this.outbox.length;
    if (
      this.status.connected === connected &&
      this.status.pending === pending &&
      this.status.interrupted === interrupted
    ) {
      return;
    }
    this.status = { connected, pending, interrupted };
    this.statusListeners.forEach((listener) => listener());
  }

  getStatus = () => this.status;

  subscribeStatus = (listener: () => void) => {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  };

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const wsClient = new WsClient();
