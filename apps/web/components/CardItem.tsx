"use client";

import { useState } from "react";
import { useBoard } from "@/lib/board-context";
import type { Card } from "@realtime-kanban/shared-types";
import { ACCENT_BORDER, tiltForId, type ColumnAccent } from "@/lib/palette";

export function CardItem({
  card,
  columnId,
  accent = "sky",
}: {
  card: Card;
  columnId: string;
  accent?: ColumnAccent;
}) {
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
      style={{ "--tilt": tiltForId(card.id) } as React.CSSProperties}
      className={`group relative bg-white rounded-lg border border-ink/10 border-l-4 ${ACCENT_BORDER[accent]} px-3 py-2.5 text-sm shadow-tactile cursor-grab active:cursor-grabbing rotate-[var(--tilt)] transition-[opacity,box-shadow,transform] duration-150 hover:shadow-tactile-hover hover:-translate-y-0.5 ${
        isDragging ? "opacity-40" : "opacity-100"
      }`}
    >
      {editors.length > 0 && (
        <div className="absolute -top-2.5 -right-2 flex">
          {editors.map((editor, i) => (
            <span
              key={`${editor.name}-${i}`}
              title={`${editor.name} is editing`}
              style={{
                backgroundColor: editor.color,
                transform: `rotate(${i % 2 === 0 ? -6 : 6}deg)`,
                zIndex: i + 1,
              }}
              className={`text-[10px] leading-none font-semibold text-white rounded-[3px_9px_3px_9px] px-2 py-1 shadow-tactile whitespace-nowrap ${
                i > 0 ? "-ml-3" : ""
              }`}
            >
              {editor.name}
            </span>
          ))}
        </div>
      )}
      {editing ? (
        <input
          autoFocus
          className="w-full outline-none text-sm bg-transparent text-ink"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
      ) : (
        <div className="flex items-start justify-between gap-2">
          <span onClick={startEditing} className="cursor-text text-ink">
            {card.title}
          </span>
          <button
            onClick={() => deleteCard(card.id)}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-ink/40 hover:text-accent-pink text-xs leading-none px-1 rounded transition-colors"
            aria-label="Delete card"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
