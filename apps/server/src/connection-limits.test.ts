import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_LIMITS, FrameQueue, RejectedIds, TokenBucket, ViolationTracker, loadLimits } from "./connection-limits.js";

// Pure logic, driven with fake timers: no sockets, no database. The end-to-end
// behaviour (real server, real WebSocket) is in limits.e2e.test.ts.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("TokenBucket", () => {
  test("starts full, runs dry, and refills continuously up to its capacity", () => {
    const bucket = new TokenBucket(3, 10); // 10 tokens/s
    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([true, true, true, false]);
    expect(bucket.msUntilToken()).toBe(100);
    vi.advanceTimersByTime(100);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([true, true, true, false]);
  });

  test("a clock that steps backwards takes no tokens away", () => {
    const bucket = new TokenBucket(2, 10);
    bucket.tryTake();
    vi.setSystemTime(Date.now() - 10_000);
    expect(bucket.tryTake()).toBe(true);
  });
});

describe("FrameQueue", () => {
  const limits = { burst: 3, refillPerSec: 10, maxBacklog: 5, maxBacklogBytes: 1_000 };

  function make(overrides: Partial<typeof limits> = {}) {
    const handled: number[] = [];
    const events: string[] = [];
    const queue = new FrameQueue<number>(
      { ...limits, ...overrides },
      {
        handle: (n) => handled.push(n),
        onDelayStart: () => events.push("delay"),
        onOverflow: () => events.push("overflow"),
      },
    );
    return { queue, handled, events };
  }

  test("within the burst a frame is handled synchronously, with nothing queued", () => {
    const { queue, handled, events } = make();
    queue.push(1, 10);
    queue.push(2, 10);
    queue.push(3, 10);
    expect(handled).toEqual([1, 2, 3]);
    expect(queue.backlog).toBe(0);
    expect(events).toEqual([]);
  });

  test("past the burst frames are delayed, not dropped, and come out in arrival order", () => {
    const { queue, handled, events } = make();
    for (let n = 1; n <= 8; n++) queue.push(n, 10);
    expect(handled).toEqual([1, 2, 3]); // the burst
    expect(queue.backlog).toBe(5);
    expect(events).toEqual(["delay"]); // announced once per episode, not per frame

    vi.advanceTimersByTime(100); // one token
    expect(handled).toEqual([1, 2, 3, 4]);
    vi.advanceTimersByTime(400);
    expect(handled).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(queue.backlog).toBe(0);
  });

  test("a frame that arrives while others are queued waits behind them even if a token is free", () => {
    const { queue, handled } = make({ burst: 1, refillPerSec: 1_000 });
    queue.push(1, 1); // spends the only token
    queue.push(2, 1); // queued; its drain timer is pending
    vi.setSystemTime(Date.now() + 5); // a token is free again, but the timer has not fired yet
    queue.push(3, 1); // must not take that token ahead of #2
    expect(handled).toEqual([1]);
    expect(queue.backlog).toBe(2);
    vi.advanceTimersByTime(10);
    expect(handled).toEqual([1, 2, 3]);
  });

  test("overflow: the frame that does not fit triggers onOverflow, the backlog is discarded and the queue goes quiet", () => {
    const { queue, handled, events } = make();
    for (let n = 1; n <= 9; n++) queue.push(n, 10); // 3 handled, 5 queued, #9 overflows
    expect(events).toEqual(["delay", "overflow"]);
    expect(queue.backlog).toBe(0);
    vi.advanceTimersByTime(10_000);
    queue.push(10, 10);
    expect(handled).toEqual([1, 2, 3]); // nothing queued is handled after the overflow
  });

  test("the backlog is also capped in bytes", () => {
    const { queue, events } = make({ maxBacklog: 100, maxBacklogBytes: 100 });
    for (let n = 1; n <= 3; n++) queue.push(n, 10);
    queue.push(4, 60); // queued: 60 bytes
    queue.push(5, 60); // 120 > 100
    expect(events).toEqual(["delay", "overflow"]);
  });

  test("stop() discards the queue and cancels the timer", () => {
    const { queue, handled } = make();
    for (let n = 1; n <= 6; n++) queue.push(n, 10);
    queue.stop();
    vi.advanceTimersByTime(10_000);
    expect(handled).toEqual([1, 2, 3]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a delay episode is announced again after the queue has emptied", () => {
    const { queue, events } = make();
    for (let n = 1; n <= 5; n++) queue.push(n, 10);
    vi.advanceTimersByTime(1_000);
    for (let n = 6; n <= 10; n++) queue.push(n, 10); // bucket refilled to its 3 again, so 2 delayed
    expect(events).toEqual(["delay", "delay"]);
  });
});

describe("ViolationTracker", () => {
  test("counts violations inside the window and forgets older ones", () => {
    const tracker = new ViolationTracker(3, 1_000);
    expect(tracker.record()).toBe(1);
    vi.advanceTimersByTime(600);
    expect(tracker.record()).toBe(2);
    vi.advanceTimersByTime(600); // the first is now 1200 ms old
    expect(tracker.record()).toBe(2);
    expect(tracker.isOver(2)).toBe(false);
    expect(tracker.record()).toBe(3);
    expect(tracker.isOver(3)).toBe(true);
  });
});

describe("RejectedIds", () => {
  test("a replay on a different connection is forgiven once; repeats after that count", () => {
    const rejected = new RejectedIds();
    expect(rejected.forgive("m1", 1)).toBe(false); // first rejection: counts
    expect(rejected.forgive("m1", 2)).toBe(true); // the same entry replayed after a reconnect
    expect(rejected.forgive("m1", 3)).toBe(false); // but only once per id
    expect(rejected.forgive("m1", 3)).toBe(false);
  });

  test("resending the same id on the connection that was already told is a repeat", () => {
    const rejected = new RejectedIds();
    expect(rejected.forgive("m1", 1)).toBe(false);
    expect(rejected.forgive("m1", 1)).toBe(false);
  });

  test("is bounded: the oldest ids are evicted first", () => {
    const rejected = new RejectedIds(2);
    rejected.forgive("a", 1);
    rejected.forgive("b", 1);
    rejected.forgive("c", 1); // evicts "a"
    expect(rejected.forgive("a", 2)).toBe(false); // forgotten, so it counts
    expect(rejected.forgive("c", 2)).toBe(true);
  });
});

describe("loadLimits", () => {
  test("defaults, overridden by positive numeric WS_* variables; anything else is ignored", () => {
    expect(loadLimits({})).toEqual(DEFAULT_LIMITS);
    const limits = loadLimits({ WS_RATE_BURST: "50", WS_RATE_PER_SEC: "abc", WS_MAX_BACKLOG: "-1", WS_MAX_PAYLOAD: "" });
    expect(limits.burst).toBe(50);
    expect(limits.refillPerSec).toBe(DEFAULT_LIMITS.refillPerSec);
    expect(limits.maxBacklog).toBe(DEFAULT_LIMITS.maxBacklog);
    expect(limits.maxPayload).toBe(DEFAULT_LIMITS.maxPayload);
  });

  test("the defaults hold what the README says: the burst covers a 500-message replay with room to spare", () => {
    expect(DEFAULT_LIMITS.burst).toBeGreaterThanOrEqual(2 * 500);
    expect(DEFAULT_LIMITS.maxBacklog).toBeGreaterThanOrEqual(DEFAULT_LIMITS.burst);
  });
});
