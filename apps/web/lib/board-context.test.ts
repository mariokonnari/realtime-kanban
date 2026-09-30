import { describe, expect, test } from "vitest";
import type { Board, Card, Column, Presence } from "@realtime-kanban/shared-types";
import { reducer, presenceReducer, actionsForUnsynced, type BoardState } from "./board-context";

function emptyState(): BoardState {
  return { boards: {}, columns: {}, cards: {} };
}

const board: Board = { id: "board-1", name: "Demo", createdAt: "2024-01-01T00:00:00.000Z" };
const column: Column = { id: "col-1", boardId: "board-1", title: "To do", order: 0 };
const card: Card = {
  id: "card-1",
  columnId: "col-1",
  title: "Write tests",
  description: "",
  position: 0,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  deletedAt: null,
};

describe("board-context reducer", () => {
  test("SYNC replaces state with the given boards/columns/cards, keyed by id", () => {
    const next = reducer(emptyState(), { type: "SYNC", boards: [board], columns: [column], cards: [card] });
    expect(next).toEqual({
      boards: { [board.id]: board },
      columns: { [column.id]: column },
      cards: { [card.id]: card },
    });
  });

  test("UPSERT adds a new entity and replaces an existing one in the same table", () => {
    const afterSync = reducer(emptyState(), { type: "SYNC", boards: [], columns: [], cards: [] });
    const afterInsert = reducer(afterSync, { type: "UPSERT", table: "cards", id: card.id, entity: card });
    expect(afterInsert.cards[card.id]).toEqual(card);

    const updatedCard: Card = { ...card, title: "Renamed" };
    const afterReplace = reducer(afterInsert, { type: "UPSERT", table: "cards", id: card.id, entity: updatedCard });
    expect(afterReplace.cards[card.id].title).toBe("Renamed");
  });

  test("PATCH updates a single field on an existing entity and leaves the rest untouched", () => {
    const state = reducer(emptyState(), { type: "SYNC", boards: [], columns: [], cards: [card] });
    const next = reducer(state, { type: "PATCH", table: "cards", id: card.id, field: "title", value: "Patched" });
    expect(next.cards[card.id].title).toBe("Patched");
    expect(next.cards[card.id].description).toBe(card.description);
  });

  test("PATCH on an entity that isn't in state is a no-op", () => {
    const state = emptyState();
    const next = reducer(state, { type: "PATCH", table: "cards", id: "missing", field: "title", value: "x" });
    expect(next).toBe(state);
  });

  test("REMOVE deletes an entity from its table without touching other tables", () => {
    const state = reducer(emptyState(), { type: "SYNC", boards: [board], columns: [], cards: [card] });
    const next = reducer(state, { type: "REMOVE", table: "cards", id: card.id });
    expect(next.cards[card.id]).toBeUndefined();
    expect(next.boards[board.id]).toEqual(board);
  });
});

describe("presenceReducer", () => {
  // A client that connects and never edits anything — cardId stays null
  // for its whole session. Presence tracking must count it, not just
  // clients who have started editing at some point.
  const alice: Presence = { clientId: "alice", name: "Alice", color: "#111111", cardId: null };
  const bob: Presence = { clientId: "bob", name: "Bob", color: "#222222", cardId: "card-1" };

  test("PRESENCE_SYNC replaces state with the given list, keyed by clientId", () => {
    const next = presenceReducer({ stale: { clientId: "stale", name: "Stale", color: "#000", cardId: null } }, {
      type: "PRESENCE_SYNC",
      presence: [alice, bob],
    });
    expect(next).toEqual({ alice, bob });
  });

  test("PRESENCE_UPDATE upserts a single client, including a never-editing one", () => {
    const next = presenceReducer({}, { type: "PRESENCE_UPDATE", presence: alice });
    expect(next).toEqual({ alice });
  });

  test("PRESENCE_LEAVE removes a client entirely, regardless of whether it was mid-edit", () => {
    const state = { alice, bob };
    expect(presenceReducer(state, { type: "PRESENCE_LEAVE", clientId: "bob" })).toEqual({ alice });
    expect(presenceReducer(state, { type: "PRESENCE_LEAVE", clientId: "alice" })).toEqual({ bob });
  });

  test("PRESENCE_LEAVE for a client not currently tracked is a no-op", () => {
    const state = { alice };
    expect(presenceReducer(state, { type: "PRESENCE_LEAVE", clientId: "ghost" })).toBe(state);
  });
});

describe("actionsForUnsynced", () => {
  const clock = { lamport: 1, clientId: "me" };

  test("re-applying a SYNC-wiped local create, edit and delete leaves the screen as the user left it", () => {
    // The server's SYNC_RESPONSE knows none of these yet.
    const synced = reducer(emptyState(), { type: "SYNC", boards: [board], columns: [column], cards: [] });
    const actions = actionsForUnsynced([
      { type: "CREATE", entityType: "card", entityId: "new-1", initialValues: { columnId: "col-1", title: "Draft" }, clock },
      { type: "MUTATE", entityType: "card", entityId: "new-1", field: "title", value: "Final", clock },
      { type: "CREATE", entityType: "card", entityId: "new-2", initialValues: { columnId: "col-1", title: "Doomed" }, clock },
      { type: "DELETE", entityType: "card", entityId: "new-2", clock },
    ]);

    const next = actions.reduce(reducer, synced);

    expect(Object.keys(next.cards)).toEqual(["new-1"]);
    expect(next.cards["new-1"].title).toBe("Final");
  });

  test("ignores messages that have no effect on the board tables", () => {
    expect(
      actionsForUnsynced([
        { type: "CRDT_UPDATE", columnId: "col-1", update: "AAA=" },
        { type: "SYNC_REQUEST" },
      ]),
    ).toEqual([]);
  });
});
