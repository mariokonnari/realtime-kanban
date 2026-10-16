import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, MutationGate, type Tab } from "../support/fixtures";
import type { TestServer } from "../support/server";
import { addCard, boardSnapshot, cardTitle, dragCard, settledSnapshot, winningWrite } from "../support/board";

// Two browsers drag the SAME card at the same time, against the real server and a real
// database. What the user wants, written as the assertion in every case below: the card
// appears exactly once, in the column its columnId says — on both screens, after a
// reload, and in Postgres (one entry across the columns' order arrays, in the column the
// card's columnId names).
//
// "At the same time" is exact, not a matter of timing: each page's incoming CRDT_UPDATE
// and MUTATE frames are held (MutationGate) while both drag, so neither page has heard of
// the other's move before making its own. Then both are released and the board settles.
//
// Before the server repaired the card order these three failed (moveCard() is a delete
// plus an insert, so two concurrent moves of one card left it listed twice), and they were
// marked test.fail. The server now deletes the entries that disagree with the card's
// columnId (apps/server/src/column-order-repair.ts) and tells every client, so they run as
// plain tests. The duplicate is still on screen for a moment, until that repair reaches the
// page; the assertions are made once the board has settled. What each page and Postgres
// show is printed as a "[concurrent-move]" line and attached to the test as "observation".

const GATED = ["MUTATE", "CRDT_UPDATE"];
const SHARED = "X";

type Snapshot = Record<string, string[]>;

/** How many rows a screen shows for the shared card, per column (columns with none left out). */
function rowsFor(snapshot: Snapshot, title = SHARED): Record<string, number> {
  const rows: Record<string, number> = {};
  for (const [column, titles] of Object.entries(snapshot)) {
    const n = titles.filter((t) => t === title).length;
    if (n > 0) rows[column] = n;
  }
  return rows;
}

/** The barrier cards are scaffolding; leave them out of what is printed. */
const withoutBarriers = (snapshot: Snapshot): Snapshot =>
  Object.fromEntries(Object.entries(snapshot).map(([c, ts]) => [c, ts.filter((t) => !t.startsWith("Barrier"))]));

/** Frames this tab has sent since `from` that the gates hold on the other side. */
const gatedSince = (tab: Tab, from: number) => tab.sent.slice(from).filter((f) => GATED.includes(f.type));

async function reloadAndSettle(page: Page): Promise<Snapshot> {
  await page.reload();
  await expect(cardTitle(page, "P")).toBeVisible();
  return settledSnapshot(page);
}

interface Fixtures {
  server: TestServer;
  openContext: () => Promise<BrowserContext>;
  openTab: (context: BrowserContext, gate?: MutationGate) => Promise<Tab>;
}

interface Observation {
  /** What each screen shows once everything has been delivered, then after a reload. */
  screens: { A: { settled: Snapshot; reloaded: Snapshot }; B: { settled: Snapshot; reloaded: Snapshot } };
  /** The shared card's rows per column on each screen: [settled, reloaded]. */
  rows: { A: [Record<string, number>, Record<string, number>]; B: [Record<string, number>, Record<string, number>] };
  postgres: {
    /** The column the card's columnId names. */
    columnId: string;
    /** Each column's order array, as card titles (barrier cards left out). */
    orders: Snapshot;
    /** How many times the shared card is in each column's order array. */
    entries: Record<string, number>;
  };
  /** The columnId writes the pages sent, by LWW rule: the one that must win. */
  columnIdWinner: string | undefined;
  /** Whether a reload changed what each page shows. */
  reloadChangesScreen: { A: boolean; B: boolean };
}

/**
 * Two pages, one shared card X among fillers: To do = [P, X, Q], the other columns empty.
 * A drags X onto `a`, B drags X onto `b`, each before hearing of the other's move; then
 * everything is delivered and observed. A target is a card title, or "column:<title>"
 * for the end of a column.
 */
