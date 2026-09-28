// Opt-in dev convenience: fills the local board with realistic-looking
// cards so the UI (and the dashboard's per-column counts) has something
// worth looking at, without hand-typing a dozen cards through the form.
//
// Refuses to run against anything but a local database — see the check
// in main() below. Unlike the server's own startup guard (db-guard.ts),
// this has no APP_ENV=production or ALLOW_REMOTE_DB=1 override: there is
// no legitimate reason to run this script against a remote database, so
// it must never be loosened to allow one.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { PrismaClient, type Column } from "@prisma/client";
import { getDatabaseHostname, isLocalHostname } from "../db-guard.js";
import { withBoardSeedLock } from "../board-seed-lock.js";

const DEMO_CARDS: Record<string, string[]> = {
  "To do": [
    "Write onboarding doc for new contributors",
    "Design column-management UI",
    "Investigate an offline edit queue",
    "Add exponential backoff to the WS reconnect",
  ],
  "In progress": [
    "Broadcast a presence-leave event on disconnect",
    "Add Card.updatedAt for the dashboard's recent-activity widget",
    "Improve the drag target hit area on mobile",
  ],
  Done: [
    "Ship real-time card ordering with Yjs",
    "Add LWW tie-breaking for concurrent title edits",
    "Deploy to Render, Vercel, and Supabase",
    "Restyle the board with the sticky-note visual language",
    "Add /dashboard with live board stats",
  ],
};

/**
 * Finds the single board (creating it only if none exists yet) and makes
 * sure it has the three demo columns. Wrapped in the same advisory lock
 * the server's own seedDemoBoard() uses, so this can never race a
 * concurrently-starting server into creating a second board — see
 * board-seed-lock.ts for why that race is real, not hypothetical.
 */
export async function ensureBoardAndColumns(
  prisma: PrismaClient,
): Promise<{ board: { id: string; name: string }; columnsByTitle: Map<string, Column> }> {
  return withBoardSeedLock(prisma, async (tx) => {
    let board = await tx.board.findFirst();
    if (!board) {
      board = await tx.board.create({ data: { id: randomUUID(), name: "Demo Board" } });
      console.log(`Created board "${board.name}"`);
    }

    const columnTitles = Object.keys(DEMO_CARDS);
    const existingColumns = await tx.column.findMany({ where: { boardId: board.id } });
    const columnsByTitle = new Map(existingColumns.map((c) => [c.title, c]));

    for (const [order, title] of columnTitles.entries()) {
      if (columnsByTitle.has(title)) continue;
      const column = await tx.column.create({
        data: { id: randomUUID(), boardId: board.id, title, order },
      });
      columnsByTitle.set(title, column);
      console.log(`Created column "${title}"`);
    }

    return { board, columnsByTitle };
  });
}

/** Attaches the demo cards to the given (already-resolved) columns. Idempotent by card title per column. */
export async function seedCards(
  prisma: PrismaClient,
  columnsByTitle: Map<string, Column>,
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;

  for (const [columnTitle, cardTitles] of Object.entries(DEMO_CARDS)) {
    const column = columnsByTitle.get(columnTitle)!;

    const existingCards = await prisma.card.findMany({
      where: { columnId: column.id, deletedAt: null },
    });
    const existingTitles = new Set(existingCards.map((c) => c.title));

    // Card ordering lives in each column's Yjs doc, not just the cards
    // table — a card only shows up on the board if its id is also in this
    // array, so seeding has to append to it the same way a real drag/create
    // does, then persist the doc back to column_docs.
    const existingDoc = await prisma.columnDoc.findUnique({ where: { columnId: column.id } });
    const order = new Y.Doc();
    if (existingDoc) Y.applyUpdate(order, existingDoc.state);
    const cardOrder = order.getArray<string>("cardOrder");

    for (const cardTitle of cardTitles) {
      if (existingTitles.has(cardTitle)) {
        skipped += 1;
        continue;
      }
      const id = randomUUID();
      await prisma.card.create({
        data: { id, columnId: column.id, title: cardTitle, description: "", position: cardOrder.length, deletedAt: null },
      });
      cardOrder.push([id]);
      inserted += 1;
    }

    await prisma.columnDoc.upsert({
      where: { columnId: column.id },
      create: { columnId: column.id, state: Buffer.from(Y.encodeStateAsUpdate(order)) },
      update: { state: Buffer.from(Y.encodeStateAsUpdate(order)) },
    });
  }

  return { inserted, skipped };
}

async function main() {
  // Loaded explicitly via --env-file-if-exists=.env in package.json's
  // seed:demo script — see index.ts for why that flag and not --env-file.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "Refusing to run: DATABASE_URL is not set.\n" +
        "Copy apps/server/.env.example to apps/server/.env and fill in a local Postgres connection string, then try again.",
    );
    process.exit(1);
  }

  const hostname = getDatabaseHostname(databaseUrl);
  if (!isLocalHostname(hostname)) {
    console.error(
      `Refusing to run: DATABASE_URL points at "${hostname}", not localhost.\n` +
        "This script seeds demo data and only ever runs against a local database " +
        "(e.g. the docker-compose Postgres from the README) — never a remote one.",
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const { board, columnsByTitle } = await ensureBoardAndColumns(prisma);
    console.log(`Using board "${board.name}"`);
    const { inserted, skipped } = await seedCards(prisma, columnsByTitle);
    console.log(`Seeded ${inserted} card(s)${skipped ? ` (${skipped} already present, skipped)` : ""}.`);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run as a side effect when this file is executed directly (`tsx
// src/scripts/seed-demo.ts`), not when seed-order.test.ts imports
// ensureBoardAndColumns/seedCards to test them directly.
const isMainModule = process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
