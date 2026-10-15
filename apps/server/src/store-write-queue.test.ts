import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";

// A failed DB write must be logged with entity/field context, must not stop
// the writes queued behind it, and must not become an unhandled rejection
// (which terminates the Node process). Prisma is stubbed so a write can be
// forced to fail.
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

const { createEntity, applyMutation, flushWrites } = await import("./store.js");

const cardValues = () => ({
  columnId: "column-1",
  title: "original",
  description: "",
  position: 0,
  createdAt: new Date().toISOString(),
  deletedAt: null,
});

let errors: ReturnType<typeof vi.spyOn>;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  db.cardCreate.mockReset().mockResolvedValue({});
  db.cardUpdate.mockReset().mockResolvedValue({});
  db.fieldClockUpsert.mockReset().mockResolvedValue({});
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  errors.mockRestore();
});

describe("the DB write queue", () => {
  test("a failed write is logged with which entity it was for", async () => {
    const id = randomUUID();
    db.cardCreate.mockRejectedValueOnce(new Error("boom"));

    createEntity("card", id, cardValues());
    await flushWrites();

    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toContain(`create card ${id}`);
    expect(errors.mock.calls[0][1]).toEqual(new Error("boom"));
  });

  test("a failed field write is logged with the entity and field", async () => {
    const id = randomUUID();
    createEntity("card", id, cardValues());
    await flushWrites();
    db.cardUpdate.mockRejectedValueOnce(new Error("boom"));

    applyMutation("card", id, "title", "new", { lamport: 1, clientId: "a" });
    await flushWrites();

    expect(errors.mock.calls[0][0]).toContain(`update card ${id} field "title"`);
  });

  test("a rejection does not poison the chain: later writes still run, in order", async () => {
    const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
    db.cardCreate.mockRejectedValueOnce(new Error("boom")); // only the first fails

    createEntity("card", first, cardValues());
    createEntity("card", second, cardValues());
    applyMutation("card", second, "title", "edited", { lamport: 1, clientId: "a" });
    createEntity("card", third, cardValues());
    await flushWrites();

    expect(db.cardCreate.mock.calls.map(([arg]) => arg.data.id)).toEqual([first, second, third]);
    expect(db.cardUpdate).toHaveBeenCalledTimes(1); // the mutation queued behind the failure ran
    expect(db.fieldClockUpsert).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  test("a failed write is not an unhandled rejection", async () => {
    db.cardCreate.mockRejectedValueOnce(new Error("boom"));
    createEntity("card", randomUUID(), cardValues());
    await flushWrites();
    await new Promise((r) => setTimeout(r, 20)); // unhandledRejection fires on a later tick

    expect(unhandled).toEqual([]);
  });
});
