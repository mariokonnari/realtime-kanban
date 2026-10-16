import * as Y from "yjs";

// Server-side repair for the card order. A move is a delete from the old column's
// Y.Array plus an insert into the new one (moveCard() in the web app), so two
// clients moving the same card at once each insert their own entry and the merged
// arrays list the card twice — in one column, or in two. The card's columnId (an
// LWW field) says where it is meant to be; this deletes the entries that disagree.
//
// Pure over the column docs and the cards, so it runs without a server: the store
// hands it its own maps, a test hands it docs it built.

/** The name of the Y.Array in a column's doc, as the client and the server both use it. */
export const ORDER_ARRAY = "cardOrder";

export interface RepairableCard {
  id: string;
  columnId: string;
  deletedAt?: string | null;
}

/**
 * For every card that is not tombstoned: if the array of the column its columnId
 * names holds at least one entry for it, keeps the first of those and deletes every
 * other entry for it, in that column or any other. A card with no entry in its
 * columnId column is left alone — in particular its only entry is never deleted,
 * wherever it is. Cards with no record (ids in an array that no card has) and
 * tombstoned cards are left alone too.
 *
 * Deletions only: no entry is added or moved, nothing else is touched, so the order
 * of the surviving entries is unchanged, and running it again changes nothing.
 * Each changed doc gets one transaction.
 *
 * Returns the ids of the docs it changed (empty when there was nothing to repair).
 * Cost is one pass over every array plus one lookup per entry: O(total entries).
 */
export function repairColumnOrders(docs: ReadonlyMap<string, Y.Doc>, cards: Iterable<RepairableCard>): string[] {
  const home = new Map<string, string>();
  for (const card of cards) {
    if (card.deletedAt == null) home.set(card.id, card.columnId);
  }

  // Every entry of every live card: where it is, and its index in that array.
  const entries = new Map<string, { columnId: string; index: number }[]>();
  for (const [columnId, doc] of docs) {
    doc
      .getArray<string>(ORDER_ARRAY)
      .toArray()
      .forEach((cardId, index) => {
        if (!home.has(cardId)) return;
        const list = entries.get(cardId);
        if (list) list.push({ columnId, index });
        else entries.set(cardId, [{ columnId, index }]);
      });
  }

  const doomed = new Map<string, number[]>();
  for (const [cardId, list] of entries) {
    if (list.length < 2) continue;
    const keep = list.find((entry) => entry.columnId === home.get(cardId));
    if (!keep) continue; // nothing in the column it names: do not choose between the others
    for (const entry of list) {
      if (entry === keep) continue;
      const indices = doomed.get(entry.columnId);
      if (indices) indices.push(entry.index);
      else doomed.set(entry.columnId, [entry.index]);
    }
  }

  for (const [columnId, indices] of doomed) {
    const doc = docs.get(columnId)!;
    const array = doc.getArray<string>(ORDER_ARRAY);
    // Highest index first, so an earlier delete never shifts a later one.
    doc.transact(() => {
      for (const index of indices.sort((a, b) => b - a)) array.delete(index, 1);
    });
  }
  return [...doomed.keys()];
}
