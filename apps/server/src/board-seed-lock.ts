import type { PrismaClient, Prisma } from "@prisma/client";

// Arbitrary constant — it just has to be the same everywhere this lock is
// taken. pg_advisory_xact_lock() coordinates across separate connections
// and even separate OS processes (the running server vs. the standalone
// seed script) as long as they're talking to the same Postgres database.
const BOARD_SEED_LOCK_KEY = 891234;

/**
 * Serializes "is there already a board? if not, create one" across
 * concurrent callers. Without this, two processes can each run the check,
 * both see zero boards, and both create one — a genuine race, not a
 * hypothetical: it's exactly how this project ended up with two "Demo
 * Board" rows (19ms apart) during development, when a leftover `tsx
 * watch` process and a freshly started one both ran their startup
 * sequence against a still-empty database at the same moment.
 *
 * pg_advisory_xact_lock is held for the lifetime of the surrounding
 * transaction and released automatically on commit or rollback, so a
 * losing caller just blocks until the winner's transaction ends, then
 * proceeds having already lost the race — its own count()/findFirst()
 * check then correctly sees the board the winner just committed.
 */
export async function withBoardSeedLock<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // $executeRaw, not $queryRaw: pg_advisory_xact_lock() returns void, and
    // Prisma's query-result deserializer has no mapping for a void column
    // (it throws trying). $executeRaw doesn't attempt to parse a result set.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOARD_SEED_LOCK_KEY}::bigint)`;
    return fn(tx);
  });
}
