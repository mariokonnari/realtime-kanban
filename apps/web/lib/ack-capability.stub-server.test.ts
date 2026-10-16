import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import WsLib, { WebSocketServer } from "ws";
import type { ClientMessage } from "@realtime-kanban/shared-types";
import { OfflineQueue, type DurableMessage } from "./offline-queue";

// The real WsClient talking over a real WebSocket to a stub server that behaves
// like a server from before ACKs existed: its SYNC_RESPONSE has no `acks` flag
// and it never sends an ACK. No Postgres involved.

describe("a server that predates ACKs (stub server, real WebSocket)", () => {
  let wss: WebSocketServer;
  let WsClient: typeof import("./ws-client").WsClient;
  const received: ClientMessage[] = [];

  beforeAll(async () => {
    wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as ClientMessage;
        received.push(message);
        if (message.type === "SYNC_REQUEST") {
          // Everything an older server sent — and no `acks`.
          socket.send(
            JSON.stringify({ type: "SYNC_RESPONSE", boards: [], columns: [], cards: [], columnOrders: {}, presence: [] }),
          );
        }
        // Never an ACK, whatever the message.
      });
    });
    const { port } = wss.address() as { port: number };
    process.env.NEXT_PUBLIC_WS_URL = `ws://127.0.0.1:${port}`; // read once, at ws-client's import
    vi.stubGlobal("WebSocket", WsLib);
    ({ WsClient } = await import("./ws-client"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    // close() waits for open connections, and the client's is still open.
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  // A plain exclusive lock that also reports whether it is held.
  function trackedLocks() {
    let tail: Promise<unknown> = Promise.resolve();
    let held = 0;
    return {
      isHeld: () => held > 0,
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

  const create = (entityId: string): DurableMessage => ({
    type: "CREATE",
    entityType: "card",
    entityId,
    initialValues: { title: entityId },
    clock: { lamport: 1, clientId: "client-a" },
  });

  test("the queue drains, pending returns to 0, the lock is released, and later edits go direct", async () => {
    const locks = trackedLocks();
    vi.stubGlobal("navigator", { locks });
    const factory = new IDBFactory();
    const client = new WsClient(new OfflineQueue(factory));
    client.send(create("card-a")); // queued: nothing is connected yet
    client.send(create("card-b"));
    expect(client.getStatus().pending).toBe(2);

    client.connect();

    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0)); // with no ACK, ever
    await vi.waitFor(() => expect(locks.isHeld()).toBe(false));
    expect(received.filter((m) => m.type === "CREATE")).toHaveLength(2); // both were delivered once
    expect(await new OfflineQueue(factory).readAll()).toEqual([]);

    // Back on the direct path: no queue, no messageId, nothing in IndexedDB.
    const before = received.length;
    client.send(create("card-c"));
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(before));
    expect(received.at(-1)).toMatchObject({ type: "CREATE", entityId: "card-c" });
    expect(received.at(-1)).not.toHaveProperty("messageId");
    expect(client.getStatus().pending).toBe(0);
    expect(await new OfflineQueue(factory).readAll()).toEqual([]);
  });
});
