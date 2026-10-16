import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { e2eEnabled, startE2eServer, Peer, readCardRow, waitForRow, type E2eServer } from "./test-support/e2e-server.js";

// Drives the real server process over a real WebSocket against a throwaway
// Postgres database (localhost only — see test-support/e2e-server.ts). Skipped,
// like seed-order.test.ts, when DATABASE_URL isn't a localhost database.
//
// A CREATE for an id the server already has — live or tombstoned — is ignored:
// no overwrite, no rebroadcast, no DB write. (Before this was fixed the
// replay overwrote the card, was rebroadcast, and then the DB's primary-key
// violation went unhandled and killed the whole server process.)

describe.skipIf(!e2eEnabled)("duplicate CREATE for an existing id (e2e, localhost only)", () => {
  let server: E2eServer;
  let creator: Peer;
  let observer: Peer;
  let cardId: string;

  beforeEach(async () => {
    server = await startE2eServer();
    creator = await Peer.connect(server.url);
    observer = await Peer.connect(server.url);
    const { columns } = await creator.sync();
    cardId = randomUUID();
    creator.send(create(columns[0].id, "original", "original description"));
    await observer.waitFor((m) => m.type === "CREATE" && m.entityId === cardId);
  }, 60_000);

  afterEach(async () => {
    creator.close();
    observer.close();
    await server.stop();
  });

  function create(columnId: string, title: string, description: string) {
    return {
      type: "CREATE" as const,
      entityType: "card" as const,
      entityId: cardId,
      initialValues: {
        columnId,
        title,
        description,
        position: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      },
      clock: { lamport: 1, clientId: "creator" },
    };
  }

  /** The replay: same id, different fields, sent after the original was handled. */
  async function replayCreate() {
    const { columns } = await creator.sync();
    creator.send(create(columns[0].id, "REPLAYED", "replayed description"));
  }

  test("the existing card's fields are left unchanged", async () => {
    await replayCreate();
    // Same socket, so the server handles this after the replay: a deterministic
    // read of its in-memory state, taken before any DB failure can matter.
    const card = (await creator.sync()).cards.find((c) => c.id === cardId);
    expect(card?.title).toBe("original");
    expect(card?.description).toBe("original description");
  });

  test("nothing is rebroadcast to other clients", async () => {
    await replayCreate();
    creator.send({ type: "PRESENCE", clientId: "creator", name: "n", color: "#000", cardId: "marker" });
    await observer.barrier("marker");
    const creates = observer.received.filter((m) => m.type === "CREATE" && m.entityId === cardId);
    expect(creates).toHaveLength(1); // the original only
  });

  test("the server process survives, and the replay never reaches the database", async () => {
    await replayCreate();
    await Promise.race([server.exited, new Promise((r) => setTimeout(r, 1500))]);
    expect(server.hasExited(), server.output().split("\n").find((l) => l.includes("Error")) ?? "").toBe(false);
    expect(server.output()).not.toContain("DB write failed");
  });

  test("a replayed CREATE for a deleted card does not resurrect it", async () => {
    creator.send({ type: "DELETE", entityType: "card", entityId: cardId, clock: { lamport: 2, clientId: "creator" } });
    await observer.waitFor((m) => m.type === "DELETE" && m.entityId === cardId);
    await replayCreate();
    const state = await creator.sync();
    expect(state.cards.find((c) => c.id === cardId)).toBeUndefined();
    expect(observer.received.filter((m) => m.type === "CREATE" && m.entityId === cardId)).toHaveLength(1);
  });

  test("...including after a restart, when the tombstone has to come back from Postgres", async () => {
    creator.send({ type: "DELETE", entityType: "card", entityId: cardId, clock: { lamport: 2, clientId: "creator" } });
    await observer.waitFor((m) => m.type === "DELETE" && m.entityId === cardId);
    await waitForRow(server.databaseUrl, cardId, (row) => row?.deletedAt != null); // persisted, not just in memory

    await server.restart();
    creator.close();
    observer.close();
    creator = await Peer.connect(server.url);
    observer = await Peer.connect(server.url);
    expect((await creator.sync()).cards.find((c) => c.id === cardId)).toBeUndefined(); // tombstoned cards aren't served

    await replayCreate();
    const state = await creator.sync();
    expect(state.cards.find((c) => c.id === cardId)).toBeUndefined();
    const row = await readCardRow(server.databaseUrl, cardId);
    expect(row?.title).toBe("original"); // the replay didn't touch the stored row either
    expect(row?.deletedAt).not.toBeNull();
    await new Promise((r) => setTimeout(r, 500)); // long enough for a (wrongly) attempted write to fail and log
    expect(server.hasExited()).toBe(false);
    expect(server.output()).not.toContain("DB write failed");
  });
});
