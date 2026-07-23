export interface LamportClock {
    lamport: number;
    clientId: string;
}

export interface Board {
    id: string;
    name: string;
    createdAt: string;
}

export interface Column {
    id: string;
    boardId: string;
    title: string;
    order: number;
}

export interface Card {
    id: string;
    columnId: string;
    title: string;
    description: string;
    position: number;
    createdAt: string;
    deletedAt: string | null;
}

export type EntityType = "board" | "column" | "card";

export interface MutateMessage {
    type: "MUTATE",
    entityType: EntityType;
    entityId: string;
    field: string;
    value: unknown;
    clock: LamportClock;
}

export interface CrdtUpdateMessage {
    type: "CRDT_UPDATE";
    columnId: string;
    update: Uint8Array;
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

export type ClientMessage = 
    | MutateMessage
    | CrdtUpdateMessage
    | CreateMessage
    | DeleteMessage;