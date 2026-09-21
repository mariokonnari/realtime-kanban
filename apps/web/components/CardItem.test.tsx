import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Card } from "@realtime-kanban/shared-types";
import { CardItem } from "./CardItem";

const updateCardField = vi.fn();
const deleteCard = vi.fn();

vi.mock("@/lib/board-context", () => ({
  useBoard: () => ({ updateCardField, deleteCard }),
}));

beforeEach(() => {
  updateCardField.mockClear();
  deleteCard.mockClear();
});

const card: Card = {
  id: "card-1",
  columnId: "col-1",
  title: "Original title",
  description: "",
  position: 0,
  createdAt: "2024-01-01T00:00:00.000Z",
  deletedAt: null,
};

describe("CardItem", () => {
  test("renders the card's title", () => {
    render(<CardItem card={card} columnId="col-1" />);
    expect(screen.getByText("Original title")).toBeInTheDocument();
  });

  test("calls updateCardField with the edited title on blur", () => {
    render(<CardItem card={card} columnId="col-1" />);

    fireEvent.click(screen.getByText("Original title"));
    const input = screen.getByDisplayValue("Original title");
    fireEvent.change(input, { target: { value: "Edited title" } });
    fireEvent.blur(input);

    expect(updateCardField).toHaveBeenCalledWith("card-1", "title", "Edited title");
  });

  test("does not call updateCardField on blur when the title is unchanged", () => {
    render(<CardItem card={card} columnId="col-1" />);

    fireEvent.click(screen.getByText("Original title"));
    fireEvent.blur(screen.getByDisplayValue("Original title"));

    expect(updateCardField).not.toHaveBeenCalled();
  });
});
