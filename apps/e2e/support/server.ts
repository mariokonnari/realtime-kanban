import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import * as Y from "yjs";
import { WS_PORT, WS_URL, isLoopbackHost } from "./env";

// The real server process (apps/server/src/index.ts) on a throwaway database, for
// the browser tests. The same idea as apps/server/src/test-support/e2e-server.ts,
// with one difference that matters here: it listens on a FIXED port, so that it can
// be stopped and started again at the address the web build points at. (That
// harness picks a new port on every restart.) Localhost only: it creates a
// `kanban_e2e_*` database next to the one DATABASE_URL names, never touches that
// one, and drops it afterwards.
//
// The server process is only ever stopped through the handle spawn() returned:
// no lookup by name, no port-based kill.

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../server");

function baseDatabaseUrl(): string {
  let url = process.env.DATABASE_URL;
  if (!url) {
    try {
      const env = readFileSync(path.join(serverDir, ".env"), "utf8");
      url = env.match(/^DATABASE_URL=["']?([^"'\r\n]+)["']?/m)?.[1];
    } catch {
      // handled below
    }
  }
  if (!url) {
    throw new Error("DATABASE_URL is not set (and apps/server/.env has none): the browser tests need a localhost Postgres.");
  }
  const { hostname } = new URL(url);
  if (!isLoopbackHost(hostname)) {
    throw new Error(`DATABASE_URL points at "${hostname}", not localhost. The browser tests only run against a local database.`);
  }
  return url;
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export class TestServer {
  private child: ChildProcess | undefined;
  private log = "";
  private exitPromise: Promise<void> | undefined;

  private constructor(
    private readonly baseUrl: string,
    readonly databaseName: string,
    readonly databaseUrl: string,
  ) {}

  static async create(): Promise<TestServer> {
    const baseUrl = baseDatabaseUrl();
    const name = `kanban_e2e_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const admin = new PrismaClient({ datasourceUrl: baseUrl });
    try {
      await admin.$executeRawUnsafe(`CREATE DATABASE ${name}`);
    } finally {
      await admin.$disconnect();
    }
    const url = new URL(baseUrl);
    url.pathname = `/${name}`;
    const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
    execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: "pipe",
    });
    return new TestServer(baseUrl, name, url.toString());
  }

  get url() {
    return WS_URL;
  }

  get running() {
    return this.child !== undefined;
  }

  output() {
    return this.log;
  }

  /** Starts the server on the fixed port and resolves once it is listening. Data in the database survives stop(). */
  async start(): Promise<void> {
    if (this.child) throw new Error("server already running");
    if (await portInUse(WS_PORT)) {
      throw new Error(
        `Port ${WS_PORT} already has a listener that this harness did not start; refusing to use it. ` +
          "Set E2E_WS_PORT to a free port (the web app is built for that port).",
      );
    }
    // APP_ENV and ALLOW_REMOTE_DB are removed from the child's environment, not just left to the caller.
    const { APP_ENV: _appEnv, ALLOW_REMOTE_DB: _allowRemote, ...env } = process.env;
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: serverDir,
      env: { ...env, DATABASE_URL: this.databaseUrl, PORT: String(WS_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.log = "";
    child.stdout!.on("data", (chunk) => (this.log += chunk));
    child.stderr!.on("data", (chunk) => (this.log += chunk));
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    this.exitPromise = exited;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start in time:\n${this.log}`)), 30_000);
      const poll = setInterval(() => {
        if (this.log.includes("listening on")) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }
      }, 50);
      void exited.then(() => {
        clearTimeout(timer);
        clearInterval(poll);
        reject(new Error(`server exited early:\n${this.log}`));
      });
    });
  }

  /** Kills the process this object started and waits for it to be gone, so the port is free when this resolves. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.kill();
    await this.exitPromise;
  }

  /** Stops the server and drops the throwaway database. */
  async dispose(): Promise<void> {
    await this.stop();
    const admin = new PrismaClient({ datasourceUrl: this.baseUrl });
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${this.databaseName} WITH (FORCE)`);
    } finally {
      await admin.$disconnect();
    }
  }

  /** Non-deleted cards as Postgres holds them. */
  async cards(): Promise<{ id: string; title: string; columnId: string }[]> {
    const db = new PrismaClient({ datasourceUrl: this.databaseUrl });
    try {
      return await db.card.findMany({
        where: { deletedAt: null },
        select: { id: true, title: true, columnId: true },
      });
    } finally {
      await db.$disconnect();
    }
  }

  /**
   * The board as Postgres holds it: every non-deleted card (with its columnId), and each
   * column's card order decoded from the persisted Yjs state in `column_docs`.
   */
  async board(): Promise<{
    columns: { id: string; title: string }[];
    cards: { id: string; title: string; columnId: string }[];
    orders: Record<string, string[]>;
  }> {
    const db = new PrismaClient({ datasourceUrl: this.databaseUrl });
    try {
      const [columns, cards, docs] = await Promise.all([
        db.column.findMany({ select: { id: true, title: true }, orderBy: { order: "asc" } }),
        db.card.findMany({ where: { deletedAt: null }, select: { id: true, title: true, columnId: true } }),
        db.columnDoc.findMany(),
      ]);
      const orders: Record<string, string[]> = {};
      for (const { columnId, state } of docs) {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, state);
        orders[columnId] = doc.getArray<string>("cardOrder").toArray();
      }
      return { columns, cards, orders };
    } finally {
      await db.$disconnect();
    }
  }
}
