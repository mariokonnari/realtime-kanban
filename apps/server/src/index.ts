import { WebSocketServer, WebSocket } from "ws";
import * as Y from "yjs";
import type { ClientMessage, Presence, ServerMessage, SyncResponseMessage } from "@realtime-kanban/shared-types";
import { LIMITS, decodeUpdate, parseClientMessage } from "@realtime-kanban/shared-types";
import {
  applyMutation,
  applyDelete,
  isTombstoned,
  createEntity,
  columnDocFor,
  isKnownColumn,
  persistColumnDoc,
  repairStoredOrders,
  flushWrites,
  getFullState,
  initStore,
  seedDemoBoard,
  cards,
} from "./store.js";
import { assertServerDatabaseHost } from "./db-guard.js";
import { FrameQueue, RejectedIds, ViolationTracker, loadLimits } from "./connection-limits.js";

const PORT = Number(process.env.PORT ?? 4001);

// DATABASE_URL is expected to already be in process.env by this point.
// The "dev" script loads apps/server/.env explicitly via Node's
// --env-file-if-exists flag (see package.json) — deliberately not
// --env-file, which hard-crashes with a Node-internal error before any of
// this code runs if the file is missing; --env-file-if-exists degrades to
// "just don't set it," letting this check below produce a clear message
// instead. The "start" script (production) has no such flag: Render
// supplies env vars from its own dashboard, and there is no .env file
// there — this check has to work with nothing but process.env either way.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "Refusing to start: DATABASE_URL is not set.\n" +
      "Local dev: copy apps/server/.env.example to apps/server/.env and fill in a local Postgres connection string.\n" +
      "Production: set DATABASE_URL as an environment variable (e.g. Render's dashboard) — no .env file is used there.",
  );
  process.exit(1);
}
assertServerDatabaseHost(databaseUrl, process.env);

await initStore();
await seedDemoBoard();

// Data written before the repair existed (or by a process that crashed between a
// move's frames) may already list a card twice. Heal it before the first client
// can see it, and persist the result. A failure here must not keep the server down:
// the repair is an improvement on data that was already being served, so log it and boot.
try {
  const healedAtStart = repairStoredOrders();
  if (healedAtStart.length > 0) {
    await flushWrites();
    console.log(`Repaired the card order of ${healedAtStart.length} column(s) at startup.`);
  }
} catch (error) {
  console.error("Startup card order repair failed:", error);
}

// WebSocket handshakes aren't subject to browser CORS/same-origin checks
// the way fetch()/XHR are — with no verifyClient at all, this server
// already accepts a connection from any origin (that's how it's worked
// against localhost all along). ALLOWED_ORIGINS is opt-in hardening for
// production: unset, behavior is unchanged; set (comma-separated) in
// deployment, only matching Origin headers are accepted. See README
// "Deployment".
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const limits = loadLimits(process.env);

const wss = new WebSocketServer({
  port: PORT,
  // A frame over this is refused by ws itself, which closes the socket with
  // 1009 before the frame is buffered or parsed.
  maxPayload: limits.maxPayload,
  verifyClient:
    allowedOrigins.length > 0
      ? (info: { origin: string }) => allowedOrigins.includes(info.origin)
      : undefined,
});
const clients = new Set<WebSocket>();

// Who's editing what, right now — ephemeral, not persisted (see
// README.md "Persistence"). Keyed by socket so a disconnect can clean up
// without the client getting a chance to say "I stopped editing" first.
const presenceBySocket = new Map<WebSocket, Presence>();

