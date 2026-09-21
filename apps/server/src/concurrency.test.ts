import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { LamportClock } from "@realtime-kanban/shared-types";
import { isNewer } from "./lww.js";

// Why Card.position is Y.Array and not a naive LWW register — see
// README.md's "Sync strategy per field" table. These two tests are meant
// to be read together: the first shows the failure mode a naive port of
// the LWW rule to list ordering would have, the second shows Y.Array
// avoiding it under the exact same scenario.
describe("concurrent list reordering: naive LWW vs. Y.Array", () => {
  test.fails("naive LWW slot registers drop a concurrent insert at the same index", () => {
    // A naive port of the field-mutation LWW rule to list ordering: treat
    // each slot index as its own LWW register, "insert at index N" =
    // "write slot N", resolved by the same isNewer() used for Card.title.
    const slots = new Map<number, string>();
    const slotClocks = new Map<number, LamportClock>();

    function naiveInsert(index: number, cardId: string, clock: LamportClock) {
      if (isNewer(clock, slotClocks.get(index))) {
        slots.set(index, cardId);
        slotClocks.set(index, clock);
      }
    }

    // Two clients, unaware of each other, both drag a different card to
    // "index 3" at roughly the same time (same lamport tick, different
    // clientId — the concurrent case).
    naiveInsert(3, "card-from-client-a", { lamport: 1, clientId: "client-a" });
    naiveInsert(3, "card-from-client-b", { lamport: 1, clientId: "client-b" });

    // A correct merge keeps both cards somewhere in the list. The naive
    // slot-LWW model can't provide that: only one clock wins the slot,
    // and the losing card is silently overwritten — it never appears
    // anywhere. This assertion is expected to fail; that failure is the
    // point of the test (see the Y.Array version directly below, which
    // is what apps/server actually uses for Card.position).
    expect(new Set(slots.values())).toEqual(new Set(["card-from-client-a", "card-from-client-b"]));
  });

  test("Y.Array preserves both concurrent inserts at the same index", () => {
    // Same scenario, but using the actual mechanism: each column is a
    // Y.Doc with a "cardOrder" Y.Array, and replicas exchange
    // Y.encodeStateAsUpdate diffs (see CRDT_UPDATE in index.ts).
    const seed = new Y.Doc();
    seed.getArray<string>("cardOrder").push(["card-0", "card-1", "card-2"]);
    const seedUpdate = Y.encodeStateAsUpdate(seed);

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    Y.applyUpdate(docA, seedUpdate);
    Y.applyUpdate(docB, seedUpdate);

    // Both replicas independently insert a different card at the same
    // index, before either has seen the other's concurrent edit.
    const beforeA = Y.encodeStateVector(docA);
    docA.getArray<string>("cardOrder").insert(3, ["card-from-client-a"]);
    const updateA = Y.encodeStateAsUpdate(docA, beforeA);

    const beforeB = Y.encodeStateVector(docB);
    docB.getArray<string>("cardOrder").insert(3, ["card-from-client-b"]);
    const updateB = Y.encodeStateAsUpdate(docB, beforeB);

    // The server relays every CRDT_UPDATE to the other clients — simulate
    // that exchange directly by cross-applying each diff.
    Y.applyUpdate(docA, updateB);
    Y.applyUpdate(docB, updateA);

    const resultA = docA.getArray<string>("cardOrder").toArray();
    const resultB = docB.getArray<string>("cardOrder").toArray();

    // Both replicas converge to the same order, and neither concurrent
    // insert is lost — unlike the naive LWW slot model above.
    expect(resultA).toEqual(resultB);
    expect(new Set(resultA)).toEqual(
      new Set(["card-0", "card-1", "card-2", "card-from-client-a", "card-from-client-b"]),
    );
    expect(resultA).toHaveLength(5);
  });
});
