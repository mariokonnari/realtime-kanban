import { describe, expect, test } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";

// Property tests for card ordering: replicas make concurrent changes to the
// per-column Y.Array, using the operation shapes `createCard` and `moveCard`
// produce, and the changes are then merged in different orders.
//
// `createCard`/`moveCard` live inside BoardProvider's useCallback and need a
// React tree and the WsClient singleton, so they cannot be called from here;
// `Replica.createCard` and `Replica.moveCard` below repeat their Yjs steps
// (board-context.tsx, createCard and moveCard) line for line, including the
// state-vector diff taken before each step and the clamp of the insert index.
// If those functions change, these copies have to change with them.

const COLUMN_IDS = ["col-a", "col-b"] as const;
type ColumnId = (typeof COLUMN_IDS)[number];

/** One CRDT_UPDATE: what a client sends and the server relays. */
interface Message {
  columnId: ColumnId;
  update: Uint8Array;
}

const SEED_CARDS: Record<ColumnId, string[]> = { "col-a": ["s0", "s1", "s2"], "col-b": ["s3", "s4"] };

// The state every replica starts from, as the SYNC_RESPONSE a late joiner gets.
const SEED_MESSAGES: Message[] = COLUMN_IDS.map((columnId) => {
  const doc = new Y.Doc();
  doc.getArray<string>("cardOrder").push(SEED_CARDS[columnId]);
  return { columnId, update: Y.encodeStateAsUpdate(doc) };
});

class Replica {
  readonly docs: Record<ColumnId, Y.Doc> = { "col-a": new Y.Doc(), "col-b": new Y.Doc() };
  /** Every CRDT_UPDATE this replica would have sent, in the order it would have sent them. */
  readonly sent: Message[] = [];

  constructor() {
    for (const { columnId, update } of SEED_MESSAGES) Y.applyUpdate(this.docs[columnId], update);
  }

  order(columnId: ColumnId): string[] {
    return this.docs[columnId].getArray<string>("cardOrder").toArray();
  }

  /** Every card this replica currently has, in either column. */
  visibleCards(): string[] {
    return COLUMN_IDS.flatMap((columnId) => this.order(columnId));
  }

  locate(cardId: string): ColumnId | undefined {
    return COLUMN_IDS.find((columnId) => this.order(columnId).includes(cardId));
  }

  receive({ columnId, update }: Message) {
    Y.applyUpdate(this.docs[columnId], update);
  }

  // Mirrors the CRDT half of createCard().
  createCard(columnId: ColumnId, id: string) {
    const doc = this.docs[columnId];
    const before = Y.encodeStateVector(doc);
    doc.getArray<string>("cardOrder").push([id]);
    this.sent.push({ columnId, update: Y.encodeStateAsUpdate(doc, before) });
  }

  // Mirrors the CRDT half of moveCard(): a delete from the old column, sent as
  // its own update, then an insert into the new one (the same doc for a reorder),
  // sent as another. The card is *not* moved: it is removed and a new entry added.
  moveCard(cardId: string, fromColumnId: ColumnId, toColumnId: ColumnId, toIndex: number) {
    const fromDoc = this.docs[fromColumnId];
    const fromBefore = Y.encodeStateVector(fromDoc);
    const fromArr = fromDoc.getArray<string>("cardOrder");
    const existingIndex = fromArr.toArray().indexOf(cardId);
    if (existingIndex !== -1) fromArr.delete(existingIndex, 1);
    this.sent.push({ columnId: fromColumnId, update: Y.encodeStateAsUpdate(fromDoc, fromBefore) });

    const toDoc = this.docs[toColumnId];
    const toBefore = Y.encodeStateVector(toDoc);
    const toArr = toDoc.getArray<string>("cardOrder");
    const clampedIndex = Math.max(0, Math.min(toIndex, toArr.length));
    toArr.insert(clampedIndex, [cardId]);
    this.sent.push({ columnId: toColumnId, update: Y.encodeStateAsUpdate(toDoc, toBefore) });
  }
}

type Snapshot = Record<ColumnId, string[]>;
const snapshot = (docs: Record<ColumnId, Y.Doc>): Snapshot => ({
  "col-a": docs["col-a"].getArray<string>("cardOrder").toArray(),
  "col-b": docs["col-b"].getArray<string>("cardOrder").toArray(),
});

// ---- generating scenarios ----------------------------------------------------------

