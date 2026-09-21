"use client";

import { useState, type DragEvent } from "react";
import { useBoard } from "@/lib/board-context";
import type { Column } from "@realtime-kanban/shared-types";
import { CardItem } from "./CardItem";

export function ColumnView({ column }: { column: Column }) {
  const { cards, columnOrder, createCard, moveCard } = useBoard();
  const [draftTitle, setDraftTitle] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const cardIds = columnOrder[column.id] ?? [];

  function handleDragOverSlot(e: DragEvent, index: number) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
    setDropIndex(index);
  }

  // dragenter/dragleave fire for every child element too, so a naive
  // "leave clears the flag" resets it while the drag is still inside the
  // column (just over a different child). Only clear when the pointer has
  // actually left the column's own bounding box.
  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsDragOver(false);
      setDropIndex(null);
    }
  }

  function handleDrop(e: DragEvent, toIndex: number) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    setDropIndex(null);
    const cardId = e.dataTransfer.getData("text/plain");
    const fromColumnId = e.dataTransfer.getData("application/x-from-column");
    if (!cardId || !fromColumnId) return;
    moveCard(cardId, fromColumnId, column.id, toIndex);
  }

  return (
    <div
      className={`w-72 shrink-0 rounded-lg p-3 border-2 transition-colors ${
        isDragOver ? "bg-blue-50 border-blue-300" : "bg-gray-50 border-transparent"
      }`}
      onDragOver={(e) => handleDragOverSlot(e, cardIds.length)}
      onDragLeave={handleDragLeave}
      onDrop={(e) => handleDrop(e, cardIds.length)}
    >
      <h2 className="font-medium text-sm text-gray-600 mb-3">{column.title}</h2>
      <div className="space-y-2 min-h-4">
        {cardIds.length === 0 && (
          <div
            className={`rounded border border-dashed text-center text-xs py-4 transition-colors ${
              isDragOver ? "border-blue-300 text-blue-400 bg-blue-50" : "border-gray-200 text-gray-400"
            }`}
          >
            No cards yet
          </div>
        )}
        {cardIds.map((cardId, index) => {
          const card = cards[cardId];
          if (!card) return null;
          return (
            <div key={cardId}>
              {dropIndex === index && <div className="h-0.5 rounded bg-blue-400 mb-2" />}
              <div onDragOver={(e) => handleDragOverSlot(e, index)} onDrop={(e) => handleDrop(e, index)}>
                <CardItem card={card} columnId={column.id} />
              </div>
            </div>
          );
        })}
        {dropIndex === cardIds.length && cardIds.length > 0 && <div className="h-0.5 rounded bg-blue-400" />}
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
