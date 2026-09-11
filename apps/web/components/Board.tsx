"use client";

import { useBoard } from "@/lib/board-context";
import { ColumnView } from "./Column";

export function Board() {
  const { boards, columns } = useBoard();
  const board = Object.values(boards)[0];
  const sortedColumns = Object.values(columns).sort((a, b) => a.order - b.order);

  if (!board) {
    return <div className="p-8 text-gray-400 text-sm">Connecting…</div>;
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
