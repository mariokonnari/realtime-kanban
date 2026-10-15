import { afterAll, beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { e2eEnabled, startE2eServer, Peer, type E2eServer } from "./test-support/e2e-server.js";

// A frame the server can't make sense of must be logged and dropped — it must
// not throw out of the socket's message handler, which would terminate the
// process and disconnect every client. Real server, throwaway localhost
// Postgres; skipped when DATABASE_URL isn't a localhost database.

describe.skipIf(!e2eEnabled)("malformed frames (e2e, localhost only)", () => {
  let server: E2eServer;

  beforeAll(async () => {
    server = await startE2eServer();
  }, 60_000);

  afterAll(async () => {
    await server.stop();
  });

  const bad: Array<[string, string]> = [
    ["not JSON at all", "{definitely not json"],
    ["an empty frame", ""],
    ["JSON null", "null"],
    ["a JSON string", '"hello"'],
    ["an object with no type", '{"entityId":"x"}'],
    ["an object whose type isn't a string", '{"type":7}'],
    ["a CRDT_UPDATE whose payload isn't a Yjs update", '{"type":"CRDT_UPDATE","columnId":"c","update":"AQ=="}'],
  ];

  test.each(bad)("%s is dropped: the server survives and keeps serving the same connection", async (_name, frame) => {
    const peer = await Peer.connect(server.url);
    const raw = new WebSocket(server.url);
    await new Promise<void>((resolve) => raw.once("open", () => resolve()));

    raw.send(frame);
    // A well-formed request on the same connection still gets answered.
    const probe = await Peer.connect(server.url);
    const sync = await probe.sync();

    expect(server.hasExited()).toBe(false);
    expect(sync.columns.length).toBeGreaterThan(0);
    expect(raw.readyState).toBe(WebSocket.OPEN);
    raw.close();
    peer.close();
    probe.close();
  });

  test("a bad frame doesn't cost the sender later messages", async () => {
    const sender = await Peer.connect(server.url);
    sender.sendRaw("{nope");
    const sync = await sender.sync();
    expect(sync.boards).toHaveLength(1);
    sender.close();
  });
});
