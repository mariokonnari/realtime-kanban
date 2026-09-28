import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { Board, Column, Card, LamportClock, EntityType } from "@realtime-kanban/shared-types";
import { encodeUpdate } from "@realtime-kanban/shared-types";
import { isNewer } from "./lww.js";
import { withBoardSeedLock } from "./board-seed-lock.js";

type Entity = Board | Column | Card;

const prisma = new PrismaClient();

// In-memory tables remain the source of truth for the conflict-resolution
// logic below (applyMutation/applyDelete/isNewer) — unchanged from the
// original in-memory store. Postgres is a write-through persistence layer
// hung off these same maps, hydrated into them at startup.
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

// DB writes are async, but the in-memory LWW check-and-set above is
// synchronous, so two mutations to the same field are already resolved
// correctly in memory before either one reaches Postgres. This queue just
// makes sure the DB writes land in that same order: without it, a slower
// write for an earlier (losing) clock could complete after a faster write
// for a later (winning) one and leave the DB holding the stale value — the
// exact "old edit resurrects itself on restart" bug persistence must avoid.
let writeQueue: Promise<unknown> = Promise.resolve();
function enqueue(write: () => Promise<unknown>) {
  writeQueue = writeQueue.then(write, write);
  return writeQueue;
}

// Same rationale as the entity[field] = value bypass below: "update one
// named field on one of three tables" isn't expressible in Prisma's
// generated per-model input types without a manual union, so this crosses
// through `any` deliberately at the boundary.
function updateEntityField(
  entityType: EntityType,
  entityId: string,
  field: string,
  value: unknown,
  extra?: Record<string, unknown>,
) {
  const data = { [field]: value, ...extra } as any;
  switch (entityType) {
    case "board":
      return prisma.board.update({ where: { id: entityId }, data });
    case "column":
      return prisma.column.update({ where: { id: entityId }, data });
    case "card":
      return prisma.card.update({ where: { id: entityId }, data });
  }
}

function createEntityRow(entityType: EntityType, entity: Entity) {
  switch (entityType) {
    case "board":
      return prisma.board.create({ data: entity as Board });
    case "column":
      return prisma.column.create({ data: entity as Column });
    case "card":
      return prisma.card.create({ data: entity as Card });
  }
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

  // updatedAt only exists on Card, and only bumps here — a mutation that
  // fails the isNewer() check above already returned before this point, so
  // a rejected stale write never touches it. Set synchronously on the
  // in-memory entity (read by getFullState()/SYNC_RESPONSE and by index.ts
  // to attach to the MUTATE broadcast) and persisted in the same write as
  // the field itself, not a separate one — see the write-ordering note on
  // `enqueue` above for why that matters.
  let updatedAt: string | undefined;
  if (entityType === "card") {
    updatedAt = new Date().toISOString();
    (entity as unknown as Record<string, unknown>).updatedAt = updatedAt;
  }

  enqueue(async () => {
    await updateEntityField(entityType, entityId, field, value, updatedAt ? { updatedAt } : undefined);
    await prisma.fieldClock.upsert({
      where: { entityId_field: { entityId, field } },
      create: { entityId, field, lamport: clock.lamport, clientId: clock.clientId },
      update: { lamport: clock.lamport, clientId: clock.clientId },
    });
  });

  return true;
}

export function applyDelete(entityType: EntityType, entityId: string): boolean {
  const table = tableFor(entityType) as Map<string, Card | Column | Board>;
  const entity = table.get(entityId);
  if (!entity || !("deletedAt" in entity)) return false;
  const deletedAt = new Date().toISOString();
  (entity as Card).deletedAt = deletedAt;

  enqueue(() => prisma.card.update({ where: { id: entityId }, data: { deletedAt } }));

  return true;
}

export function isTombstoned(entityType: EntityType, entityId: string): boolean {
  if (entityType !== "card") return false;
  return cards.get(entityId)?.deletedAt != null;
}

export function createEntity(entityType: EntityType, entityId: string, initial: Record<string, unknown>) {
  const table = tableFor(entityType) as Map<string, Entity>;
  // updatedAt is server-authoritative on create, same as every other write
  // path for it — not trusted from the client's initialValues, even though
  // it may include one (see createCard() in board-context.tsx, which sets
  // its own for the creating tab's optimistic local copy only).
  const values = entityType === "card" ? { ...initial, updatedAt: new Date().toISOString() } : initial;
  const entity = { id: entityId, ...values } as Entity;
  table.set(entityId, entity);

  enqueue(() => createEntityRow(entityType, entity));
}

export function getColumnDoc(columnId: string): Y.Doc {
  let doc = columnDocs.get(columnId);
  if (!doc) {
    doc = new Y.Doc();
    columnDocs.set(columnId, doc);
  }
  return doc;
}

/** Persists a column's full Yjs state — call after any update is applied to its doc. */
export function persistColumnDoc(columnId: string): void {
  const doc = columnDocs.get(columnId);
  if (!doc) return;
  const state = Buffer.from(Y.encodeStateAsUpdate(doc));
  enqueue(() =>
    prisma.columnDoc.upsert({
      where: { columnId },
      create: { columnId, state },
      update: { state },
    }),
  );
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

/** Loads all persisted state from Postgres into the in-memory tables. Must run before serving any connections. */
export async function initStore(): Promise<void> {
  const [dbBoards, dbColumns, dbCards, dbClocks, dbDocs] = await Promise.all([
    prisma.board.findMany(),
    prisma.column.findMany(),
    prisma.card.findMany(),
    prisma.fieldClock.findMany(),
    prisma.columnDoc.findMany(),
  ]);

  for (const b of dbBoards) {
    boards.set(b.id, { id: b.id, name: b.name, createdAt: b.createdAt.toISOString() });
  }
  for (const c of dbColumns) {
    columns.set(c.id, { id: c.id, boardId: c.boardId, title: c.title, order: c.order });
  }
  for (const c of dbCards) {
    cards.set(c.id, {
      id: c.id,
      columnId: c.columnId,
      title: c.title,
      description: c.description,
      position: c.position,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      deletedAt: c.deletedAt ? c.deletedAt.toISOString() : null,
    });
  }
  for (const fc of dbClocks) {
    fieldClocks.set(fieldKey(fc.entityId, fc.field), { lamport: fc.lamport, clientId: fc.clientId });
  }
  for (const doc of dbDocs) {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, doc.state);
    columnDocs.set(doc.columnId, ydoc);
  }
}

/** Seeds a single demo board so the UI has something to render on first run. Only runs if the database is empty. */
export async function seedDemoBoard(): Promise<void> {
  await withBoardSeedLock(prisma, async (tx) => {
    const existing = await tx.board.count();
    if (existing > 0) return;

    const boardId = randomUUID();
    const board: Board = { id: boardId, name: "Demo Board", createdAt: new Date().toISOString() };
    boards.set(boardId, board);
    await tx.board.create({ data: board });

    const columnTitles = ["To do", "In progress", "Done"];
    for (const [order, title] of columnTitles.entries()) {
      const columnId = randomUUID();
      const column: Column = { id: columnId, boardId, title, order };
      columns.set(columnId, column);
      await tx.column.create({ data: column });

      const doc = getColumnDoc(columnId);
      doc.getArray<string>("cardOrder"); // initialize empty Y.Array
      await tx.columnDoc.create({
        data: { columnId, state: Buffer.from(Y.encodeStateAsUpdate(doc)) },
      });
    }
  });
}

export { boards, columns, cards };
