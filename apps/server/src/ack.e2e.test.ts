import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AckMessage, ClientMessage, ServerMessage } from "@realtime-kanban/shared-types";
import {
  e2eEnabled,
  startE2eServer,
  Peer,
  readCardRow,
  waitForRow,
  type E2eServer,
} from "./test-support/e2e-server.js";

// Real server over a real WebSocket against a throwaway localhost Postgres;
// skipped when DATABASE_URL isn't a localhost database.
//
// The delivery contract: a durable message that carries a messageId is ACKed
// to its sender — and only its sender — once it has been handled (applied,
// rejected as stale, or ignored as a duplicate) and its DB writes have
// settled. A message the server can never accept is ACKed with an error. A
// message with no messageId is handled exactly as before and never ACKed.

const isAck = (id: string) => (m: ServerMessage): m is AckMessage => m.type === "ACK" && m.messageId === id;
const acksFor = (peer: Peer, id: string) => peer.received.filter(isAck(id));

describe.skipIf(!e2eEnabled)("ACKs and idempotent handlers (e2e, localhost only)", () => {
  let server: E2eServer;
  let sender: Peer;
  let observer: Peer;
  let columnId: string;
  let cardId: string;

  beforeAll(async () => {
    server = await startE2eServer();
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    sender = await Peer.connect(server.url);
    observer = await Peer.connect(server.url);
    columnId = (await sender.sync()).columns[0].id;
    cardId = randomUUID();
    return () => {
      sender.close();
      observer.close();
    };
  });

  const createMsg = (messageId?: string, title = "original"): ClientMessage => ({
    type: "CREATE",
    entityType: "card",
    entityId: cardId,
    initialValues: {
      columnId,
      title,
      description: "original description",
      position: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    },
    clock: { lamport: 1, clientId: "sender" },
    ...(messageId ? { messageId } : {}),
  });

  const titleEdit = (value: string, lamport: number, messageId?: string): ClientMessage => ({
    type: "MUTATE",
    entityType: "card",
    entityId: cardId,
    field: "title",
    value,
    clock: { lamport, clientId: "sender" },
    ...(messageId ? { messageId } : {}),
  });

  /** Resolves once the observer has been handed everything the server broadcast so far. */
  async function observerCaughtUp() {
    const marker = `marker-${randomUUID()}`;
    sender.send({ type: "PRESENCE", clientId: "sender", name: "n", color: "#000", cardId: marker });
    await observer.barrier(marker);
  }

  const creates = () => observer.received.filter((m) => m.type === "CREATE" && m.entityId === cardId);

  test("a message with a messageId is ACKed to its sender only, and only once it is in Postgres", async () => {
    const id = randomUUID();
    sender.send(createMsg(id));

    await sender.waitFor(isAck(id));
    expect(await readCardRow(server.databaseUrl, cardId)).not.toBeNull(); // already persisted when the ACK arrives

    await observerCaughtUp();
    expect(observer.received.some((m) => m.type === "ACK")).toBe(false);
    expect(acksFor(sender, id)[0].error).toBeUndefined();
  });

  test("every SYNC_RESPONSE advertises ACK support, so a client knows to wait for ACKs", async () => {
    const first = await sender.sync();
    const second = await observer.sync();
    const third = await sender.sync(); // a later one on the same socket too

    expect([first.acks, second.acks, third.acks]).toEqual([true, true, true]);
  });

  test("a message with no messageId is handled as before and never ACKed", async () => {
    sender.send(createMsg());
    const before = sender.received.length;
    const state = await sender.sync(); // same socket: handled after the CREATE

    expect(state.cards.some((c) => c.id === cardId)).toBe(true);
    expect(sender.received.slice(before).map((m) => m.type)).toEqual(["SYNC_RESPONSE"]);
  });

  test("the same CREATE twice: both are ACKed, and there is one unchanged card and one broadcast", async () => {
    const id = randomUUID();
    sender.send(createMsg(id));
    await sender.waitFor(isAck(id));
    sender.send(createMsg(id, "REPLAYED")); // same messageId, as a replay from the queue would be
    await vi.waitFor(() => expect(acksFor(sender, id)).toHaveLength(2));

    const card = (await sender.sync()).cards.find((c) => c.id === cardId);
    expect(card?.title).toBe("original");
    expect(card?.description).toBe("original description");
    await observerCaughtUp();
    expect(creates()).toHaveLength(1);
    expect(acksFor(sender, id).every((a) => a.error === undefined)).toBe(true);
  });

  test("a stale MUTATE the server rejects is still ACKed", async () => {
    sender.send(createMsg());
    sender.send(titleEdit("winner", 10));
    const id = randomUUID();
    sender.send(titleEdit("stale", 2, id));

    await sender.waitFor(isAck(id));
    expect((await sender.sync()).cards.find((c) => c.id === cardId)?.title).toBe("winner");
    expect(acksFor(sender, id)[0].error).toBeUndefined();
  });

  test("a replayed MUTATE with an identical clock is a no-op: ACKed again, not rebroadcast, nothing changes", async () => {
    sender.send(createMsg());
    const id = randomUUID();
    sender.send(titleEdit("once", 5, id));
    await sender.waitFor(isAck(id));
    const stateAfterFirst = (await sender.sync()).cards.find((c) => c.id === cardId);

    sender.send(titleEdit("once", 5, id)); // identical, including the clock
    await vi.waitFor(() => expect(acksFor(sender, id)).toHaveLength(2));

    const stateAfterReplay = (await sender.sync()).cards.find((c) => c.id === cardId);
    expect(stateAfterReplay).toEqual(stateAfterFirst); // incl. updatedAt: not bumped by the replay
    await observerCaughtUp();
    expect(observer.received.filter((m) => m.type === "MUTATE" && m.entityId === cardId)).toHaveLength(1);
  });

  test("a second DELETE does nothing: ACKed, deletedAt not re-stamped, no DB write, not rebroadcast", async () => {
    sender.send(createMsg());
    const id = randomUUID();
    const del: ClientMessage = {
      type: "DELETE",
      entityType: "card",
      entityId: cardId,
      clock: { lamport: 2, clientId: "sender" },
      messageId: id,
    };
    sender.send(del);
    await sender.waitFor(isAck(id));
    const first = await waitForRow(server.databaseUrl, cardId, (row) => row?.deletedAt != null);
    await new Promise((r) => setTimeout(r, 25)); // so a re-stamp could not land on the same millisecond

    sender.send(del);
    await vi.waitFor(() => expect(acksFor(sender, id)).toHaveLength(2));

    const after = await readCardRow(server.databaseUrl, cardId);
    expect(after?.deletedAt?.toISOString()).toBe(first.deletedAt?.toISOString());
    await observerCaughtUp();
    expect(observer.received.filter((m) => m.type === "DELETE" && m.entityId === cardId)).toHaveLength(1);
    expect(server.output()).not.toContain("DB write failed");
  });

  test("the same CRDT_UPDATE twice: both ACKed, and the column order holds the card once", async () => {
    const Y = await import("yjs");
    const { encodeUpdate, decodeUpdate } = await import("@realtime-kanban/shared-types");
    const doc = new Y.Doc();
    doc.getArray<string>("cardOrder").push([cardId]);
    const update = encodeUpdate(Y.encodeStateAsUpdate(doc));
    const id = randomUUID();
    const crdt: ClientMessage = { type: "CRDT_UPDATE", columnId, update, messageId: id };

    sender.send(crdt);
    await sender.waitFor(isAck(id));
    sender.send(crdt); // a replay
    await vi.waitFor(() => expect(acksFor(sender, id)).toHaveLength(2));

    const synced = new Y.Doc();
    Y.applyUpdate(synced, decodeUpdate((await sender.sync()).columnOrders[columnId]));
    expect(synced.getArray<string>("cardOrder").toArray().filter((c) => c === cardId)).toHaveLength(1);
  });

  test("a handler that throws ACKs with an error, so the client can drop the message", async () => {
    const id = randomUUID();
    sender.sendRaw(JSON.stringify({ type: "CRDT_UPDATE", columnId, update: "AQ==", messageId: id })); // not a Yjs update

    const ack = await sender.waitFor(isAck(id));
    expect(ack.error).toBeTruthy();
    expect(server.hasExited()).toBe(false);
    expect((await sender.sync()).columns.length).toBeGreaterThan(0); // and it keeps serving
  });

  test("an invalid message carrying a messageId is ACKed with an error; one with no id can't be", async () => {
    const id = randomUUID();
    sender.sendRaw(JSON.stringify({ type: 7, messageId: id }));
    sender.sendRaw("{not json");

    const ack = await sender.waitFor(isAck(id));
    expect(ack.error).toBeTruthy();
    const before = sender.received.length;
    await sender.sync();
    expect(sender.received.slice(before).map((m) => m.type)).toEqual(["SYNC_RESPONSE"]); // nothing for the non-JSON frame
  });

  test("a messageId is not relayed to other clients", async () => {
    sender.send(createMsg(randomUUID()));
    const relayed = await observer.waitFor((m) => m.type === "CREATE" && m.entityId === cardId);
    expect("messageId" in relayed).toBe(false);
  });
});
