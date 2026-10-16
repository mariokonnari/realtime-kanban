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

  /** Delivers a frame from the server. */
  receive(message: unknown) {
    this.emit("message", { data: JSON.stringify(message) });
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

// What a queued message looks like once the client has stamped its messageId.
const withId = (message: DurableMessage, messageId: unknown = expect.any(String)) => ({ ...message, messageId });

const types = (socket: FakeWebSocket) => socket.sent.map((m) => m.type);
const values = (socket: FakeWebSocket) =>
  socket.sent.filter((m) => m.type === "MUTATE").map((m) => (m as { value: string }).value);
const durable = (socket: FakeWebSocket) =>
  socket.sent.filter((m): m is DurableMessage => m.type !== "SYNC_REQUEST" && m.type !== "PRESENCE");
const idsSent = (socket: FakeWebSocket) => durable(socket).map((m) => m.messageId);

/** Plays the server: ACKs every durable message on `socket` that carries a messageId. */
async function ackAll(socket: FakeWebSocket, expectedCount?: number) {
  if (expectedCount !== undefined) await vi.waitFor(() => expect(durable(socket)).toHaveLength(expectedCount));
  for (const message of durable(socket)) {
    if (message.messageId) socket.receive({ type: "ACK", messageId: message.messageId });
  }
}

/** Lets every pending IndexedDB / microtask step run (fake-indexeddb schedules with setImmediate). */
async function settle() {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

let factory: IDBFactory;
let clients: WsClient[];

const storedMessages = async () => (await new OfflineQueue(factory).readAll()).map((entry) => entry.message);

// A fresh page load: new WsClient, reading the same IndexedDB as before.
function newClient() {
  const client = new WsClient(new OfflineQueue(factory));
  clients.push(client);
  return client;
}

async function connectedSocket(client: WsClient) {
  const before = FakeWebSocket.instances.length;
  client.connect();
  await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(before));
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
  vi.restoreAllMocks();
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
    expect(stored.map((e) => e.message)).toEqual([withId(create("card-a")), withId(mutate("typed offline"))]);
    expect(client.getStatus().pending).toBe(2);
  });

  test("replays in insertion order, after SYNC_REQUEST, and clears each entry once it is ACKed", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    client.send(create("card-a"));
    client.send(mutate("one", 2));
    client.send(mutate("two", 3));
    client.send({ type: "CRDT_UPDATE", columnId: "col-1", update: "AAA=" });
    expect(socket.sent).toEqual([]); // nothing reaches a socket that isn't open yet

    socket.open();
    await ackAll(socket, 4);
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));

    // Original messages verbatim — clocks are not re-stamped at replay time.
    expect(socket.sent.slice(0, 5)).toEqual([
      { type: "SYNC_REQUEST" },
      withId(create("card-a")),
      withId(mutate("one", 2)),
      withId(mutate("two", 3)),
      withId({ type: "CRDT_UPDATE", columnId: "col-1", update: "AAA=" }),
    ]);
    await vi.waitFor(async () => expect(await storedMessages()).toEqual([]));
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
    await ackAll(socket, 3);
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));

    expect(types(socket).slice(0, 2)).toEqual(["SYNC_REQUEST", "CREATE"]);
    expect(values(socket)).toEqual(["from last session", "new this session"]);
    await vi.waitFor(async () => expect(await storedMessages()).toEqual([]));
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
    await ackAll(socket, 2);
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
    // Known limit: a message sent straight through isn't tracked for an ACK.
    expect(socket.sent.at(-1)).not.toHaveProperty("messageId");
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
    await ackAll(second, 1);
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));

    expect(values(second)).toEqual(["while offline"]);
    expect(client.getStatus()).toEqual({ connected: true, pending: 0, interrupted: false });
  });

  test("after replaying, asks for one more sync so edits that lost on the server get corrected", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    client.send(mutate("offline edit", 2));
    socket.open();
    await ackAll(socket, 1);
    await vi.waitFor(() => expect(types(socket).filter((t) => t === "SYNC_REQUEST")).toHaveLength(2));

    expect(types(socket)).toEqual(["SYNC_REQUEST", "MUTATE", "SYNC_REQUEST"]);
  });

  test("takeUnsynced returns messages the SYNC_RESPONSE can't include: still queued, or sent after the request", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    client.send(create("card-a"));
    socket.open();
    await ackAll(socket, 1);
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));
    await vi.waitFor(() => expect(types(socket).filter((t) => t === "SYNC_REQUEST")).toHaveLength(2)); // flush finished
    await settle();
    client.send(mutate("live after request"));

    // First response answers the first SYNC_REQUEST: both messages came after it.
    expect(client.takeUnsynced()).toMatchObject([create("card-a"), mutate("live after request")]);
  });

  test("takeUnsynced lists a sent-but-unACKed entry once, not once as 'sent' and again as 'still queued'", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    client.send(create("card-a"));
    socket.open();
    await vi.waitFor(() => expect(durable(socket)).toHaveLength(1)); // sent, no ACK yet

    expect(client.takeUnsynced()).toMatchObject([create("card-a")]);
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

  test("receiving a MUTATE, CREATE or DELETE moves our clock past the one it carries", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    socket.open();
    const remote = (lamport: number) => ({ lamport, clientId: "someone-else" });

    socket.receive({ type: "MUTATE", entityType: "card", entityId: "c", field: "title", value: "x", clock: remote(1_000) });
    expect(nextClock().lamport).toBeGreaterThan(1_000);

    socket.receive({ type: "CREATE", entityType: "card", entityId: "c", initialValues: {}, clock: remote(2_000) });
    expect(nextClock().lamport).toBeGreaterThan(2_000);

    socket.receive({ type: "DELETE", entityType: "card", entityId: "c", clock: remote(3_000) });
    expect(nextClock().lamport).toBeGreaterThan(3_000);
  });

  test("a SYNC_RESPONSE moves our clock past every field clock in it; a message with no clock moves nothing", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    socket.open();

    socket.receive({
      type: "SYNC_RESPONSE",
      boards: [],
      columns: [],
      cards: [],
      columnOrders: {},
      presence: [],
      fieldClocks: {
        "c:title": { lamport: 4_000, clientId: "x" },
        "c:description": { lamport: 9_000, clientId: "y" },
      },
    });
    const afterSync = nextClock().lamport;
    expect(afterSync).toBeGreaterThan(9_000);

    socket.receive({ type: "PRESENCE", clientId: "z", name: "n", color: "#000", cardId: null });
    expect(nextClock().lamport).toBe(afterSync + 1);
  });

  test("a SYNC_RESPONSE from an older server, with no fieldClocks, is handled", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    socket.open();
    const before = nextClock().lamport;

    socket.receive({ type: "SYNC_RESPONSE", boards: [], columns: [], cards: [], columnOrders: {}, presence: [] });

    expect(nextClock().lamport).toBe(before + 1);
  });

  test("without IndexedDB it degrades to an in-memory queue and still replays", async () => {
    const client = new WsClient(new OfflineQueue(undefined));
    clients.push(client);
    const socket = await connectedSocket(client);
    client.send(mutate("memory only"));
    expect(client.getStatus().pending).toBe(1);

    socket.open();
    await ackAll(socket, 1);
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));
    expect(values(socket)).toEqual(["memory only"]);
  });
});

