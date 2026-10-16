import { describe, expect, test } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";
import { repairColumnOrders } from "../../server/src/column-order-repair.js";

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

// ---- the server's repair, over the same kind of scenario -----------------------------------
//
// The tests above show the merge leaves a card in two places when two replicas move it at
// once. The server now repairs that (apps/server/src/column-order-repair.ts: keep the first
// entry in the column the card's columnId names, delete the others). These tests run the real
// repairColumnOrders() over scenarios of concurrent moves of the SAME cards, in three columns
// (so a card can be moved to two different other columns), and check the repaired result.
//
// A move is modelled with all three of the messages moveCard() sends: a MUTATE of columnId
// (only when the column changes; Lamport clock per replica, ties broken by replica id) and
// two CRDT_UPDATEs. The server's columnId for a card is the highest clock among the MUTATEs
// it has applied, worked out here separately from the code under test.

const COLS = ["col-a", "col-b", "col-c"] as const;
type Col = (typeof COLS)[number];
const SEEDS: Record<Col, string[]> = { "col-a": ["s0", "s1", "s2"], "col-b": ["s3", "s4"], "col-c": ["s5"] };
const SEED_IDS = Object.values(SEEDS).flat();
const SEED_COLUMN = new Map<string, Col>(COLS.flatMap((c) => SEEDS[c].map((id) => [id, c] as [string, Col])));

interface Clock {
  lamport: number;
  clientId: string;
}
type Frame =
  | { kind: "mutate"; cardId: string; to: Col; clock: Clock }
  | { kind: "crdt"; columnId: Col; update: Uint8Array };

/** Higher lamport wins, then higher id — written out here, not taken from isNewer(). */
const beats = (a: Clock, b: Clock | undefined) =>
  b === undefined || a.lamport > b.lamport || (a.lamport === b.lamport && a.clientId > b.clientId);

// Built once and applied to every doc, like SEED_MESSAGES above: the seed entries must be the
// same items everywhere, or an update that refers to one could never be integrated.
const SEED_UPDATES = new Map<Col, Uint8Array>(
  COLS.map((c) => {
    const doc = new Y.Doc();
    doc.getArray<string>("cardOrder").push(SEEDS[c]);
    return [c, Y.encodeStateAsUpdate(doc)] as [Col, Uint8Array];
  }),
);
const seededDocs = () => {
  const docs = new Map<string, Y.Doc>();
  for (const c of COLS) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, SEED_UPDATES.get(c)!);
    docs.set(c, doc);
  }
  return docs;
};
const copyOf = (docs: Map<string, Y.Doc>) => {
  const out = new Map<string, Y.Doc>();
  for (const [c, doc] of docs) {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    out.set(c, copy);
  }
  return out;
};
const placement = (docs: Map<string, Y.Doc>) =>
  Object.fromEntries(COLS.map((c) => [c, docs.get(c)!.getArray<string>("cardOrder").toArray()])) as Record<Col, string[]>;

class MovingReplica {
  readonly docs = seededDocs();
  readonly stream: Frame[] = [];
  private lamport = 0;
  constructor(readonly id: string) {}

  where(cardId: string): Col {
    return COLS.find((c) => this.docs.get(c)!.getArray<string>("cardOrder").toArray().includes(cardId))!;
  }

  // moveCard() of board-context.tsx: MUTATE if the column changes, then delete, then insert.
  move(cardId: string, to: Col, toIndex: number) {
    const from = this.where(cardId);
    if (from !== to) this.stream.push({ kind: "mutate", cardId, to, clock: { lamport: ++this.lamport, clientId: this.id } });
    const fromDoc = this.docs.get(from)!;
    const fromBefore = Y.encodeStateVector(fromDoc);
    const fromArr = fromDoc.getArray<string>("cardOrder");
    const at = fromArr.toArray().indexOf(cardId);
    if (at !== -1) fromArr.delete(at, 1);
    this.stream.push({ kind: "crdt", columnId: from, update: Y.encodeStateAsUpdate(fromDoc, fromBefore) });
    const toDoc = this.docs.get(to)!;
    const toBefore = Y.encodeStateVector(toDoc);
    const toArr = toDoc.getArray<string>("cardOrder");
    toArr.insert(Math.max(0, Math.min(toIndex, toArr.length)), [cardId]);
    this.stream.push({ kind: "crdt", columnId: to, update: Y.encodeStateAsUpdate(toDoc, toBefore) });
  }

  receive(frame: Frame) {
    if (frame.kind === "crdt") Y.applyUpdate(this.docs.get(frame.columnId)!, frame.update);
  }
}

/** The server: applies frames as they arrive, as index.ts does, and repairs when it should. */
class ServerModel {
  readonly docs = seededDocs();
  readonly columnId = new Map<string, Col>(SEED_COLUMN);
  private readonly clocks = new Map<string, Clock>();
  /** Every repair update it has produced, in order (what it broadcasts to everyone). */
  readonly repairs: { columnId: string; update: Uint8Array }[] = [];

  handle(frame: Frame, repairEachTime: boolean) {
    if (frame.kind === "crdt") {
      Y.applyUpdate(this.docs.get(frame.columnId)!, frame.update);
      if (repairEachTime) this.repair();
    } else if (beats(frame.clock, this.clocks.get(frame.cardId))) {
      this.clocks.set(frame.cardId, frame.clock);
      this.columnId.set(frame.cardId, frame.to);
      if (repairEachTime) this.repair();
    }
  }