async function concurrentMoves(
  { server, openContext, openTab }: Fixtures,
  a: string,
  b: string,
): Promise<Observation> {
  const gateA = new MutationGate(GATED);
  const gateB = new MutationGate(GATED);
  const A = await openTab(await openContext(), gateA);
  const B = await openTab(await openContext(), gateB);
  await Promise.all([A.page.goto("/"), B.page.goto("/")]);
  await Promise.all([expect(A.page.getByText("2 live")).toBeVisible(), expect(B.page.getByText("2 live")).toBeVisible()]);

  for (const title of ["P", SHARED, "Q"]) {
    await addCard(A.page, title);
    await expect(cardTitle(B.page, title)).toBeVisible();
  }
  expect((await boardSnapshot(A.page))["To do"]).toEqual(["P", SHARED, "Q"]);
  expect((await boardSnapshot(B.page))["To do"]).toEqual(["P", SHARED, "Q"]);

  gateA.hold();
  gateB.hold();

  // A drags first. The server handles A's frames and relays them; B's page holds them.
  const startA = A.sent.length;
  await dragCard(A.page, SHARED, a);
  await expect.poll(() => gatedSince(A, startA).filter((f) => f.type === "CRDT_UPDATE").length).toBe(2);
  // (at least: a repair of the server's, if one were needed, would be held here too)
  await expect.poll(() => gateB.heldCount).toBeGreaterThanOrEqual(gatedSince(A, startA).length);

  // B drags while its page has not applied any of that.
  const startB = B.sent.length;
  await dragCard(B.page, SHARED, b);
  await expect.poll(() => gatedSince(B, startB).filter((f) => f.type === "CRDT_UPDATE").length).toBe(2);
  // (B's MUTATE, if it sent one, may lose to A's at the server and not be relayed; its CRDT_UPDATEs always are,
  // and once they have made the duplicate the server's repair follows them, also held here: 2 or more.)
  await expect.poll(() => gateA.heldOf("CRDT_UPDATE")).toBeGreaterThanOrEqual(2);

  // Concurrent for real: the two screens disagree about where the card is.
  expect(await boardSnapshot(A.page), "A before release").not.toEqual(await boardSnapshot(B.page));

  gateA.release();
  gateB.release();

  // Barriers, as in concurrent-edit.spec.ts: once B shows A's new card, B has been sent
  // everything the server relayed before it, and the other way round.
  await addCard(A.page, "Barrier A");
  await expect(cardTitle(B.page, "Barrier A")).toBeVisible();
  await addCard(B.page, "Barrier B");
  await expect(cardTitle(A.page, "Barrier B")).toBeVisible();

  const settled = { A: await settledSnapshot(A.page), B: await settledSnapshot(B.page) };

  // Postgres. Writes are queued in order, so once the last barrier card is in the To do
  // order array, everything before it has landed.
  const toDoOf = (board: Awaited<ReturnType<TestServer["board"]>>) => board.columns.find((c) => c.title === "To do")!.id;
  await expect
    .poll(async () => {
      const board = await server.board();
      const barrier = board.cards.find((c) => c.title === "Barrier B");
      return barrier !== undefined && (board.orders[toDoOf(board)] ?? []).includes(barrier.id);
    })
    .toBe(true);
  const board = await server.board();
  const titleOf = new Map(board.cards.map((c) => [c.id, c.title]));
  const columnTitle = new Map(board.columns.map((c) => [c.id, c.title]));
  const card = board.cards.find((c) => c.title === SHARED)!;
  const orders: Snapshot = {};
  const entries: Record<string, number> = {};
  for (const column of board.columns) {
    const ids = board.orders[column.id] ?? [];
    orders[column.title] = ids.map((id) => titleOf.get(id) ?? `(unknown ${id})`).filter((t) => !t.startsWith("Barrier"));
    const n = ids.filter((id) => id === card.id).length;
    if (n > 0) entries[column.title] = n;
  }

  const moves = [...A.sent, ...B.sent].filter(
    (f): f is typeof f & { value: string; clock: { lamport: number; clientId: string } } =>
      f.type === "MUTATE" && f.field === "columnId",
  );
  const columnIdWinner = moves.length > 0 ? columnTitle.get(winningWrite(moves).value) : undefined;

  const reloaded = { A: await reloadAndSettle(A.page), B: await reloadAndSettle(B.page) };

  return {
    screens: {
      A: { settled: withoutBarriers(settled.A), reloaded: withoutBarriers(reloaded.A) },
      B: { settled: withoutBarriers(settled.B), reloaded: withoutBarriers(reloaded.B) },
    },
    rows: {
      A: [rowsFor(settled.A), rowsFor(reloaded.A)],
      B: [rowsFor(settled.B), rowsFor(reloaded.B)],
    },
    postgres: { columnId: columnTitle.get(card.columnId) ?? card.columnId, orders, entries },
    columnIdWinner,
    reloadChangesScreen: {
      A: JSON.stringify(settled.A) !== JSON.stringify(reloaded.A),
      B: JSON.stringify(settled.B) !== JSON.stringify(reloaded.B),
    },
  };
}

