import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getDatabaseHostname, isLocalHostname } from "./db-guard.js";
import { seedDemoBoard } from "./store.js";
import { ensureBoardAndColumns, seedCards } from "./scripts/seed-demo.js";

// These are real Postgres integration tests, not the mocked-Prisma unit
// tests store.test.ts uses — the whole point is proving board seeding is
// order-independent against an actual database. Per the task ("verify
// against localhost only"), they refuse to run against anything else, the
// same way the seed script itself does.
const databaseUrl = process.env.DATABASE_URL ?? "";
const hostname = databaseUrl ? getDatabaseHostname(databaseUrl) : "";
const runIntegration = isLocalHostname(hostname);

describe.skipIf(!runIntegration)("board seeding is order-independent (integration, localhost only)", () => {
  const prisma = new PrismaClient();

  async function resetDb() {
    // Board has onDelete: Cascade to Column, Card, and ColumnDoc, so
    // clearing boards clears the rest. FieldClock has no FK to any of
    // them, so it needs its own cleanup.
    await prisma.fieldClock.deleteMany();
    await prisma.board.deleteMany();
  }

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    // Leave the local dev database in the same "one seeded demo board"
    // state a fresh clone would have, rather than empty.
    await resetDb();
    await seedDemoBoard();
    await prisma.$disconnect();
  });

  test("seed script running before the server's own seeding produces exactly one board and three columns", async () => {
    const { board, columnsByTitle } = await ensureBoardAndColumns(prisma);
    await seedCards(prisma, columnsByTitle);

    await seedDemoBoard();

    const boards = await prisma.board.findMany();
    const columns = await prisma.column.findMany();
    expect(boards).toHaveLength(1);
    expect(boards[0]!.id).toBe(board.id);
    expect(columns).toHaveLength(3);
    expect(columns.every((c) => c.boardId === board.id)).toBe(true);
  });

  test("seed script running after the server's own seeding produces exactly one board and three columns", async () => {
    await seedDemoBoard();

    const { board } = await ensureBoardAndColumns(prisma);

    const boards = await prisma.board.findMany();
    const columns = await prisma.column.findMany();
    expect(boards).toHaveLength(1);
    expect(columns).toHaveLength(3);
    expect(columns.every((c) => c.boardId === board.id)).toBe(true);
  });

  test("two concurrent seedDemoBoard() calls against an empty database still produce exactly one board", async () => {
    // This is the actual bug that shipped: two processes racing the old
    // count-then-create check both saw zero boards and both created one.
    // The advisory lock in board-seed-lock.ts should serialize these.
    await Promise.all([seedDemoBoard(), seedDemoBoard()]);

    const boards = await prisma.board.findMany();
    const columns = await prisma.column.findMany();
    expect(boards).toHaveLength(1);
    expect(columns).toHaveLength(3);
  });
});
