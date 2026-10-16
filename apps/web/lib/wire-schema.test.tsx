import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/react";
import { parseClientMessage, type ClientMessage } from "@realtime-kanban/shared-types";

// The server validates every frame against the schema in shared-types and
// strips what the schema doesn't know. This runs the messages the REAL client
// builds — through BoardProvider's own createCard / updateCardField / moveCard /
// deleteCard / setEditingCard, and WsClient's SYNC_REQUEST — through that same
// schema and requires each to come out unchanged: accepted, with no field
// stripped. If someone adds a field to a message on the client without teaching
// the schema about it, the server would silently drop it; this fails first.
// Needs no server and no database.

type Board = typeof import("./board-context");
type Client = typeof import("./ws-client");

// Keeps the provider's wsClient.connect() off the network.
class IdleWebSocket {
  static OPEN = 1;
  readyState = 0;
  addEventListener() {}
  send() {}
  close() {}
}

describe("the messages the real client sends satisfy the server's schema", () => {
  let boardModule: Board;
  let clientModule: Client;
  const sent: ClientMessage[] = [];
  let board: ReturnType<Board["useBoard"]>;

  function Probe() {
    board = boardModule.useBoard();
    return null;
  }

  beforeAll(async () => {
    vi.stubGlobal("WebSocket", IdleWebSocket);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    boardModule = await import("./board-context");
    clientModule = await import("./ws-client");
    vi.spyOn(clientModule.wsClient, "send").mockImplementation((message) => {
      sent.push(message);
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("each message type, as built by the client, is accepted and nothing is stripped", () => {
    render(
      <boardModule.BoardProvider>
        <Probe />
      </boardModule.BoardProvider>,
    );
    sent.length = 0; // drop the provider's own on-mount PRESENCE; setEditingCard sends the PRESENCE checked below

    board.createCard("column-a", "A card"); // CREATE + CRDT_UPDATE
    board.updateCardField("card-1", "title", "Renamed"); // MUTATE
    board.updateCardField("card-1", "description", "Longer text"); // MUTATE
    board.moveCard("card-1", "column-a", "column-b", 0); // MUTATE columnId + 2 × CRDT_UPDATE
    board.moveCard("card-1", "column-b", "column-b", 0); // reorder within a column
    board.deleteCard("card-1"); // DELETE
    board.setEditingCard("card-1"); // PRESENCE
    board.setEditingCard(null); // PRESENCE
    clientModule.wsClient.send({ type: "SYNC_REQUEST" });

    const types = new Set(sent.map((m) => m.type));
    expect([...types].sort()).toEqual(["CRDT_UPDATE", "CREATE", "DELETE", "MUTATE", "PRESENCE", "SYNC_REQUEST"]);
    for (const message of sent) {
      expect(parseClientMessage(message), JSON.stringify(message).slice(0, 200)).toEqual({ ok: true, message });
    }
  });

  test("with the messageId the queue stamps on it, too", () => {
    for (const message of sent.filter((m) => m.type !== "SYNC_REQUEST" && m.type !== "PRESENCE")) {
      const stamped = { ...message, messageId: crypto.randomUUID() };
      expect(parseClientMessage(stamped)).toEqual({ ok: true, message: stamped });
    }
  });
});
