import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where the channel keeps the small amount of state it has: the comments and
 * who is currently watching.
 *
 * Three backends, chosen by what the environment actually offers.
 *
 * Redis, when `KV_REST_API_URL` and `KV_REST_API_TOKEN` are set. This is the
 * only one that is correct on Vercel: functions are ephemeral and there can be
 * several of them at once, so anything held on the instance is neither durable
 * nor shared.
 *
 * A JSON file, when there is a writable disk. This is local development, where
 * a file survives a restart and needs no account anywhere.
 *
 * Instance memory, when there is neither. It keeps the app working rather than
 * erroring, but it forgets on every cold start and two instances disagree —
 * so a deployment without Redis will drop comments and undercount viewers.
 * `storeKind()` reports which one is live so the UI can be honest about it.
 */

const REDIS_URL = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;
const DIR = path.join(process.cwd(), ".data");

export type StoreKind = "redis" | "file" | "memory";

let fileWritable: boolean | null = null;
const memory = new Map<string, string>();

export function storeKind(): StoreKind {
  if (REDIS_URL && REDIS_TOKEN) return "redis";
  if (fileWritable === false) return "memory";
  return "file";
}

async function redis(command: unknown[]): Promise<unknown> {
  const res = await fetch(REDIS_URL as string, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  const body = (await res.json()) as { result?: unknown };
  return body.result;
}

export async function readJson<T>(key: string, fallback: T): Promise<T> {
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      const raw = await redis(["GET", key]);
      return typeof raw === "string" ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  if (fileWritable !== false) {
    try {
      const raw = await readFile(path.join(DIR, `${key}.json`), "utf8");
      return JSON.parse(raw) as T;
    } catch (err) {
      // A missing file is the normal first run. A read-only disk is not, and
      // means every later write will fail too — so stop trying.
      if ((err as NodeJS.ErrnoException)?.code === "EROFS") fileWritable = false;
      return memory.has(key) ? (JSON.parse(memory.get(key) as string) as T) : fallback;
    }
  }

  return memory.has(key) ? (JSON.parse(memory.get(key) as string) as T) : fallback;
}

export async function writeJson(key: string, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value);

  if (REDIS_URL && REDIS_TOKEN) {
    try {
      await redis(["SET", key, encoded]);
      return;
    } catch {
      // Fall through to memory rather than losing the write outright.
    }
  } else if (fileWritable !== false) {
    try {
      await mkdir(DIR, { recursive: true });
      await writeFile(path.join(DIR, `${key}.json`), encoded, "utf8");
      return;
    } catch {
      fileWritable = false;
    }
  }

  memory.set(key, encoded);
}
