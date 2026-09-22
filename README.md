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

## Deployment

**Live demo:** _not yet deployed — see steps below_

Three separate services, matching "Architecture" above: `apps/web` →
Vercel, `apps/server` → Render, Postgres → Supabase (chosen over
Render's own free Postgres, which is deleted after 30 days — Supabase's
free tier only pauses on inactivity and keeps the data).

### 1. Supabase (database)

Create a project, then **Project Settings → Database → Connection
string** and copy the **Session pooler** string, not "Direct
connection." Supabase's direct-connection host is IPv6-only on the free
tier, and Render (like most PaaS platforms) only has IPv4 egress, so the
direct string will fail to connect from Render even though it works
from a home network with IPv6. The session pooler is IPv4-reachable and
— unlike the transaction pooler on port 6543 — behaves enough like a
normal Postgres connection that Prisma Client and `prisma migrate
deploy` both work against it with no extra flags (`pgbouncer=true`
etc.). This string becomes `DATABASE_URL` in step 2.

### 2. Render (apps/server)

Create a **Web Service** from this repo. Leave **Root Directory**
unset (the repo root) — `apps/server` depends on `packages/shared-types`,
and running `npm install` from the repo root is what makes npm
workspaces resolve that and hoist `node_modules` correctly; setting
Root Directory to `apps/server` would `cd` into it before `npm install`
ever runs and break that resolution.

- **Build Command:**
  ```
  npm install && npm run build:shared-types && npx prisma generate --schema=apps/server/prisma/schema.prisma && npm run build --workspace=apps/server
  ```
- **Pre-Deploy Command** (runs after build, before the new instance
  takes traffic; if your plan's UI doesn't have this field, append it
  to the Build Command instead):
  ```
  npx prisma migrate deploy --schema=apps/server/prisma/schema.prisma
  ```
- **Start Command:**
  ```
  node apps/server/dist/index.js
  ```
- **Environment variables:**
  - `DATABASE_URL` — the Supabase session pooler string from step 1.
  - `ALLOWED_ORIGINS` (optional, recommended) — your Vercel domain,
    e.g. `https://your-app.vercel.app`. See "WebSocket origin checks"
    below.
  - `PORT` — Render sets this automatically; `index.ts` already reads
    `process.env.PORT`, no action needed.

Render's free tier spins the service down after 15 minutes of
inactivity. Data isn't at risk (Postgres lives on Supabase, not on this
service), but the first connection after idle time takes 30–60s to wake
it back up — the client's fixed-delay reconnect in `ws-client.ts` just
keeps retrying until it succeeds, so this shows up as a slow first
connect, not an error.

Once deployed, note the `https://<name>.onrender.com` URL — Render
terminates TLS for you, so `wss://<name>.onrender.com` (swap the
scheme) is what becomes `NEXT_PUBLIC_WS_URL` in step 3. No code change
is needed for `wss://` to work.

### 3. Vercel (apps/web)

Import the repo, then in **Project Settings**:

- **Root Directory:** `apps/web`, with **"Include source files outside
  of the Root Directory in the Build Step"** turned on — needed so the
  build can still see `../../packages/shared-types` and the root
  lockfile for npm workspaces to resolve. (If that setting doesn't
  behave as expected, the fallback is Root Directory = repo root with
  Output Directory = `apps/web/.next`.)
- **Build Command** (override the default — see below):
  ```
  npm --prefix ../.. run build:shared-types && npm run build
  ```
- **Environment variables:**
  - `NEXT_PUBLIC_WS_URL` = `wss://<your-render-service>.onrender.com`

  Set this **before** the first build, or redeploy after adding it.
  Next.js inlines `NEXT_PUBLIC_*` variables into the JS bundle at build
  time — it does not read them at runtime — so changing the value later
  requires a new build, not just a restart.

### Does the build need shared-types built first?

Yes. `packages/shared-types/package.json` points `main` at
`dist/index.js`, not source (see "Why shared-types is compiled"
above). If `apps/web`'s build runs plain `next build` with no `dist/`
present, the import `@realtime-kanban/shared-types` fails to resolve
and the build breaks. The override above runs the same
`build:shared-types` step the root `npm run build` script already
does, just from `apps/web`'s working directory (Vercel always builds
from Root Directory).

### WebSocket origin checks (CORS)

No server changes were needed for the deployed web app to *connect* —
a WebSocket handshake isn't a `fetch()`/XHR request, so it isn't
subject to the browser's CORS/same-origin checks. `apps/server` will
accept a connection from your Vercel domain with zero configuration,
exactly like it already does from `localhost`.

The flip side: with nothing configured, it also accepts a connection
from anywhere else — the WS endpoint has a public, guessable URL now,
so anyone who has it can open a raw WebSocket and read/write board
data, same as the already-documented "No auth" gap, just reachable
from the internet instead of only your machine. `index.ts` supports an
optional `ALLOWED_ORIGINS` env var (comma-separated) that restricts
accepted connections via `verifyClient`; left unset, it's a no-op —
local dev and the zero-config deploy behave exactly as before. Set it
to your Vercel production domain once you have it. (Vercel preview
deployments get a new URL each time, so this only cleanly covers the
production domain unless you keep `ALLOWED_ORIGINS` updated.)

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
