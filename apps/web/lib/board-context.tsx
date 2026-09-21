"use client";

import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState } from "react";
import * as Y from "yjs";
import type { Board, Column, Card, ServerMessage } from "@realtime-kanban/shared-types";
import { encodeUpdate, decodeUpdate } from "@realtime-kanban/shared-types";
import { wsClient, nextClock } from "./ws-client";

export interface BoardState {
  boards: Record<string, Board>;
  columns: Record<string, Column>;
  cards: Record<string, Card>;
}

type Table = "boards" | "columns" | "cards";

export type Action =
  | { type: "SYNC"; boards: Board[]; columns: Column[]; cards: Card[] }
  | { type: "UPSERT"; table: Table; id: string; entity: Board | Column | Card }
  | { type: "PATCH"; table: Table; id: string; field: string; value: unknown }
  | { type: "REMOVE"; table: Table; id: string };

export function reducer(state: BoardState, action: Action): BoardState {
  switch (action.type) {
    case "SYNC":
      return {
        boards: Object.fromEntries(action.boards.map((b) => [b.id, b])),
        columns: Object.fromEntries(action.columns.map((c) => [c.id, c])),
        cards: Object.fromEntries(action.cards.map((c) => [c.id, c])),
      };
    case "UPSERT":
      return { ...state, [action.table]: { ...state[action.table], [action.id]: action.entity } };
    case "PATCH": {
      const entity = state[action.table][action.id] as unknown as Record<string, unknown> | undefined;
      if (!entity) return state;
      return {
        ...state,
        [action.table]: {
          ...state[action.table],
          [action.id]: { ...entity, [action.field]: action.value },
        },
      };
    }
    case "REMOVE": {
      const next = { ...state[action.table] };
      delete next[action.id];
      return { ...state, [action.table]: next };
    }
  }
}

interface BoardApi extends BoardState {
  columnOrder: Record<string, string[]>;
  updateCardField: (cardId: string, field: "title" | "description", value: string) => void;
  createCard: (columnId: string, title: string) => void;
  deleteCard: (cardId: string) => void;
  moveCard: (cardId: string, fromColumnId: string, toColumnId: string, toIndex: number) => void;
}

const BoardContext = createContext<BoardApi | null>(null);

export function useBoard() {
  const ctx = useContext(BoardContext);
  if (!ctx) throw new Error("useBoard must be used inside <BoardProvider>");
  return ctx;
}

