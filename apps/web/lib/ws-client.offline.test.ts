import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { ClientMessage } from "@realtime-kanban/shared-types";
import { OfflineQueue, type DurableMessage } from "./offline-queue";
import { WsClient, nextClock } from "./ws-client";

// Stands in for the browser WebSocket: tests decide when it opens and
// closes, and inspect exactly what was written to it.
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: ClientMessage[] = [];
  private listeners: Record<string, Array<(event: unknown) => void>> = {};

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(listener);
  }

  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(JSON.parse(data));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  private emit(type: string, event: unknown) {
    (this.listeners[type] ?? []).forEach((listener) => listener(event));
  }
}

function mutate(value: string, lamport = 1): DurableMessage {
  return {
    type: "MUTATE",
    entityType: "card",
    entityId: "card-1",
    field: "title",
    value,
    clock: { lamport, clientId: "client-a" },
  };
}

function create(entityId: string): DurableMessage {
  return {
    type: "CREATE",
    entityType: "card",
    entityId,
    initialValues: { title: entityId },
    clock: { lamport: 1, clientId: "client-a" },
  };
}

const types = (socket: FakeWebSocket) => socket.sent.map((m) => m.type);
const values = (socket: FakeWebSocket) =>
  socket.sent.filter((m) => m.type === "MUTATE").map((m) => (m as { value: string }).value);

let factory: IDBFactory;
let clients: WsClient[];

// A fresh page load: new WsClient, reading the same IndexedDB as before.
function newClient() {
  const client = new WsClient(new OfflineQueue(factory));
  clients.push(client);
  return client;
}

