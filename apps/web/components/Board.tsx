"use client";

import { useBoard } from "@/lib/board-context";
import { accentForIndex } from "@/lib/palette";
import { ColumnView } from "./Column";

function BoardSkeleton() {
  return (
    <div className="p-4 sm:p-8" role="status" aria-live="polite">
      <span className="sr-only">Loading board…</span>
      <div className="h-6 w-40 bg-ink/10 rounded animate-pulse motion-reduce:animate-none mb-6" />
      <div className="flex gap-4 items-start">
        {[0, 1, 2].map((i) => (
          <div key={i} className="w-72 shrink-0 bg-white/70 rounded-xl p-3">
            <div className="h-4 w-20 bg-ink/10 rounded animate-pulse motion-reduce:animate-none mb-3" />
            <div className="space-y-2">
              <div className="h-10 bg-ink/5 rounded-lg animate-pulse motion-reduce:animate-none" />
              <div className="h-10 bg-ink/5 rounded-lg animate-pulse motion-reduce:animate-none" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Board() {
  const { boards, columns } = useBoard();
  const board = Object.values(boards)[0];
  const sortedColumns = Object.values(columns).sort((a, b) => a.order - b.order);

  if (!board) {
    return <BoardSkeleton />;
  }

  return (
    <div className="p-4 sm:p-8">
      <h1 className="font-display text-lg sm:text-xl font-semibold mb-6 text-ink">{board.name}</h1>
      <div className="flex gap-4 items-start overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 pb-2 snap-x snap-proximity">
        {sortedColumns.map((column, index) => (
          <ColumnView key={column.id} column={column} accent={accentForIndex(index)} />
        ))}
      </div>
    </div>
  );
}