type Op =
  | { kind: "create"; column: ColumnId }
  | { kind: "move"; pick: number; to: ColumnId; toIndex: number };

const arbOp: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("create" as const), column: fc.constantFrom(...COLUMN_IDS) }),
  fc.record({
    kind: fc.constant("move" as const),
    pick: fc.nat(),
    to: fc.constantFrom(...COLUMN_IDS),
    toIndex: fc.nat(8), // past the end of a short column as often as inside it: the clamp is exercised
  }),
);

// Numbers that drive a delivery order. The message count isn't known until the
// ops have run, so the order is derived from these afterwards, deterministically
// (and they shrink like any other numbers).
const arbNoise = fc.array(fc.nat(), { minLength: 1, maxLength: 40 });

const arbScenario = fc.record({
  ops: fc.array(fc.array(arbOp, { maxLength: 6 }), { minLength: 2, maxLength: 3 }),
  noise: fc.array(arbNoise, { minLength: 3, maxLength: 3 }),
});
type Scenario = typeof arbScenario extends fc.Arbitrary<infer T> ? T : never;

const pickFrom = <T>(items: T[], noise: number[], i: number): T => items[noise[i % noise.length] % items.length];

/** Every message at least once, in a random order (Fisher–Yates driven by `noise`). */
function anyOrder<T>(messages: T[], noise: number[]): T[] {
  const out = [...messages];
  for (let i = out.length - 1; i > 0; i--) {
    const j = noise[i % noise.length] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A random interleaving of the senders' streams that keeps each sender's own order — what a socket gives. */
function perSenderOrder<T>(streams: T[][], noise: number[]): T[] {
  const left = streams.map((s) => [...s]);
  const out: T[] = [];
  for (let i = 0; left.some((s) => s.length > 0); i++) {
    const live = left.filter((s) => s.length > 0);
    out.push(pickFrom(live, noise, i).shift()!);
  }
  return out;
}

/** Some messages delivered a second time, later than their first delivery (a replayed queue entry). */
function withRepeats<T>(order: T[], noise: number[]): T[] {
  const out = [...order];
  const repeats = noise.length % 4;
  for (let r = 0; r < repeats && order.length > 0; r++) {
    const message = pickFrom(order, noise, 2 * r);
    const first = out.indexOf(message);
    out.splice(first + 1 + (noise[(2 * r + 1) % noise.length] % (out.length - first)), 0, message);
  }
  return out;
}

// ---- running one ----------------------------------------------------------------------

type Delivery = "per-sender order" | "any order";

/**
 * `exclusive`: a seed card is moved only by one replica (seed card i by replica
 * i mod n), and a created card only by its creator. `free`: any replica may move
 * any card it can see, so two may move the same one.
 */
function run({ ops, noise }: Scenario, delivery: Delivery, ownership: "exclusive" | "free") {
  const replicas = ops.map(() => new Replica());
  const created: string[] = [];
  const owner = (cardId: string) => (cardId.startsWith("s") ? Number(cardId.slice(1)) % replicas.length : Number(cardId.split("-")[0].slice(1)));

  // Concurrent phase: nobody has heard from anybody.
  ops.forEach((replicaOps, r) => {
    const replica = replicas[r];
    replicaOps.forEach((op, step) => {
      if (op.kind === "create") {
        const id = `n${r}-${step}`;
        created.push(id);
        replica.createCard(op.column, id);
      } else {
        const pool = replica.visibleCards().filter((id) => ownership === "free" || owner(id) === r);
        if (pool.length === 0) return;
        const cardId = pool[op.pick % pool.length];
        replica.moveCard(cardId, replica.locate(cardId)!, op.to, op.toIndex);
      }
    });
  });

  // Merge phase: each replica receives everybody else's messages in its own order.
  replicas.forEach((replica, r) => {
    const foreign = replicas.map((other, o) => (o === r ? [] : other.sent));
    const order =
      delivery === "per-sender order" ? perSenderOrder(foreign, noise[r]) : anyOrder(foreign.flat(), noise[r]);
    withRepeats(order, noise[r]).forEach((message) => replica.receive(message));
  });

  // What the server holds: it applies every CRDT_UPDATE it is sent, in some order (one more).
  const server = { "col-a": new Y.Doc(), "col-b": new Y.Doc() };
  for (const { columnId, update } of SEED_MESSAGES) Y.applyUpdate(server[columnId], update);
  for (const message of anyOrder(replicas.flatMap((r) => r.sent), noise[0].map((n) => n + 1))) {
    Y.applyUpdate(server[message.columnId], message.update);
  }

  return { replicas, server, expectedIds: [...Object.values(SEED_CARDS).flat(), ...created] };
}

function expectConverged({ replicas, server }: ReturnType<typeof run>) {
  const reference = snapshot(server);
  for (const replica of replicas) expect(snapshot(replica.docs)).toEqual(reference);
  // A client that joins afterwards gets the server's full state and ends up the same.
  const late = { "col-a": new Y.Doc(), "col-b": new Y.Doc() };
  for (const columnId of COLUMN_IDS) Y.applyUpdate(late[columnId], Y.encodeStateAsUpdate(server[columnId]));
  expect(snapshot(late)).toEqual(reference);
  return reference;
}

const count = (snap: Snapshot) => {
  const counts = new Map<string, number>();
  for (const id of [...snap["col-a"], ...snap["col-b"]]) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
};

// ---- the properties ---------------------------------------------------------------------

describe.each<Delivery>(["per-sender order", "any order"])("Yjs card order merges with delivery in %s", (delivery) => {
  test("replicas, the server and a late joiner converge; no card is lost; none appears that nobody made", () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const result = run(scenario, delivery, "free");
        const counts = count(expectConverged(result));
        expect([...counts.keys()].sort()).toEqual([...result.expectedIds].sort());
        for (const n of counts.values()) expect(n).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 150 },
    );
  });

  test("when each card is moved by one replica only, every card ends up in exactly one place", () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const result = run(scenario, delivery, "exclusive");
        const counts = count(expectConverged(result));
        expect([...counts.keys()].sort()).toEqual([...result.expectedIds].sort());
        for (const n of counts.values()) expect(n).toBe(1);
      }),
      { numRuns: 150 },
    );
  });
});

