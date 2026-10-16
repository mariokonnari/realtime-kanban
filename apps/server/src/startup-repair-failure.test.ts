import { afterAll, expect, test, vi } from "vitest";
import net from "node:net";
import WebSocket from "ws";
import type { ServerMessage } from "@realtime-kanban/shared-types";

// index.ts creates its WebSocketServer at import time and exports nothing, so the test
// cannot be handed the instance. The `ws` module is wrapped instead: the real class, but
// every instance it constructs is recorded here so afterAll can shut it down.
const created = vi.hoisted(() => [] as { close(cb?: (error?: Error) => void): void; clients: Set<{ terminate(): void }> }[]);
vi.mock("ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ws")>();
  class RecordingServer extends actual.WebSocketServer {
    constructor(...args: ConstructorParameters<typeof actual.WebSocketServer>) {
      super(...args);
      created.push(this);
    }
  }
  return { ...actual, default: actual.default, WebSocketServer: RecordingServer };
});

// index.ts is imported as it is, so its top-level startup code runs, with ./store.js
// replaced by a stub (no database, no Prisma). The stub's repairStoredOrders() throws,
// which is how a failure of the startup card order repair is forced without a hook in
// the production code. The server must log it and carry on booting.
const repairStoredOrders = vi.fn(() => {
  throw new Error("repair blew up");
});

vi.mock("./store.js", () => ({
  applyMutation: vi.fn(),
  applyDelete: vi.fn(),
  isTombstoned: vi.fn(() => false),
  createEntity: vi.fn(),
  columnDocFor: vi.fn(),
  isKnownColumn: vi.fn(() => false),
  persistColumnDoc: vi.fn(),
  flushWrites: vi.fn(async () => undefined),
  getFullState: vi.fn(() => ({ boards: [], columns: [], cards: [], columnOrders: {}, fieldClocks: {} })),
  initStore: vi.fn(async () => undefined),
  seedDemoBoard: vi.fn(async () => undefined),
  cards: new Map(),
  repairStoredOrders,
}));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

const sockets: WebSocket[] = [];
let port = 0;

// Closes the client, then the server index.ts started: its connections are terminated (close()
// alone waits for them) and the listening socket is released, which is checked by connecting
// to the port again.
afterAll(async () => {
  sockets.forEach((s) => s.terminate());
  expect(created, "index.ts constructed one WebSocketServer").toHaveLength(1);
  const [server] = created;
  server.clients.forEach((client) => client.terminate());
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  const refused = await new Promise<boolean>((resolve) => {
    const probe = net.connect({ port, host: "127.0.0.1" });
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", () => resolve(true));
  });
  expect(refused, "the port no longer accepts connections").toBe(true);
});

test("the server still boots and serves a SYNC_RESPONSE when the startup card order repair throws", async () => {
  port = await freePort();
  vi.stubEnv("PORT", String(port));
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/never_connected");
  vi.stubEnv("APP_ENV", "");
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

  await import("./index.js"); // resolves only if the top-level await chain got past the failed repair

  expect(repairStoredOrders).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledWith("Startup card order repair failed:", expect.objectContaining({ message: "repair blew up" }));
  expect(log).toHaveBeenCalledWith(expect.stringContaining("listening on"));
  expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Repaired the card order"));

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(socket);
  const response = await new Promise<ServerMessage>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("open", () => socket.send(JSON.stringify({ type: "SYNC_REQUEST" })));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === "SYNC_RESPONSE") resolve(message);
    });
  });
  expect(response.type).toBe("SYNC_RESPONSE");
});
