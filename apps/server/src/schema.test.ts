import { describe, expect, test } from "vitest";
import { LIMITS, encodeUpdate, parseClientMessage } from "@realtime-kanban/shared-types";

// The wire schema, on its own. The server-side behaviour built on it (error
// ACKs, nothing registered or mutated) is in validation.e2e.test.ts.

const clock = { lamport: 1, clientId: "c1" };
const cardValues = { columnId: "col", title: "t", description: "d", position: 0, createdAt: "2026-01-01T00:00:00.000Z" };

const valid = {
  MUTATE: { type: "MUTATE", entityType: "card", entityId: "a", field: "title", value: "x", clock },
  CRDT_UPDATE: { type: "CRDT_UPDATE", columnId: "col", update: "AQ==" },
  CREATE: { type: "CREATE", entityType: "card", entityId: "a", initialValues: cardValues, clock },
  DELETE: { type: "DELETE", entityType: "card", entityId: "a", clock },
  PRESENCE: { type: "PRESENCE", clientId: "c1", name: "Otter", color: "#ef4444", cardId: null },
  SYNC_REQUEST: { type: "SYNC_REQUEST" },
} as const;

describe("parseClientMessage", () => {
  test.each(Object.entries(valid))("a well-formed %s is accepted unchanged", (_type, message) => {
    expect(parseClientMessage(message)).toEqual({ ok: true, message });
  });

  test("a message with a messageId keeps it; one without stays without", () => {
    const withId = parseClientMessage({ ...valid.MUTATE, messageId: "11111111-2222-3333-4444-555555555555" });
    expect(withId.ok && withId.message).toMatchObject({ messageId: "11111111-2222-3333-4444-555555555555" });
    const without = parseClientMessage(valid.MUTATE);
    expect(without.ok && "messageId" in without.message).toBe(false);
  });

  test("unknown extra fields are stripped, at the top level and inside initialValues, not rejected", () => {
    const result = parseClientMessage({
      ...valid.CREATE,
      futureField: { anything: true },
      updatedAt: "set by a client that shouldn't",
      initialValues: { ...cardValues, id: "somebody-else", colour: "red" },
    });
    expect(result).toEqual({
      ok: true,
      message: { ...valid.CREATE, initialValues: cardValues },
    });

    const mutate = parseClientMessage({ ...valid.MUTATE, updatedAt: "2020-01-01", extra: 1 });
    expect(mutate).toEqual({ ok: true, message: valid.MUTATE }); // updatedAt on a MUTATE is the server's to set
  });

  test("MUTATE and CREATE require a clock; DELETE doesn't, but a clock it carries must be well-formed", () => {
    const { clock: _m, ...mutate } = valid.MUTATE;
    const { clock: _c, ...create } = valid.CREATE;
    const { clock: _d, ...del } = valid.DELETE;
    expect(parseClientMessage(mutate)).toMatchObject({ ok: false });
    expect(parseClientMessage(create)).toMatchObject({ ok: false });
    expect(parseClientMessage(del)).toMatchObject({ ok: true });
    expect(parseClientMessage({ ...del, clock: { lamport: "1", clientId: "c" } })).toMatchObject({ ok: false });
  });

  test("a clock must be a non-negative integer lamport and a non-empty clientId", () => {
    for (const bad of [
      { lamport: -1, clientId: "c" },
      { lamport: 1.5, clientId: "c" },
      { lamport: Number.MAX_SAFE_INTEGER + 2, clientId: "c" },
      { lamport: 1, clientId: "" },
      { lamport: 1 },
      "1",
      null,
    ]) {
      expect(parseClientMessage({ ...valid.MUTATE, clock: bad }), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });

  test("entityType must be board, column or card", () => {
    for (const bad of ["Card", "cards", "", 1, null, undefined]) {
      expect(parseClientMessage({ ...valid.MUTATE, entityType: bad })).toMatchObject({ ok: false });
      expect(parseClientMessage({ ...valid.DELETE, entityType: bad })).toMatchObject({ ok: false });
    }
    expect(parseClientMessage({ ...valid.MUTATE, entityType: "board" })).toMatchObject({ ok: true });
    expect(parseClientMessage({ ...valid.MUTATE, entityType: "column" })).toMatchObject({ ok: true });
  });

  test("required fields are strict", () => {
    expect(parseClientMessage({ type: "MUTATE" })).toMatchObject({ ok: false });
    expect(parseClientMessage({ ...valid.MUTATE, entityId: undefined })).toMatchObject({ ok: false });
    expect(parseClientMessage({ ...valid.MUTATE, entityId: "" })).toMatchObject({ ok: false });
    expect(parseClientMessage({ ...valid.MUTATE, field: undefined })).toMatchObject({ ok: false });
    expect(parseClientMessage({ ...valid.MUTATE, value: undefined })).toMatchObject({ ok: false });
    expect(parseClientMessage({ ...valid.CRDT_UPDATE, columnId: 5 })).toMatchObject({ ok: false });
    expect(parseClientMessage({ ...valid.PRESENCE, cardId: undefined })).toMatchObject({ ok: false });
    expect(parseClientMessage({ ...valid.CREATE, initialValues: { ...cardValues, columnId: undefined } })).toMatchObject({
      ok: false,
    });
    expect(parseClientMessage({ ...valid.CREATE, initialValues: "nope" })).toMatchObject({ ok: false });
  });

  test("not an object, or an unknown type, is rejected", () => {
    for (const bad of [null, undefined, 7, "MUTATE", [], { type: 7 }, { type: "WAT" }, { entityId: "x" }]) {
      expect(parseClientMessage(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });

  test("a field name must be a plain identifier — it becomes a property name on an entity", () => {
    for (const bad of ["__proto__", "a.b", "a b", "", "9lives", "constructor\n"]) {
      expect(parseClientMessage({ ...valid.MUTATE, field: bad }), bad).toMatchObject({ ok: false });
    }
    for (const good of ["title", "description", "columnId", "position"]) {
      expect(parseClientMessage({ ...valid.MUTATE, field: good })).toMatchObject({ ok: true });
    }
  });

  test("a MUTATE value is a string, number, boolean or null — not an object or array", () => {
    for (const good of ["x", 3, 1.5, true, null, ""]) expect(parseClientMessage({ ...valid.MUTATE, value: good })).toMatchObject({ ok: true });
    for (const bad of [{}, [], { a: 1 }]) expect(parseClientMessage({ ...valid.MUTATE, value: bad })).toMatchObject({ ok: false });
  });

  describe("size caps", () => {
    const over = (n: number) => "x".repeat(n + 1);

    test("messageId", () => {
      expect(parseClientMessage({ ...valid.MUTATE, messageId: "x".repeat(LIMITS.messageId) })).toMatchObject({ ok: true });
      expect(parseClientMessage({ ...valid.MUTATE, messageId: over(LIMITS.messageId) })).toMatchObject({ ok: false });
      expect(parseClientMessage({ ...valid.MUTATE, messageId: "" })).toMatchObject({ ok: false });
      expect(parseClientMessage({ ...valid.MUTATE, messageId: 5 })).toMatchObject({ ok: false });
    });

    test("ids, field names, text values and presence strings", () => {
      expect(parseClientMessage({ ...valid.MUTATE, entityId: over(LIMITS.id) })).toMatchObject({ ok: false });
      expect(parseClientMessage({ ...valid.MUTATE, clock: { lamport: 1, clientId: over(LIMITS.id) } })).toMatchObject({ ok: false });
      expect(parseClientMessage({ ...valid.CRDT_UPDATE, columnId: over(LIMITS.id) })).toMatchObject({ ok: false });
      expect(parseClientMessage({ ...valid.MUTATE, field: over(LIMITS.field) })).toMatchObject({ ok: false });
      expect(parseClientMessage({ ...valid.MUTATE, value: "x".repeat(LIMITS.text) })).toMatchObject({ ok: true });
      expect(parseClientMessage({ ...valid.MUTATE, value: over(LIMITS.text) })).toMatchObject({ ok: false });
      expect(
        parseClientMessage({ ...valid.CREATE, initialValues: { ...cardValues, description: over(LIMITS.text) } }),
      ).toMatchObject({ ok: false });
      expect(parseClientMessage({ ...valid.PRESENCE, name: over(LIMITS.presenceName) })).toMatchObject({ ok: false });
      expect(parseClientMessage({ ...valid.PRESENCE, color: over(LIMITS.presenceColor) })).toMatchObject({ ok: false });
      expect(parseClientMessage({ ...valid.PRESENCE, cardId: over(LIMITS.id) })).toMatchObject({ ok: false });
    });

    test("the CRDT_UPDATE base64 payload, and it must be base64", () => {
      const atCap = "AAAA".repeat(LIMITS.updateBase64 / 4);
      expect(atCap).toHaveLength(LIMITS.updateBase64);
      expect(parseClientMessage({ ...valid.CRDT_UPDATE, update: atCap })).toMatchObject({ ok: true });
      expect(parseClientMessage({ ...valid.CRDT_UPDATE, update: atCap + "AAAA" })).toMatchObject({ ok: false });
      for (const bad of ["A", "AB", "A!Q=", "AQ=", "AQ===", "AQ==x", "A Q=="]) {
        expect(parseClientMessage({ ...valid.CRDT_UPDATE, update: bad }), bad).toMatchObject({ ok: false });
      }
      // What the client actually sends is accepted.
      expect(parseClientMessage({ ...valid.CRDT_UPDATE, update: encodeUpdate(new Uint8Array([0, 0])) })).toMatchObject({ ok: true });
      expect(parseClientMessage({ ...valid.CRDT_UPDATE, update: "" })).toMatchObject({ ok: true });
    });
  });

  test("a failure says where, in a short string that never contains the payload", () => {
    const secret = "s3cret".repeat(100);
    const result = parseClientMessage({ ...valid.MUTATE, entityType: secret });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("entityType");
      expect(result.error).not.toContain("s3cret");
      expect(result.error.length).toBeLessThanOrEqual(200);
    }
  });
});
