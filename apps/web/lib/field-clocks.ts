import { isNewer, fieldKey, type LamportClock } from "@realtime-kanban/shared-types";

/**
 * The client's copy of the server's per-field LWW clocks (entityId:field ->
 * clock of the write currently displayed). Runs the same `isNewer` as the
 * server, so a replica ignores a remote write exactly when the server would
 * have rejected it — instead of the last message to arrive winning.
 */
export class FieldClocks {
  private clocks = new Map<string, LamportClock>();

  /**
   * Records `clock` for the field if it beats the one held, and says whether
   * it did. Callers apply the write to local state only when this is true.
   */
  accept(entityId: string, field: string, clock: LamportClock): boolean {
    const key = fieldKey(entityId, field);
    if (!isNewer(clock, this.clocks.get(key))) return false;
    this.clocks.set(key, clock);
    return true;
  }

  /**
   * Replaces everything with the server's clocks from a SYNC_RESPONSE. Replace,
   * not merge: the synced state replaces local state too, and a local edit
   * the server hasn't seen yet must be able to win again when it's re-applied
   * on top (a merge would keep its clock and then reject it as "equal").
   */
  reset(serverClocks: Record<string, LamportClock> = {}) {
    this.clocks = new Map(Object.entries(serverClocks));
  }
}
