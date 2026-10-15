import { describe, expect, test } from "vitest";
import { FieldClocks } from "./field-clocks";

const clock = (lamport: number, clientId = "a") => ({ lamport, clientId });

describe("FieldClocks", () => {
  test("accepts the first write to a field, then only strictly newer ones", () => {
    const clocks = new FieldClocks();
    expect(clocks.accept("card-1", "title", clock(5))).toBe(true);
    expect(clocks.accept("card-1", "title", clock(4))).toBe(false); // older
    expect(clocks.accept("card-1", "title", clock(5))).toBe(false); // identical: a replay is a no-op
    expect(clocks.accept("card-1", "title", clock(6))).toBe(true);
  });

  test("breaks lamport ties on clientId, the same way the server does", () => {
    const clocks = new FieldClocks();
    clocks.accept("card-1", "title", clock(5, "b"));
    expect(clocks.accept("card-1", "title", clock(5, "a"))).toBe(false);
    expect(clocks.accept("card-1", "title", clock(5, "c"))).toBe(true);
  });

  test("tracks each entity and field separately", () => {
    const clocks = new FieldClocks();
    clocks.accept("card-1", "title", clock(9));
    expect(clocks.accept("card-1", "description", clock(1))).toBe(true);
    expect(clocks.accept("card-2", "title", clock(1))).toBe(true);
  });

  test("a rejected write does not lower the stored clock", () => {
    const clocks = new FieldClocks();
    clocks.accept("card-1", "title", clock(9));
    clocks.accept("card-1", "title", clock(3));
    expect(clocks.accept("card-1", "title", clock(8))).toBe(false);
  });

  test("reset replaces everything with the server's clocks", () => {
    const clocks = new FieldClocks();
    clocks.accept("card-1", "title", clock(50));
    clocks.accept("card-2", "title", clock(50));

    clocks.reset({ "card-1:title": clock(7) });

    expect(clocks.accept("card-1", "title", clock(8))).toBe(true); // beats the server's 7, though not our old 50
    expect(clocks.accept("card-1", "title", clock(7))).toBe(false); // the server's own clock isn't newer than itself
    expect(clocks.accept("card-2", "title", clock(1))).toBe(true); // forgotten: the server didn't send it
  });

  test("reset with no clocks (an older server) just empties the map", () => {
    const clocks = new FieldClocks();
    clocks.accept("card-1", "title", clock(50));
    clocks.reset(undefined);
    expect(clocks.accept("card-1", "title", clock(1))).toBe(true);
  });
});
