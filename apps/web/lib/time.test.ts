import { afterEach, describe, expect, test, vi } from "vitest";
import { formatRelativeTime } from "./time";

describe("formatRelativeTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("formats under a minute as 'just now'", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:30.000Z"));
    expect(formatRelativeTime("2026-01-01T00:00:00.000Z")).toBe("just now");
  });

  test("formats minutes", () => {
    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
    expect(formatRelativeTime("2026-01-01T00:00:00.000Z")).toBe("5m ago");
  });

  test("formats hours", () => {
    vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));
    expect(formatRelativeTime("2026-01-01T00:00:00.000Z")).toBe("2h ago");
  });

  test("formats days", () => {
    vi.setSystemTime(new Date("2026-01-04T00:00:00.000Z"));
    expect(formatRelativeTime("2026-01-01T00:00:00.000Z")).toBe("3d ago");
  });
});
