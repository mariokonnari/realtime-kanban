# realtime-kanban

A real-time collaborative Kanban board demonstrating two concurrency
strategies side by side: last-write-wins (LWW) registers for
single-value fields, and CRDTs (Yjs) for concurrent list ordering.

## Architecture

- **`apps/web`** — Next.js App Router frontend, Tailwind CSS.
- **`apps/server`** — Node WebSocket server. Kept as a separate
  deployable unit from `web` on purpose: persistent WebSocket
  connections don't survive on serverless platforms like Vercel, so
  the realtime layer has to be its own process.
- **`packages/shared-types`** — the wire protocol and domain model,
  imported by both apps. One shared source of truth for message
  shapes prevents client and server drifting out of sync silently.

## Sync strategy per field

| Field | Strategy |
|---|---|
| `Board.name`, `Column.title` | LWW |
| `Card.title`, `Card.description`, `Card.columnId` | LWW |
| `Card.position` | Naive LWW-on-index first (deliberately breaks under concurrent drags) → replaced with Yjs `Y.Array` |
| `Column.order` | Deferred — goes straight to `Y.Array`, no naive phase |

**Why `Card.position` gets the naive-then-CRDT treatment and
`Column.order` doesn't:** card drags are the highest-frequency
interaction and the one worth demonstrating the LWW failure mode on.
Column reorders are rare — repeating the same broken-demo narrative
there would double the build for no new interview story.

**LWW tie-breaking:** every field mutation carries a Lamport clock
(`{ lamport, clientId }`), not a wall-clock timestamp — wall clocks
drift across machines and can't be trusted to order concurrent edits.
Higher `lamport` wins; ties break on `clientId`.

**Tombstones:** deletes never remove a row — they set `deletedAt`.
Policy is delete-wins-unconditionally: once a card is tombstoned, any
concurrent edit referencing it is dropped, even if the edit's clock is
newer. Chosen over clock-based resurrection because a deleted card
reappearing is worse UX than one dropped edit.

**Why Tailwind over a compiled atomic-CSS approach (StyleX/Emotion,
as Linear uses):** that choice is scale-driven for Linear — years of
CSS, large team, measured runtime cost. None of that applies here.
Tailwind matches broader industry adoption and lets time go toward
the CRDT/LWW logic instead of a hand-rolled design system.

## Known gaps

- No board UI yet — drag-and-drop, columns, cards
- No WebSocket client / Yjs binding in `apps/web`
- No persistence — `apps/server/src/store.ts` is in-memory; swappable
  for Postgres/Prisma without touching the LWW/CRDT logic
- No auth
- No offline queue / reconnect sync (IndexedDB)
- No sync-on-connect — a client joining mid-session sees nothing
  until the next edit; needs a `SYNC_REQUEST`/`SYNC_RESPONSE` pair
- `CRDT_UPDATE.update` is a raw `Uint8Array`, currently sent through
  `JSON.stringify` — corrupts binary data. Needs a binary WS frame
  before this path is real.

## Getting started

```bash
npm install
npm run dev:server   # apps/server, ws://localhost:4001
npm run dev:web       # apps/web, http://localhost:3000
```