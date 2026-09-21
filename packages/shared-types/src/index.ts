export * from "./binary.js";

// ---- Conflict resolution primitives ----

// Logical clock, not wall-clock time — wall clocks drift across machines
// and can't be trusted to order concurrent edits correctly.
export interface LamportClock {
  lamport: number;
  clientId: string; // tie-breaker when two clocks land on the same tick
}

// ---- Domain model ----

export interface Board {
  id: string;
  name: string; // LWW
  createdAt: string;
}

export interface Column {
  id: string;
  boardId: string;
  title: string; // LWW
  order: number; // deferred: will use Y.Array directly, no naive phase
}

export interface Card {
  id: string;
  columnId: string; // LWW — "which column is this card in"
  title: string; // LWW
  description: string; // LWW
  position: number; // legacy naive field, superseded by each column's Y.Array
  createdAt: string;
  deletedAt: string | null; // tombstone — never hard-delete
}

export type EntityType = "board" | "column" | "card";

// ---- Presence (ephemeral, not persisted — see apps/server/src/index.ts) ----

// No real auth: each tab picks a random name + color for itself on
// connect, just enough to tell two open tabs apart in a demo.
export interface Presence {
  clientId: string;
  name: string;
  color: string;
  cardId: string | null; // the card this client is actively editing, or null
}

// ---- Wire messages ----

export interface MutateMessage {
  type: "MUTATE";
  entityType: EntityType;
  entityId: string;
  field: string;
  value: unknown;
  clock: LamportClock;
}

export interface CrdtUpdateMessage {
  type: "CRDT_UPDATE";
  columnId: string;
  update: string; // base64-encoded Yjs diff — see binary.ts for why
}

export interface CreateMessage {
  type: "CREATE";
  entityType: EntityType;
  entityId: string;
  initialValues: Record<string, unknown>;
  clock: LamportClock;
}

export interface DeleteMessage {
  type: "DELETE";
  entityType: EntityType;
  entityId: string;
  clock: LamportClock;
}

// Broadcast whenever a client starts or stops editing a card
// (cardId: null means "stopped"). No clock — last message for a given
// clientId simply wins, which is fine for a display-only hint.
export interface PresenceMessage extends Presence {
  type: "PRESENCE";
}

// Sent by a client immediately on connecting — it has no state yet
// and needs the server to hand it everything that currently exists.
export interface SyncRequestMessage {
  type: "SYNC_REQUEST";
}

// The server's reply to SYNC_REQUEST: full current state, including
// each column's Yjs ordering doc encoded as a single full update.
export interface SyncResponseMessage {
  type: "SYNC_RESPONSE";
  boards: Board[];
  columns: Column[];
  cards: Card[]; // tombstoned cards are excluded, not sent
  columnOrders: Record<string, string>; // columnId -> base64 full Y.Doc state
  presence: Presence[]; // who else is currently editing what, for late joiners
}

export type ClientMessage =
  | MutateMessage
  | CrdtUpdateMessage
  | CreateMessage
  | DeleteMessage
  | PresenceMessage
  | SyncRequestMessage;

export type ServerMessage =
  | MutateMessage
  | CrdtUpdateMessage
  | CreateMessage
  | DeleteMessage
  | PresenceMessage
  | SyncResponseMessage;
