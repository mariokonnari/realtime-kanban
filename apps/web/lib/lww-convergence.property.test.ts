import { beforeEach, describe, expect, test, vi } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { isNewer, type LamportClock } from "@realtime-kanban/shared-types";
import { FieldClocks } from "./field-clocks";

// Property tests for the LWW rule. What runs here is the real code:
//   - `isNewer` from shared-types (through the compiled dist, like both apps),
//   - the client's `FieldClocks`,
//   - the server's `applyMutation`, with Prisma stubbed the same way
//     apps/server/src/store-write-queue.test.ts does it.
// Nothing was extracted from production code to make this possible; where the
// test mirrors a few lines of production code instead, it says so.
const db = vi.hoisted(() => ({
  cardCreate: vi.fn(),
  cardUpdate: vi.fn(),
  fieldClockUpsert: vi.fn(),
}));

vi.mock("@prisma/client", () => {
  class PrismaClient {
    card = { create: db.cardCreate, update: db.cardUpdate };
    fieldClock = { upsert: db.fieldClockUpsert };
    columnDoc = { upsert: vi.fn().mockResolvedValue({}) };
  }
  return { PrismaClient };
});

const { createEntity, applyMutation, flushWrites, getFullState } = await import("../../server/src/store.js");

beforeEach(() => {
  db.cardCreate.mockReset().mockResolvedValue({});
  db.cardUpdate.mockReset().mockResolvedValue({});
  db.fieldClockUpsert.mockReset().mockResolvedValue({});
});

// ---- the operations under test ------------------------------------------------

const ENTITIES = ["card-1", "card-2"] as const;
const FIELDS = ["title", "description", "columnId"] as const;
// Few lamport values and few client ids on purpose: that is what makes ties —
// the interesting case for `isNewer` — common instead of astronomically rare.
const CLIENT_IDS = ["a", "b", "c"] as const;

interface Op {
  entityId: string;
  field: string;
  value: string;
  clock: LamportClock;
}

const opKey = (op: Pick<Op, "entityId" | "field" | "clock">) =>
  `${op.entityId}/${op.field}/${op.clock.lamport}/${op.clock.clientId}`;

const arbOps: fc.Arbitrary<Op[]> = fc
  .uniqueArray(
    fc.record({
      entityId: fc.constantFrom(...ENTITIES),
      field: fc.constantFrom(...FIELDS),
      clock: fc.record({ lamport: fc.integer({ min: 0, max: 6 }), clientId: fc.constantFrom(...CLIENT_IDS) }),
    }),
    // Precondition, not a restriction on the property: a MUTATE's clock names it.
    // `nextClock()` gives every write a fresh lamport and every tab a fresh
    // clientId, so two different writes to one field never carry the same clock.
    // Two writes with an equal clock and different values would be a bug in the
    // sender, and `isNewer` (equal is not newer) would keep whichever came first.
    { selector: opKey, minLength: 1, maxLength: 12 },
  )
  .map((ops) => ops.map((op, i): Op => ({ ...op, value: `v${i}` })));

/**
 * An order in which one replica receives the ops: every op at least once, in a
 * random order, with some repeated (a replayed queue entry, a rebroadcast).
 */
function arbDelivery(count: number): fc.Arbitrary<number[]> {
  const indexes = Array.from({ length: count }, (_, i) => i);
  return fc
    .tuple(
      fc.shuffledSubarray(indexes, { minLength: count, maxLength: count }),
      fc.array(fc.tuple(fc.nat(count - 1), fc.nat(40)), { maxLength: 2 * count }),
    )
    .map(([order, repeats]) => {
      const delivery = [...order];
      for (const [index, at] of repeats) delivery.splice(at % (delivery.length + 1), 0, index);
      return delivery;
    });
}

// ---- replicas -------------------------------------------------------------------

type State = Record<string, { value: string; clock: LamportClock }>; // "entity/field" -> what is shown

