import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { e2eEnabled, startE2eServer, Peer, type E2eServer } from "./test-support/e2e-server.js";

// Real server, real WebSocket, throwaway localhost Postgres. Skipped when
// DATABASE_URL isn't a localhost database.
//
// Documents the protocol: when applyMutation rejects a stale write, the server
// says nothing to the sender, and SYNC_RESPONSE carries the winning clocks.
// Clients converge anyway because they compare clocks themselves — see
// apps/web/lib/convergence.e2e.test.tsx.

describe.skipIf(!e2eEnabled)("a rejected LWW write (e2e, localhost only)", () => {
  let server: E2eServer;

  beforeAll(async () => {
    server = await startE2eServer();
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  test("the sender of a stale MUTATE receives no reply about it", async () => {
    const winner = await Peer.connect(server.url);
    const loser = await Peer.connect(server.url);
    const { columns } = await winner.sync();
    const cardId = randomUUID();
    winner.send({
      type: "CREATE",
      entityType: "card",
      entityId: cardId,
      initialValues: {
        columnId: columns[0].id,
        title: "original",
        description: "",
        position: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      },
      clock: { lamport: 1, clientId: "winner" },
    });
    winner.send({
      type: "MUTATE",
      entityType: "card",
      entityId: cardId,
      field: "title",
      value: "from the winner",
      clock: { lamport: 10, clientId: "winner" },
    });
    await loser.waitFor((m) => m.type === "MUTATE" && m.entityId === cardId);

    const before = loser.received.length;
    loser.send({
      type: "MUTATE",
      entityType: "card",
      entityId: cardId,
      field: "title",
      value: "from the loser",
      clock: { lamport: 3, clientId: "loser" },
    });
    // Same socket, handled in order: once this response is back, the stale
    // MUTATE above has been handled too.
    const sync = await loser.sync();

    expect(sync.cards.find((c) => c.id === cardId)?.title).toBe("from the winner"); // it really was rejected
    expect(sync.fieldClocks?.[`${cardId}:title`]).toEqual({ lamport: 10, clientId: "winner" }); // and the winner's clock is in the sync
    expect(loser.received.slice(before).map((m) => m.type)).toEqual(["SYNC_RESPONSE"]); // and nothing told the sender
    winner.close();
    loser.close();
  });
});
