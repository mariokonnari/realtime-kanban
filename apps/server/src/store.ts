import * as Y from "yjs";
import type {
  Board,
  Column,
  Card,
  LamportClock,
  EntityType,
} from "@realtime-kanban/shared-types";
import { isNewer } from "./lww.js";

type Entity = Board | Column | Card;

// Tracks the clock that last won each (entityId, field) — this is what
// isNewer() compares against, kept separate from the entity data itself.
const fieldClocks = new Map<string, LamportClock>();

const boards = new Map<string, Board>();
const columns = new Map<string, Column>();
const cards = new Map<string, Card>();

// One Y.Doc per column, holding that column's card ordering (Y.Array).
// Not wired into card CRUD yet — this is the seam where the naive
// position field gets replaced.
const columnDocs = new Map<string, Y.Doc>();

function tableFor(entityType: EntityType) {
  return entityType === "board"
    ? boards
    : entityType === "column"
      ? columns
      : cards;
}

function fieldKey(entityId: string, field: string) {
  return `${entityId}:${field}`;
}

/** Apply an LWW field mutation. Returns false if a newer write already won (rejected, not an error). */
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

  (entity as unknown as Record<string, unknown>)[field] = value;
  fieldClocks.set(key, clock);
  return true;
}

/** Delete wins unconditionally — see project notes on why. */
export function applyDelete(entityType: EntityType, entityId: string): boolean {
  const table = tableFor(entityType) as Map<string, Card | Column | Board>;
  const entity = table.get(entityId);
  if (!entity || "deletedAt" in entity === false) return false;
  (entity as Card).deletedAt = new Date().toISOString();
  return true;
}

export function isTombstoned(
  entityType: EntityType,
  entityId: string,
): boolean {
  if (entityType !== "card") return false;
  return cards.get(entityId)?.deletedAt != null;
}

export function createEntity(
  entityType: EntityType,
  entityId: string,
  initial: Record<string, unknown>,
) {
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

export { boards, columns, cards };