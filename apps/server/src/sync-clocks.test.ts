import { describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Same Prisma stub as store.test.ts — only the in-memory state is under test.
vi.mock("@prisma/client", () => {
  const delegate = new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) });
  class PrismaClient {
    constructor() {
      return new Proxy(this, { get: () => delegate });
    }
  }
  return { PrismaClient };
});

const { applyDelete, applyMutation, createEntity, getFullState } = await import("./store.js");

function newCard() {
  const id = randomUUID();
  createEntity("card", id, {
    columnId: "column-1",
    title: "original",
    description: "",
    position: 0,
    createdAt: new Date().toISOString(),
    deletedAt: null,
  });
  return id;
}

describe("getFullState().fieldClocks", () => {
  test("carries the winning clock of every field applied to a card it sends", () => {
    const id = newCard();
    applyMutation("card", id, "title", "first", { lamport: 3, clientId: "a" });
    applyMutation("card", id, "title", "second", { lamport: 8, clientId: "b" });
    applyMutation("card", id, "description", "d", { lamport: 2, clientId: "a" });

    const { fieldClocks } = getFullState();

    expect(fieldClocks[`${id}:title`]).toEqual({ lamport: 8, clientId: "b" });
    expect(fieldClocks[`${id}:description`]).toEqual({ lamport: 2, clientId: "a" });
  });

  test("a rejected stale write leaves the clock alone", () => {
    const id = newCard();
    applyMutation("card", id, "title", "winner", { lamport: 9, clientId: "a" });
    applyMutation("card", id, "title", "stale", { lamport: 1, clientId: "b" });

    expect(getFullState().fieldClocks[`${id}:title`]).toEqual({ lamport: 9, clientId: "a" });
  });

  test("leaves out clocks for a tombstoned card, which the response doesn't send either", () => {
    const id = newCard();
    applyMutation("card", id, "title", "x", { lamport: 5, clientId: "a" });
    applyDelete("card", id);

    const state = getFullState();

    expect(state.cards.find((c) => c.id === id)).toBeUndefined();
    expect(Object.keys(state.fieldClocks).filter((k) => k.startsWith(`${id}:`))).toEqual([]);
  });
});
