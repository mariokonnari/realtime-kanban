import { test as base, expect, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";
import { WEB_URL, isLoopbackHost } from "./env";
import { TestServer } from "./server";

export { expect };

// Anything a page tried to reach that is not this machine. Checked when the test ends.
const offLimits: string[] = [];

/** A message the page sent to the server, parsed. */
export type SentFrame = { type: string; messageId?: string; [key: string]: unknown };

export interface Tab {
  page: Page;
  /** Every frame this page sent over any WebSocket, in order, across reconnects. */
  sent: SentFrame[];
}

/**
 * Holds the server's broadcasts of certain types (MUTATE unless told otherwise) on
 * their way to one page, so that two pages can both edit a card before either has
 * heard of the other's edit — a concurrent edit by construction, not by luck of
 * timing. Everything else, and everything the page sends, passes straight through.
 */
export class MutationGate {
  private holding = false;
  private held: { route: WebSocketRoute; message: string | Buffer; type: string }[] = [];

  constructor(private readonly types: readonly string[] = ["MUTATE"]) {}

  get heldCount() {
    return this.held.length;
  }

  /** How many held frames are of this type. */
  heldOf(type: string) {
    return this.held.filter((h) => h.type === type).length;
  }

  hold() {
    this.holding = true;
  }

  /** Stops holding and delivers what was held, in the order it arrived. */
  release() {
    this.holding = false;
    for (const { route, message } of this.held.splice(0)) route.send(message);
  }

  async install(page: Page) {
    await page.routeWebSocket(/.*/, (route) => {
      const server = route.connectToServer();
      route.onMessage((message) => server.send(message));
      route.onClose((code, reason) => void server.close({ code, reason }));
      server.onMessage((message) => {
        const type = typeof message === "string" ? (JSON.parse(message) as { type?: string }).type : undefined;
        if (this.holding && type !== undefined && this.types.includes(type)) {
          this.held.push({ route, message, type });
        } else {
          route.send(message);
        }
      });
      server.onClose((code, reason) => void route.close({ code, reason }));
    });
  }
}

export const test = base.extend<{
  /** A real server process on a throwaway database, at the address the web build points at. */
  server: TestServer;
  /** A fresh browser context (own cookies, own IndexedDB) that can only reach this machine. */
  openContext: () => Promise<BrowserContext>;
  /** A page in `context`, with its sent frames recorded. Pass a gate to hold the server's MUTATE broadcasts to it. */
  openTab: (context: BrowserContext, gate?: MutationGate) => Promise<Tab>;
}>({
  server: async ({}, use) => {
    const server = await TestServer.create();
    try {
      await server.start();
      await use(server);
    } finally {
      await server.dispose();
    }
  },

  openContext: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    const blocked = offLimits;
    blocked.length = 0;
    await use(async () => {
      const context = await browser.newContext({ baseURL: WEB_URL, serviceWorkers: "block" });
      // http(s) to anywhere but this machine is refused (and fails the test below). Other schemes
      // (data:, blob:) never leave the browser.
      await context.route(/^https?:/, (route) => {
        const { hostname } = new URL(route.request().url());
        if (isLoopbackHost(hostname)) return route.continue();
        blocked.push(route.request().url());
        return route.abort();
      });
      contexts.push(context);
      return context;
    });
    await Promise.all(contexts.map((c) => c.close()));
    expect(blocked, "requests to anything but localhost").toEqual([]);
  },

  openTab: async ({}, use) => {
    await use(async (context, gate) => {
      const page = await context.newPage();
      const sent: SentFrame[] = [];
      page.on("websocket", (ws) => {
        // WebSockets are not covered by context.route, so they are checked as they open.
        if (!isLoopbackHost(new URL(ws.url()).hostname)) offLimits.push(ws.url());
        ws.on("framesent", ({ payload }) => sent.push(JSON.parse(payload.toString()) as SentFrame));
      });
      await gate?.install(page);
      return { page, sent };
    });
  },
});