export function BoardProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { boards: {}, columns: {}, cards: {} });
  const [columnOrder, setColumnOrder] = useState<Record<string, string[]>>({});
  const docsRef = useRef<Map<string, Y.Doc>>(new Map());

  // Gets (or lazily creates) the Y.Doc for a column and wires its
  // Y.Array observer to React state — this is the seam where CRDT
  // internals become something the UI can actually render.
  const getDoc = useCallback((columnId: string) => {
    let doc = docsRef.current.get(columnId);
    if (!doc) {
      doc = new Y.Doc();
      docsRef.current.set(columnId, doc);
      const arr = doc.getArray<string>("cardOrder");
      arr.observe(() => {
        setColumnOrder((prev) => ({ ...prev, [columnId]: arr.toArray() }));
      });
    }
    return doc;
  }, []);

  useEffect(() => {
    wsClient.connect();
    return wsClient.subscribe((message: ServerMessage) => {
      switch (message.type) {
        case "SYNC_RESPONSE": {
          dispatch({ type: "SYNC", boards: message.boards, columns: message.columns, cards: message.cards });
          Object.entries(message.columnOrders).forEach(([columnId, base64]) => {
            Y.applyUpdate(getDoc(columnId), decodeUpdate(base64));
          });
          break;
        }
        case "CREATE": {
          const table: Table = message.entityType === "card" ? "cards" : message.entityType === "column" ? "columns" : "boards";
          dispatch({ type: "UPSERT", table, id: message.entityId, entity: { id: message.entityId, ...message.initialValues } as Card });
          break;
        }
        case "MUTATE": {
          const table: Table = message.entityType === "card" ? "cards" : message.entityType === "column" ? "columns" : "boards";
          dispatch({ type: "PATCH", table, id: message.entityId, field: message.field, value: message.value });
          break;
        }
        case "DELETE": {
          if (message.entityType === "card") dispatch({ type: "REMOVE", table: "cards", id: message.entityId });
          break;
        }
        case "CRDT_UPDATE": {
          Y.applyUpdate(getDoc(message.columnId), decodeUpdate(message.update));
          break;
        }
      }
    });
  }, [getDoc]);

  const updateCardField = useCallback((cardId: string, field: "title" | "description", value: string) => {
    dispatch({ type: "PATCH", table: "cards", id: cardId, field, value });
    wsClient.send({ type: "MUTATE", entityType: "card", entityId: cardId, field, value, clock: nextClock() });
  }, []);

  const createCard = useCallback(
    (columnId: string, title: string) => {
      const id = crypto.randomUUID();
      const initialValues = {
        columnId,
        title,
        description: "",
        position: 0,
        createdAt: new Date().toISOString(),
        deletedAt: null,
      };
      dispatch({ type: "UPSERT", table: "cards", id, entity: { id, ...initialValues } as Card });
      wsClient.send({ type: "CREATE", entityType: "card", entityId: id, initialValues, clock: nextClock() });

      const doc = getDoc(columnId);
      const before = Y.encodeStateVector(doc);
      doc.getArray<string>("cardOrder").push([id]);
      wsClient.send({ type: "CRDT_UPDATE", columnId, update: encodeUpdate(Y.encodeStateAsUpdate(doc, before)) });
    },
    [getDoc],
  );

  const deleteCard = useCallback((cardId: string) => {
    dispatch({ type: "REMOVE", table: "cards", id: cardId });
    wsClient.send({ type: "DELETE", entityType: "card", entityId: cardId, clock: nextClock() });
  }, []);

  const moveCard = useCallback(
    (cardId: string, fromColumnId: string, toColumnId: string, toIndex: number) => {
      if (fromColumnId !== toColumnId) {
        dispatch({ type: "PATCH", table: "cards", id: cardId, field: "columnId", value: toColumnId });
        wsClient.send({
          type: "MUTATE",
          entityType: "card",
          entityId: cardId,
          field: "columnId",
          value: toColumnId,
          clock: nextClock(),
        });
      }

      const fromDoc = getDoc(fromColumnId);
      const fromBefore = Y.encodeStateVector(fromDoc);
      const fromArr = fromDoc.getArray<string>("cardOrder");
      const existingIndex = fromArr.toArray().indexOf(cardId);
      if (existingIndex !== -1) fromArr.delete(existingIndex, 1);
      wsClient.send({
        type: "CRDT_UPDATE",
        columnId: fromColumnId,
        update: encodeUpdate(Y.encodeStateAsUpdate(fromDoc, fromBefore)),
      });

      // Same-column reorder reuses fromDoc (it's the same Y.Doc) — the
      // delete above already happened on it, so this insert lands on
      // the post-delete state, which is what we want.
      const toDoc = getDoc(toColumnId);
      const toBefore = Y.encodeStateVector(toDoc);
      const toArr = toDoc.getArray<string>("cardOrder");
      const clampedIndex = Math.max(0, Math.min(toIndex, toArr.length));
      toArr.insert(clampedIndex, [cardId]);
      wsClient.send({
        type: "CRDT_UPDATE",
        columnId: toColumnId,
        update: encodeUpdate(Y.encodeStateAsUpdate(toDoc, toBefore)),
      });
    },
    [getDoc],
  );

  const value: BoardApi = { ...state, columnOrder, updateCardField, createCard, deleteCard, moveCard };
  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}
