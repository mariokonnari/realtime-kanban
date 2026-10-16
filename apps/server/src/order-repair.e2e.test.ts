import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { PrismaClient } from "@prisma/client";
import { decodeUpdate, encodeUpdate, type CrdtUpdateMessage, type ServerMessage } from "@realtime-kanban/shared-types";
import { e2eEnabled, startE2eServer, Peer, type E2eServer } from "./test-support/e2e-server.js";

// The card-order repair against the real server process, a real WebSocket and a
// real Postgres (throwaway database, localhost only — see test-support/e2e-server.ts).
// The pure rules are in column-order-repair.test.ts; this is the wiring: when the repair
// runs, who is told, that it does not loop, and that it heals data already stored.

/** A client's copy of the column orders, with the Yjs steps moveCard() performs. */
class Replica {
  readonly docs = new Map<string, Y.Doc>();
  readonly sent: CrdtUpdateMessage[] = [];

  constructor(columnOrders: Record<string, string>) {
    for (const [columnId, base64] of Object.entries(columnOrders)) Y.applyUpdate(this.doc(columnId), decodeUpdate(base64));
  }

  doc(columnId: string) {
    let doc = this.docs.get(columnId);
    if (!doc) this.docs.set(columnId, (doc = new Y.Doc()));
    return doc;
  }

  order(columnId: string) {
    return this.doc(columnId).getArray<string>("cardOrder").toArray();
  }

  /** The CRDT_UPDATEs moveCard() sends: a delete from the old column, then an insert into the new one. */
  move(cardId: string, from: string, to: string, toIndex: number): CrdtUpdateMessage[] {
    const out: CrdtUpdateMessage[] = [];
    const fromDoc = this.doc(from);
    const fromBefore = Y.encodeStateVector(fromDoc);
    const fromArr = fromDoc.getArray<string>("cardOrder");
    const existing = fromArr.toArray().indexOf(cardId);
    if (existing !== -1) fromArr.delete(existing, 1);
    out.push({ type: "CRDT_UPDATE", columnId: from, update: encodeUpdate(Y.encodeStateAsUpdate(fromDoc, fromBefore)) });
    const toDoc = this.doc(to);
    const toBefore = Y.encodeStateVector(toDoc);
    const toArr = toDoc.getArray<string>("cardOrder");
    toArr.insert(Math.max(0, Math.min(toIndex, toArr.length)), [cardId]);
    out.push({ type: "CRDT_UPDATE", columnId: to, update: encodeUpdate(Y.encodeStateAsUpdate(toDoc, toBefore)) });
    this.sent.push(...out);
    return out;
  }

  receive(messages: ServerMessage[]) {
    for (const m of messages) if (m.type === "CRDT_UPDATE") Y.applyUpdate(this.doc(m.columnId), decodeUpdate(m.update));
  }
}

const decodeOrders = (columnOrders: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(columnOrders).map(([columnId, base64]) => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, decodeUpdate(base64));
      return [columnId, doc.getArray<string>("cardOrder").toArray()];
    }),
  );

async function storedOrders(databaseUrl: string): Promise<Record<string, string[]>> {
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const out: Record<string, string[]> = {};
    for (const { columnId, state } of await db.columnDoc.findMany()) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, state);
      out[columnId] = doc.getArray<string>("cardOrder").toArray();
    }
    return out;
  } finally {
    await db.$disconnect();
  }
}

const settle = () => new Promise((r) => setTimeout(r, 600));

