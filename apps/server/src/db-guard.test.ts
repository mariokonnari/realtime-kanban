import { describe, expect, test } from "vitest";
import { checkServerDatabaseHost, getDatabaseHostname, isLocalHostname } from "./db-guard.js";

// These exercise the pure host-check logic only — never
// assertServerDatabaseHost, which calls process.exit(1) on a refusal and
// would kill the test runner. Verified against localhost only: no test
// here opens a real database connection.

describe("isLocalHostname", () => {
  test("accepts localhost and 127.0.0.1", () => {
    expect(isLocalHostname("localhost")).toBe(true);
    expect(isLocalHostname("127.0.0.1")).toBe(true);
  });

  test("rejects a remote host", () => {
    expect(isLocalHostname("aws-1-eu-west-1.pooler.supabase.com")).toBe(false);
  });
});

describe("getDatabaseHostname", () => {
  test("extracts the hostname from a postgres connection string", () => {
    expect(getDatabaseHostname("postgresql://user:pass@localhost:5432/kanban")).toBe("localhost");
    expect(getDatabaseHostname("postgresql://user:pass@aws-1-eu-west-1.pooler.supabase.com:5432/postgres")).toBe(
      "aws-1-eu-west-1.pooler.supabase.com",
    );
  });
});

describe("checkServerDatabaseHost", () => {
  test("localhost is always allowed", () => {
    const result = checkServerDatabaseHost("postgresql://user:pass@localhost:5432/kanban", {});
    expect(result).toEqual({ hostname: "localhost", allowed: true });
  });

  test("a remote host is refused by default", () => {
    const result = checkServerDatabaseHost(
      "postgresql://user:pass@aws-1-eu-west-1.pooler.supabase.com:5432/postgres",
      {},
    );
    expect(result).toEqual({ hostname: "aws-1-eu-west-1.pooler.supabase.com", allowed: false });
  });

  test("APP_ENV=production allows a remote host", () => {
    const result = checkServerDatabaseHost(
      "postgresql://user:pass@aws-1-eu-west-1.pooler.supabase.com:5432/postgres",
      { APP_ENV: "production" },
    );
    expect(result.allowed).toBe(true);
  });

  test("ALLOW_REMOTE_DB=1 allows a remote host", () => {
    const result = checkServerDatabaseHost(
      "postgresql://user:pass@aws-1-eu-west-1.pooler.supabase.com:5432/postgres",
      { ALLOW_REMOTE_DB: "1" },
    );
    expect(result.allowed).toBe(true);
  });

  test("an unrelated APP_ENV value does not allow a remote host", () => {
    const result = checkServerDatabaseHost(
      "postgresql://user:pass@aws-1-eu-west-1.pooler.supabase.com:5432/postgres",
      { APP_ENV: "staging" },
    );
    expect(result.allowed).toBe(false);
  });
});
