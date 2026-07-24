import type { LamportClock } from "@realtime-kanban/shared-types";

/**
 * Returns true if `incoming` should overwrite `current`.
 * Higher lamport wins; on a tie, higher clientId wins (arbitrary but
 * deterministic — every replica applies the same rule and converges).
 */
export function isNewer(incoming: LamportClock, current: LamportClock | undefined): boolean {
  if (!current) return true;
  if (incoming.lamport !== current.lamport) return incoming.lamport > current.lamport;
  return incoming.clientId > current.clientId;
}