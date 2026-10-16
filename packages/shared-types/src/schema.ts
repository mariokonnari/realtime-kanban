import { z } from "zod";
import type { ClientMessage } from "./index.js";

// Runtime validation for every message a client can send. The TypeScript
// interfaces in index.ts say what a well-behaved client sends; this is what the
// server checks before it trusts a frame. It lives here (not in apps/server) so
// client tests can run the exact same check against the messages the real
// client builds.
//
// Two rules apply everywhere:
//  - Required fields are strict: a missing or wrongly-typed one rejects the
//    message.
//  - Unknown extra fields are STRIPPED, not rejected. An older cached client, or
//    a newer one talking to this server, may send fields this schema has never
//    heard of; rejecting those would lock it out. parseClientMessage() returns
//    the stripped copy, and that copy — never the raw frame — is what gets
//    handled and relayed.

/** Size caps. Strings are measured in UTF-16 code units (zod's `.max()`). */
export const LIMITS = {
  /** messageId — clients send a UUID (36). */
  messageId: 128,
  /** entityId, columnId, clientId, cardId. */
  id: 128,
  /** An LWW field name such as "title". */
  field: 64,
  /** Any free-text value: titles, descriptions, timestamps. */
  text: 10_000,
  /** Presence display name / colour. */
  presenceName: 64,
  presenceColor: 32,
  /** A CRDT_UPDATE's base64 payload: 512 KiB of base64 text, ~384 KiB of Yjs update. */
  updateBase64: 512 * 1024,
} as const;

const id = z.string().min(1).max(LIMITS.id);
const text = z.string().max(LIMITS.text);

const clock = z.object({
  lamport: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  clientId: id,
});

const entityType = z.enum(["board", "column", "card"]);

// A single LWW value. Every field the app syncs is a string, number or null;
// nothing legitimate sends an object or array here.
const scalar = z.union([text, z.number().finite(), z.boolean(), z.null()]);

// Absent on messages from clients that predate ACKs, so it must stay optional.
const messageId = z.string().min(1).max(LIMITS.messageId).optional();

// Standard base64 alphabet, padded. Checked here so that a payload that isn't
// base64 is rejected as invalid instead of making atob() throw in a handler.
const base64 = z
  .string()
  .max(LIMITS.updateBase64)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "not base64");

const mutate = z.object({
  type: z.literal("MUTATE"),
  messageId,
  entityType,
  entityId: id,
  // Becomes a property name on an in-memory entity, so keep it to plain
  // identifiers: no "__proto__", no punctuation.
  field: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/, "not a field name").max(LIMITS.field),
  value: scalar,
  clock,
});

const crdtUpdate = z.object({
  type: z.literal("CRDT_UPDATE"),
  messageId,
  columnId: id,
  update: base64,
});

// CREATE's initialValues are checked per entity type, and any key that isn't a
// column of that entity is stripped — including `id`, which createEntity() would
// otherwise let override entityId.
const cardValues = z.object({
  columnId: id,
  title: text,
  description: text,
  position: z.number().finite(),
  createdAt: text,
  updatedAt: text.optional(),
  deletedAt: text.nullable().optional(),
});
const columnValues = z.object({ boardId: id, title: text, order: z.number().int() });
const boardValues = z.object({ name: text, createdAt: text.optional() });

const createBase = { type: z.literal("CREATE"), messageId, entityId: id, clock } as const;
const create = z.discriminatedUnion("entityType", [
  z.object({ ...createBase, entityType: z.literal("card"), initialValues: cardValues }),
  z.object({ ...createBase, entityType: z.literal("column"), initialValues: columnValues }),
  z.object({ ...createBase, entityType: z.literal("board"), initialValues: boardValues }),
]);

const del = z.object({
  type: z.literal("DELETE"),
  messageId,
  entityType,
  entityId: id,
  // The server never reads a DELETE's clock (a tombstone wins unconditionally),
  // so it isn't required — but when one is sent it has to be well-formed.
  clock: clock.optional(),
});

const presence = z.object({
  type: z.literal("PRESENCE"),
  clientId: id,
  name: z.string().max(LIMITS.presenceName),
  color: z.string().max(LIMITS.presenceColor),
  cardId: id.nullable(),
});

const syncRequest = z.object({ type: z.literal("SYNC_REQUEST") });

export const ClientMessageSchema = z.union([mutate, crdtUpdate, create, del, presence, syncRequest]);

export type ParseResult = { ok: true; message: ClientMessage } | { ok: false; error: string };

/** The message's `type` when it is a string, for logging a rejection. */
function typeOf(input: unknown): string {
  const type = (input as { type?: unknown } | null)?.type;
  return typeof type === "string" ? type.slice(0, 32) : "?";
}

/**
 * Validates one decoded frame. On success `message` is a stripped copy: only
 * the fields the schema knows, within their caps. On failure `error` is a short
 * description — a field path and reason, never the payload itself.
 */
export function parseClientMessage(input: unknown): ParseResult {
  const type = typeOf(input);
  const result = ClientMessageSchema.safeParse(input);
  if (result.success) return { ok: true, message: result.data as ClientMessage };

  // A union reports one branch per member; the one whose `type` literal matched
  // is the useful one. If none did, the type itself is unknown.
  const known = ["MUTATE", "CRDT_UPDATE", "CREATE", "DELETE", "PRESENCE", "SYNC_REQUEST"];
  if (!known.includes(type)) return { ok: false, error: `unknown message type "${type}"` };
  const branch = result.error.issues.find((issue) => issue.code === "invalid_union")?.errors ?? [];
  const issues = branch.find((issues) => !issues.some((i) => i.path[0] === "type")) ?? result.error.issues;
  const first = issues[0];
  const where = first.path.length > 0 ? first.path.join(".") : "message";
  return { ok: false, error: `${type}: ${where}: ${first.message}`.slice(0, 200) };
}
