"use client";

import type { ClientMessage, ServerMessage, LamportClock } from "@realtime-kanban/shared-types";
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
}

// Held while draining so two tabs sharing one IndexedDB never replay the same
// entry twice — the server's CREATE is not idempotent.
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
      this.listeners.forEach((listener) => listener(message));
    });

    socket.addEventListener("close", () => {
      this.socket = null;
      this.connected = false;
      this.interrupted = true;
      this.sentSince = []; // responses to this socket's requests will never arrive
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
    const entry: OutboxEntry = { message, written: Promise.resolve() };
    // Wait for the initial read so this write can't also show up in it.
    entry.written = this.loadPending()
      .then(() => this.queue.add(message))
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

  private async flush() {
    await this.reconcile();
    let replayed = 0;
    while (this.isOpen()) {
      const entry = this.outbox[0];
      if (!entry) break;
      await entry.written;
      if (!this.isOpen() || !this.rawSend(entry.message)) break;
      this.noteSent(entry.message);
      this.outbox = this.outbox.filter((e) => e !== entry);
      replayed += 1;
      this.publish();
      if (typeof entry.key === "number") await this.queue.remove(entry.key).catch(() => {});
    }
    // Replayed edits can lose to newer ones; the server never tells the loser.
    // One more sync hands back the authoritative result of the whole replay.
    if (replayed > 0 && this.isOpen()) this.requestSync();
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
   * sent after the matching SYNC_REQUEST, plus those still queued. The caller
   * re-applies them on top of the synced state so optimistic local edits
   * don't vanish on reconnect (the server never echoes a message to its sender).
   */
  takeUnsynced(): ClientMessage[] {
    const sent = this.sentSince.shift() ?? [];
    return [...sent, ...this.outbox.map((entry) => entry.message)];
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