async function connectedSocket(client: WsClient) {
  client.connect();
  await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

beforeEach(() => {
  factory = new IDBFactory();
  clients = [];
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  // Only the reconnect timer; fake-indexeddb schedules with setImmediate.
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("WsClient offline queue", () => {
  test("a message queued while the socket is closed persists across a simulated reload", async () => {
    const client = newClient();
    client.send(create("card-a"));
    client.send(mutate("typed offline"));

    // Not the in-memory array: a brand-new reader of the database sees them.
    const reader = new OfflineQueue(factory);
    await vi.waitFor(async () => expect(await reader.readAll()).toHaveLength(2));
    const stored = await reader.readAll();
    expect(stored.map((e) => e.message)).toEqual([create("card-a"), mutate("typed offline")]);
    expect(client.getStatus().pending).toBe(2);
  });

  test("replays in insertion order, after SYNC_REQUEST, and clears each entry as it goes", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    client.send(create("card-a"));
    client.send(mutate("one", 2));
    client.send(mutate("two", 3));
    client.send({ type: "CRDT_UPDATE", columnId: "col-1", update: "AAA=" });
    expect(socket.sent).toEqual([]); // nothing reaches a socket that isn't open yet

    socket.open();
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));

    // Original messages verbatim — clocks are not re-stamped at replay time.
    expect(socket.sent.slice(0, 5)).toEqual([
      { type: "SYNC_REQUEST" },
      create("card-a"),
      mutate("one", 2),
      mutate("two", 3),
      { type: "CRDT_UPDATE", columnId: "col-1", update: "AAA=" },
    ]);
    expect(await new OfflineQueue(factory).readAll()).toEqual([]);
  });

  test("a previous session's leftovers replay on the next load, before anything new", async () => {
    const leftover = new OfflineQueue(factory);
    await leftover.add(create("card-old"));
    await leftover.add(mutate("from last session", 4));
    await leftover.close();

    const client = newClient();
    const socket = await connectedSocket(client);
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(2)); // visible before connecting
    client.send(mutate("new this session", 5));

    socket.open();
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));

    expect(types(socket).slice(0, 2)).toEqual(["SYNC_REQUEST", "CREATE"]);
    expect(values(socket)).toEqual(["from last session", "new this session"]);
    expect(await new OfflineQueue(factory).readAll()).toEqual([]);
  });

  test("a live message never overtakes one still queued", async () => {
    const leftover = new OfflineQueue(factory);
    await leftover.add(create("card-a"));
    await leftover.close();

    const client = newClient();
    const socket = await connectedSocket(client);
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(1));

    socket.open();
    client.send(mutate("depends on the CREATE")); // lands mid-drain
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));

    expect(socket.sent.filter((m) => m.type === "CREATE" || m.type === "MUTATE").map((m) => m.type)).toEqual([
      "CREATE",
      "MUTATE",
    ]);
  });

  test("with nothing queued and the socket open, messages go straight out and never touch IndexedDB", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    socket.open();
    await vi.waitFor(() => expect(client.getStatus().connected).toBe(true));

    client.send(mutate("live"));

    expect(values(socket)).toEqual(["live"]);
    expect(await new OfflineQueue(factory).readAll()).toEqual([]);
    expect(client.getStatus().pending).toBe(0);
  });

  test("SYNC_REQUEST is never queued, and PRESENCE is held in memory only", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    client.send({ type: "SYNC_REQUEST" });
    client.send({ type: "PRESENCE", clientId: "a", name: "Otter", color: "#fff", cardId: null });

    expect(await new OfflineQueue(factory).readAll()).toEqual([]);
    expect(client.getStatus().pending).toBe(0);

    socket.open();
    await vi.waitFor(() => expect(types(socket)).toContain("PRESENCE"));
    // Exactly the one fresh SYNC_REQUEST from connecting, then the presence announcement.
    expect(types(socket)).toEqual(["SYNC_REQUEST", "PRESENCE"]);
  });

  test("a dropped connection queues new edits and reports offline; reconnecting drains and reports back online", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    socket.open();
    await vi.waitFor(() => expect(client.getStatus().connected).toBe(true));
    expect(client.getStatus()).toEqual({ connected: true, pending: 0, interrupted: false });

    socket.drop();
    client.send(mutate("while offline", 2));
    expect(client.getStatus()).toEqual({ connected: false, pending: 1, interrupted: true });

    vi.advanceTimersByTime(1000); // the client's reconnect delay
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const second = FakeWebSocket.instances[1];
    second.open();
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));

    expect(values(second)).toEqual(["while offline"]);
    expect(client.getStatus()).toEqual({ connected: true, pending: 0, interrupted: false });
  });

  test("after replaying, asks for one more sync so edits that lost on the server get corrected", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    client.send(mutate("offline edit", 2));
    socket.open();
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));
    await vi.waitFor(() => expect(types(socket).filter((t) => t === "SYNC_REQUEST")).toHaveLength(2));

    expect(types(socket)).toEqual(["SYNC_REQUEST", "MUTATE", "SYNC_REQUEST"]);
  });

  test("takeUnsynced returns messages the SYNC_RESPONSE can't include: still queued, or sent after the request", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    client.send(create("card-a"));
    socket.open();
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));
    client.send(mutate("live after request"));

    // First response answers the first SYNC_REQUEST: both messages came after it.
    expect(client.takeUnsynced()).toEqual([create("card-a"), mutate("live after request")]);
  });

  test("a clock restored from the queue pushes new edits above it, so they can't lose to the replayed one", async () => {
    const leftover = new OfflineQueue(factory);
    await leftover.add(mutate("old session", 40));
    await leftover.close();

    const client = newClient();
    await connectedSocket(client);
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(1));

    expect(nextClock().lamport).toBeGreaterThan(40);
  });

  test("without IndexedDB it degrades to an in-memory queue and still replays", async () => {
    const client = new WsClient(new OfflineQueue(undefined));
    clients.push(client);
    const socket = await connectedSocket(client);
    client.send(mutate("memory only"));
    expect(client.getStatus().pending).toBe(1);

    socket.open();
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));
    expect(values(socket)).toEqual(["memory only"]);
  });
});
