import { describe, expect, test } from "vitest";
import type { Board, Card, Column } from "@realtime-kanban/shared-types";
import { reducer, type BoardState } from "./board-context";

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