/** What the test expects every replica to hold: the write with the highest clock, per field. */
function expectedState(ops: Op[]): State {
  // A comparator written out here on purpose, not `isNewer`: if the oracle used
  // the code under test, "replicas agree" and "agree on the right answer" could
  // both be satisfied by a rule that is consistently wrong.
  const higher = (a: LamportClock, b: LamportClock) =>
    a.lamport !== b.lamport ? a.lamport > b.lamport : a.clientId > b.clientId;
  const winners: State = {};
  for (const op of ops) {
    const key = `${op.entityId}/${op.field}`;
    if (!winners[key] || higher(op.clock, winners[key].clock)) winners[key] = { value: op.value, clock: op.clock };
  }
  return winners;
}

/**
 * A client replica: `FieldClocks.accept` decides, the patch is applied only if it
 * says yes. This mirrors the MUTATE case in BoardProvider (board-context.tsx) —
 * `if (!clocks.accept(...)) break; dispatch(PATCH ...)` — which is an inline
 * closure and not exported, so it cannot be called from a test.
 */
function runClientReplica(ops: Op[], delivery: number[]): State {
  const clocks = new FieldClocks();
  const shown: State = {};
  for (const index of delivery) {
    const op = ops[index];
    if (!clocks.accept(op.entityId, op.field, op.clock)) continue;
    shown[`${op.entityId}/${op.field}`] = { value: op.value, clock: op.clock };
  }
  return shown;
}

let runs = 0;

/**
 * A server replica: the real store, driven through the real `applyMutation`.
 * The store is a module singleton, so each replica gets its own entity ids (the
 * store keys its clocks by entity id and field); the ops are the same ones.
 */
async function runServerReplica(ops: Op[], delivery: number[]): Promise<{ state: State; persisted: State }> {
  const prefix = `run${(runs += 1)}-${randomUUID()}`;
  const idOf = (entityId: string) => `${prefix}-${entityId}`;
  for (const entityId of ENTITIES) {
    createEntity("card", idOf(entityId), { columnId: "col", title: "", description: "", position: 0 });
  }
  await flushWrites();
  db.cardUpdate.mockClear();
  db.fieldClockUpsert.mockClear();

  for (const index of delivery) {
    const op = ops[index];
    applyMutation("card", idOf(op.entityId), op.field, op.value, op.clock);
  }
  await flushWrites();

  const full = getFullState();
  const state: State = {};
  for (const entityId of ENTITIES) {
    const card = full.cards.find((c) => c.id === idOf(entityId)) as unknown as Record<string, unknown>;
    for (const field of FIELDS) {
      const clock = full.fieldClocks[`${idOf(entityId)}:${field}`];
      if (clock) state[`${entityId}/${field}`] = { value: card[field] as string, clock };
    }
  }

  // What the DB stub saw, replayed in call order: the row ends up holding the
  // last value written, and the clock row the last clock. They must agree with
  // memory — that is the write queue keeping DB order equal to memory order.
  const persisted: State = {};
  const lastValue = new Map<string, string>();
  for (const [{ where, data }] of db.cardUpdate.mock.calls) {
    for (const field of FIELDS) if (field in data) lastValue.set(`${where.id}/${field}`, data[field]);
  }
  for (const [{ create }] of db.fieldClockUpsert.mock.calls) {
    const entityId = ENTITIES.find((e) => create.entityId === idOf(e))!;
    persisted[`${entityId}/${create.field}`] = {
      value: lastValue.get(`${create.entityId}/${create.field}`)!,
      clock: { lamport: create.lamport, clientId: create.clientId },
    };
  }
  return { state, persisted };
}

// ---- the properties ---------------------------------------------------------------

