"use client";

import type { ClientMessage, ServerMessage, LamportClock } from "@realtime-kanban/shared-types";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4001";

// Stable per-tab identity for the lifetime of the page. A real deployment
// would persist this in sessionStorage so a refresh doesn't reset it —
// left as module state for now since the demo doesn't depend on it
// surviving a reload.
const clientId = crypto.randomUUID();
let lamport = 0;

export function nextClock(): LamportClock {
  lamport += 1;
  return { lamport, clientId };
}

export function getClientId() {
  return clientId;
}

// No real auth: just enough that two open tabs are visually
// distinguishable in a demo. Picked once per tab, same lifetime as
// clientId above.
const PRESENCE_NAMES = [
  "Otter", "Falcon", "Lynx", "Panda", "Heron", "Fox", "Wren", "Orca",
  "Ibis", "Newt", "Puffin", "Badger", "Mantis", "Gecko", "Raven", "Stoat",
];
const PRESENCE_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
];

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

export const presenceIdentity = { name: pick(PRESENCE_NAMES), color: pick(PRESENCE_COLORS) };

type Listener = (message: ServerMessage) => void;

class WsClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private queue: ClientMessage[] = [];

  connect() {
    if (this.socket) return;
    const socket = new WebSocket(WS_URL);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.rawSend({ type: "SYNC_REQUEST" });
      this.queue.forEach((message) => this.rawSend(message));
      this.queue = [];
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as ServerMessage;
      this.listeners.forEach((listener) => listener(message));
    });

    socket.addEventListener("close", () => {
      this.socket = null;
      // Naive fixed-delay reconnect, no exponential backoff yet —
      // acceptable for a demo, a real gap for production.
      setTimeout(() => this.connect(), 1000);
    });
  }

  private rawSend(message: ClientMessage) {
    this.socket?.send(JSON.stringify(message));
  }

  send(message: ClientMessage) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.rawSend(message);
    } else {
      this.queue.push(message);
    }
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const wsClient = new WsClient();
