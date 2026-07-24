import { WebSocketServer, WebSocket } from "ws";
import * as Y from "yjs";
import type { ClientMessage } from "@realtime-kanban/shared-types";
import { applyMutation, applyDelete, isTombstoned, createEntity, getColumnDoc } from "./store.js";

const PORT = Number(process.env.PORT ?? 4001);
const wss = new WebSocketServer({ port: PORT });
const clients = new Set<WebSocket>();

function broadcast(message: unknown, exclude?: WebSocket) {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

wss.on("connection", (socket) => {
  clients.add(socket);

  socket.on("message", (raw) => {
    // NOTE: JSON.stringify/parse can't carry a raw Uint8Array (CRDT_UPDATE.update)
    // cleanly — real implementation should send CRDT_UPDATE as a separate binary
    // WS frame, not JSON. Flagged here rather than silently done wrong.
    const message = JSON.parse(raw.toString()) as ClientMessage;

    switch (message.type) {
      case "CREATE": {
        createEntity(message.entityType, message.entityId, message.initialValues);
        broadcast(message, socket);
        break;
      }

      case "MUTATE": {
        if (message.entityType === "card" && isTombstoned("card", message.entityId)) {
          // Delete wins — silently drop edits to a tombstoned card.
          break;
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
        Y.applyUpdate(doc, new Uint8Array(message.update));
        broadcast(message, socket);
        break;
      }
    }
  });

  socket.on("close", () => clients.delete(socket));
});

console.log(`Kanban WS server listening on ws://localhost:${PORT}`);