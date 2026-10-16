import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { LIMITS, encodeUpdate, type AckMessage, type ClientMessage, type ServerMessage } from "@realtime-kanban/shared-types";
import { e2eEnabled, startE2eServer, Peer, readCardRow, type E2eServer } from "./test-support/e2e-server.js";

// Real server over a real WebSocket against a throwaway localhost Postgres,
// default limits; skipped when DATABASE_URL isn't a localhost database.
//
// Input validation: every message is checked (schema, then server state) before
// a handler runs, a refused message is answered through the existing error-ACK
// path, and nothing is registered or mutated on its behalf. The rate limiter
// and violation handling, which need smaller limits, are in limits.e2e.test.ts.

type Durable = Extract<ClientMessage, { type: "MUTATE" | "CREATE" | "DELETE" | "CRDT_UPDATE" }>;
const isAck = (id: string) => (m: ServerMessage): m is AckMessage => m.type === "ACK" && m.messageId === id;

describe.skipIf(!e2eEnabled)("input validation (e2e, localhost only)", () => {
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

  const clock = (lamport: number) => ({ lamport, clientId: "sender" });
  const cardValues = () => ({
    columnId,
    title: "original",
    description: "original description",
    position: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  });
  const createCard = (messageId?: string): ClientMessage => ({
    type: "CREATE",
    entityType: "card",
    entityId: cardId,
    initialValues: cardValues(),
    clock: clock(1),
    ...(messageId ? { messageId } : {}),
  });
  const sendJson = (peer: Peer, message: object) => peer.sendRaw(JSON.stringify(message));

  /** Resolves once the observer has been handed everything the server broadcast so far. */
  async function observerCaughtUp() {
    const marker = `marker-${randomUUID()}`;
    sender.send({ type: "PRESENCE", clientId: "sender", name: "n", color: "#000", cardId: marker });
    await observer.barrier(marker);
  }

  async function yjsUpdate(...ids: string[]) {
    const doc = new Y.Doc();
    doc.getArray<string>("cardOrder").push(ids);
    return encodeUpdate(Y.encodeStateAsUpdate(doc));
  }

  test("a 500-message replay with messageIds passes the limiter, and every message is ACKed", async () => {
    // What the real client does on reconnect (ws-client.ts flush()): SYNC_REQUEST,
    // then its whole outbox in one burst with no pacing. 500 entries shaped like
    // real ones: createCard queues CREATE + CRDT_UPDATE, an edit queues a MUTATE.
    const doc = new Y.Doc();
    const order = doc.getArray<string>("cardOrder");
    const cardIds = Array.from({ length: 200 }, () => randomUUID());
    const burst: Durable[] = [];
    for (const id of cardIds) {
      burst.push({
        type: "CREATE",
        entityType: "card",
        entityId: id,
        initialValues: { ...cardValues(), title: `card ${id}` },
        clock: clock(1),
        messageId: randomUUID(),
      });
      const before = Y.encodeStateVector(doc);
      order.push([id]);
      burst.push({
        type: "CRDT_UPDATE",
        columnId,
        update: encodeUpdate(Y.encodeStateAsUpdate(doc, before)),
        messageId: randomUUID(),
      });
    }
    for (const id of cardIds.slice(0, 100)) {
      burst.push({
        type: "MUTATE",
        entityType: "card",
        entityId: id,
        field: "description",
        value: "edited",
        clock: clock(2),
        messageId: randomUUID(),
      });
    }
    expect(burst).toHaveLength(500);

    sender.send({ type: "SYNC_REQUEST" });
    for (const message of burst) sender.send(message);

    await sender.waitFor((m) => m.type === "ACK" && m.messageId === burst[499].messageId, 30_000);
    const acks = sender.received.filter((m): m is AckMessage => m.type === "ACK");
    expect(acks).toHaveLength(500);
    expect(new Set(acks.map((a) => a.messageId))).toEqual(new Set(burst.map((m) => m.messageId)));
    expect(acks.filter((a) => a.error)).toEqual([]);
    expect(acks.map((a) => a.messageId)).toEqual(burst.map((m) => m.messageId)); // in the order sent

    // Not delayed, not counted against it, not closed.
    expect(server.output()).not.toContain("[rate limit]");
    expect(server.output()).not.toContain("[violation]");
    const state = await sender.sync();
    expect(cardIds.every((id) => state.cards.some((c) => c.id === id))).toBe(true);
    expect(state.cards.find((c) => c.id === cardIds[0])?.description).toBe("edited");
    expect(state.cards.find((c) => c.id === cardIds[150])?.description).toBe("original description");
    const synced = new Y.Doc();
    Y.applyUpdate(synced, Uint8Array.from(Buffer.from(state.columnOrders[columnId], "base64")));
    expect(synced.getArray<string>("cardOrder").toArray()).toEqual(cardIds);
  }, 60_000);

  describe("a CRDT_UPDATE for a column the server doesn't have", () => {
    test("registers no doc, whether the payload is garbage or a perfectly good Yjs update", async () => {
      const known = Object.keys((await sender.sync()).columnOrders).sort();
      const unknown = randomUUID();
      const garbage = randomUUID();
      const good = randomUUID();
      sendJson(sender, { type: "CRDT_UPDATE", columnId: unknown, update: "AQ==", messageId: garbage });
      sendJson(sender, { type: "CRDT_UPDATE", columnId: unknown, update: await yjsUpdate(cardId), messageId: good });

      expect((await sender.waitFor(isAck(garbage))).error).toBeTruthy();
      expect((await sender.waitFor(isAck(good))).error).toBeTruthy();

      for (const peer of [sender, await Peer.connect(server.url)]) {
        const orders = (await peer.sync()).columnOrders;
        expect(Object.keys(orders).sort()).toEqual(known);
        expect(unknown in orders).toBe(false);
        if (peer !== sender) peer.close();
      }
      await observerCaughtUp();
      expect(observer.received.some((m) => m.type === "CRDT_UPDATE")).toBe(false); // and was never relayed
      expect(server.hasExited()).toBe(false);
    });

    test("still reaches a column that does exist", async () => {
      const id = randomUUID();
      sendJson(sender, { type: "CRDT_UPDATE", columnId, update: await yjsUpdate(cardId), messageId: id });
      expect((await sender.waitFor(isAck(id))).error).toBeUndefined();
      await observer.waitFor((m) => m.type === "CRDT_UPDATE" && m.columnId === columnId);
    });
  });

  describe("an invalid message with a messageId is ACKed with an error, and the connection keeps serving", () => {
    const tooLong = (n: number) => "x".repeat(n + 1);
    const mutate = { type: "MUTATE", entityType: "card", entityId: "a", field: "title", value: "v", clock: clock(1) };
    const cases: Array<[string, () => object]> = [
      ["MUTATE with no clock", () => ({ ...mutate, clock: undefined })],
      ["CREATE with no clock", () => ({ ...createCard(), clock: undefined })],
      ["an entityType that isn't board/column/card", () => ({ ...mutate, entityType: "workspace" })],
      ["a clock with a negative lamport", () => ({ ...mutate, clock: { lamport: -1, clientId: "c" } })],
      ["a missing required field", () => ({ ...mutate, entityId: undefined })],
      ["a field name that isn't an identifier", () => ({ ...mutate, field: "__proto__" })],
      ["an object as a value", () => ({ ...mutate, value: { nested: true } })],
      ["a value over the text cap", () => ({ ...mutate, value: tooLong(LIMITS.text) })],
      ["CREATE initialValues of the wrong shape", () => ({ ...createCard(), initialValues: "nope" })],
      ["a CRDT_UPDATE that isn't base64", () => ({ type: "CRDT_UPDATE", columnId, update: "not base64!" })],
      ["a CRDT_UPDATE over the base64 cap", () => ({ type: "CRDT_UPDATE", columnId, update: "A".repeat(LIMITS.updateBase64 + 4) })],
      ["a CRDT_UPDATE that isn't a Yjs update", () => ({ type: "CRDT_UPDATE", columnId, update: "AQ==" })],
      ["a PRESENCE with a missing cardId", () => ({ type: "PRESENCE", clientId: "c", name: "n", color: "#000" })],
      ["an unknown message type", () => ({ type: "WAT" })],
    ];

    test.each(cases)("%s", async (_name, build) => {
      const id = randomUUID();
      sendJson(sender, { ...build(), messageId: id });

      const ack = await sender.waitFor(isAck(id));
      expect(ack.error).toMatch(/^invalid message/);
      expect(ack.error!.length).toBeLessThanOrEqual(200);
      expect(server.hasExited()).toBe(false);
      expect((await sender.sync()).columns.length).toBeGreaterThan(0); // same socket, still served
      await observerCaughtUp();
      expect(observer.received.filter((m) => m.type !== "PRESENCE")).toEqual([]); // nothing was relayed
    });

    test("one past the messageId cap can't be ACKed (there is no sane id to echo), but is still refused", async () => {
      sendJson(sender, { ...mutate, clock: undefined, messageId: tooLong(LIMITS.messageId) });
      const before = sender.received.length;
      await sender.sync();
      expect(sender.received.slice(before).map((m) => m.type)).toEqual(["SYNC_RESPONSE"]);
    });

    test("the violation is logged, without the payload", async () => {
      const marker = `payload-${randomUUID()}`;
      const id = randomUUID();
      sendJson(sender, { ...mutate, clock: undefined, value: marker, messageId: id });
      await sender.waitFor(isAck(id));
      expect(server.output()).toMatch(/\[violation\] conn=\d+ \S+ MUTATE|\[violation\] conn=\d+ \S+ frame: MUTATE: clock/);
      expect(server.output()).not.toContain(marker);
    });
  });

  test("unknown extra fields are stripped, not rejected: the message is handled and relayed without them", async () => {
    const logBefore = server.output().length;
    const id = randomUUID();
    sendJson(sender, {
      ...createCard(id),
      futureField: { anything: true },
      initialValues: { ...cardValues(), id: "not-the-entity-id", colour: "red" },
    });

    const ack = await sender.waitFor(isAck(id));
    expect(ack.error).toBeUndefined();
    const relayed = (await observer.waitFor((m) => m.type === "CREATE" && m.entityId === cardId)) as Extract<ServerMessage, { type: "CREATE" }>;
    expect("futureField" in relayed).toBe(false);
    expect("colour" in relayed.initialValues).toBe(false);
    expect("id" in relayed.initialValues).toBe(false);

    const card = (await sender.sync()).cards.find((c) => c.id === cardId);
    expect(card).toMatchObject({ id: cardId, title: "original" });
    expect(card && "colour" in card).toBe(false);

    // And on a MUTATE: a client-sent updatedAt is not the server's updatedAt.
    const edit = randomUUID();
    sendJson(sender, {
      type: "MUTATE",
      entityType: "card",
      entityId: cardId,
      field: "title",
      value: "edited",
      clock: clock(5),
      updatedAt: "1999-01-01T00:00:00.000Z",
      somethingNew: 1,
      messageId: edit,
    });
    expect((await sender.waitFor(isAck(edit))).error).toBeUndefined();
    const mutated = (await observer.waitFor((m) => m.type === "MUTATE" && m.entityId === cardId)) as Extract<ServerMessage, { type: "MUTATE" }>;
    expect(mutated.value).toBe("edited");
    expect(mutated.updatedAt).not.toBe("1999-01-01T00:00:00.000Z");
    expect(Number.isNaN(Date.parse(mutated.updatedAt!))).toBe(false);
    expect("somethingNew" in mutated).toBe(false);
    expect(server.output().slice(logBefore)).not.toContain("[violation]"); // not a violation, either
  });

  test("a MUTATE without a clock is rejected before it mutates anything", async () => {
    // The hole this closes: a field that has never been written has no clock to
    // lose to, so a clock-less MUTATE used to be applied, broadcast and persisted.
    sender.send(createCard());
    await sender.sync(); // handled, in order
    const id = randomUUID();
    sendJson(sender, {
      type: "MUTATE",
      entityType: "card",
      entityId: cardId,
      field: "title",
      value: "hijacked",
      messageId: id,
    });

    expect((await sender.waitFor(isAck(id))).error).toBeTruthy();
    const state = await sender.sync();
    expect(state.cards.find((c) => c.id === cardId)?.title).toBe("original");
    expect(`${cardId}:title` in (state.fieldClocks ?? {})).toBe(false); // no clock was recorded either
    await observerCaughtUp();
    expect(observer.received.some((m) => m.type === "MUTATE")).toBe(false); // not relayed
    expect((await readCardRow(server.databaseUrl, cardId))?.title).toBe("original"); // nor persisted
    expect(server.output()).not.toContain("DB write failed");
  });

  test("a CREATE for a card with no clock creates nothing", async () => {
    const id = randomUUID();
    sendJson(sender, { ...createCard(), clock: undefined, messageId: id });
    expect((await sender.waitFor(isAck(id))).error).toBeTruthy();
    expect((await sender.sync()).cards.some((c) => c.id === cardId)).toBe(false);
    expect(await readCardRow(server.databaseUrl, cardId)).toBeNull();
  });

  test("a frame over maxPayload is refused by ws: the socket is closed with 1009 and the server keeps serving", async () => {
    sender.sendRaw(JSON.stringify({ type: "PRESENCE", clientId: "c", name: "x".repeat(1024 * 1024 + 1), color: "#000", cardId: null }));
    expect(await sender.waitForClose()).toBe(1009);
    // ws raises an 'error' event on the server's socket for this; unhandled, it would end the process.
    expect(server.hasExited()).toBe(false);
    const probe = await Peer.connect(server.url);
    expect((await probe.sync()).columns.length).toBeGreaterThan(0);
    probe.close();
  });
});