describe("what the merge does not give you", () => {
  test("two replicas moving the same card at the same time leave it in the board twice (known limitation)", () => {
    // moveCard() is delete + insert, not a Yjs move. Both replicas delete the old
    // entry (one entry, so the deletes agree) and each inserts its own new one.
    // The replicas still converge — the property tests above hold — but to a
    // column holding the card twice, and ColumnView renders one row per entry.
    const a = new Replica();
    const b = new Replica();
    a.moveCard("s0", "col-a", "col-b", 0);
    b.moveCard("s0", "col-a", "col-b", 2);
    a.sent.forEach((m) => b.receive(m));
    b.sent.forEach((m) => a.receive(m));

    expect(snapshot(a.docs)).toEqual(snapshot(b.docs));
    expect(a.order("col-a")).not.toContain("s0");
    expect(a.order("col-b").filter((id) => id === "s0")).toHaveLength(2);
  });
});

// What this proves — and what it does not
//
// Proves: Yjs's merge, applied to the operation shapes our client actually
// emits (push on create; delete-then-insert on move, within and across
// columns, with an insert index that may be out of range), is independent of
// the order updates arrive in and of repeats. Two or three replicas that each
// made changes without hearing from the others, and a server that applied
// every update in yet another order, end with identical columns, and so does a
// client that joins later from the server's full state. Nothing is lost.
// "per-sender order" is what a socket delivers; "any order" is stronger (Yjs
// buffers an update whose dependencies haven't arrived), so it also covers
// reordering we do not expect to see.
//
// Does not prove:
//   - that the order is *right* for a user: convergence says the replicas
//     agree, not that a card landed where its dragger dropped it, and
//     concurrent moves of one card duplicate it (last test);
//   - network behaviour: loss, partitions and reconnects are not simulated, only
//     delivery order; updates are never dropped, only reordered and repeated;
//   - persistence: nothing is written to Postgres or read back, and the server
//     here is a Y.Doc, not the server process;
//   - interplay with tombstones: DELETE of a card is an LWW field, and deleting a
//     card does not touch the Y.Array, so a deleted card's entry stays in its
//     column's order and is only hidden by the UI (`cards[cardId]` is missing).
//     Nothing here covers that, nor a card whose `columnId` field (LWW) and
//     whose Y.Array entry (CRDT) disagree after concurrent moves;
//   - the real moveCard/createCard, only copies of their Yjs steps (see the top).
