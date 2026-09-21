# realtime-kanban

A real-time collaborative Kanban board demonstrating two concurrency
strategies side by side: last-write-wins (LWW) registers for
single-value fields, and CRDTs (Yjs) for concurrent list ordering.

**Status: the core real-time loop is built and verified — board UI,
WebSocket client, LWW mutations, CRDT card ordering, tombstoned
deletes, sync-on-connect for late joiners, Postgres persistence, and
lightweight per-tab presence all work end to end.** Auth, an offline
queue, and column management UI are the remaining gaps (see below).

## Architecture

- **`apps/web`** — Next.js App Router frontend, Tailwind CSS.
- **`apps/server`** — Node WebSocket server. Separate from `web` on
  purpose: persistent WebSocket connections don't survive on
  serverless platforms like Vercel, so the realtime layer has to be
  its own deployable process.
- **`packages/shared-types`** — the wire protocol and domain model,
  compiled to `dist/` and consumed by both apps as real `.js` output
  (see "Why shared-types is compiled" below — this wasn't the
  original design, it's a fix for a real bug).

## Running this locally

```bash
npm install
npm run build:shared-types   # required before first run, and after
                               # any edit to packages/shared-types
docker compose up -d          # local Postgres for apps/server
npm run prisma:generate --workspace=apps/server
npm run prisma:migrate --workspace=apps/server   # first run only, creates the schema
npm run dev:server            # apps/server, ws://localhost:4001
npm run dev:web                # apps/web, http://localhost:3000
```

Open `http://localhost:3000` in two browser tabs side by side. Add a
card in one tab — it appears in the other. Drag a card between
columns or reorder it within a column — both tabs converge to the
same order, with a drop-zone highlight showing where the card will
land. Edit a card's title concurrently in both tabs — one edit wins
deterministically (LWW), not just "whichever saved last." Click into
a card to edit it in one tab — the other tab shows a small colored
name badge on that card for as long as you're editing.

**If you're actively editing `packages/shared-types`**, run
`npm run dev --workspace=packages/shared-types` in a separate
terminal (a `tsc --watch`) so `apps/server` and `apps/web` pick up
changes without you remembering to rebuild manually each time.

## Why shared-types is compiled, not imported as raw source

Originally `apps/server` and `apps/web` both imported
`shared-types`' `.ts` source directly. That broke in two opposite
directions at once: `apps/server` runs via `tsx`, which uses Node's
real ESM loader and requires relative imports to end in `.js` even
when the file is `.ts`. Turbopack (bundling `shared-types` for the
browser) couldn't resolve that same `.js`-pointing-to-`.ts`
convention and failed with "module has no exports at all." Neither
import style satisfied both consumers — so the fix isn't an import
style, it's not shipping raw source to either side. `shared-types`
now compiles to `dist/index.js` + `.d.ts`, and both apps import that,
same as they'd import any other real npm package.

## Sync strategy per field

| Field | Strategy |
|---|---|
| `Board.name`, `Column.title` | LWW |
| `Card.title`, `Card.description`, `Card.columnId` | LWW |
| `Card.position` (ordering) | Yjs `Y.Array`, one per column |
| `Column.order` | Fixed at seed time — no reordering UI yet |

**Why `Card.position` gets CRDT treatment and `Column.order`
doesn't:** card drags are the highest-frequency interaction and the
one worth demonstrating the LWW failure mode on. Column reorders are
rare and there's no UI for adding/removing columns yet — three fixed
columns (`To do` / `In progress` / `Done`) are seeded on first server
start.

**LWW tie-breaking:** every field mutation carries a Lamport clock
(`{ lamport, clientId }`), not a wall-clock timestamp. Higher
`lamport` wins; ties break on `clientId`.

**Tombstones:** deletes never remove a row — they set `deletedAt`.
Delete wins unconditionally: a concurrent edit to a tombstoned card
is dropped even if its clock is newer.

**CRDT updates over the wire:** JSON can't carry a raw `Uint8Array`,
so `Y.encodeStateAsUpdate`'s output is base64-encoded before sending
(see `packages/shared-types/src/binary.ts`) and decoded on receipt.
This trades ~33% size overhead for not needing binary WebSocket
frames — an acceptable tradeoff at this scale.

**Sync-on-connect:** a client sends `SYNC_REQUEST` on connecting; the
server replies with every board/column/non-tombstoned-card plus each
column's full CRDT state, so a client joining mid-session sees
current state immediately instead of waiting for the next edit.

## Persistence

`apps/server/src/store.ts` is backed by Postgres via Prisma
(`apps/server/prisma/schema.prisma`). The in-memory `Map`s that the
LWW/CRDT logic reads and writes are still there — they're hydrated
from Postgres on startup (`initStore()`) and every mutation is
written through to the DB after the in-memory check-and-set, so the
conflict-resolution code itself never touches Prisma directly.

- `field_clocks` persists the same `{ lamport, clientId }` each field
  last applied, not just the entity data — without it a restart would
  forget which edits already won and let an old edit resurrect itself.
- `column_docs` persists each column's full Yjs state
  (`Y.encodeStateAsUpdate`), so card ordering survives a restart too.
- DB writes are queued (`store.ts`'s `enqueue`) so they land in the
  same order as the in-memory mutations that triggered them — Prisma
  calls are async, so without this a slower write for an
  already-superseded clock could finish after a newer one and leave
  the DB holding the stale value.
- `seedDemoBoard()` only seeds if `boards` is empty in Postgres.

See "Running this locally" above for the local Postgres setup.

## Known gaps

- **No auth** — anyone who connects can edit anything.
- **No offline queue / reconnect sync** — the client's WebSocket
  reconnects on drop (naive fixed-delay, no backoff), but any edits
  made while disconnected are lost, not queued.
- **Test coverage is unit-level, not end-to-end.**
  `apps/server/src/*.test.ts` covers the LWW tie-breaking rules, the
  CRDT-vs-naive-LWW ordering guarantee side by side, and tombstone
  behavior; `apps/web/**/*.test.ts` covers the board reducer and
  `CardItem`. Nothing drives the actual WebSocket server end-to-end,
  and `Board.tsx`/`Column.tsx` and the drag-and-drop interaction
  aren't covered.
- **No column management UI** — columns are fixed at three, seeded
  server-side.
- **Presence is best-effort, not persisted** — editing badges are
  relayed live between connected clients and included in
  `SYNC_RESPONSE` for late joiners, but there's no history once a
  client disconnects mid-edit beyond clearing its badge.
- **Base64 CRDT transport** is a real tradeoff, not a bug, but binary
  WS frames would be more efficient at larger scale.
