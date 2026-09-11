"use client";

import { useState, type DragEvent } from "react";
import { useBoard } from "@/lib/board-context";
import type { Column } from "@realtime-kanban/shared-types";
import { CardItem } from "./CardItem";

export function ColumnView({ column }: { column: Column }) {
  const { cards, columnOrder, createCard, moveCard } = useBoard();
  const [draftTitle, setDraftTitle] = useState("");
  const cardIds = columnOrder[column.id] ?? [];

  function handleDrop(e: DragEvent, toIndex: number) {
    e.preventDefault();
    e.stopPropagation();
    const cardId = e.dataTransfer.getData("text/plain");
    const fromColumnId = e.dataTransfer.getData("application/x-from-column");
    if (!cardId || !fromColumnId) return;
    moveCard(cardId, fromColumnId, column.id, toIndex);
  }

  return (
    <div
      className="w-72 shrink-0 bg-gray-50 rounded-lg p-3"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => handleDrop(e, cardIds.length)}
    >
      <h2 className="font-medium text-sm text-gray-600 mb-3">{column.title}</h2>
      <div className="space-y-2 min-h-4">
        {cardIds.map((cardId, index) => {
          const card = cards[cardId];
          if (!card) return null;
          return (
            <div key={cardId} onDragOver={(e) => e.preventDefault()} onDrop={(e) => handleDrop(e, index)}>
              <CardItem card={card} columnId={column.id} />
            </div>
          );
        })}
      </div>
      <form
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draftTitle.trim()) return;
          createCard(column.id, draftTitle.trim());
          setDraftTitle("");
        }}
      >
        <input
          className="w-full text-sm px-2 py-1.5 rounded border border-gray-200 bg-white placeholder:text-gray-400"
          placeholder="+ Add a card"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
        />
      </form>
    </div>
  );
}
