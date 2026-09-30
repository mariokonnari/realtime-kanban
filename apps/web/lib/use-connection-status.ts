"use client";

import { useSyncExternalStore } from "react";
import { wsClient, type ConnectionStatus } from "./ws-client";

// What the server-rendered HTML assumes: nothing pending, no failed
// connection — i.e. the normal "N live" indicator, same as before this existed.
const SERVER_STATUS: ConnectionStatus = { connected: false, pending: 0, interrupted: false };

export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(wsClient.subscribeStatus, wsClient.getStatus, () => SERVER_STATUS);
}
