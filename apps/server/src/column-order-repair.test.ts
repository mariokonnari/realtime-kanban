import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { ORDER_ARRAY, repairColumnOrders, type RepairableCard } from "./column-order-repair.js";

// repairColumnOrders() is pure over Y.Docs and cards, so none of this needs a server
// or a database.

const docWith = (ids: string[]) => {
  const doc = new Y.Doc();
  doc.getArray<string>(ORDER_ARRAY).push(ids);
  return doc;
};
const orderOf = (doc: Y.Doc) => doc.getArray<string>(ORDER_ARRAY).toArray();
const board = (columns: Record<string, string[]>) => new Map(Object.entries(columns).map(([id, ids]) => [id, docWith(ids)]));
const orders = (docs: Map<string, Y.Doc>) => Object.fromEntries([...docs].map(([id, doc]) => [id, orderOf(doc)]));
const card = (id: string, columnId: string, deletedAt: string | null = null): RepairableCard => ({ id, columnId, deletedAt });

describe("repairColumnOrders", () => {
  test("a card listed twice in its own column keeps its first entry", () => {
    const docs = board({ a: ["p", "x", "q", "x"], b: [] });
    expect(repairColumnOrders(docs, [card("p", "a"), card("x", "a"), card("q", "a")])).toEqual(["a"]);
    expect(orders(docs)).toEqual({ a: ["p", "x", "q"], b: [] });
  });

  test("entries in other columns are deleted, and the one in the columnId column is kept", () => {
    const docs = board({ a: ["p"], b: ["x"], c: ["x"] });
    repairColumnOrders(docs, [card("p", "a"), card("x", "c")]);
    expect(orders(docs)).toEqual({ a: ["p"], b: [], c: ["x"] });
  });

  test("a mix: duplicates in the right column and in two others, in one pass", () => {
    const docs = board({ a: ["x", "p", "x"], b: ["x", "q"], c: ["r", "x"] });
    repairColumnOrders(docs, [card("p", "a"), card("q", "b"), card("r", "c"), card("x", "b")]);
    expect(orders(docs)).toEqual({ a: ["p"], b: ["x", "q"], c: ["r"] });
  });

  test("returns only the columns it changed, and does not touch the others", () => {
    const docs = board({ a: ["p"], b: ["x", "x"], c: ["q"] });
    const untouched = Y.encodeStateAsUpdate(docs.get("c")!);
    expect(repairColumnOrders(docs, [card("p", "a"), card("x", "b"), card("q", "c")])).toEqual(["b"]);
    expect(Y.encodeStateAsUpdate(docs.get("c")!)).toEqual(untouched);
  });

  test("is idempotent: the second run changes nothing and says so", () => {
    const docs = board({ a: ["x", "p", "x"], b: ["x"] });
    const cards = [card("p", "a"), card("x", "a")];
    expect(repairColumnOrders(docs, cards)).toEqual(["a", "b"]);
    const after = Y.encodeStateAsUpdate(docs.get("a")!);
    const afterB = Y.encodeStateAsUpdate(docs.get("b")!);
    expect(repairColumnOrders(docs, cards)).toEqual([]);
    expect(orders(docs)).toEqual({ a: ["x", "p"], b: [] });
    expect(Y.encodeStateAsUpdate(docs.get("a")!)).toEqual(after);
    expect(Y.encodeStateAsUpdate(docs.get("b")!)).toEqual(afterB);
  });

  test("deletions only: the state vector is unchanged and the survivors keep their order", () => {
    const docs = board({ a: ["x", "p", "x", "q", "x"], b: ["r", "x"] });
    const vectors = new Map([...docs].map(([id, doc]) => [id, Y.encodeStateVector(doc)]));
    const before = orders(docs);
    repairColumnOrders(docs, [card("p", "a"), card("q", "a"), card("r", "b"), card("x", "a")]);
    for (const [id, doc] of docs) {
      expect(Y.encodeStateVector(doc)).toEqual(vectors.get(id));
      // what is left is the old array with some entries removed: same relative order
      const remaining = orderOf(doc);
      let at = 0;
      for (const cardId of before[id]) if (cardId === remaining[at]) at++;
      expect(at).toBe(remaining.length);
    }
  });

  describe("never deletes a card's only entry", () => {
    test("one entry, in the right column", () => {
      const docs = board({ a: ["x"], b: [] });
      expect(repairColumnOrders(docs, [card("x", "a")])).toEqual([]);
      expect(orders(docs)).toEqual({ a: ["x"], b: [] });
    });

    test("one entry, in the wrong column", () => {
      const docs = board({ a: [], b: ["x"] });
      expect(repairColumnOrders(docs, [card("x", "a")])).toEqual([]);
      expect(orders(docs)).toEqual({ a: [], b: ["x"] });
    });

    test("whatever the arrays hold, a card with an entry before still has one after", () => {
      // every way to place 0–2 entries of x in each of three columns, with x's columnId in each
      for (const home of ["a", "b", "c"]) {
        for (let code = 0; code < 27; code++) {
          const counts = [code % 3, Math.floor(code / 3) % 3, Math.floor(code / 9)];
          const docs = board({
            a: Array(counts[0]).fill("x"),
            b: Array(counts[1]).fill("x"),
            c: Array(counts[2]).fill("x"),
          });
          const had = counts[0] + counts[1] + counts[2];
          repairColumnOrders(docs, [card("x", home)]);
          const total = [...docs.values()].reduce((n, doc) => n + orderOf(doc).length, 0);
          if (had > 0) expect(total, `entries ${counts}, columnId ${home}`).toBeGreaterThanOrEqual(1);
          // and when the columnId column has one, exactly one remains overall
          const homeCount = counts["abc".indexOf(home)];
          if (homeCount > 0) expect(total).toBe(1);
          else expect(total).toBe(had); // nothing in the column it names: nothing is deleted
        }
      }
    });
  });

  test("does nothing while the columnId column has no entry, and acts once it arrives", () => {
    // The state between a move's MUTATE (columnId is now b) and its insert into b: x is listed in a only.
    const docs = board({ a: ["x", "x"], b: [] });
    const cards = [card("x", "b")];
    expect(repairColumnOrders(docs, cards)).toEqual([]);
    expect(orders(docs)).toEqual({ a: ["x", "x"], b: [] });

    // The insert arrives.
    docs.get("b")!.getArray<string>(ORDER_ARRAY).push(["x"]);
    expect(repairColumnOrders(docs, cards)).toEqual(["a"]);
    expect(orders(docs)).toEqual({ a: [], b: ["x"] });
  });

  test("skips tombstoned cards and leaves their entries exactly as they were", () => {
    const docs = board({ a: ["x", "x"], b: ["x", "y"] });
    const gone = new Date().toISOString();
    expect(repairColumnOrders(docs, [card("x", "a", gone), card("y", "b")])).toEqual([]);
    expect(orders(docs)).toEqual({ a: ["x", "x"], b: ["x", "y"] });
  });

  test("ids that no card has are left alone", () => {
    const docs = board({ a: ["ghost", "ghost", "x"] });
    expect(repairColumnOrders(docs, [card("x", "a")])).toEqual([]);
    expect(orders(docs)).toEqual({ a: ["ghost", "ghost", "x"] });
  });

  test("a columnId naming a column with no doc changes nothing", () => {
    const docs = board({ a: ["x"], b: ["x"] });
    expect(repairColumnOrders(docs, [card("x", "nowhere")])).toEqual([]);
    expect(orders(docs)).toEqual({ a: ["x"], b: ["x"] });
  });

  test("the update a repair produces carries the deletions to another replica", () => {
    const server = board({ a: ["p", "x"], b: ["x"] });
    const replica = new Map([...server].map(([id, doc]) => [id, new Y.Doc()]));
    for (const [id, doc] of server) Y.applyUpdate(replica.get(id)!, Y.encodeStateAsUpdate(doc));

    const before = new Map([...server].map(([id, doc]) => [id, Y.encodeStateVector(doc)]));
    const changed = repairColumnOrders(server, [card("p", "a"), card("x", "a")]);
    expect(changed).toEqual(["b"]);
    for (const id of changed) Y.applyUpdate(replica.get(id)!, Y.encodeStateAsUpdate(server.get(id)!, before.get(id)));
    expect(orders(replica)).toEqual({ a: ["p", "x"], b: [] });
  });

  // A precondition, pinned so it is not forgotten: the repair trusts the columnId it is
  // given. A move sends its MUTATE before its CRDT_UPDATEs on one socket, so the server
  // learns the new columnId first. If an insert were handled while columnId still named
  // the OLD column, the repair would keep the old entry and delete the new one.
  test("depends on columnId being current: with the old columnId it deletes the newer entry", () => {
    const docs = board({ a: ["x"], b: ["x"] }); // a's entry is the stale one, b's the move's insert
    repairColumnOrders(docs, [card("x", "a")]); // columnId has not caught up with the move to b
    expect(orders(docs)).toEqual({ a: ["x"], b: [] });
  });
});
