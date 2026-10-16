import { test, expect, MutationGate } from "../support/fixtures";
import { addCard, boardSnapshot, cardTitle, editTitle, winningWrite } from "../support/board";

// Two browsers (separate contexts: separate storage, separate WebSocket, separate
// client id) edit the title of one card concurrently, against the real server and a
// real database. Both screens must end up showing the same title, and it must be the
// one the LWW rule picks.
//
// "Concurrently" is made exact instead of left to timing: each page's incoming MUTATEs
// are held (MutationGate) while both edit, so neither sees the other's edit before
// making its own. And the edits are arranged so that the one that reaches the server
// LAST is the one that must LOSE — B makes three edits (lamport 2, 3, 4), then A makes
// one (lamport 2), which arrives after them all. A server or client that let the last
// arrival win would end on "A edit"; LWW ends on "B edit 3".

test("two browsers edit the same card at once and both end on the winning title", async ({ server, openContext, openTab }) => {
  const gateA = new MutationGate();
  const gateB = new MutationGate();
  const A = await openTab(await openContext(), gateA);
  const B = await openTab(await openContext(), gateB);
  await Promise.all([A.page.goto("/"), B.page.goto("/")]);
  // "2 live": each page's socket is open and has seen the other's presence.
  await Promise.all([expect(A.page.getByText("2 live")).toBeVisible(), expect(B.page.getByText("2 live")).toBeVisible()]);

  await addCard(A.page, "Shared card");
  await expect(cardTitle(B.page, "Shared card")).toBeVisible();

  gateA.hold();
  gateB.hold();
  await editTitle(B.page, "Shared card", "B edit 1");
  await editTitle(B.page, "B edit 1", "B edit 2");
  await editTitle(B.page, "B edit 2", "B edit 3");
  // The server has handled all three and broadcast them; A's page is holding them back.
  await expect.poll(() => gateA.heldCount).toBe(3);
  await editTitle(A.page, "Shared card", "A edit");

  // Concurrent for real: right now the two screens disagree about the card.
  expect((await boardSnapshot(A.page))["To do"]).toEqual(["A edit"]);
  expect((await boardSnapshot(B.page))["To do"]).toEqual(["B edit 3"]);

  gateA.release();
  gateB.release();

  // A barrier in each direction. A page's frames reach the server in the order it sent
  // them and the server relays in the order it handled them, so once B shows A's new
  // card the server has handled A's MUTATE before it (and would have broadcast it, had it
  // accepted it); once A shows B's, A has processed everything B had been sent.
  await addCard(A.page, "Barrier A");
  await expect(cardTitle(B.page, "Barrier A")).toBeVisible();
  await addCard(B.page, "Barrier B");
  await expect(cardTitle(A.page, "Barrier B")).toBeVisible();

  const edits = [...A.sent, ...B.sent].filter(
    (f): f is typeof f & { field: string; value: string; clock: { lamport: number; clientId: string } } =>
      f.type === "MUTATE" && f.field === "title",
  );
  expect(edits.map((e) => e.value).sort()).toEqual(["A edit", "B edit 1", "B edit 2", "B edit 3"]);
  const winner = winningWrite(edits);
  expect(winner.value, "the scenario is set up so the last write to arrive is not the winner").toBe("B edit 3");

  const [screenA, screenB] = await Promise.all([boardSnapshot(A.page), boardSnapshot(B.page)]);
  expect(screenA).toEqual(screenB);
  expect(screenA["To do"]).toEqual([winner.value, "Barrier A", "Barrier B"]);

  // ...and Postgres holds the same.
  await expect
    .poll(async () => (await server.cards()).map((c) => c.title).sort())
    .toEqual([winner.value, "Barrier A", "Barrier B"].sort());
});

// What this proves: with the real client, server, WebSocket and Postgres, an edit that
// loses on clock but arrives last does not win, on either screen or in the database,
// and the two screens agree after a window in which they visibly disagreed.
//
// What it does not: more than two browsers, fields other than the title, concurrent
// edits that tie on lamport (the property tests cover ties), a delete racing an edit,
// or card ordering (Yjs) — only the LWW field is edited here.
