import { describe, expect, test } from "vitest";
import type { LamportClock } from "@realtime-kanban/shared-types";
import { isNewer } from "./lww.js";

describe("isNewer", () => {
  test("accepts any clock when there is no current clock yet", () => {
    expect(isNewer({ lamport: 1, clientId: "a" }, undefined)).toBe(true);
  });

  test("higher lamport wins regardless of clientId", () => {
    expect(isNewer({ lamport: 5, clientId: "aaa" }, { lamport: 4, clientId: "zzz" })).toBe(true);
    expect(isNewer({ lamport: 4, clientId: "zzz" }, { lamport: 5, clientId: "aaa" })).toBe(false);
  });

  test("higher lamport wins regardless of the order the two clocks are applied in", () => {
    // Two replicas can see the same two edits in opposite orders (network
    // reordering, reconnects, etc). Whichever order they're folded in,
    // they must converge on the same winner.
    const lowerClock: LamportClock = { lamport: 2, clientId: "client-a" };
    const higherClock: LamportClock = { lamport: 7, clientId: "client-b" };

    let current: LamportClock | undefined;
    if (isNewer(lowerClock, current)) current = lowerClock;
    if (isNewer(higherClock, current)) current = higherClock;
    expect(current).toEqual(higherClock);

    current = undefined;
    if (isNewer(higherClock, current)) current = higherClock;
    if (isNewer(lowerClock, current)) current = lowerClock;
    expect(current).toEqual(higherClock);
  });

  test("same lamport ties break on clientId, independent of arrival order", () => {
    const lowId: LamportClock = { lamport: 3, clientId: "aaa" };
    const highId: LamportClock = { lamport: 3, clientId: "zzz" };

    expect(isNewer(highId, lowId)).toBe(true);
    expect(isNewer(lowId, highId)).toBe(false);

    let current: LamportClock | undefined = lowId;
    if (isNewer(highId, current)) current = highId;
    expect(current).toEqual(highId);

    current = highId;
    if (isNewer(lowId, current)) current = lowId;
    expect(current).toEqual(highId);
  });

  test("a clock does not win a tie against an identical clock", () => {
    const clock: LamportClock = { lamport: 3, clientId: "aaa" };
    expect(isNewer(clock, clock)).toBe(false);
  });
});
