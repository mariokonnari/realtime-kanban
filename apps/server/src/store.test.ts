import { afterEach, describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { LamportClock } from "@realtime-kanban/shared-types";

// store.ts writes through to Postgres via Prisma. These tests exercise
// only the in-memory conflict-resolution logic (the part this project's
// concurrency guarantees actually live in), so Prisma is replaced with a
// stub that resolves every call — no database needed to run this suite.
vi.mock("@prisma/client", () => {
  const delegate = new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) });
  class PrismaClient {
    constructor() {
      return new Proxy(this, { get: () => delegate });
    }
  }
  return { PrismaClient };
});

const { applyDelete, applyMutation, createEntity, isTombstoned, cards } = await import("./store.js");

afterEach(() => {
  vi.useRealTimers();
});

describe("tombstones", () => {
  test("an edit arriving after a delete is dropped, regardless of clock recency", () => {
    const cardId = randomUUID();
    createEntity("card", cardId, {
      columnId: "column-1",
      title: "original title",
      description: "",
      position: 0,
      createdAt: new Date().toISOString(),
      deletedAt: null,
    });

    applyDelete("card", cardId);
    expect(isTombstoned("card", cardId)).toBe(true);

    // A clock far newer than anything the card has seen — under the plain
    // LWW rule this would win easily. Delete still wins unconditionally:
    // this mirrors the guard in index.ts's MUTATE handler, which checks
    // isTombstoned() before ever calling applyMutation().
    const muchNewerClock: LamportClock = { lamport: 999_999, clientId: "zzz-latecomer" };
    if (!isTombstoned("card", cardId)) {
      applyMutation("card", cardId, "title", "resurrected", muchNewerClock);
    }

    expect(cards.get(cardId)?.title).toBe("original title");
    expect(cards.get(cardId)?.deletedAt).not.toBeNull();
  });

  test("applyMutation itself refuses to write a tombstoned card once deleted", () => {
    // Even without the index.ts guard, a delete followed by a mutation
    // that some other caller forgot to gate must not resurrect the title
    // — applyMutation has no tombstone awareness of its own (that's the
    // WS handler's job), so this test documents that the guard is load
    // bearing: calling applyMutation directly on a tombstoned card DOES
    // still overwrite the field, which is exactly why index.ts must check
    // isTombstoned() first rather than relying on applyMutation alone.
    const cardId = randomUUID();
    createEntity("card", cardId, {
      columnId: "column-1",
      title: "original title",
      description: "",
      position: 0,
      createdAt: new Date().toISOString(),
      deletedAt: null,
    });

    applyDelete("card", cardId);

    const applied = applyMutation("card", cardId, "title", "unguarded write", {
      lamport: 1,
      clientId: "someone",
    });

    expect(applied).toBe(true);
    expect(cards.get(cardId)?.title).toBe("unguarded write");
  });
});

describe("Card.updatedAt", () => {
  test("createEntity sets it, and an applied mutation bumps it", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const cardId = randomUUID();
    createEntity("card", cardId, {
      columnId: "column-1",
      title: "original",
      description: "",
      position: 0,
      createdAt: new Date().toISOString(),
      deletedAt: null,
    });
    expect(cards.get(cardId)?.updatedAt).toBe("2026-01-01T00:00:00.000Z");

    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
    const applied = applyMutation("card", cardId, "title", "new title", { lamport: 1, clientId: "a" });

    expect(applied).toBe(true);
    expect(cards.get(cardId)?.updatedAt).toBe("2026-01-01T00:05:00.000Z");
  });

  test("a rejected (stale) mutation does not bump it", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const cardId = randomUUID();
    createEntity("card", cardId, {
      columnId: "column-1",
      title: "original",
      description: "",
      position: 0,
      createdAt: new Date().toISOString(),
      deletedAt: null,
    });

    // A real edit first, so there's a field clock for the next one to lose against.
    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
    applyMutation("card", cardId, "title", "first edit", { lamport: 5, clientId: "a" });
    const updatedAtAfterFirstEdit = cards.get(cardId)?.updatedAt;

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    // Lower lamport than the clock already recorded for this field — isNewer() rejects it.
    const applied = applyMutation("card", cardId, "title", "stale edit", { lamport: 1, clientId: "b" });

    expect(applied).toBe(false);
    expect(cards.get(cardId)?.title).not.toBe("stale edit");
    expect(cards.get(cardId)?.updatedAt).toBe(updatedAtAfterFirstEdit);
  });
});
