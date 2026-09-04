import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { head, put } from "@vercel/blob";

/**
 * Where the channel keeps the small amount of state it has.
 *
 * Two backends, chosen by what the environment offers.
 *
 * Vercel Blob, when `BLOB_READ_WRITE_TOKEN` is set. This is the only one that
 * is correct in production: the deployed filesystem is read-only and functions
 * are ephemeral, so anything written to disk throws, and anything held on the
 * instance is neither durable nor shared between instances.
 *
 * A JSON file, when there is a writable disk — local development, where a file
 * survives a restart and needs no account anywhere.
 *
 * Nothing here throws. A store that fails takes the comment with it, but it
 * must not take the request down: the previous version let an `EROFS` escape
 * the route, which crashed the handler, returned an HTML error page, and made
 * the browser report failure for a comment it had in fact accepted. Writes
 * report success or failure by return value, and the caller decides.
 */

const DIR = path.join(process.cwd(), ".data");
const token = process.env.BLOB_READ_WRITE_TOKEN;

/**
 * Upstash-style Redis, preferred over Blob when configured.
 *
 * Blob was the wrong tool for this. It is object storage billed per operation,
 * and this app writes small documents constantly — a presence heartbeat every
 * twenty seconds per viewer, a registry refresh on every clip. That ran the
 * store into suspension, and once writes fail the registry reads empty, so
 * every tab believes no broadcast exists and starts one of its own. The
 * one-stream guarantee was only ever as reliable as the store underneath it.
 */
const REDIS_URL = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

/** Last-resort per-instance memory, so a dead store degrades rather than 500s. */
const memory = new Map<string, string>();

export type StoreKind = "redis" | "blob" | "file" | "memory";

export function storeKind(): StoreKind {
  if (REDIS_URL && REDIS_TOKEN) return "redis";
  if (token) return "blob";
  return "file";
}

async function redis(command: unknown[]): Promise<unknown> {
  const res = await fetch(REDIS_URL as string, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  return ((await res.json()) as { result?: unknown }).result;
}

export async function readJson<T>(key: string, fallback: T): Promise<T> {
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      const raw = await redis(["GET", key]);
      if (typeof raw === "string") return JSON.parse(raw) as T;
    } catch {
      // Fall through: a reachable fallback beats an error.
    }
    const held = memory.get(key);
    return held ? (JSON.parse(held) as T) : fallback;
  }

  if (token) {
    try {
      // `head` resolves the pathname to its current URL; the URL is then read
      // with caching off, because a blob just overwritten is otherwise served
      // stale from the CDN.
      const meta = await head(`${key}.json`, { token });
      const res = await fetch(meta.url, { cache: "no-store" });
      if (!res.ok) return fallback;
      return (await res.json()) as T;
    } catch {
      // Nothing stored yet is the normal first run, not an error.
      return fallback;
    }
  }

  try {
    return JSON.parse(await readFile(path.join(DIR, `${key}.json`), "utf8")) as T;
  } catch {
    const held = memory.get(key);
    return held ? (JSON.parse(held) as T) : fallback;
  }
}

/** Returns whether the value is actually persisted. Never throws. */
export async function writeJson(key: string, value: unknown): Promise<boolean> {
  const encoded = JSON.stringify(value);
  // Always kept locally too: a suspended or unreachable store then degrades to
  // per-instance state instead of losing the write outright.
  memory.set(key, encoded);

  if (REDIS_URL && REDIS_TOKEN) {
    try {
      await redis(["SET", key, encoded]);
      return true;
    } catch {
      return false;
    }
  }

  if (token) {
    try {
      await put(`${key}.json`, encoded, {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
        // The document is rewritten on every comment, so it must not be cached.
        cacheControlMaxAge: 0,
        token,
      });
      return true;
    } catch {
      return false;
    }
  }

  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(path.join(DIR, `${key}.json`), encoded, "utf8");
    return true;
  } catch {
    return false;
  }
}
