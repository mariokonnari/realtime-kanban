// Shared logic for confirming DATABASE_URL points at a local database
// before doing something that should never touch a remote one. Only the
// host-detection primitives are shared — the *policy* for what to do about
// a non-local host is deliberately kept separate per caller, because it's
// legitimately different: the running server needs to allow a real
// production deployment (Supabase) to work, while the demo-seeding script
// (see scripts/seed-demo.ts) must never run against a remote database
// under any circumstance, including a stray APP_ENV=production in the
// environment. Collapsing those into one shared policy would silently
// re-enable exactly the mistake this guard exists to catch.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function getDatabaseHostname(databaseUrl: string): string {
  return new URL(databaseUrl).hostname;
}

export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname);
}

export interface DbGuardEnv {
  APP_ENV?: string;
  ALLOW_REMOTE_DB?: string;
}

export interface DbGuardResult {
  hostname: string;
  allowed: boolean;
}

// Policy for the running server: a non-local host is fine in a real
// production deployment, or under an explicit manual override — otherwise
// this is almost certainly a local dev run accidentally pointed at a
// remote database (e.g. a Supabase URL left over in .env), which is
// exactly the mistake this guard exists to catch.
export function checkServerDatabaseHost(databaseUrl: string, env: DbGuardEnv): DbGuardResult {
  const hostname = getDatabaseHostname(databaseUrl);
  const allowed = isLocalHostname(hostname) || env.APP_ENV === "production" || env.ALLOW_REMOTE_DB === "1";
  return { hostname, allowed };
}

/**
 * Logs the resolved DB host and exits the process if it's an unexpected
 * remote one. Call before initStore() — refusing after the store has
 * already started reading/writing defeats the point.
 */
export function assertServerDatabaseHost(databaseUrl: string, env: DbGuardEnv): string {
  const { hostname, allowed } = checkServerDatabaseHost(databaseUrl, env);
  if (!allowed) {
    console.error(
      `Refusing to start: DATABASE_URL points at "${hostname}", not localhost.\n` +
        "This looks like a local dev run pointed at a remote database. If this is a " +
        "real production deployment, set APP_ENV=production. To override intentionally " +
        "(e.g. testing against a staging DB), set ALLOW_REMOTE_DB=1.",
    );
    process.exit(1);
  }
  console.log(`Database host: ${hostname}`);
  return hostname;
}
