"use client";

import { useBoard } from "@/lib/board-context";
import { accentForIndex, ACCENT_BG, ACCENT_BORDER_LEFT } from "@/lib/palette";
import { formatRelativeTime } from "@/lib/time";

// Keeps the widget a quick glance, not a second card list.
const RECENTLY_ACTIVE_LIMIT = 5;

function DashboardSkeleton() {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-8 py-4 sm:py-8" role="status" aria-live="polite">
      <span className="sr-only">Loading dashboard…</span>
      <div className="h-6 w-48 bg-ink/10 rounded animate-pulse motion-reduce:animate-none mb-6" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 bg-white/70 rounded-xl animate-pulse motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-white border border-ink/10 p-4 shadow-tactile">
      <p className="text-xs font-medium text-ink/50 uppercase tracking-wide mb-2">{label}</p>
      <p className="font-display text-3xl font-bold text-ink tabular-nums">{value}</p>
    </div>
  );
}

export function Dashboard() {
  const { boards, columns, cards, collaborators } = useBoard();
  const board = Object.values(boards)[0];

  if (!board) {
    return <DashboardSkeleton />;
  }

  const sortedColumns = Object.values(columns)
    .filter((c) => c.boardId === board.id)
    .sort((a, b) => a.order - b.order);
  const boardColumnIds = new Set(sortedColumns.map((c) => c.id));
  const activeCards = Object.values(cards).filter((card) => boardColumnIds.has(card.columnId));
  const totalActive = activeCards.length;
  const liveCount = collaborators.length + 1; // +1 for this tab
  const countsByColumn = sortedColumns.map((column) => ({
    column,
    count: activeCards.filter((card) => card.columnId === column.id).length,
  }));
  const maxColumnCount = Math.max(1, ...countsByColumn.map((c) => c.count));
  const accentByColumnId = new Map(sortedColumns.map((column, index) => [column.id, accentForIndex(index)]));
  const recentlyActive = [...activeCards]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, RECENTLY_ACTIVE_LIMIT);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-8 py-4 sm:py-8">
      <h1 className="font-display text-lg sm:text-xl font-semibold text-ink mb-6">{board.name} — Dashboard</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatTile label="Total active cards" value={totalActive} />

        <div className="rounded-xl bg-white border border-ink/10 p-4 shadow-tactile">
          <p className="text-xs font-medium text-ink/50 uppercase tracking-wide mb-2">Collaborators</p>
          <div className="flex items-center gap-3">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-accent-sunflower opacity-75 motion-safe:animate-ping" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent-sunflower" />
            </span>
            <span className="font-display text-2xl font-bold text-ink tabular-nums">{liveCount}</span>
            <span className="text-sm text-ink/60">live now</span>
          </div>
        </div>

        <div className="rounded-xl bg-white border border-ink/10 p-4 shadow-tactile sm:col-span-2 lg:col-span-1">
          <p className="text-xs font-medium text-ink/50 uppercase tracking-wide mb-3">Cards per column</p>
          <div className="space-y-2.5">
            {countsByColumn.map(({ column, count }, index) => {
              const accent = accentForIndex(index);
              const widthPct = Math.round((count / maxColumnCount) * 100);
              return (
                <div key={column.id} className="flex items-center gap-2 text-sm">
                  <span className="w-24 truncate text-ink/70">{column.title}</span>
                  <div className="flex-1 h-2.5 rounded-full bg-ink/5 overflow-hidden">
                    <div className={`h-full rounded-full ${ACCENT_BG[accent]}`} style={{ width: `${widthPct}%` }} />
                  </div>
                  <span className="w-5 text-right text-ink/70 tabular-nums">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-xl bg-white border border-ink/10 p-4 shadow-tactile">
        <p className="text-xs font-medium text-ink/50 uppercase tracking-wide mb-3">Recently active</p>
        {recentlyActive.length === 0 ? (
          <p className="text-sm text-ink/50">No cards yet — recent activity will show up here.</p>
        ) : (
          <ul className="space-y-2">
            {recentlyActive.map((card) => {
              const accent = accentByColumnId.get(card.columnId) ?? "sky";
              const column = columns[card.columnId];
              return (
                <li
                  key={card.id}
                  className={`flex items-center justify-between gap-3 border-l-4 ${ACCENT_BORDER_LEFT[accent]} pl-3 py-1 text-sm`}
                >
                  <span className="truncate text-ink">{card.title}</span>
                  <span className="shrink-0 text-xs text-ink/50">
                    {column?.title ?? ""} · {formatRelativeTime(card.updatedAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
