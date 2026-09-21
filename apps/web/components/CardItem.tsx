"use client";

import { useState } from "react";
import { useBoard } from "@/lib/board-context";
import type { Card } from "@realtime-kanban/shared-types";

export function CardItem({ card, columnId }: { card: Card; columnId: string }) {
  const { updateCardField, deleteCard, editorsByCard, setEditingCard } = useBoard();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(card.title);
  const [isDragging, setIsDragging] = useState(false);
  const editors = editorsByCard[card.id] ?? [];

  function startEditing() {
    setDraft(card.title);
    setEditing(true);
    setEditingCard(card.id);
  }

  function commit() {
    setEditing(false);
    setEditingCard(null);
    if (draft.trim() && draft !== card.title) {
      updateCardField(card.id, "title", draft.trim());
    }
  }

  return (
    <div
      draggable
      onDragStart={(e) => {
        setIsDragging(true);
        e.dataTransfer.setData("text/plain", card.id);
        e.dataTransfer.setData("application/x-from-column", columnId);
      }}
      onDragEnd={() => setIsDragging(false)}
      className={`group relative bg-white rounded border border-gray-200 px-3 py-2 text-sm shadow-sm cursor-grab active:cursor-grabbing transition-opacity ${
        isDragging ? "opacity-40" : "opacity-100"
      }`}
    >
      {editors.length > 0 && (
        <div className="absolute -top-2 -right-2 flex gap-1">
          {editors.map((editor, i) => (
            <span
              key={`${editor.name}-${i}`}
              title={`${editor.name} is editing`}
              className="text-[10px] leading-none font-medium text-white rounded-full px-1.5 py-1 shadow"
              style={{ backgroundColor: editor.color }}
            >
              {editor.name}
            </span>
          ))}
        </div>
      )}
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
          <span onClick={startEditing} className="cursor-text">
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
