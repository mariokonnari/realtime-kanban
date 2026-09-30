import { describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { ClientMessage, MutateMessage } from "@realtime-kanban/shared-types";

// Same Prisma stub as store.test.ts — only the in-memory LWW logic is under test.
vi.mock("@prisma/client", () => {
  const delegate = new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) });
  class PrismaClient {
    constructor() {
      return new Proxy(this, { get: () => delegate });
    }
  }
  return { PrismaClient };
});

const { applyMutation, createEntity, cards } = await import("./store.js");

// A message the web client queued in IndexedDB while offline and later
// replays: it's been through structured clone and JSON, nothing else. Its
// clock is whatever it was stamped with when the user made the edit.
function asReplayed(message: MutateMessage): MutateMessage {
  return JSON.parse(JSON.stringify(structuredClone(message))) as MutateMessage;
}

function apply(message: ClientMessage) {
  if (message.type !== "MUTATE") throw new Error("test only applies MUTATE");
  return applyMutation(message.entityType, message.entityId, message.field, message.value, message.clock);
}

function newCard() {
  const cardId = randomUUID();
  createEntity("card", cardId, {
    columnId: "column-1",
    title: "original",
    description: "",
    position: 0,
    createdAt: new Date().toISOString(),
    deletedAt: null,
  });
  return cardId;
}

function titleEdit(cardId: string, value: string, lamport: number, clientId: string): MutateMessage {
  return { type: "MUTATE", entityType: "card", entityId: cardId, field: "title", value, clock: { lamport, clientId } };
}

describe("replaying an offline-queued MUTATE needs no new conflict logic", () => {
  test("an old-clock edit replayed after a newer one already landed loses", () => {
    const cardId = newCard();
    const queuedOffline = asReplayed(titleEdit(cardId, "typed while offline", 3, "client-a"));

    // While client A was offline, client B's newer edit reached the server.
    expect(apply(titleEdit(cardId, "newer, from B", 5, "client-b"))).toBe(true);
    // A reconnects and replays.
    expect(apply(queuedOffline)).toBe(false);

    expect(cards.get(cardId)?.title).toBe("newer, from B");
  });

  test("the same replay wins when its clock is actually newer — replay order doesn't decide", () => {
    const cardId = newCard();
    const queuedOffline = asReplayed(titleEdit(cardId, "typed while offline", 9, "client-a"));

    apply(titleEdit(cardId, "older, from B", 5, "client-b"));
    expect(apply(queuedOffline)).toBe(true);

    expect(cards.get(cardId)?.title).toBe("typed while offline");
  });

  test("replaying the same queued edit twice is harmless", () => {
    const cardId = newCard();
    const queuedOffline = asReplayed(titleEdit(cardId, "once", 4, "client-a"));

    expect(apply(queuedOffline)).toBe(true);
    expect(apply(queuedOffline)).toBe(false);
    expect(cards.get(cardId)?.title).toBe("once");
  });
});
