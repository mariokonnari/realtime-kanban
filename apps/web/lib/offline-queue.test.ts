import { describe, expect, test } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { ClientMessage } from "@realtime-kanban/shared-types";
import { OfflineQueue, isDurable, type DurableMessage } from "./offline-queue";

function mutate(title: string, lamport: number): DurableMessage {
  return {
    type: "MUTATE",
    entityType: "card",
    entityId: "card-1",
    field: "title",
    value: title,
    clock: { lamport, clientId: "client-a" },
  };
}

describe("OfflineQueue", () => {
  test("entries survive a simulated reload, read back via a fresh connection in insertion order", async () => {
    const factory = new IDBFactory();
    const before = new OfflineQueue(factory);
    await before.add(mutate("first", 1));
    await before.add(mutate("second", 2));
    await before.add(mutate("third", 3));
    await before.close(); // the page unloads; only what's in IndexedDB remains

    const after = new OfflineQueue(factory);
    const entries = await after.readAll();

    expect(entries.map((e) => (e.message as { value: string }).value)).toEqual(["first", "second", "third"]);
    const keys = entries.map((e) => e.key);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
  });

  test("remove deletes only that entry and tolerates a key that's already gone", async () => {
    const queue = new OfflineQueue(new IDBFactory());
    const k1 = await queue.add(mutate("first", 1));
    await queue.add(mutate("second", 2));

    await queue.remove(k1);
    await queue.remove(k1);

    const remaining = await queue.readAll();
    expect(remaining.map((e) => (e.message as { value: string }).value)).toEqual(["second"]);
  });

  test("keys keep increasing after earlier entries are removed, so order can't be reshuffled", async () => {
    const queue = new OfflineQueue(new IDBFactory());
    const k1 = await queue.add(mutate("first", 1));
    await queue.remove(k1);
    const k2 = await queue.add(mutate("second", 2));
    expect(k2).toBeGreaterThan(k1);
  });

  test("rejects rather than throwing synchronously when IndexedDB is unavailable", async () => {
    const queue = new OfflineQueue(undefined);
    await expect(queue.readAll()).rejects.toThrow(/not available/);
  });
});

describe("isDurable", () => {
  test("queues only state-changing messages", () => {
    const durable: ClientMessage[] = [
      mutate("x", 1),
      { type: "CREATE", entityType: "card", entityId: "c", initialValues: {}, clock: { lamport: 1, clientId: "a" } },
      { type: "DELETE", entityType: "card", entityId: "c", clock: { lamport: 1, clientId: "a" } },
      { type: "CRDT_UPDATE", columnId: "col", update: "AAA=" },
    ];
    const ephemeral: ClientMessage[] = [
      { type: "SYNC_REQUEST" },
      { type: "PRESENCE", clientId: "a", name: "Otter", color: "#fff", cardId: null },
    ];
    expect(durable.every(isDurable)).toBe(true);
    expect(ephemeral.some(isDurable)).toBe(false);
  });
});
