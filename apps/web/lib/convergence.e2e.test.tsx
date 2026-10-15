import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/react";
import WsLib from "ws";
import {
  e2eEnabled,
  startE2eServer,
  Peer,
  type E2eServer,
} from "../../server/src/test-support/e2e-server";

// Client A is the REAL client — BoardProvider + WsClient, in jsdom — talking
// over a real WebSocket to the REAL server process and a throwaway localhost
// Postgres. Peer B and a probe are bare protocol peers driven by the test.
//
// To force "concurrent" edits deterministically, A's socket can be gated:
// while held, A's outbound frames are buffered, so a remote edit can reach the
// server (and be broadcast back to A) *before* A's own edit does, exactly as
// if the two had crossed on the wire. Skipped when DATABASE_URL isn't a
// localhost database.
//
// "Converged" below means: what A displays equals the server's authoritative
// value (read back through a fresh SYNC). That's deliberately not tied to
// *which* edit wins, so these stay valid under any fix that makes A agree.
//
// The last two scenarios used to diverge (they were `test.fails`): the client
// applied every remote write regardless of its clock, and never advanced its
// own Lamport counter on receipt. The client now runs the server's isNewer()
// per field and observes every clock it sees. The server sends no rejection
// reply; the client's own check is what makes these converge.

class GatedWebSocket extends WsLib {
  static holding = false;
  static held: Array<{ socket: GatedWebSocket; data: string }> = [];

  static hold() {
    GatedWebSocket.holding = true;
  }

  static release() {
    GatedWebSocket.holding = false;
    for (const { socket, data } of GatedWebSocket.held.splice(0)) socket.sendNow(data);
  }

  /** The real send, bypassing the gate. */
  sendNow(data: string) {
    super.send(data);
  }

  // The client only ever calls send(data) with a string frame.
  send(data: string) {
    if (GatedWebSocket.holding) GatedWebSocket.held.push({ socket: this, data });
    else super.send(data);
  }
}

type Board = typeof import("./board-context");
type Client = typeof import("./ws-client");

describe.skipIf(!e2eEnabled)("do clients converge? (real client + real server, localhost only)", () => {
  let server: E2eServer;
  let boardModule: Board;
  let clientModule: Client;
  let board: ReturnType<Board["useBoard"]>;
  let peerB: Peer;
  let probe: Peer;
  let columnId: string;

  function Probe() {
    board = boardModule.useBoard();
    return null;
  }

  beforeAll(async () => {
    server = await startE2eServer();
    process.env.NEXT_PUBLIC_WS_URL = server.url; // read once, at ws-client's import
    vi.stubGlobal("WebSocket", GatedWebSocket);
    // No React act() environment: the socket updates state outside of act, on purpose.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    boardModule = await import("./board-context");
    clientModule = await import("./ws-client");
  }, 60_000);

  afterEach(() => {
    GatedWebSocket.release();
    peerB?.close();
    probe?.close();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await server.stop();
  });

  /** Mounts client A and gives it a fresh card created by peer B. */
  async function setUp() {
    render(
      <boardModule.BoardProvider>
        <Probe />
      </boardModule.BoardProvider>,
    );
    await vi.waitFor(() => expect(clientModule.wsClient.getStatus().connected).toBe(true));
    // The provider is remounted per test but the socket is a singleton, so ask for state explicitly.
    clientModule.wsClient.send({ type: "SYNC_REQUEST" });
    await vi.waitFor(() => expect(Object.keys(board.columns)).toHaveLength(3));
    columnId = Object.keys(board.columns)[0];

    peerB = await Peer.connect(server.url);
    probe = await Peer.connect(server.url);
    const cardId = crypto.randomUUID();
    peerB.send({
      type: "CREATE",
      entityType: "card",
      entityId: cardId,
      initialValues: {
        columnId,
        title: "original",
        description: "",
        position: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      },
      clock: { lamport: 1, clientId: "peer-b" },
    });
    await vi.waitFor(() => expect(board.cards[cardId]?.title).toBe("original"));
    return cardId;
  }

  const bEdits = (cardId: string, value: string, lamport: number) =>
    peerB.send({
      type: "MUTATE",
      entityType: "card",
      entityId: cardId,
      field: "title",
      value,
      clock: { lamport, clientId: "peer-b" },
    });

  /** Waits until the server has handled everything A sent so far, then returns its title for the card. */
  async function serverTitleAfterA(cardId: string) {
    const marker = `done-${crypto.randomUUID()}`;
    board.setEditingCard(marker); // A's PRESENCE, sent after (and handled after) its edit
    await peerB.barrier(marker);
    return (await probe.sync()).cards.find((c) => c.id === cardId)?.title;
  }

  test("concurrent edit, the remote edit has the higher clock and reaches the server first: A converges", async () => {
    const cardId = await setUp();
    GatedWebSocket.hold();
    board.updateCardField(cardId, "title", "from A");
    await vi.waitFor(() => expect(board.cards[cardId].title).toBe("from A")); // optimistic

    bEdits(cardId, "from B", 1_000_000);
    // B's broadcast reaches A while A's own edit is still unsent.
    await vi.waitFor(() => expect(board.cards[cardId].title).toBe("from B"));
    GatedWebSocket.release(); // A's lower-clock edit now arrives and is rejected

    const serverTitle = await serverTitleAfterA(cardId);
    expect(serverTitle).toBe("from B");
    expect(board.cards[cardId].title).toBe(serverTitle);
  });

  test(
    "concurrent edit, the remote edit has the LOWER clock and reaches the server first: the winner keeps its value",
    async () => {
      const cardId = await setUp();
      GatedWebSocket.hold();
      board.updateCardField(cardId, "title", "from A"); // clock lamport >= 1

      bEdits(cardId, "from B (older)", 0);
      // B's lower-clock edit is applied first and broadcast to A. Its PRESENCE,
      // sent right after, is the signal that A has been handed that broadcast
      // (A used to overwrite its own value with it here).
      const marker = `b-sent-${crypto.randomUUID()}`;
      peerB.send({ type: "PRESENCE", clientId: "peer-b", name: "B", color: "#000", cardId: marker });
      await vi.waitFor(() => expect(board.collaborators.some((p) => p.cardId === marker)).toBe(true));
      expect(board.cards[cardId].title).toBe("from A"); // A ignored the stale remote write
      GatedWebSocket.release(); // A's higher-clock edit now arrives and wins on the server.

      const serverTitle = await serverTitleAfterA(cardId);
      expect(serverTitle).toBe("from A");
      expect(board.cards[cardId].title).toBe(serverTitle);
    },
  );

  test(
    "an edit made after receiving the winner's edit is rejected, and A keeps showing its own value",
    async () => {
      const cardId = await setUp();
      bEdits(cardId, "from B", 1_000_000);
      await vi.waitFor(() => expect(board.cards[cardId].title).toBe("from B"));

      // A has seen B's edit, so this is causally after it — but A's Lamport
      // counter never saw clock 1,000,000, so it stamps a tiny one and loses.
      board.updateCardField(cardId, "title", "from A");

      const serverTitle = await serverTitleAfterA(cardId);
      await new Promise((r) => setTimeout(r, 200));
      expect(board.cards[cardId].title).toBe(serverTitle);
    },
  );
});
