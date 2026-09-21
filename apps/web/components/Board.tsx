"use client";

import { useBoard } from "@/lib/board-context";
import { ColumnView } from "./Column";

function BoardSkeleton() {
  return (
    <div className="p-8" role="status" aria-live="polite">
      <span className="sr-only">Loading board…</span>
      <div className="h-6 w-40 bg-gray-200 rounded animate-pulse mb-6" />
      <div className="flex gap-4 items-start">
        {[0, 1, 2].map((i) => (
          <div key={i} className="w-72 shrink-0 bg-gray-50 rounded-lg p-3">
            <div className="h-4 w-20 bg-gray-200 rounded animate-pulse mb-3" />
            <div className="space-y-2">
              <div className="h-10 bg-gray-100 rounded animate-pulse" />
              <div className="h-10 bg-gray-100 rounded animate-pulse" />
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
    <div className="p-8">
      <h1 className="text-xl font-semibold mb-6 text-gray-800">{board.name}</h1>
      <div className="flex gap-4 items-start">
        {sortedColumns.map((column) => (
          <ColumnView key={column.id} column={column} />
        ))}
      </div>
    </div>
  );
}
