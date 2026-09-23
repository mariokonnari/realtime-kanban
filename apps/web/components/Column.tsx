"use client";

import { useState, type DragEvent } from "react";
import { useBoard } from "@/lib/board-context";
import type { Column } from "@realtime-kanban/shared-types";
import { ACCENT_BG, ACCENT_BG_SOFT, ACCENT_BORDER_SOFT, type ColumnAccent } from "@/lib/palette";
import { CardItem } from "./CardItem";

export function ColumnView({ column, accent }: { column: Column; accent: ColumnAccent }) {
  const { cards, columnOrder, createCard, moveCard } = useBoard();
  const [draftTitle, setDraftTitle] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const cardIds = columnOrder[column.id] ?? [];
  const cardCount = cardIds.filter((id) => cards[id]).length;

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
      className={`w-72 shrink-0 snap-start rounded-xl p-3 border-2 transition-colors bg-white/60 ${
        isDragOver ? `${ACCENT_BORDER_SOFT[accent]} ${ACCENT_BG_SOFT[accent]}` : "border-transparent"
      }`}
      onDragOver={(e) => handleDragOverSlot(e, cardIds.length)}
      onDragLeave={handleDragLeave}
      onDrop={(e) => handleDrop(e, cardIds.length)}
    >
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="font-display font-semibold text-sm text-ink">{column.title}</h2>
        <span className="text-xs text-ink/40 tabular-nums">{cardCount}</span>
      </div>
      <div className={`h-1 rounded-full mb-3 ${ACCENT_BG[accent]}`} />
      <div className="space-y-2 min-h-4">
        {cardIds.length === 0 && (
          <div
            className={`rounded-lg border border-dashed text-center text-xs py-4 transition-colors ${
              isDragOver ? `${ACCENT_BORDER_SOFT[accent]} ${ACCENT_BG_SOFT[accent]} text-ink/50` : "border-ink/15 text-ink/40"
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
              {dropIndex === index && <div className={`h-1 rounded-full mb-2 ${ACCENT_BG[accent]}`} />}
              <div onDragOver={(e) => handleDragOverSlot(e, index)} onDrop={(e) => handleDrop(e, index)}>
                <CardItem card={card} columnId={column.id} accent={accent} />
              </div>
            </div>
          );
        })}
        {dropIndex === cardIds.length && cardIds.length > 0 && (
          <div className={`h-1 rounded-full ${ACCENT_BG[accent]}`} />
        )}
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
          className="w-full text-sm px-2.5 py-1.5 rounded-lg border border-ink/10 bg-white placeholder:text-ink/35 text-ink"
          placeholder="+ Add a card"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
        />
      </form>
    </div>
  );
}