describe("LWW: every replica converges, whatever the delivery", () => {
  const arbScenario = arbOps.chain((ops) =>
    fc.record({
      ops: fc.constant(ops),
      // Two server-side replicas and two client replicas, each receiving the ops
      // in its own order, each with its own duplicates.
      deliveries: fc.tuple(arbDelivery(ops.length), arbDelivery(ops.length), arbDelivery(ops.length), arbDelivery(ops.length)),
    }),
  );

  test("all replicas end identical, and identical to the highest-clock write per field", async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async ({ ops, deliveries }) => {
        const expected = expectedState(ops);

        const server1 = await runServerReplica(ops, deliveries[0]);
        const server2 = await runServerReplica(ops, deliveries[1]);
        const client1 = runClientReplica(ops, deliveries[2]);
        const client2 = runClientReplica(ops, deliveries[3]);

        expect(server1.state).toEqual(expected);
        expect(server2.state).toEqual(expected);
        expect(client1).toEqual(expected);
        expect(client2).toEqual(expected);
        // The DB stub's last writes match memory, even though the writes were queued
        // behind each other and some belonged to superseded clocks.
        expect(server1.persisted).toEqual(expected);
        expect(server2.persisted).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });

  // Same replicas, weaker claim: they agree with each other. Split out because it is
  // the half of the property above that a *consistently wrong* rule still satisfies
  // (e.g. "lowest clock wins" is a perfectly good total order, and every replica
  // would agree on the wrong winner). It is kept so a failure report says which half broke.
  test("all replicas end identical (agreement only, without checking who won)", async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async ({ ops, deliveries }) => {
        const [s1, s2] = [await runServerReplica(ops, deliveries[0]), await runServerReplica(ops, deliveries[1])];
        const [c1, c2] = [runClientReplica(ops, deliveries[2]), runClientReplica(ops, deliveries[3])];
        expect(s2.state).toEqual(s1.state);
        expect(c1).toEqual(s1.state);
        expect(c2).toEqual(s1.state);
      }),
      { numRuns: 200 },
    );
  });

  test("a replica that has already applied the ops ignores every one of them delivered again", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbOps.chain((ops) => fc.tuple(fc.constant(ops), arbDelivery(ops.length))),
        async ([ops, redelivery]) => {
          const clocks = new FieldClocks();
          for (const op of ops) clocks.accept(op.entityId, op.field, op.clock);
          // The same ops again, in any order and with repeats: none is accepted a second time.
          for (const index of redelivery) {
            const op = ops[index];
            expect(clocks.accept(op.entityId, op.field, op.clock)).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test("isNewer is a strict total order on distinct clocks: exactly one of a, b is newer", () => {
    const arbClock = fc.record({ lamport: fc.integer({ min: 0, max: 6 }), clientId: fc.constantFrom(...CLIENT_IDS) });
    fc.assert(
      fc.property(arbClock, arbClock, (a, b) => {
        fc.pre(a.lamport !== b.lamport || a.clientId !== b.clientId);
        expect(isNewer(a, b)).not.toBe(isNewer(b, a));
        expect(isNewer(a, a)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});

// What this proves — and what it does not
//
// Proves: the LWW merge is order- and duplicate-independent. For any set of
// writes (random fields, entities, lamports, client ids — ties are common), any
// delivery order, with repeats, the server's real `applyMutation` and the
// client's real `FieldClocks` both end holding the write with the highest
// (lamport, clientId) for every field, so replicas that saw the same writes
// show the same thing. The DB stub additionally shows the server's queued
// writes land in an order whose last value is that same winner.
//
// Does not prove:
//   - anything about the network or the sockets: deliveries here are function
//     calls. Loss, reordering inside a TCP stream, and half-open connections are
//     not exercised (see the Playwright tests, and README "Known gaps");
//   - persistence: Prisma is a stub, so this shows write *order*, not that
//     Postgres holds the value, nor that a restart reloads it;
//   - tombstones: the server drops a MUTATE to a deleted card in index.ts, above
//     `applyMutation`, so delete-wins is not part of this merge and not covered;
//   - the rest of a client: SYNC_RESPONSE resets, unsynced re-application and the
//     React reducer are not run, only the accept-then-patch step;
//   - writes with an equal clock and different values (the generator rules them
//     out, as every real sender does).