/** Prints and attaches what was seen, so a run reports it whether or not it passes. */
async function report(name: string, observation: Observation) {
  const text = JSON.stringify(observation);
  console.log(`[concurrent-move] ${name} ${text}`);
  await test.info().attach("observation", { body: JSON.stringify(observation, null, 2), contentType: "application/json" });
}

/**
 * The behavior wanted: the card is on screen exactly once — on both pages, before and
 * after a reload — in the column Postgres says it is in, appears once in the order
 * arrays, and a reload changes nothing on either page. The column is whatever Postgres
 * names (`o.postgres.columnId`): when two moves go to different columns the LWW winner can
 * be either, so it is not fixed here. `allowed` says which columns it may name.
 */
function expectOnceWhereItsColumnIdSays(o: Observation, allowed: string[]) {
  expect(allowed, "Postgres: the card's columnId").toContain(o.postgres.columnId);
  const column = o.postgres.columnId;
  expect.soft(o.postgres.entries, "Postgres: entries for the card across the columns' order arrays").toEqual({ [column]: 1 });
  for (const page of ["A", "B"] as const) {
    expect.soft(o.rows[page][0], `page ${page}: rows for the card`).toEqual({ [column]: 1 });
    expect.soft(o.rows[page][1], `page ${page} after a reload: rows for the card`).toEqual({ [column]: 1 });
  }
  expect.soft(o.screens.A.settled, "the two screens agree").toEqual(o.screens.B.settled);
  expect.soft(o.screens.A.reloaded, "page A: a reload changes nothing").toEqual(o.screens.A.settled);
  expect.soft(o.screens.B.reloaded, "page B: a reload changes nothing").toEqual(o.screens.B.settled);
  expect.soft(o.reloadChangesScreen, "a reload changed what a page shows").toEqual({ A: false, B: false });
}

test("1. both pages move the same card within one column, to different positions", async ({ server, openContext, openTab }) => {
  // A: onto P (top). B: to the end of the column.
  const observation = await concurrentMoves({ server, openContext, openTab }, "P", "column:To do");
  await report("same column", observation);
  expectOnceWhereItsColumnIdSays(observation, ["To do"]);
  // The survivor sits where one of the two moves put it: first (A's) or last (B's), never in the middle.
  const order = observation.screens.A.settled["To do"];
  expect([["X", "P", "Q"], ["P", "Q", "X"]]).toContainEqual(order);
});

test("2. both pages move the same card to different other columns", async ({ server, openContext, openTab }) => {
  // A: In progress. B: Done. Either can win the columnId; Postgres says which.
  const observation = await concurrentMoves({ server, openContext, openTab }, "column:In progress", "column:Done");
  await report("different columns", observation);
  expectOnceWhereItsColumnIdSays(observation, ["In progress", "Done"]);
  expect(observation.columnIdWinner, "the LWW winner computed from the frames the pages sent").toBe(observation.postgres.columnId);
});

test("3. one page moves the card to another column while the other reorders it in its own", async ({ server, openContext, openTab }) => {
  // A: to In progress. B: reorders within To do, onto P (top). Only A sends a columnId, so it wins.
  const observation = await concurrentMoves({ server, openContext, openTab }, "column:In progress", "P");
  await report("move vs reorder", observation);
  expectOnceWhereItsColumnIdSays(observation, ["In progress"]);
});

// What this covers: the three two-page races on one shared card, with the real client,
// server, WebSocket and Postgres, concurrent by construction. What it does not: three or
// more pages, a delete or title edit racing a move, the same race with the arrival order
// reversed (A's frames always reach the server first), or drops anywhere but the card
// positions and column headings used above. It does not show the duplicate is hidden
// while it lasts: the gates hold the server's repair along with everything else, and the
// assertions run after it has been delivered.
