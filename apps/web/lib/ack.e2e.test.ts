import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import WsLib from "ws";
import type { ClientMessage } from "@realtime-kanban/shared-types";
import { e2eEnabled, startE2eServer, Peer, type E2eServer } from "../../server/src/test-support/e2e-server";
import { OfflineQueue, type DurableMessage } from "./offline-queue";

// The real WsClient (queue in fake-indexeddb) against the real server process
// and a throwaway localhost Postgres: the two halves of the ACK protocol
// agreeing with each other. Skipped when DATABASE_URL isn't a localhost
// database.

describe.skipIf(!e2eEnabled)("queued messages and ACKs, real client and real server (localhost only)", () => {
  let server: E2eServer;
  let WsClient: typeof import("./ws-client").WsClient;
  let factory: IDBFactory;
  let columnId: string;
  let probe: Peer;
  const clients: InstanceType<typeof WsClient>[] = [];

  beforeAll(async () => {
    server = await startE2eServer();
    process.env.NEXT_PUBLIC_WS_URL = server.url; // read once, at ws-client's import
    vi.stubGlobal("WebSocket", WsLib);
    ({ WsClient } = await import("./ws-client"));
    const peer = await Peer.connect(server.url);
    columnId = (await peer.sync()).columns[0].id;
    peer.close();
  }, 60_000);

  afterEach(() => {
    probe?.close();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await server.stop();
  });

  const card = (id: string, title: string): DurableMessage => ({
    type: "CREATE",
    entityType: "card",
    entityId: id,
    initialValues: {
      columnId,
      title,
      description: "",
      position: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    },
    clock: { lamport: 1, clientId: "queued-client" },
  });

  async function startClient() {
    factory = new IDBFactory();
    const queue = new OfflineQueue(factory);
    const client = new WsClient(queue);
    clients.push(client);
    probe = await Peer.connect(server.url);
    return { client, queue };
  }

  test("a message queued before connecting is delivered, ACKed by the real server, and only then removed", async () => {
    const { client } = await startClient();
    const id = crypto.randomUUID();
    client.send(card(id, "queued offline"));
    expect(client.getStatus().pending).toBe(1);

    client.connect();

    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0)); // can only happen on a real ACK
    await vi.waitFor(async () => expect(await new OfflineQueue(factory).readAll()).toEqual([]));
    expect((await probe.sync()).cards.find((c) => c.id === id)?.title).toBe("queued offline");
  });

  test("replaying a message whose ACK was lost is harmless: the server recognizes it, ACKs again, and the card is unchanged", async () => {
    const { client } = await startClient();
    const id = crypto.randomUUID();
    const messageId = crypto.randomUUID();

    // The first delivery: the server applied it (the client just never heard back).
    const sender = await Peer.connect(server.url);
    sender.send({ ...card(id, "original"), messageId } as ClientMessage);
    await sender.waitFor((m) => m.type === "ACK" && m.messageId === messageId);
    sender.close();

    // What the client still has on disk: the same message, same id, different payload.
    await new OfflineQueue(factory).add({ ...card(id, "REPLAYED"), messageId });
    client.connect();

    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0)); // ACKed again, so dropped
    const state = await probe.sync();
    expect(state.cards.filter((c) => c.id === id)).toHaveLength(1);
    expect(state.cards.find((c) => c.id === id)?.title).toBe("original");
    expect(server.hasExited()).toBe(false);
  });

  test("a message the server can never accept is ACKed with an error and dropped, not replayed forever", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, queue } = await startClient();
    // A CRDT_UPDATE that isn't a valid Yjs update makes the server's handler throw.
    await queue.add({ type: "CRDT_UPDATE", columnId, update: "AQ==", messageId: crypto.randomUUID() });

    client.connect();

    await vi.waitFor(() => expect(client.getStatus().pending).toBe(0));
    await vi.waitFor(async () => expect(await new OfflineQueue(factory).readAll()).toEqual([]));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("dropping it"));
    expect(server.hasExited()).toBe(false);
    error.mockRestore();
  });
});
