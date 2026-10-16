/**
 * CI sets REQUIRE_DB=1 (and only CI does — it is set in .github/workflows/ci.yml,
 * nowhere else). The database-backed suites normally skip themselves when
 * DATABASE_URL isn't a localhost database, so that `npm test` works on a machine
 * without Postgres. In CI a skip would turn a missing database into a green run,
 * so with this set they fail instead.
 */
export const requireDb = process.env.REQUIRE_DB === "1";

export const requireDbMessage =
  "REQUIRE_DB=1, but DATABASE_URL is not set to a localhost database, so the database-backed tests cannot run. " +
  "Refusing to skip them.";