describe("WsClient acknowledgements", () => {
  test("an entry is deleted when the server ACKs it, not when it is sent", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    client.send(create("card-a"));
    socket.open();
    await vi.waitFor(() => expect(durable(socket)).toHaveLength(1));
    await settle();

    // Sent, not yet ACKed: still counted as pending, and still in IndexedDB.
    expect(client.getStatus().pending).toBe(1);
    expect(await storedMessages()).toEqual([withId(create("card-a"))]);

    await ackAll(socket);
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));
    await vi.waitFor(async () => expect(await storedMessages()).toEqual([]));
  });

  test("an unACKed entry replays after a reconnect, with the same messageId", async () => {
    const client = newClient();
    const first = await connectedSocket(client);
    client.send(create("card-a"));
    first.open();
    await vi.waitFor(() => expect(durable(first)).toHaveLength(1));
    const [messageId] = idsSent(first);
    expect(messageId).toEqual(expect.any(String));

    first.drop(); // no ACK ever arrived
    expect(client.getStatus().pending).toBe(1);
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const second = FakeWebSocket.instances[1];
    second.open();
    await vi.waitFor(() => expect(durable(second)).toHaveLength(1));

    expect(durable(second)[0]).toEqual(withId(create("card-a"), messageId)); // same message, same id
    await ackAll(second);
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));
    await vi.waitFor(async () => expect(await storedMessages()).toEqual([]));
  });

  test("the messageId survives a reload: the next page load sends the stored entry under the same id", async () => {
    const before = newClient();
    before.send(create("card-a")); // queued offline, never sent
    await vi.waitFor(async () => expect(await storedMessages()).toHaveLength(1));
    const [stored] = await storedMessages();
    const messageId = (stored as DurableMessage).messageId;
    expect(messageId).toEqual(expect.any(String));

    const afterReload = newClient();
    const socket = await connectedSocket(afterReload);
    socket.open();
    await vi.waitFor(() => expect(durable(socket)).toHaveLength(1));

    expect(idsSent(socket)).toEqual([messageId]);
  });

  test("entries written by an older client, with no messageId, are still deleted as soon as they are sent", async () => {
    const leftover = new OfflineQueue(factory);
    await leftover.add(create("card-old")); // no messageId: the server will never ACK this
    await leftover.close();

    const client = newClient();
    const socket = await connectedSocket(client);
    socket.open();
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0)); // no ACK sent
    await vi.waitFor(async () => expect(await storedMessages()).toEqual([]));

    expect(durable(socket)).toEqual([create("card-old")]); // sent verbatim, not given an id
  });

  test("an ACK carrying an error drops the entry too, so a message the server can never accept isn't replayed forever", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = newClient();
    const socket = await connectedSocket(client);
    client.send(mutate("poison"));
    socket.open();
    await vi.waitFor(() => expect(durable(socket)).toHaveLength(1));

    socket.receive({ type: "ACK", messageId: idsSent(socket)[0], error: "failed to handle message" });

    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));
    await vi.waitFor(async () => expect(await storedMessages()).toEqual([]));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("failed to handle message"));
  });

  test("an ACK for an unknown id, or a repeated one, changes nothing", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    client.send(create("card-a"));
    client.send(create("card-b"));
    socket.open();
    await vi.waitFor(() => expect(durable(socket)).toHaveLength(2));

    socket.receive({ type: "ACK", messageId: "nobody-sent-this" });
    expect(client.getStatus().pending).toBe(2);

    const [first] = idsSent(socket);
    socket.receive({ type: "ACK", messageId: first });
    socket.receive({ type: "ACK", messageId: first });
    expect(client.getStatus().pending).toBe(1);
  });

  test("ACKs are handled inside the client: subscribers never see them", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    socket.open();
    const seen: string[] = [];
    client.subscribe((message) => seen.push(message.type));

    socket.receive({ type: "ACK", messageId: "x" });
    socket.receive({ type: "PRESENCE_LEAVE", clientId: "z" });

    expect(seen).toEqual(["PRESENCE_LEAVE"]);
  });

  test("a live message sent while entries await their ACK waits behind them", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    client.send(create("card-a"));
    socket.open();
    await vi.waitFor(() => expect(durable(socket)).toHaveLength(1)); // sent, unACKed

    client.send(mutate("depends on the CREATE"));
    await vi.waitFor(() => expect(durable(socket)).toHaveLength(2));

    expect(durable(socket).map((m) => m.type)).toEqual(["CREATE", "MUTATE"]);
    expect(idsSent(socket).every((id) => typeof id === "string")).toBe(true);
  });
});

