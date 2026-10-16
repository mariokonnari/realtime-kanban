// Per-connection limits: a token bucket that DELAYS (never drops) frames, a
// violation counter, and a memory of messages already rejected with an error.
// No I/O and no `ws` import, so all of it is unit-testable with fake timers.

export interface Limits {
  /** Largest accepted WebSocket frame, in bytes; ws closes the socket (1009) on a bigger one. */
  maxPayload: number;
  /** Token bucket capacity: how many frames one connection may send in a burst. */
  burst: number;
  /** Tokens added per second: the sustained rate once the burst is spent. */
  refillPerSec: number;
  /** Frames held back (delayed) per connection; one more than this closes the socket. */
  maxBacklog: number;
  /** Same, in bytes of raw frame, so a backlog of big frames can't fill memory. */
  maxBacklogBytes: number;
  /** Violations inside `violationWindowMs` that close the connection. */
  maxViolations: number;
  violationWindowMs: number;
}

// See README "Input validation and limits" for why these numbers.
export const DEFAULT_LIMITS: Limits = {
  maxPayload: 1024 * 1024,
  burst: 1000,
  refillPerSec: 100,
  maxBacklog: 2000,
  maxBacklogBytes: 4 * 1024 * 1024,
  maxViolations: 10,
  violationWindowMs: 60_000,
};

const ENV_NAMES: Record<keyof Limits, string> = {
  maxPayload: "WS_MAX_PAYLOAD",
  burst: "WS_RATE_BURST",
  refillPerSec: "WS_RATE_PER_SEC",
  maxBacklog: "WS_MAX_BACKLOG",
  maxBacklogBytes: "WS_MAX_BACKLOG_BYTES",
  maxViolations: "WS_MAX_VIOLATIONS",
  violationWindowMs: "WS_VIOLATION_WINDOW_MS",
};

/** Defaults, overridden by WS_* environment variables (positive numbers only; anything else is ignored). */
export function loadLimits(env: Record<string, string | undefined>): Limits {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(ENV_NAMES) as Array<keyof Limits>) {
    const raw = env[ENV_NAMES[key]];
    const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
    if (Number.isFinite(value) && value > 0) limits[key] = value;
  }
  return limits;
}

/** Refills continuously at `refillPerSec`, holds at most `capacity`, starts full. */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
  }

  private refill() {
    const now = Date.now();
    // Date.now() can step backwards (clock adjustment); never let that remove tokens.
    this.tokens = Math.min(this.capacity, this.tokens + (Math.max(0, now - this.last) * this.refillPerSec) / 1000);
    this.last = now;
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds until one whole token is available (0 if one is now). */
  msUntilToken(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) * 1000) / this.refillPerSec);
  }
}

export interface FrameQueueHooks<T> {
  /** Handles one frame. Called in arrival order, never concurrently, never re-entrantly. */
  handle(frame: T): void;
  /** The first frame of a delay episode was held back (the queue went from empty to non-empty). */
  onDelayStart?(): void;
  /** The backlog is full; the frame that didn't fit was not queued and nothing more is handled. */
  onOverflow(): void;
}

/**
 * Per-connection FIFO in front of the message handler.
 *
 * A frame is handled immediately when nothing is waiting and a token is
 * available — which is every frame under normal load, so behaviour there is
 * identical to having no queue. Otherwise it waits, and the queue releases
 * frames strictly in arrival order as tokens come back. A frame can therefore
 * be late but can never be overtaken: once anything is queued, every later frame
 * queues behind it even if a token happens to be free. That ordering is a
 * protocol property, not an optimisation: the client's fallback for servers
 * without ACKs relies on the SYNC_RESPONSE to its first SYNC_REQUEST being sent
 * before any ACK on that socket, which holds only if the SYNC_REQUEST is handled
 * before the messages that follow it.
 */
export class FrameQueue<T> {
  private readonly bucket: TokenBucket;
  private readonly queue: Array<{ frame: T; bytes: number }> = [];
  private queuedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly limits: Pick<Limits, "burst" | "refillPerSec" | "maxBacklog" | "maxBacklogBytes">,
    private readonly hooks: FrameQueueHooks<T>,
  ) {
    this.bucket = new TokenBucket(limits.burst, limits.refillPerSec);
  }

  get backlog(): number {
    return this.queue.length;
  }

  push(frame: T, bytes: number) {
    if (this.stopped) return;
    if (this.queue.length === 0 && this.bucket.tryTake()) {
      this.hooks.handle(frame);
      return;
    }
    if (this.queue.length >= this.limits.maxBacklog || this.queuedBytes + bytes > this.limits.maxBacklogBytes) {
      this.stop();
      this.hooks.onOverflow();
      return;
    }
    if (this.queue.length === 0) this.hooks.onDelayStart?.();
    this.queue.push({ frame, bytes });
    this.queuedBytes += bytes;
    this.schedule();
  }

  /** Discards whatever is still queued and ignores later frames (the socket is closing). */
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue.length = 0;
    this.queuedBytes = 0;
  }

  private schedule() {
    if (this.timer || this.stopped || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.drain();
    }, Math.max(1, this.bucket.msUntilToken()));
  }

  private drain() {
    while (!this.stopped && this.queue.length > 0 && this.bucket.tryTake()) {
      const next = this.queue.shift()!;
      this.queuedBytes -= next.bytes;
      this.hooks.handle(next.frame);
    }
    this.schedule();
  }
}

/** Counts violations inside a sliding window. */
export class ViolationTracker {
  private readonly times: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Records one violation; returns how many are inside the window now, this one included. */
  record(): number {
    const now = Date.now();
    this.times.push(now);
    while (this.times.length > 0 && now - this.times[0] > this.windowMs) this.times.shift();
    return this.times.length;
  }

  isOver(count: number): boolean {
    return count >= this.max;
  }
}

/**
 * Messages the server answered with an error ACK, remembered so that a replay
 * of the same entry on a later connection isn't punished twice.
 *
 * Why this exists: the client drops an entry only when the error ACK reaches
 * it. If the connection dies first, the entry replays on the next connection
 * and is rejected again — and without this, that would count as a second
 * violation for something the client has no way to know it must stop sending.
 *
 * Bounded in two ways so it can't be farmed. A replay is forgiven once per
 * messageId (a client that keeps resending the same rejected id is counted
 * from then on), and only on a different connection than the one that was
 * already told (resending on the same connection is plainly a repeat). The map
 * is capped and evicts the oldest ids first.
 */
export class RejectedIds {
  private readonly seen = new Map<string, { connection: number; forgiven: boolean }>();

  constructor(private readonly max = 10_000) {}

  /** Records a rejection of `messageId` on `connection`; true if it should not count as a violation. */
  forgive(messageId: string, connection: number): boolean {
    const entry = this.seen.get(messageId);
    this.seen.delete(messageId); // re-inserted below, so the oldest entry is always first
    let forgiven = false;
    if (entry && entry.connection !== connection && !entry.forgiven) forgiven = true;
    this.seen.set(messageId, { connection, forgiven: forgiven || (entry?.forgiven ?? false) });
    if (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!);
    return forgiven;
  }
}
