import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { SentFrame } from "./fixtures";

// How the tests see and drive the board. Selectors follow the markup in
// apps/web/components (a card is a draggable div; its title a span.cursor-text;
// the "+ Add a card" input belongs to a column).

const CARD = '[draggable="true"]';

/** The title of a card as shown (exact match), when it is not being edited. */
export const cardTitle = (page: Page, title: string) => page.locator(CARD).getByText(title, { exact: true });

/** Adds a card to the first column ("To do") and waits for it to appear. */
export async function addCard(page: Page, title: string) {
  const input = page.getByPlaceholder("+ Add a card").first();
  await input.fill(title);
  await input.press("Enter");
  await expect(cardTitle(page, title)).toBeVisible();
}

/** Renames a card the way a person does: click the title, type, Enter. */
export async function editTitle(page: Page, from: string, to: string) {
  await cardTitle(page, from).click();
  const input = page.locator(`${CARD} input`);
  await input.fill(to);
  await input.press("Enter");
  await expect(cardTitle(page, to)).toBeVisible();
}

/** What the screen shows: column title -> card titles, top to bottom. */
export function boardSnapshot(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => {
    const out: Record<string, string[]> = {};
    for (const heading of Array.from(document.querySelectorAll("h2"))) {
      const column = heading.closest('[class*="snap-start"]');
      out[heading.textContent ?? ""] = Array.from(
        column?.querySelectorAll('[draggable="true"] span.cursor-text') ?? [],
      ).map((span) => span.textContent ?? "");
    }
    return out;
  });
}

/** What the browser has queued in IndexedDB (the offline outbox), oldest first. */
export function readOutbox(page: Page): Promise<SentFrame[]> {
  return page.evaluate(
    () =>
      new Promise<SentFrame[]>((resolve, reject) => {
        const open = indexedDB.open("realtime-kanban-offline", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction("outbox", "readonly").objectStore("outbox").getAll();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            db.close(); // never hold the database open: the app's own connection must not be blocked
            resolve(request.result as SentFrame[]);
          };
        };
      }),
  );
}

interface Clock {
  lamport: number;
  clientId: string;
}

/**
 * Which of these writes should win, by the rule in the README (higher lamport, then
 * higher clientId) — written out again here rather than imported, so the test does not
 * use the code it is checking to decide what the right answer is.
 */
export function winningWrite<T extends { clock: Clock }>(writes: T[]): T {
  return writes.reduce((best, w) =>
    w.clock.lamport !== best.clock.lamport
      ? w.clock.lamport > best.clock.lamport
        ? w
        : best
      : w.clock.clientId > best.clock.clientId
        ? w
        : best,
  );
}