function broadcast(message: unknown, exclude?: WebSocket) {
  // A messageId is between the sender and the server (see ACK below); other
  // clients have no use for it.
  const { messageId: _omitted, ...relayed } = message as { messageId?: string };
  const payload = JSON.stringify(relayed);
  for (const client of clients) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// After a CRDT_UPDATE or a columnId MUTATE has been applied: delete the order
// entries that disagree with the cards' columnIds, and tell EVERY client —
// the sender too, since its own optimistic insert may be one of the entries
// deleted. These frames are sent from here, not fed back through processFrame,
// so they never trigger another repair. A failure must not read as the sender's
// fault (a thrown handler counts as a violation), so it is logged and dropped.
function broadcastRepairs() {
  try {
    for (const { columnId, update } of repairStoredOrders()) {
      broadcast({ type: "CRDT_UPDATE", columnId, update } satisfies ServerMessage);
    }
  } catch (error) {
    console.error("Card order repair failed:", error);
  }
}

function send(socket: WebSocket, message: unknown) {
  socket.send(JSON.stringify(message));
}

function handleMessage(socket: WebSocket, message: ClientMessage) {
  switch (message.type) {
    case "SYNC_REQUEST": {
      const state = getFullState();
      const response: SyncResponseMessage = {
        type: "SYNC_RESPONSE",
        ...state,
        presence: [...presenceBySocket.values()],
        acks: true,
      };
      send(socket, response);
      break;
    }

    case "CREATE": {
      // A CREATE for an id that already exists (a replay, or a duplicate send)
      // is ignored outright: no overwrite, no DB write, no rebroadcast.
      if (!createEntity(message.entityType, message.entityId, message.initialValues)) break;
      // createEntity() overrides updatedAt with the server's own clock for
      // cards (see store.ts) — relay that authoritative value to other
      // clients too, not the client-sent one the raw message still
      // carries, so what they see matches what was actually persisted.
      const updatedAt = message.entityType === "card" ? cards.get(message.entityId)?.updatedAt : undefined;
      broadcast(
        updatedAt ? { ...message, initialValues: { ...message.initialValues, updatedAt } } : message,
        socket,
      );
      break;
    }

    case "MUTATE": {
      if (message.entityType === "card" && isTombstoned("card", message.entityId)) {
        break; // delete wins — silently drop edits to a tombstoned card
      }
      const applied = applyMutation(
        message.entityType,
        message.entityId,
        message.field,
        message.value,
        message.clock,
      );
      if (applied) {
        // applyMutation already bumped the in-memory card's updatedAt
        // synchronously — attach it so other clients can update their
        // local copy live instead of waiting for a reconnect/resync.
        const updatedAt = message.entityType === "card" ? cards.get(message.entityId)?.updatedAt : undefined;
        broadcast(updatedAt ? { ...message, updatedAt } : message, socket);
        if (message.entityType === "card" && message.field === "columnId") broadcastRepairs();
      }
      break;
    }

    case "DELETE": {
      // Only the delete that actually tombstones something is relayed; a
      // replay of one that already happened is ignored.
      if (applyDelete(message.entityType, message.entityId)) broadcast(message, socket);
      break;
    }

    case "CRDT_UPDATE": {
      // checkAgainstState() has already refused an unknown column, so this only
      // creates a doc for a column that exists.
      const doc = columnDocFor(message.columnId);
      if (!doc) throw new Error(`no such column ${message.columnId}`);
      Y.applyUpdate(doc, decodeUpdate(message.update));
      persistColumnDoc(message.columnId);
      broadcast(message, socket); // relay the same base64 string, no re-encoding needed
      broadcastRepairs();
      break;
    }

    case "PRESENCE": {
      presenceBySocket.set(socket, {
        clientId: message.clientId,
        name: message.name,
        color: message.color,
        cardId: message.cardId,
      });
      broadcast(message, socket);
      break;
    }
  }
}

// The id an ACK for this frame would carry. Only a sane one: an id past the cap
// (or not a string) can't have come from a conforming client, and echoing it
// back would just bounce an attacker's bytes at them.
function messageIdOf(parsed: unknown): string | undefined {
  const id = (parsed as { messageId?: unknown } | null)?.messageId;
  return typeof id === "string" && id.length > 0 && id.length <= LIMITS.messageId ? id : undefined;
}

function afterWrites(fn: () => void) {
  void flushWrites().then(fn);
}

// Tells the sending socket its message has been dealt with, so the client can
// stop holding it for replay. Sent once the DB writes queued so far have
// settled (flushWrites never rejects; a failed write is logged, see store.ts):
// an ACK means "applied and persisted", not just "applied in memory", so a
// server crash before the write leaves the message un-ACKed and it replays.
function ack(socket: WebSocket, messageId: string, error?: string) {
  afterWrites(() => {
    if (socket.readyState === WebSocket.OPEN) {
      send(socket, { type: "ACK", messageId, ...(error ? { error } : {}) } satisfies ServerMessage);
    }
  });
}

// Checks that need the server's state, run after the schema and before the
// handler touches anything. Returns why the message can't be accepted, if so.
// Nothing here registers or changes state.
function checkAgainstState(message: ClientMessage): string | undefined {
  if (message.type !== "CRDT_UPDATE") return undefined;
  if (!isKnownColumn(message.columnId)) return "unknown column";
  try {
    Y.decodeUpdate(decodeUpdate(message.update)); // parses the structs without applying them
  } catch {
    return "not a Yjs update";
  }
  return undefined;
}

let nextConnectionId = 1;

interface Connection {
  readonly id: number;
  readonly address: string;
  readonly socket: WebSocket;
  readonly violations: ViolationTracker;
  readonly queue: FrameQueue<WebSocket.RawData>;
  // Set once the server has decided to close this socket: later frames are
  // ignored (they were never ACKed, so a conforming client replays them).
  closing: boolean;
}

// Server-wide, so a replay on a new connection is recognised. See RejectedIds.
const rejectedIds = new RejectedIds();

function closeConnection(conn: Connection, code: number, reason: string) {
  if (conn.closing) return;
  conn.closing = true;
  conn.queue.stop();
  // After the ACKs already queued, so an entry rejected with an error is told
  // so before the socket goes: otherwise it would replay on the next
  // connection, be rejected again and eventually close that one too.
  afterWrites(() => conn.socket.close(code, reason));
}

// The one path for a message the server refuses: invalid, or it threw. A frame
// with a messageId is ACKed with an error and the client drops the entry; one
// without can't be, and is only logged. Either way it counts as a violation
// of this connection, and repeated violations close it.
function reject(conn: Connection, messageId: string | undefined, type: string, error: string) {
  // The same entry replayed after the connection that rejected it died, because
  // its error ACK never arrived, isn't a new offence by this client.
  const forgiven = messageId !== undefined && rejectedIds.forgive(messageId, conn.id);
  const count = forgiven ? 0 : conn.violations.record();
  console.warn(
    `[violation] conn=${conn.id} ${conn.address} ${type}: ${error}` +
      (forgiven ? " (replay of an already-rejected message, not counted)" : ` (${count}/${limits.maxViolations})`),
  );
  if (messageId) ack(conn.socket, messageId, `invalid message: ${error}`.slice(0, 200));
  if (!forgiven && conn.violations.isOver(count)) {
    console.warn(`[violation] conn=${conn.id} ${conn.address} closing: ${count} violations within ${limits.violationWindowMs} ms`);
    closeConnection(conn, 1008, "too many invalid messages");
  }
}

// A frame that isn't JSON, fails the schema, or can't be handled is logged and
// dropped. Nothing may throw out of a socket "message" listener: an uncaught
// exception there terminates the whole process, taking every client's
// connection with it. If the dropped message carried a messageId it is ACKed
// with an error, so the client discards it instead of replaying a message that
// can never succeed.
//
// Validation happens first and completely: the schema (shapes, caps, required
// fields, unknown fields stripped), then checks against server state. Only a
// message that passed both reaches handleMessage, so a handler never runs on
// input it would have to defend itself against, and nothing is registered or
// mutated on behalf of a message that is then refused.
function processFrame(conn: Connection, raw: WebSocket.RawData) {
  if (conn.closing) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    reject(conn, undefined, "frame", "not JSON"); // no messageId to ACK
    return;
  }
  const messageId = messageIdOf(parsed);
  const result = parseClientMessage(parsed);
  if (!result.ok) {
    reject(conn, messageId, "frame", result.error);
    return;
  }
  const message = result.message;
  const problem = checkAgainstState(message);
  if (problem) {
    reject(conn, messageId, message.type, problem);
    return;
  }
  try {
    handleMessage(conn.socket, message);
  } catch (error) {
    // Not expected now that the message is validated; kept so one bad message
    // can never take the process down.
    console.error(`Dropping ${message.type} message that failed to handle:`, error);
    reject(conn, messageId, message.type, "failed to handle message");
    return;
  }
  if (messageId) ack(conn.socket, messageId);
}

