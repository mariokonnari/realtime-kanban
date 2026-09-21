import { WebSocketServer, WebSocket } from "ws";
import * as Y from "yjs";
import type { ClientMessage, Presence, SyncResponseMessage } from "@realtime-kanban/shared-types";
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
} from "./store.js";

const PORT = Number(process.env.PORT ?? 4001);
await initStore();
await seedDemoBoard();

const wss = new WebSocketServer({ port: PORT });
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
        broadcast(message, socket);
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
        if (applied) broadcast(message, socket);
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
    // If this client was mid-edit when it disconnected, tell everyone else
    // to drop the badge — otherwise it'd be stuck showing forever.
    if (presence?.cardId != null) {
      broadcast({ type: "PRESENCE", ...presence, cardId: null } satisfies ClientMessage);
    }
  });
});

console.log(`Kanban WS server listening on ws://localhost:${PORT}`);
