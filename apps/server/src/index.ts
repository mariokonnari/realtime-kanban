import { WebSocketServer, WebSocket } from "ws";
import * as Y from "yjs";
import type { ClientMessage, Presence, ServerMessage, SyncResponseMessage } from "@realtime-kanban/shared-types";
import { decodeUpdate } from "@realtime-kanban/shared-types";
import {
  applyMutation,
  applyDelete,
  isTombstoned,
  createEntity,
  getColumnDoc,
  persistColumnDoc,
  getFullState,
  initStore,
  seedDemoBoard,
  cards,
} from "./store.js";
import { assertServerDatabaseHost } from "./db-guard.js";

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

const wss = new WebSocketServer({
  port: PORT,
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
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function send(socket: WebSocket, message: unknown) {
  socket.send(JSON.stringify(message));
}

wss.on("connection", (socket) => {
  clients.add(socket);

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as ClientMessage;

    switch (message.type) {
      case "SYNC_REQUEST": {
        const state = getFullState();
        const response: SyncResponseMessage = {
          type: "SYNC_RESPONSE",
          ...state,
          presence: [...presenceBySocket.values()],
        };
        send(socket, response);
        break;
      }

      case "CREATE": {
        createEntity(message.entityType, message.entityId, message.initialValues);
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
        }
        break;
      }

      case "DELETE": {
        applyDelete(message.entityType, message.entityId);
        broadcast(message, socket);
        break;
      }

      case "CRDT_UPDATE": {
        const doc = getColumnDoc(message.columnId);
        Y.applyUpdate(doc, decodeUpdate(message.update));
        persistColumnDoc(message.columnId);
        broadcast(message, socket); // relay the same base64 string, no re-encoding needed
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
  });

  socket.on("close", () => {
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