describe.skipIf(!e2eEnabled)("card order repair (e2e, localhost only)", () => {
  let server: E2eServer;
  const peers: Peer[] = [];

  beforeEach(async () => {
    server = await startE2eServer();
  }, 60_000);

  afterEach(async () => {
    peers.splice(0).forEach((p) => p.close());
    await server.stop();
  });

  async function connect() {
    const peer = await Peer.connect(server.url);
    peers.push(peer);
    return peer;
  }

  /** One card X in the first column, known to both peers. Returns the pieces a test needs. */
  async function twoPeersOneCard() {
    const [one, two] = [await connect(), await connect()];
    const { columns } = await one.sync();
    const [c0, c1, c2] = columns.map((c) => c.id);
    const cardId = randomUUID();
    one.send({
      type: "CREATE",
      entityType: "card",
      entityId: cardId,
      initialValues: { columnId: c0, title: "X", description: "", position: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null },
      clock: { lamport: 1, clientId: "one" },
    });
    const creation = new Replica({});
    creation.doc(c0).getArray<string>("cardOrder").push([cardId]);
    one.send({ type: "CRDT_UPDATE", columnId: c0, update: encodeUpdate(Y.encodeStateAsUpdate(creation.doc(c0))) });
    await two.waitFor((m) => m.type === "CRDT_UPDATE" && m.columnId === c0);
    // Both now start from the server's state.
    const replicas = [new Replica((await one.sync()).columnOrders), new Replica((await two.sync()).columnOrders)];
    expect(replicas[0].order(c0)).toEqual([cardId]);
    return { one, two, replicas, c0, c1, c2, cardId };
  }

  /** Sends `frames` and waits until the server has handled them (same socket, so a SYNC_REQUEST after them proves it). */
  async function sendAndWait(peer: Peer, frames: CrdtUpdateMessage[], before: () => void = () => {}) {
    before();
    frames.forEach((f) => peer.send(f));
    await peer.sync();
  }

  test("two same-column moves at once: the duplicate is repaired, and every client — the sender included — gets one repair frame", async () => {
    const { one, two, replicas, c0, cardId } = await twoPeersOneCard();
    const seenBefore = [one.received.length, two.received.length];

    const first = replicas[0].move(cardId, c0, c0, 0);
    const second = replicas[1].move(cardId, c0, c0, 1);
    await sendAndWait(one, first);
    await sendAndWait(two, second);
    await settle(); // long enough for a repair that fed itself to have done so

    for (const [peer, replica, theirs, seen] of [
      [one, replicas[0], second, seenBefore[0]],
      [two, replicas[1], first, seenBefore[1]],
    ] as const) {
      const updates = peer.received.slice(seen).filter((m): m is CrdtUpdateMessage => m.type === "CRDT_UPDATE");
      const relayed = updates.filter((m) => theirs.some((t) => t.update === m.update));
      const repairs = updates.filter((m) => !theirs.some((t) => t.update === m.update));
      expect(relayed).toHaveLength(2); // the other client's two frames
      expect(repairs).toHaveLength(1); // one repair, not a stream
      expect(repairs[0].columnId).toBe(c0);
      expect("messageId" in repairs[0]).toBe(false);
      replica.receive(updates);
      expect(replica.order(c0)).toEqual([cardId]);
    }

    const state = await one.sync();
    expect(decodeOrders(state.columnOrders)[c0]).toEqual([cardId]);
    await expect.poll(async () => (await storedOrders(server.databaseUrl))[c0]).toEqual([cardId]);
  }, 60_000);

  test.each([
    { name: "the later MUTATE has the higher clock and wins", lamport: 6, winner: "c2" },
    { name: "the later MUTATE has the lower clock and is rejected", lamport: 4, winner: "c1" },
  ] as const)("two moves to different columns at once: $name; the card ends up once, where columnId says", async ({ lamport, winner }) => {
    const { one, two, replicas, c0, c1, c2, cardId } = await twoPeersOneCard();
    const columnOf = { c1, c2 };

    // moveCard() sends the MUTATE first, then the two CRDT_UPDATEs.
    one.send({ type: "MUTATE", entityType: "card", entityId: cardId, field: "columnId", value: c1, clock: { lamport: 5, clientId: "one" } });
    await sendAndWait(one, replicas[0].move(cardId, c0, c1, 0));
    two.send({ type: "MUTATE", entityType: "card", entityId: cardId, field: "columnId", value: c2, clock: { lamport, clientId: "two" } });
    await sendAndWait(two, replicas[1].move(cardId, c0, c2, 0));
    await settle();

    const state = await one.sync();
    const where = columnOf[winner];
    expect(state.cards.find((c) => c.id === cardId)?.columnId).toBe(where);
    expect(decodeOrders(state.columnOrders)).toMatchObject({ [c0]: [], [c1]: where === c1 ? [cardId] : [], [c2]: where === c2 ? [cardId] : [] });

    // Both clients, applying what they were sent, agree with the server.
    for (const [peer, replica] of [[one, replicas[0]], [two, replicas[1]]] as const) {
      replica.receive(peer.received);
      expect([c0, c1, c2].map((c) => replica.order(c))).toEqual([c0, c1, c2].map((c) => decodeOrders(state.columnOrders)[c]));
    }
    await expect.poll(async () => (await storedOrders(server.databaseUrl))[where]).toEqual([cardId]);
    const stored = await storedOrders(server.databaseUrl);
    expect(Object.values(stored).flat().filter((id) => id === cardId)).toHaveLength(1);
  }, 60_000);

  test("an applied columnId MUTATE repairs at once when it makes an entry the card's home", async () => {
    const { one, two, replicas, c0, c1, c2, cardId } = await twoPeersOneCard();

    // Both inserts arrive while columnId still names c0, which no longer lists the card:
    // there is nothing in the column it names, so nothing is chosen between c1 and c2.
    await sendAndWait(one, replicas[0].move(cardId, c0, c1, 0));
    await sendAndWait(two, replicas[1].move(cardId, c0, c2, 0));
    await settle();
    let orders = decodeOrders((await one.sync()).columnOrders);
    expect([orders[c1], orders[c2]]).toEqual([[cardId], [cardId]]);

    const seen = two.received.length;
    one.send({ type: "MUTATE", entityType: "card", entityId: cardId, field: "columnId", value: c1, clock: { lamport: 5, clientId: "one" } });
    await one.sync();
    await settle();
    orders = decodeOrders((await one.sync()).columnOrders);
    expect([orders[c1], orders[c2]]).toEqual([[cardId], []]);
    // the other client was told, by a CRDT_UPDATE it did not send
    const told = two.received.slice(seen).filter((m): m is CrdtUpdateMessage => m.type === "CRDT_UPDATE");
    expect(told.map((m) => m.columnId)).toEqual([c2]);
  }, 60_000);

  test("a duplicate already in the database is repaired at startup, before any client connects, and persisted", async () => {
    const peer = await connect();
    const { columns } = await peer.sync();
    const [c0, c1] = columns.map((c) => c.id);
    const cardId = randomUUID();
    peer.send({
      type: "CREATE",
      entityType: "card",
      entityId: cardId,
      initialValues: { columnId: c0, title: "X", description: "", position: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null },
      clock: { lamport: 1, clientId: "p" },
    });
    await peer.sync();
    await expect.poll(async () => (await storedOrders(server.databaseUrl))[c0]).toBeDefined();
    peer.close();

    // Corrupt what is stored the way the old double-move did: x twice in c0 (its column), once in c1.
    const db = new PrismaClient({ datasourceUrl: server.databaseUrl });
    try {
      for (const [columnId, ids] of [[c0, [cardId, cardId]], [c1, [cardId]]] as const) {
        const doc = new Y.Doc();
        doc.getArray<string>("cardOrder").push([...ids]);
        const state = Buffer.from(Y.encodeStateAsUpdate(doc));
        await db.columnDoc.upsert({ where: { columnId }, create: { columnId, state }, update: { state } });
      }
    } finally {
      await db.$disconnect();
    }
    expect(Object.values(await storedOrders(server.databaseUrl)).flat()).toHaveLength(3);

    await server.restart();
    expect(server.output()).toContain("Repaired the card order of 2 column(s) at startup");

    const fresh = await connect();
    const orders = decodeOrders((await fresh.sync()).columnOrders);
    expect(orders[c0]).toEqual([cardId]);
    expect(orders[c1]).toEqual([]);
    // ...and Postgres holds the repaired state, not just the server's memory.
    expect(await storedOrders(server.databaseUrl)).toMatchObject({ [c0]: [cardId], [c1]: [] });

    // Healthy data is left alone: another restart repairs nothing.
    await server.restart();
    expect(server.output()).not.toContain("Repaired");
  }, 90_000);
});
