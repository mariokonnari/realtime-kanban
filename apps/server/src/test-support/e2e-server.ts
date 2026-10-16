import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage, SyncResponseMessage } from "@realtime-kanban/shared-types";
import { getDatabaseHostname, isLocalHostname } from "../db-guard.js";
import { requireDb, requireDbMessage } from "./require-db.js";

// Test support for driving the *real* server process (src/index.ts) over a
// real WebSocket against a real Postgres. Localhost only, and never the dev
// database: each server gets its own throwaway `kanban_e2e_*` database on the
// same instance, migrated on start and dropped on stop, so test files can run
// in parallel without sharing state.

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function baseDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = readFileSync(path.join(serverDir, ".env"), "utf8");
    return env.match(/^DATABASE_URL=["']?([^"'\r\n]+)["']?/m)?.[1];
  } catch {
    return undefined;
  }
}

const baseUrl = baseDatabaseUrl();

const baseUrlIsLocal = baseUrl !== undefined && isLocalHostname(getDatabaseHostname(baseUrl));

/**
 * True when DATABASE_URL (or apps/server/.env) points at localhost — same rule as seed-order.test.ts.
 * With REQUIRE_DB=1 it is true regardless, so the suites run instead of skipping and fail in
 * createDatabase() (which still refuses anything that is not localhost) when there is no database.
 */
export const e2eEnabled = baseUrlIsLocal || requireDb;

async function createDatabase(): Promise<{ name: string; url: string }> {
  // The localhost rule holds even when REQUIRE_DB forced the suites on: nothing below runs against a remote database.
  if (!baseUrlIsLocal) throw new Error(requireDbMessage);
  const name = `kanban_e2e_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.$disconnect();
  }
  const url = new URL(baseUrl!);
  url.pathname = `/${name}`;
  const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: "pipe",
  });
  return { name, url: url.toString() };
}

async function dropDatabase(name: string) {
  const admin = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.$disconnect();
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export interface E2eServer {
  /** Changes after restart() — the new process listens on a new port. */
  readonly url: string;
  /** This server's throwaway database, e.g. for asserting on what actually got persisted. */
  readonly databaseUrl: string;
  /** Resolves with the exit code when the current server process exits (crash or stop). */
  readonly exited: Promise<number | null>;
  hasExited(): boolean;
  /** Everything the current process wrote to stdout/stderr. */
  output(): string;
  /** Kills the process and starts a new one on the same database, so state must come back from Postgres. */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

interface Running {
  url: string;
  exited: Promise<number | null>;
  hasExited(): boolean;
  output(): string;
  kill(): Promise<void>;
}

async function spawnServer(databaseUrl: string, extraEnv: Record<string, string>): Promise<Running> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: serverDir,
    env: { ...process.env, ...extraEnv, DATABASE_URL: databaseUrl, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  let exited = false;
  const exitedPromise = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      exited = true;
      resolve(code);
    });
  });
  child.stdout!.on("data", (chunk) => (log += chunk));
  child.stderr!.on("data", (chunk) => (log += chunk));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start in time:
${log}`)), 30_000);
    const check = setInterval(() => {
      if (log.includes("listening on")) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 50);
    void exitedPromise.then((code) => {
      clearTimeout(timer);
      clearInterval(check);
      reject(new Error(`server exited early (code ${code}):
${log}`));
    });
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    exited: exitedPromise,
    hasExited: () => exited,
    output: () => log,
    async kill() {
      if (!exited) child.kill();
      await exitedPromise;
    },
  };
}

/** `env` adds environment variables to the server process, e.g. smaller WS_* limits so a test can reach them cheaply. */
export async function startE2eServer(options: { env?: Record<string, string> } = {}): Promise<E2eServer> {
  const extraEnv = options.env ?? {};
  const database = await createDatabase();
  let running = await spawnServer(database.url, extraEnv);
  return {
    get url() {
      return running.url;
    },
    databaseUrl: database.url,
    get exited() {
      return running.exited;
    },
    hasExited: () => running.hasExited(),
    output: () => running.output(),
    async restart() {
      await running.kill();
      running = await spawnServer(database.url, extraEnv);
    },
    async stop() {
      await running.kill();
      await dropDatabase(database.name);
    },
  };
}

/** The persisted Card row (or null), read straight from the server's database. */
type CardRow = Awaited<ReturnType<typeof readCardRow>>;

export async function readCardRow(databaseUrl: string, id: string) {
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    return await db.card.findUnique({ where: { id } });
  } finally {
    await db.$disconnect();
  }
}

export async function waitForRow(databaseUrl: string, id: string, ready: (row: CardRow) => boolean) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const row = await readCardRow(databaseUrl, id);
    if (ready(row)) return row as NonNullable<CardRow>;
    if (Date.now() > deadline) throw new Error("timed out waiting for the write to reach Postgres");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A bare protocol-level client: records everything the server sends it, in order. */
export class Peer {
  readonly received: ServerMessage[] = [];
  /** The close code once the server (or this peer) has closed the socket. */
  closeCode: number | undefined;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => this.received.push(JSON.parse(raw.toString()) as ServerMessage));
    socket.on("close", (code) => {
      this.closeCode = code;
    });
  }

  /** Resolves with the close code once the socket has closed. */
  async waitForClose(timeoutMs = 5000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.closeCode === undefined) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the socket to close");
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.closeCode;
  }

  static async connect(url: string): Promise<Peer> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new Peer(socket);
  }

  send(message: ClientMessage) {
    this.socket.send(JSON.stringify(message));
  }

  /** Sends a frame verbatim — for malformed-frame tests. */
  sendRaw(frame: string) {
    this.socket.send(frame);
  }

  /** Waits for a message matching `predicate` (already received or still to come). */
  async waitFor<T extends ServerMessage>(predicate: (m: ServerMessage) => m is T, timeoutMs?: number): Promise<T>;
  async waitFor(predicate: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  async waitFor(predicate: (m: ServerMessage) => boolean, timeoutMs = 5000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.received.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error("timed out waiting for a server message");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** The server's current full state, as a fresh SYNC_REQUEST/SYNC_RESPONSE round trip. */
  async sync(): Promise<SyncResponseMessage> {
    const already = this.received.filter((m) => m.type === "SYNC_RESPONSE").length;
    this.send({ type: "SYNC_REQUEST" });
    const deadline = Date.now() + 5000;
    for (;;) {
      const responses = this.received.filter((m): m is SyncResponseMessage => m.type === "SYNC_RESPONSE");
      if (responses.length > already) return responses[responses.length - 1];
      if (Date.now() > deadline) throw new Error("timed out waiting for SYNC_RESPONSE");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /**
   * Resolves once this peer has *seen* a PRESENCE carrying `marker` as its
   * cardId. The server handles one socket's messages in order, so when
   * another client sends that PRESENCE after some other message, seeing it
   * here proves the earlier message has already been handled.
   */
  async barrier(marker: string) {
    await this.waitFor((m) => m.type === "PRESENCE" && m.cardId === marker);
  }

  close() {
    this.socket.close();
  }
}
