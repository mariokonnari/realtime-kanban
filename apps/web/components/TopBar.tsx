"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useBoard } from "@/lib/board-context";
import { useConnectionStatus } from "@/lib/use-connection-status";

export function TopBar() {
  const pathname = usePathname();
  const { collaborators } = useBoard();
  const isDashboard = pathname === "/dashboard";
  const liveCount = collaborators.length + 1; // +1 for this tab
  const { connected, pending, interrupted } = useConnectionStatus();
  // "Offline" only once a connection has actually dropped/failed (or queued
  // work is waiting) — not during the first moments after page load.
  const offline = !connected && (interrupted || pending > 0);
  // Reconnected, but the queue hasn't finished draining yet.
  const syncing = connected && pending > 0;

  return (
    <header className="sticky top-0 z-20 bg-canvas/90 backdrop-blur border-b border-ink/10">
      <div className="mx-auto max-w-6xl px-4 sm:px-8 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <span className="font-display font-bold text-base sm:text-lg text-ink whitespace-nowrap truncate">
            Realtime Kanban
          </span>
          <nav className="flex gap-1 text-sm font-medium" aria-label="Primary">
            <Link
              href="/"
              aria-current={!isDashboard ? "page" : undefined}
              className={`px-3 py-1.5 rounded-full transition-colors ${
                !isDashboard ? "bg-ink text-canvas" : "text-ink/60 hover:text-ink hover:bg-ink/5"
              }`}
            >
              Board
            </Link>
            <Link
              href="/dashboard"
              aria-current={isDashboard ? "page" : undefined}
              className={`px-3 py-1.5 rounded-full transition-colors ${
                isDashboard ? "bg-ink text-canvas" : "text-ink/60 hover:text-ink hover:bg-ink/5"
              }`}
            >
              Dashboard
            </Link>
          </nav>
        </div>
        {offline || syncing ? (
          <div
            className="flex items-center gap-2 shrink-0"
            role="status"
            title={
              offline
                ? `Not connected — ${pending} change${pending === 1 ? "" : "s"} saved on this device, will sync on reconnect`
                : `Reconnected — sending ${pending} saved change${pending === 1 ? "" : "s"}`
            }
          >
            <span className="inline-flex h-2 w-2 rounded-full bg-accent-pink" />
            <span className="text-xs sm:text-sm font-medium text-ink/70 whitespace-nowrap">
              {offline ? "Offline" : "Syncing"} — {pending} pending
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 shrink-0" title={`${liveCount} people connected right now`}>
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-accent-sunflower opacity-75 motion-safe:animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-sunflower" />
            </span>
            <span className="text-xs sm:text-sm font-medium text-ink/70 whitespace-nowrap">{liveCount} live</span>
          </div>
        )}
      </div>
    </header>
  );
}