  repair() {
    const before = new Map([...this.docs].map(([c, doc]) => [c, Y.encodeStateVector(doc)]));
    const cards = [...this.columnId].map(([id, columnId]) => ({ id, columnId }));
    for (const columnId of repairColumnOrders(this.docs, cards)) {
      this.repairs.push({ columnId, update: Y.encodeStateAsUpdate(this.docs.get(columnId)!, before.get(columnId)) });
    }
  }
}

const arbMove = fc.record({ pick: fc.nat(), to: fc.constantFrom(...COLS), toIndex: fc.nat(6) });
type MoveSpec = typeof arbMove extends fc.Arbitrary<infer M> ? M : never;
const arbMoves = fc.record({
  moves: fc.array(fc.array(arbMove, { minLength: 1, maxLength: 4 }), { minLength: 2, maxLength: 3 }),
  noise: fc.array(arbNoise, { minLength: 4, maxLength: 4 }),
});

/** Replicas move cards (any of the seeds, so several may move the same one) without hearing from each other. */
function concurrentMoves({ moves }: { moves: MoveSpec[][] }) {
  const replicas = moves.map((_, r) => new MovingReplica(`r${r}`));
  moves.forEach((list, r) => list.forEach((m) => replicas[r].move(SEED_IDS[m.pick % SEED_IDS.length], m.to, m.toIndex)));
  return replicas;
}

/** The columnId each card should end with: the highest clock among all MUTATEs, else where it began. */
function expectedColumns(replicas: MovingReplica[]) {
  const best = new Map<string, { clock: Clock; to: Col }>();
  for (const f of replicas.flatMap((r) => r.stream)) {
    if (f.kind === "mutate" && beats(f.clock, best.get(f.cardId)?.clock)) best.set(f.cardId, { clock: f.clock, to: f.to });
  }
  return new Map<string, Col>(SEED_IDS.map((id) => [id, best.get(id)?.to ?? SEED_COLUMN.get(id)!] as [string, Col]));
}

function expectEachCardOnceWhereItsColumnIdSays(docs: Map<string, Y.Doc>, columns: Map<string, Col>) {
  const where = placement(docs);
  for (const id of SEED_IDS) {
    const entries = COLS.flatMap((c) => where[c].filter((x) => x === id).map(() => c));
    expect(entries, `card ${id}`).toEqual([columns.get(id)]);
  }
}

describe("the server's repair, after concurrent moves of the same cards", () => {
  test("merged in any order and then repaired, every card is in its columnId column exactly once", () => {
    fc.assert(
      fc.property(arbMoves, (scenario) => {
        const replicas = concurrentMoves(scenario);
        const server = new ServerModel();
        for (const frame of anyOrder(replicas.flatMap((r) => r.stream), scenario.noise[0])) server.handle(frame, false);
        expect(server.columnId, "the server's columnId is the highest clock").toEqual(expectedColumns(replicas));

        server.repair();
        expectEachCardOnceWhereItsColumnIdSays(server.docs, server.columnId);

        // Idempotent: nothing more to do, nothing changes.
        const settled = placement(server.docs);
        const repairs = server.repairs.length;
        server.repair();
        expect(server.repairs).toHaveLength(repairs);
        expect(placement(server.docs)).toEqual(settled);
      }),
      { numRuns: 200 },
    );
  });

  test("repaired as the server really does (after each frame, each sender's frames in order, with replays) the result is the same, and every replica converges on it", () => {
    fc.assert(
      fc.property(arbMoves, (scenario) => {
        const replicas = concurrentMoves(scenario);
        const server = new ServerModel();
        const arrival = withRepeats(perSenderOrder(replicas.map((r) => r.stream), scenario.noise[1]), scenario.noise[2]);
        for (const frame of arrival) server.handle(frame, true);

        expectEachCardOnceWhereItsColumnIdSays(server.docs, expectedColumns(replicas));

        // Each replica gets what the server relays (everyone else's frames) and every repair, in its own order.
        const repairs: Frame[] = server.repairs.map((x) => ({ kind: "crdt", columnId: x.columnId as Col, update: x.update }));
        replicas.forEach((replica, r) => {
          const others = replicas.flatMap((o, i) => (i === r ? [] : o.stream));
          for (const frame of anyOrder([...others, ...repairs], scenario.noise[3])) replica.receive(frame);
          expect(placement(replica.docs)).toEqual(placement(server.docs));
        });

        // A client that joins afterwards gets the server's state and sees the same.
        expect(placement(copyOf(server.docs))).toEqual(placement(server.docs));
      }),
      { numRuns: 200 },
    );
  });

  test("the repair only deletes: the same cards remain and the survivors keep their relative order", () => {
    fc.assert(
      fc.property(arbMoves, (scenario) => {
        const replicas = concurrentMoves(scenario);
        const server = new ServerModel();
        for (const frame of anyOrder(replicas.flatMap((r) => r.stream), scenario.noise[0])) server.handle(frame, false);
        const before = placement(server.docs);
        server.repair();
        const after = placement(server.docs);
        for (const c of COLS) {
          let at = 0;
          for (const id of before[c]) if (id === after[c][at]) at++;
          expect(at, c).toBe(after[c].length);
        }
        expect(new Set(COLS.flatMap((c) => after[c]))).toEqual(new Set(COLS.flatMap((c) => before[c])));
      }),
      { numRuns: 200 },
    );
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
//     Nothing here covers that. A card whose `columnId` field (LWW) and Y.Array
//     entry (CRDT) disagree after concurrent moves IS covered, for the server's
//     repair only, in the last describe: three columns, seed cards, no deletes,
//     no creates, and the server model applies a move's MUTATE before its inserts;
//   - the real moveCard/createCard, only copies of their Yjs steps (see the top).
