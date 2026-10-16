import { test, expect } from "../support/fixtures";
import { addCard, boardSnapshot, cardTitle, editTitle, readOutbox, winningWrite } from "../support/board";

// Two pages of ONE browser context share one IndexedDB (the offline outbox) and one
// set of Web Locks (navigator.locks), the real ones, which the unit tests only see as
// fakes. While the server is down each page queues edits; when it comes back, the
// queue must be delivered once — not once per page — and everything must converge.
//
// The disconnect is made by stopping the server process this test started and starting
// it again (same port, same database). It is not made with context.setOffline(): see the
// note at the bottom for why that would not be a disconnect.

test("entries queued by two pages while the server is down are each sent once, and the board converges", async ({
  server,
  openContext,
  openTab,
}) => {
  const context = await openContext();
  const P1 = await openTab(context);
  const P2 = await openTab(context);
  await Promise.all([P1.page.goto("/"), P2.page.goto("/")]);
  await Promise.all([expect(P1.page.getByText("2 live")).toBeVisible(), expect(P2.page.getByText("2 live")).toBeVisible()]);

  // A card both pages know and the server has persisted.
  await addCard(P1.page, "Shared card");
  await expect(cardTitle(P2.page, "Shared card")).toBeVisible();
  await expect.poll(async () => (await server.cards()).map((c) => c.title)).toEqual(["Shared card"]);

  // Take the server away. Each page notices and says so.
  await server.stop();
  await Promise.all([expect(P1.page.getByText(/^Offline/)).toBeVisible(), expect(P2.page.getByText(/^Offline/)).toBeVisible()]);

  // Each page queues three messages: a CREATE and a CRDT_UPDATE for the new card, a MUTATE for the rename.
  await editTitle(P1.page, "Shared card", "Shared by P1");
  await addCard(P1.page, "Only P1");
  await editTitle(P2.page, "Shared card", "Shared by P2");
  await addCard(P2.page, "Only P2");
  await Promise.all([
    expect(P1.page.getByText("Offline — 3 pending")).toBeVisible(),
    expect(P2.page.getByText("Offline — 3 pending")).toBeVisible(),
  ]);

  // All six are in the one IndexedDB, each with its own messageId, and nothing has been sent since the server went away.
  await expect.poll(async () => (await readOutbox(P1.page)).length).toBe(6);
  const queued = await readOutbox(P1.page);
  expect(await readOutbox(P2.page)).toEqual(queued); // the same store from either page
  const queuedIds = queued.map((entry) => entry.messageId);
  expect(queuedIds.every((id) => typeof id === "string")).toBe(true);
  expect(new Set(queuedIds).size).toBe(6);
  expect([...P1.sent, ...P2.sent].filter((f) => f.messageId !== undefined)).toEqual([]);

  // Bring it back. Both pages reconnect on their own (the client retries every second).
  await server.start();
  await Promise.all([expect(P1.page.getByText("2 live")).toBeVisible(), expect(P2.page.getByText("2 live")).toBeVisible()]);
  await expect.poll(async () => (await readOutbox(P1.page)).length).toBe(0);

  // Each queued entry went over the wire exactly once, counting both pages.
  const sends = new Map<string, number>();
  for (const frame of [...P1.sent, ...P2.sent]) {
    if (frame.messageId !== undefined) sends.set(frame.messageId, (sends.get(frame.messageId) ?? 0) + 1);
  }
  expect(Object.fromEntries(sends)).toEqual(Object.fromEntries(queuedIds.map((id) => [id, 1])));

  // Converged: the same board on both screens, holding all three cards and the LWW winner of the rename...
  const renames = queued.filter(
    (e): e is typeof e & { clock: { lamport: number; clientId: string }; value: string } =>
      e.type === "MUTATE" && (e as { field?: unknown }).field === "title",
  );
  expect(renames.map((r) => r.value).sort()).toEqual(["Shared by P1", "Shared by P2"]);
  const winner = winningWrite(renames).value;

  await expect
    .poll(async () => {
      const [a, b] = await Promise.all([boardSnapshot(P1.page), boardSnapshot(P2.page)]);
      return a["To do"]?.length === 3 && JSON.stringify(a) === JSON.stringify(b);
    })
    .toBe(true);
  const [one, two] = await Promise.all([boardSnapshot(P1.page), boardSnapshot(P2.page)]);
  expect(one).toEqual(two);
  expect(one["To do"]).toHaveLength(3);
  expect([...one["To do"]].sort()).toEqual([winner, "Only P1", "Only P2"].sort());

  // ...and the same in Postgres.
  await expect
    .poll(async () => (await server.cards()).map((c) => c.title).sort())
    .toEqual([winner, "Only P1", "Only P2"].sort());
});

// What this proves: in a real browser, with real IndexedDB and real Web Locks, two pages
// that queued entries while the connection was down deliver each entry once between them
// (the page that gets the lock sends the other's entries too, then clears them), the server
// ACKs them, the outbox ends empty, and both screens and Postgres hold the same board,
// including the LWW winner of a rename both pages made without seeing the other's.
//
// What it does not: a tab closing or crashing mid-drain (the lock being released by the
// browser), a server that dies in the middle of a drain (entries sent but not ACKed are
// sent again, by design — "once" here is for a clean reconnect), a server that is slow
// rather than gone, more than two pages, queued deletes, or a reload while offline.
//
// About context.setOffline(true): it is not used above. In Chromium it emulates the network
// for new requests; whether it also closes a WebSocket that is already open is checked
// separately, and the result is in the report that accompanies this test, not assumed.
