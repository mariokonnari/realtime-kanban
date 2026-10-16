import { describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { decodeUpdate } from "@realtime-kanban/shared-types";

// The store wrapper around repairColumnOrders(): the real maps, Prisma stubbed (as in
// store.test.ts), so no database is needed. It hands back one update per changed column.
vi.mock("@prisma/client", () => {
  const delegate = new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) });
  class PrismaClient {
    constructor() {
      return new Proxy(this, { get: () => delegate });
    }
  }
  return { PrismaClient };
});

const { createEntity, applyMutation, applyDelete, columnDocFor, repairStoredOrders } = await import("./store.js");

function newColumn() {
  const id = randomUUID();
  createEntity("column", id, { boardId: "b", title: id, order: 0 });
  return id;
}
function newCard(columnId: string) {
  const id = randomUUID();
  createEntity("card", id, { columnId, title: id, description: "", position: 0, createdAt: "", deletedAt: null });
  return id;
}
const orderOf = (columnId: string) => columnDocFor(columnId)!.getArray<string>("cardOrder").toArray();
const push = (columnId: string, ...ids: string[]) => columnDocFor(columnId)!.getArray<string>("cardOrder").push(ids);

describe("repairStoredOrders", () => {
  test("repairs the store's own docs and returns an update only for the column it changed", () => {
    const a = newColumn();
    const b = newColumn();
    const x = newCard(a);
    const other = newCard(a);
    push(a, other);

    // Two concurrent moves of x arrive: a no longer lists it, and b lists it twice.
    push(b, x, x);
    applyMutation("card", x, "columnId", b, { lamport: 5, clientId: "c" });

    const updates = repairStoredOrders();
    expect(updates.map((u) => u.columnId)).toEqual([b]);
    expect(orderOf(b)).toEqual([x]);
    expect(orderOf(a)).toEqual([other]);
  });

  test("the update, applied to a replica that still holds the duplicate, removes it", () => {
    const col = newColumn();
    const x = newCard(col);

    // Two clients each insert x; both inserts reach the server and a third replica.
    const one = new Y.Doc();
    const two = new Y.Doc();
    one.getArray<string>("cardOrder").push([x]);
    two.getArray<string>("cardOrder").push([x]);
    const server = columnDocFor(col)!;
    Y.applyUpdate(server, Y.encodeStateAsUpdate(one));
    Y.applyUpdate(server, Y.encodeStateAsUpdate(two));
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(server));
    expect(replica.getArray<string>("cardOrder").toArray()).toEqual([x, x]);

    const updates = repairStoredOrders();
    expect(updates.map((u) => u.columnId)).toEqual([col]);
    Y.applyUpdate(replica, decodeUpdate(updates[0].update));
    expect(replica.getArray<string>("cardOrder").toArray()).toEqual([x]);
    expect(replica.getArray<string>("cardOrder").toArray()).toEqual(orderOf(col));
  });

  test("is idempotent: a second call returns nothing", () => {
    const col = newColumn();
    const x = newCard(col);
    push(col, x, x, x);
    expect(repairStoredOrders().map((u) => u.columnId)).toEqual([col]);
    expect(repairStoredOrders()).toEqual([]);
    expect(orderOf(col)).toEqual([x]);
  });

  test("leaves a tombstoned card's entries alone", () => {
    const col = newColumn();
    const x = newCard(col);
    push(col, x, x);
    applyDelete("card", x);
    expect(repairStoredOrders()).toEqual([]);
    expect(orderOf(col)).toEqual([x, x]);
  });

  test("does nothing while the card's columnId column has no entry, then acts when it arrives", () => {
    const a = newColumn();
    const b = newColumn();
    const x = newCard(a);
    push(a, x, x);
    applyMutation("card", x, "columnId", b, { lamport: 9, clientId: "c" }); // the MUTATE of a move to b
    expect(repairStoredOrders()).toEqual([]);
    expect(orderOf(a)).toEqual([x, x]);

    push(b, x); // the move's insert
    expect(repairStoredOrders().map((u) => u.columnId)).toEqual([a]);
    expect(orderOf(a)).toEqual([]);
    expect(orderOf(b)).toEqual([x]);
  });
});