// Two tabs share one IndexedDB store and, in a real browser, one Web Lock.
// The fake below is a plain exclusive lock queue — enough to exercise how the
// client holds it.
function fakeLocks() {
  let tail: Promise<unknown> = Promise.resolve();
  let held = 0;
  return {
    /** Whether anyone — a client's drain, or a test standing in for another tab — currently holds the lock. */
    isHeld: () => held > 0,
    /** Takes the lock the way another tab would, until the returned function is called. */
    holdLikeAnotherTab(): () => void {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      void this.request("held-by-test", () => gate);
      return release;
    },
    request(_name: string, fn: () => Promise<void>) {
      const run = tail.then(() => {
        held += 1;
        return fn().finally(() => (held -= 1));
      });
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

describe("two tabs draining one store", () => {
  async function twoTabsWithTwoQueuedEntries() {
    vi.stubGlobal("navigator", { locks: fakeLocks() });
    const leftover = new OfflineQueue(factory);
    await leftover.add({ ...create("card-a"), messageId: "m1" });
    await leftover.add({ ...mutate("edit", 2), messageId: "m2" });
    await leftover.close();

    const tab1 = newClient();
    const socket1 = await connectedSocket(tab1);
    const tab2 = newClient();
    const socket2 = await connectedSocket(tab2);
    await vi.waitFor(() => expect(tab1.getStatus().pending).toBe(2));
    await vi.waitFor(() => expect(tab2.getStatus().pending).toBe(2));
    return { tab1, tab2, socket1, socket2 };
  }

  test("each entry is sent once: the second tab waits while the first has unACKed entries", async () => {
    const { tab1, tab2, socket1, socket2 } = await twoTabsWithTwoQueuedEntries();

    socket1.open();
    await vi.waitFor(() => expect(durable(socket1)).toHaveLength(2)); // tab 1 sent both, no ACK yet
    socket2.open(); // tab 2's drain now queues behind tab 1's lock
    await settle();

    expect(durable(socket2)).toEqual([]); // not re-sent while tab 1's socket is open and unACKed
    expect(await storedMessages()).toHaveLength(2); // and not deleted yet

    await ackAll(socket1);
    await vi.waitFor(() => expect(tab1.getStatus().pending).toBe(0));
    await vi.waitFor(() => expect(tab2.getStatus().pending).toBe(0)); // tab 2 re-reads the store and finds nothing left
    await settle();

    expect(durable(socket2)).toEqual([]);
    expect([...idsSent(socket1), ...idsSent(socket2)]).toEqual(["m1", "m2"]); // each exactly once, in total
    expect(await storedMessages()).toEqual([]);
  });

  test("if the first tab's socket closes before the ACKs, the other tab takes the entries over", async () => {
    const { tab1, tab2, socket1, socket2 } = await twoTabsWithTwoQueuedEntries();

    socket1.open();
    await vi.waitFor(() => expect(durable(socket1)).toHaveLength(2));
    socket2.open();
    await settle();
    expect(durable(socket2)).toEqual([]);

    socket1.drop(); // never ACKed
    await vi.waitFor(() => expect(durable(socket2)).toHaveLength(2));
    expect(idsSent(socket2)).toEqual(["m1", "m2"]); // same ids as tab 1 used

    await ackAll(socket2);
    await vi.waitFor(() => expect(tab2.getStatus().pending).toBe(0));
    await vi.waitFor(async () => expect(await storedMessages()).toEqual([]));
    expect(tab1.getStatus().connected).toBe(false);
  });
});

// Whether to wait for ACKs is decided per socket, from its first SYNC_RESPONSE:
// `acks: true` means the server ACKs; anything else means an older server that
// never will, so the client must not wait for one.
describe("ACK capability", () => {
  const syncResponse = (acks?: boolean) => ({
    type: "SYNC_RESPONSE",
    boards: [],
    columns: [],
    cards: [],
    columnOrders: {},
    presence: [],
    ...(acks === undefined ? {} : { acks }),
  });

  async function reconnect(first: FakeWebSocket) {
    first.drop();
    vi.advanceTimersByTime(1000); // the client's reconnect delay
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(FakeWebSocket.instances.indexOf(first) + 1));
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  test("a first SYNC_RESPONSE with acks: true keeps entries until they are ACKed", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    client.send(create("card-a"));
    socket.open();
    await vi.waitFor(() => expect(durable(socket)).toHaveLength(1));

    socket.receive(syncResponse(true));
    await settle();

    expect(client.getStatus().pending).toBe(1);
    expect(await storedMessages()).toHaveLength(1);
  });

  test("a first SYNC_RESPONSE with no acks flag counts what was already sent as delivered: entries are removed from the outbox and IndexedDB", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    client.send(create("card-a"));
    client.send(mutate("edit", 2));
    socket.open();
    await vi.waitFor(() => expect(durable(socket)).toHaveLength(2)); // sent, never ACKed

    socket.receive(syncResponse());

    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));
    await vi.waitFor(async () => expect(await storedMessages()).toEqual([]));
  });

  test("...and the drain lock is released, not held waiting for ACKs that will never come", async () => {
    const locks = fakeLocks();
    vi.stubGlobal("navigator", { locks });
    const client = newClient();
    const socket = await connectedSocket(client);
    client.send(create("card-a"));
    socket.open();
    await vi.waitFor(() => expect(durable(socket)).toHaveLength(1));
    await settle();
    expect(locks.isHeld()).toBe(true); // waiting on an ACK

    socket.receive(syncResponse());

    await vi.waitFor(() => expect(locks.isHeld()).toBe(false));
  });

  test("entries sent after a no-flag decision are deleted on send, with no ACK", async () => {
    const locks = fakeLocks();
    vi.stubGlobal("navigator", { locks });
    const release = locks.holdLikeAnotherTab(); // this tab's drain has to wait for the lock
    const client = newClient();
    const socket = await connectedSocket(client);
    client.send(create("card-a"));
    socket.open();
    await settle();
    expect(durable(socket)).toEqual([]); // nothing sent yet

    socket.receive(syncResponse()); // decided while nothing was awaiting
    release(); // now the drain runs

    await vi.waitFor(() => expect(durable(socket)).toHaveLength(1));
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0)); // gone without an ACK
    await vi.waitFor(async () => expect(await storedMessages()).toEqual([]));
  });

  test("after a no-flag decision, later edits go direct and never touch IndexedDB", async () => {
    const client = newClient();
    const socket = await connectedSocket(client);
    client.send(create("card-a"));
    socket.open();
    await vi.waitFor(() => expect(durable(socket)).toHaveLength(1));
    socket.receive(syncResponse());
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));
    await settle(); // the drain finishes and releases its lock

    client.send(mutate("live"));

    expect(values(socket)).toEqual(["live"]);
    expect(socket.sent.at(-1)).not.toHaveProperty("messageId");
    expect(client.getStatus().pending).toBe(0);
    expect(await storedMessages()).toEqual([]);
  });

  test("the decision is made once per socket: a later SYNC_RESPONSE doesn't flip it either way", async () => {
    // yes, then no
    const a = newClient();
    const socketA = await connectedSocket(a);
    a.send(create("card-a"));
    socketA.open();
    await vi.waitFor(() => expect(durable(socketA)).toHaveLength(1));
    socketA.receive(syncResponse(true));
    socketA.receive(syncResponse()); // ignored
    await settle();
    expect(a.getStatus().pending).toBe(1); // still waiting for its ACK

    // no, then yes
    factory = new IDBFactory();
    const b = newClient();
    const socketB = await connectedSocket(b);
    b.send(create("card-b"));
    socketB.open();
    await vi.waitFor(() => expect(durable(socketB)).toHaveLength(1));
    socketB.receive(syncResponse());
    await vi.waitFor(() => expect(b.getStatus().pending).toBe(0));
    socketB.receive(syncResponse(true)); // ignored: this socket's server doesn't ACK
    await settle();
    b.send(create("card-c")); // direct (nothing queued): no tracking was switched back on
    expect(b.getStatus().pending).toBe(0);
    expect(socketB.sent.at(-1)).not.toHaveProperty("messageId");
  });

  test("a socket that closes before its first SYNC_RESPONSE leaves the entries queued, and they replay on reconnect", async () => {
    const client = newClient();
    const first = await connectedSocket(client);
    client.send(create("card-a"));
    client.send(mutate("edit", 2));
    first.open();
    await vi.waitFor(() => expect(durable(first)).toHaveLength(2));
    const ids = idsSent(first);

    const second = await reconnect(first); // no SYNC_RESPONSE, no ACK ever arrived
    expect(client.getStatus().pending).toBe(2);
    expect(await storedMessages()).toHaveLength(2);

    second.open();
    await vi.waitFor(() => expect(durable(second)).toHaveLength(2));
    expect(idsSent(second)).toEqual(ids); // same messages, same ids
  });

  test("a first socket that ACKs, then a second to a server without the flag: the second falls back", async () => {
    const client = newClient();
    const first = await connectedSocket(client);
    client.send(create("card-a"));
    first.open();
    await vi.waitFor(() => expect(durable(first)).toHaveLength(1));
    first.receive(syncResponse(true));

    const second = await reconnect(first); // before any ACK
    expect(client.getStatus().pending).toBe(1); // the first socket's "yes" decided nothing about this one
    second.open();
    await vi.waitFor(() => expect(durable(second)).toHaveLength(1));
    await settle();
    expect(client.getStatus().pending).toBe(1); // assumed capable until its first response

    second.receive(syncResponse()); // the older server

    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));
    await vi.waitFor(async () => expect(await storedMessages()).toEqual([]));
    client.send(mutate("live"));
    expect(values(second)).toEqual(["live"]); // direct again
  });

  test("a first socket without the flag, then a second to a server that ACKs: the second waits for ACKs again", async () => {
    const client = newClient();
    const first = await connectedSocket(client);
    first.open();
    first.receive(syncResponse()); // an older server
    const second = await reconnect(first);
    client.send(create("card-a")); // queued: nothing is open to take it
    second.open();
    second.receive(syncResponse(true));
    await vi.waitFor(() => expect(durable(second)).toHaveLength(1));
    await settle();

    expect(client.getStatus().pending).toBe(1); // held until ACKed

    await ackAll(second);
    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));
  });
});
