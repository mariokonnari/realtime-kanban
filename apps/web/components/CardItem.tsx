"use client";

import { useState } from "react";
import { useBoard } from "@/lib/board-context";
import type { Card } from "@realtime-kanban/shared-types";

export function CardItem({ card, columnId }: { card: Card; columnId: string }) {
  const { updateCardField, deleteCard } = useBoard();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(card.title);

  function commit() {
    setEditing(false);
    if (draft.trim() && draft !== card.title) {
      updateCardField(card.id, "title", draft.trim());
    }
  }

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", card.id);
        e.dataTransfer.setData("application/x-from-column", columnId);
      }}
      className="group bg-white rounded border border-gray-200 px-3 py-2 text-sm shadow-sm cursor-grab active:cursor-grabbing"
    >
      {editing ? (
        <input
          autoFocus
          className="w-full outline-none text-sm"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
      ) : (
        <div className="flex items-start justify-between gap-2">
          <span onClick={() => setEditing(true)} className="cursor-text">
            {card.title}
          </span>
          <button
            onClick={() => deleteCard(card.id)}
            className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 text-xs leading-none px-1"
            aria-label="Delete card"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
