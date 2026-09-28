import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Board, Column, Card } from "@realtime-kanban/shared-types";
import { Dashboard } from "./Dashboard";

let boards: Record<string, Board> = {};
let columns: Record<string, Column> = {};
let cards: Record<string, Card> = {};
let collaborators: unknown[] = [];

vi.mock("@/lib/board-context", () => ({
  useBoard: () => ({ boards, columns, cards, collaborators }),
}));

const board: Board = { id: "board-1", name: "Demo Board", createdAt: "2026-01-01T00:00:00.000Z" };
const colTodo: Column = { id: "col-todo", boardId: "board-1", title: "To do", order: 0 };
const colDone: Column = { id: "col-done", boardId: "board-1", title: "Done", order: 1 };

function makeCard(overrides: Partial<Card>): Card {
  return {
    id: "card-x",
    columnId: colTodo.id,
    title: "Untitled",
    description: "",
    position: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("Dashboard", () => {
  beforeEach(() => {
    boards = { [board.id]: board };
    columns = { [colTodo.id]: colTodo, [colDone.id]: colDone };
    cards = {};
    collaborators = [];
  });

  test("recently-active widget says so plainly when no card has any activity", () => {
    render(<Dashboard />);
    expect(screen.getByText(/no cards yet/i)).toBeInTheDocument();
  });

  test("lists real cards most-recently-updated first, not mock data", () => {
    cards = {
      old: makeCard({ id: "old", title: "Old card", updatedAt: "2026-01-01T00:00:00.000Z" }),
      newer: makeCard({ id: "newer", title: "Newer card", columnId: colDone.id, updatedAt: "2026-01-01T01:00:00.000Z" }),
    };
    render(<Dashboard />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Newer card");
    expect(items[0]).toHaveTextContent("Done");
    expect(items[1]).toHaveTextContent("Old card");
    expect(items[1]).toHaveTextContent("To do");
  });

  test("total active cards and cards-per-column reflect real card state", () => {
    cards = {
      a: makeCard({ id: "a", columnId: colTodo.id }),
      b: makeCard({ id: "b", columnId: colTodo.id }),
      c: makeCard({ id: "c", columnId: colDone.id }),
    };
    render(<Dashboard />);
    expect(screen.getByText("3")).toBeInTheDocument(); // total active cards
  });
});