function frameBytes(raw: WebSocket.RawData): number {
  return Array.isArray(raw) ? raw.reduce((sum, chunk) => sum + chunk.byteLength, 0) : raw.byteLength;
}

wss.on("connection", (socket, request) => {
  clients.add(socket);

  const conn: Connection = {
    id: nextConnectionId++,
    address: request.socket.remoteAddress ?? "unknown",
    socket,
    violations: new ViolationTracker(limits.maxViolations, limits.violationWindowMs),
    closing: false,
    queue: new FrameQueue<WebSocket.RawData>(limits, {
      handle: (raw) => processFrame(conn, raw),
      onDelayStart: () =>
        console.warn(
          `[rate limit] conn=${conn.id} ${conn.address} past its burst of ${limits.burst}: delaying messages, in order`,
        ),
      onOverflow: () => {
        console.warn(
          `[rate limit] conn=${conn.id} ${conn.address} backlog over ${limits.maxBacklog} messages: closing; unACKed messages replay on reconnect`,
        );
        closeConnection(conn, 1013, "too many queued messages");
      },
    }),
  };

  // Without a listener an 'error' event is an uncaught exception, which ends
  // the process. ws emits one for a frame over maxPayload (RangeError, then it
  // closes the socket with 1009) and for protocol errors — all of which a
  // client can cause at will.
  socket.on("error", (error) => {
    console.warn(`[connection] conn=${conn.id} ${conn.address} socket error: ${error.message}`);
  });

  // Every frame goes through the queue, which hands it straight to processFrame
  // unless this connection is over its rate.
  socket.on("message", (raw) => conn.queue.push(raw, frameBytes(raw)));

  socket.on("close", () => {
    conn.queue.stop();
    clients.delete(socket);
    const presence = presenceBySocket.get(socket);
    presenceBySocket.delete(socket);
    // Tell everyone else this client is gone entirely — not just "stopped
    // editing" (the old cardId:null broadcast this replaces only fired for
    // a client that was mid-edit, and even then left a stale, never-editing
    // entry behind in every other client's presence map forever). A client
    // that never sent a PRESENCE message was never in presenceBySocket in
    // the first place, so there's nothing to tell anyone about.
    if (presence) {
      broadcast({ type: "PRESENCE_LEAVE", clientId: presence.clientId } satisfies ServerMessage);
    }
  });
});

console.log(`Kanban WS server listening on ws://localhost:${PORT}`);
