# realtime-kanban

A real-time collaborative Kanban board demonstrating two concurrency
strategies side by side: last-write-wins (LWW) registers for
single-value fields, and CRDTs (Yjs) for concurrent list ordering.

**Status: the core real-time loop is built and verified — board UI,
WebSocket client, LWW mutations, CRDT card ordering, tombstoned
deletes, and sync-on-connect for late joiners all work end to end.**
Persistence, auth, offline queue, and tests are the remaining gaps
(see below).

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

## Local dev workflow

```bash
npm install
npm run build:shared-types   # required before first run, and after
                               # any edit to packages/shared-types
npm run dev:server            # apps/server, ws://localhost:4001
npm run dev:web                # apps/web, http://localhost:3000
```

Open `http://localhost:3000` in two browser tabs side by side. Add a
card in one tab — it appears in the other. Drag a card between
columns or reorder it within a column — both tabs converge to the
same order. Edit a card's title concurrently in both tabs — one edit
wins deterministically (LWW), not just "whichever saved last."

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

## Known gaps

- **No persistence** — `apps/server/src/store.ts` is in-memory;
  restarting the server loses all data. Swappable for Postgres/Prisma
  without touching the LWW/CRDT logic itself.
- **No auth** — anyone who connects can edit anything.
- **No offline queue / reconnect sync** — the client's WebSocket
  reconnects on drop (naive fixed-delay, no backoff), but any edits
  made while disconnected are lost, not queued.
- **No tests** — Vitest + RTL were part of the original plan and
  haven't been added yet.
- **No column management UI** — columns are fixed at three, seeded
  server-side.
- **Base64 CRDT transport** is a real tradeoff, not a bug, but binary
  WS frames would be more efficient at larger scale.
