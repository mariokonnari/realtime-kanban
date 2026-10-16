// Everything the browser tests talk to is on this machine, on fixed ports.
// Fixed because `next build` inlines NEXT_PUBLIC_WS_URL into the bundle: the
// test server has to be at the address the web app was built with, including
// after a restart. Only the ports can be changed (E2E_WS_PORT, E2E_WEB_PORT);
// the host cannot, so there is no way to aim these tests at a deployed service.

export const HOST = "127.0.0.1";
export const WS_PORT = Number(process.env.E2E_WS_PORT ?? 4101);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3101);

export const WS_URL = `ws://${HOST}:${WS_PORT}`;
export const WEB_URL = `http://${HOST}:${WEB_PORT}`;

// Ports other tooling already uses: the dev servers (README), and Postgres.
const RESERVED_PORTS = new Set([3000, 4001, 5432]);

for (const [name, port] of [
  ["E2E_WS_PORT", WS_PORT],
  ["E2E_WEB_PORT", WEB_PORT],
] as const) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || RESERVED_PORTS.has(port)) {
    throw new Error(
      `${name}=${port} is not usable: pick a free port above 1023 that is not one of ${[...RESERVED_PORTS].join(", ")}.`,
    );
  }
}

// APP_ENV=production would let the server accept a non-local DATABASE_URL
// (db-guard.ts), and so would ALLOW_REMOTE_DB=1. Neither may be present.
if (process.env.APP_ENV === "production" || process.env.ALLOW_REMOTE_DB === "1") {
  throw new Error("Refusing to run the browser tests with APP_ENV=production or ALLOW_REMOTE_DB=1 in the environment.");
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export const isLoopbackHost = (hostname: string) => LOOPBACK.has(hostname);
