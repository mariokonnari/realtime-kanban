import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import type { Board, Column, Card, LamportClock, EntityType } from "@realtime-kanban/shared-types";
import { encodeUpdate } from "@realtime-kanban/shared-types";
import { isNewer } from "./lww.js";

type Entity = Board | Column | Card;

const fieldClocks = new Map<string, LamportClock>();
const boards = new Map<string, Board>();
const columns = new Map<string, Column>();
const cards = new Map<string, Card>();
const columnDocs = new Map<string, Y.Doc>();

function tableFor(entityType: EntityType) {
  return entityType === "board" ? boards : entityType === "column" ? columns : cards;
}

function fieldKey(entityId: string, field: string) {
  return `${entityId}:${field}`;
}

export function applyMutation(
  entityType: EntityType,
  entityId: string,
  field: string,
  value: unknown,
  clock: LamportClock,
): boolean {
  const key = fieldKey(entityId, field);
  if (!isNewer(clock, fieldClocks.get(key))) return false;

  const table = tableFor(entityType) as Map<string, Entity>;
  const entity = table.get(entityId);
  if (!entity) return false;

  // Bypassing structural typing here is deliberate: this function's whole
  // job is "write an arbitrary named field," which TypeScript's static
  // model can't verify. See project notes on the tradeoff this implies.
  (entity as unknown as Record<string, unknown>)[field] = value;
  fieldClocks.set(key, clock);
  return true;
}

export function applyDelete(entityType: EntityType, entityId: string): boolean {
  const table = tableFor(entityType) as Map<string, Card | Column | Board>;
  const entity = table.get(entityId);
  if (!entity || !("deletedAt" in entity)) return false;
  (entity as Card).deletedAt = new Date().toISOString();
  return true;
}

export function isTombstoned(entityType: EntityType, entityId: string): boolean {
  if (entityType !== "card") return false;
  return cards.get(entityId)?.deletedAt != null;
}

export function createEntity(entityType: EntityType, entityId: string, initial: Record<string, unknown>) {
  const table = tableFor(entityType) as Map<string, Entity>;
  table.set(entityId, { id: entityId, ...initial } as Entity);
}

export function getColumnDoc(columnId: string): Y.Doc {
  let doc = columnDocs.get(columnId);
  if (!doc) {
    doc = new Y.Doc();
    columnDocs.set(columnId, doc);
  }
  return doc;
}

/** Full snapshot for a newly-connected client (SYNC_RESPONSE payload). */
export function getFullState() {
  const columnOrders: Record<string, string> = {};
  for (const [columnId, doc] of columnDocs.entries()) {
    columnOrders[columnId] = encodeUpdate(Y.encodeStateAsUpdate(doc));
  }
  return {
    boards: [...boards.values()],
    columns: [...columns.values()],
    cards: [...cards.values()].filter((c) => c.deletedAt == null),
    columnOrders,
  };
}

/** Seeds a single demo board so the UI has something to render on first run. */
export function seedDemoBoard() {
  if (boards.size > 0) return;

  const boardId = randomUUID();
  boards.set(boardId, { id: boardId, name: "Demo Board", createdAt: new Date().toISOString() });

  const columnTitles = ["To do", "In progress", "Done"];
  columnTitles.forEach((title, order) => {
    const columnId = randomUUID();
    columns.set(columnId, { id: columnId, boardId, title, order });
    getColumnDoc(columnId).getArray<string>("cardOrder"); // initialize empty Y.Array
  });
}

export { boards, columns, cards };
