import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import type { AckMessage, ClientMessage, ServerMessage, SyncResponseMessage } from "@realtime-kanban/shared-types";
import { e2eEnabled, startE2eServer, Peer, type E2eServer } from "./test-support/e2e-server.js";

// The per-connection rate limiter and violation handling, against the real
// server with small limits (set through WS_* variables) so they can be reached
// in a test. The default limits are exercised by validation.e2e.test.ts (a
// 500-message replay) and ack.e2e.test.ts. Skipped without a localhost Postgres.
//
// Here: burst 20, then 500/s; a backlog of at most 150; 3 violations close the
// connection.

// A message that can carry a messageId.
type Durable = Extract<ClientMessage, { type: "MUTATE" | "CREATE" | "DELETE" | "CRDT_UPDATE" }>;
const idOf = (m: ClientMessage) => ("messageId" in m ? m.messageId : undefined);
const isAck = (id: string) => (m: ServerMessage): m is AckMessage => m.type === "ACK" && m.messageId === id;
const acks = (peer: Peer) => peer.received.filter((m): m is AckMessage => m.type === "ACK");

describe.skipIf(!e2eEnabled)("rate limiting and violations (e2e, localhost only)", () => {
  let server: E2eServer;

  beforeAll(async () => {
    server = await startE2eServer({
      env: { WS_RATE_BURST: "20", WS_RATE_PER_SEC: "500", WS_MAX_BACKLOG: "150", WS_MAX_VIOLATIONS: "3" },
    });
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  const clock = (lamport: number) => ({ lamport, clientId: "sender" });
  const invalid = (messageId?: string) =>
    JSON.stringify({ type: "MUTATE", entityType: "card", entityId: "a", field: "title", value: "v", ...(messageId ? { messageId } : {}) });

  describe("a burst past the bucket is delayed, not dropped, and per-socket order is unchanged", () => {
    test("every message is handled, in the order sent: a SYNC_REQUEST sees exactly what came before it", async () => {
      const peer = await Peer.connect(server.url);
      const { columns } = await peer.sync();
      const columnId = columns[0].id;
      const logBefore = server.output().length;

      const card = (n: number) => `${runId}-${n}`;
      const runId = randomUUID();
      const create = (n: number): Durable => ({
        type: "CREATE",
        entityType: "card",
        entityId: card(n),
        initialValues: { columnId, title: `card ${n}`, description: "", position: 0, createdAt: new Date().toISOString() },
        clock: clock(1),
        messageId: `create-${runId}-${n}`,
      });
      const edit = (n: number): Durable => ({
        type: "MUTATE",
        entityType: "card",
        entityId: card(n),
        field: "title",
        value: `edited ${n}`,
        clock: clock(2),
        messageId: `edit-${runId}-${n}`,
      });

      // 1 + 40 + 1 + 40 + 40 = 122 frames in one burst against a bucket of 20:
      // ~100 of them are delayed. A MUTATE overtaking the CREATE it depends on
      // would be dropped; a SYNC_REQUEST overtaken (or overtaking) would list
      // the wrong cards.
      const sent: ClientMessage[] = [{ type: "SYNC_REQUEST" }];
      for (let n = 0; n < 40; n++) sent.push(create(n));
      sent.push({ type: "SYNC_REQUEST" });
      for (let n = 40; n < 80; n++) sent.push(create(n));
      for (let n = 0; n < 40; n++) sent.push(edit(n));
      const firstSync = peer.received.length; // everything from here on is this burst's
      for (const message of sent) peer.send(message);

      const lastId = idOf(sent[sent.length - 1])!;
      await peer.waitFor(isAck(lastId), 15_000);
      const received = peer.received.slice(firstSync);

      // It really went through the delay path…
      expect(server.output().slice(logBefore)).toContain("[rate limit]");
      expect(server.output().slice(logBefore)).toContain("delaying messages, in order");
      // …and nothing was dropped or refused: all 80 CREATEs and 40 MUTATEs ACKed, none with an error.
      const ackIds = received.filter((m): m is AckMessage => m.type === "ACK");
      expect(ackIds.filter((a) => a.error)).toEqual([]);
      // ACKs come back in the order the messages were sent.
      expect(ackIds.map((a) => a.messageId)).toEqual(sent.flatMap((m) => idOf(m) ?? []));

      // The first SYNC_REQUEST was handled before everything behind it: its
      // response precedes every ACK (the client's no-ACK-support fallback relies on this).
      const firstResponse = received.findIndex((m) => m.type === "SYNC_RESPONSE");
      const firstAck = received.findIndex((m) => m.type === "ACK");
      expect(firstResponse).toBeGreaterThanOrEqual(0);
      expect(firstResponse).toBeLessThan(firstAck);

      // The second SYNC_REQUEST sat between cards 39 and 40: it lists 0..39 and no more.
      const responses = received.filter((m): m is SyncResponseMessage => m.type === "SYNC_RESPONSE");
      expect(responses).toHaveLength(2);
      const mine = (r: SyncResponseMessage) => r.cards.filter((c) => c.id.startsWith(runId)).map((c) => c.id).sort();
      expect(mine(responses[0])).toEqual([]);
      expect(mine(responses[1])).toEqual(Array.from({ length: 40 }, (_, n) => card(n)).sort());

      // And the MUTATEs found their CREATEs.
      const final = await peer.sync();
      for (let n = 0; n < 40; n++) expect(final.cards.find((c) => c.id === card(n))?.title).toBe(`edited ${n}`);
      for (let n = 40; n < 80; n++) expect(final.cards.find((c) => c.id === card(n))?.title).toBe(`card ${n}`);
      peer.close();
    }, 30_000);
  });

  test("past the backlog cap the socket is closed; what was handled was ACKed, in order, and the rest replays", async () => {
    const peer = await Peer.connect(server.url);
    const logBefore = server.output().length;
    const ids = Array.from({ length: 600 }, () => randomUUID());
    for (const id of ids) {
      peer.send({ type: "PRESENCE", clientId: "flood", name: "n", color: "#000", cardId: null, messageId: id } as unknown as ClientMessage);
    }

    expect(await peer.waitForClose()).toBe(1013);
    expect(server.output().slice(logBefore)).toContain("closing; unACKed messages replay on reconnect");
    expect(server.hasExited()).toBe(false);

    // Handled strictly in order: what was ACKed is a prefix of what was sent.
    const acked = acks(peer).map((a) => a.messageId);
    expect(acked.length).toBeGreaterThanOrEqual(20); // at least the burst
    expect(acked.length).toBeLessThan(ids.length);
    expect(acked).toEqual(ids.slice(0, acked.length));

    // The first one that wasn't ACKed is accepted when it is sent again on a new connection, as the client would.
    const retry = await Peer.connect(server.url);
    retry.send({ type: "PRESENCE", clientId: "flood", name: "n", color: "#000", cardId: null, messageId: ids[acked.length] } as unknown as ClientMessage);
    expect((await retry.waitFor(isAck(ids[acked.length]))).error).toBeUndefined();
    retry.close();
  });

  describe("violations", () => {
    test("repeated ones close the connection — after the errors have been ACKed, so the client drops those entries", async () => {
      const peer = await Peer.connect(server.url);
      const logBefore = server.output().length;
      const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      for (const id of ids) peer.sendRaw(invalid(id));

      expect(await peer.waitForClose()).toBe(1008);
      // Three violations (the limit) closed it; the first three were each told why.
      expect(acks(peer).map((a) => a.messageId)).toEqual(ids.slice(0, 3));
      expect(acks(peer).every((a) => a.error)).toBe(true);
      const log = server.output().slice(logBefore);
      expect(log).toContain("(3/3)");
      expect(log).toContain("closing: 3 violations");
      expect(server.hasExited()).toBe(false);
    });

    test("frames with no messageId count too", async () => {
      const peer = await Peer.connect(server.url);
      peer.sendRaw("{nope");
      peer.sendRaw(invalid());
      peer.sendRaw('"a string"');
      expect(await peer.waitForClose()).toBe(1008);
    });

    test("a rejected message the client replays after reconnecting is not counted against it again", async () => {
      // The error ACK for `replayed` is lost with the first connection (the client
      // never saw it), so on the next one the same entry arrives again.
      const replayed = randomUUID();
      const first = await Peer.connect(server.url);
      first.sendRaw(invalid(replayed));
      await first.waitFor(isAck(replayed));
      first.close();

      const second = await Peer.connect(server.url);
      const logBefore = server.output().length;
      second.sendRaw(invalid(replayed)); // forgiven: 0 of 3
      expect((await second.waitFor(isAck(replayed))).error).toBeTruthy(); // still told to drop it
      second.sendRaw(invalid(randomUUID())); // 1
      second.sendRaw(invalid(randomUUID())); // 2
      await second.sync(); // handled in order, so all three above have been
      expect(second.closeCode).toBeUndefined(); // open: without the exemption this is already violation 3
      expect(server.output().slice(logBefore)).toContain("replay of an already-rejected message, not counted");

      second.sendRaw(invalid(randomUUID())); // 3
      expect(await second.waitForClose()).toBe(1008);
    });

    test("but resending the same rejected id on the same connection is a repeat, and so is a third connection's", async () => {
      const id = randomUUID();
      const same = await Peer.connect(server.url);
      same.sendRaw(invalid(id));
      same.sendRaw(invalid(id));
      same.sendRaw(invalid(id));
      expect(await same.waitForClose()).toBe(1008); // three counted: no free pass on one connection

      const other = randomUUID();
      for (let connection = 0; connection < 3; connection++) {
        const peer = await Peer.connect(server.url);
        peer.sendRaw(invalid(other));
        await peer.waitFor(isAck(other));
        peer.close();
      }
      // `other` was forgiven once (its second connection); the third counted.
      const probe = await Peer.connect(server.url);
      const logBefore = server.output().length;
      probe.sendRaw(invalid(other));
      await probe.waitFor(isAck(other));
      expect(server.output().slice(logBefore)).not.toContain("not counted"); // the one free pass is spent
      probe.close();
    });
  });
});
