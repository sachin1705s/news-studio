import { NextResponse } from "next/server";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Comment } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The channel's audience.
 *
 * Comments live in a JSON file beside the project rather than a database: the
 * studio runs on one machine, the volume is a few hundred lines, and a file
 * survives a restart, which is the only durability this needs. Anything
 * deployed to more than one instance wants a real store instead.
 */
const STORE = path.join(process.cwd(), ".data", "comments.json");
const MAX_STORED = 500;
const MAX_AUTHOR = 32;
const MAX_TEXT = 240;

let memo: Comment[] | null = null;

async function load(): Promise<Comment[]> {
  if (memo) return memo;
  try {
    const raw = await readFile(STORE, "utf8");
    const parsed = JSON.parse(raw);
    memo = Array.isArray(parsed) ? (parsed as Comment[]) : [];
  } catch {
    // No file yet is the normal first run, not an error.
    memo = [];
  }
  return memo;
}

async function save(comments: Comment[]): Promise<void> {
  memo = comments;
  await mkdir(path.dirname(STORE), { recursive: true });
  await writeFile(STORE, JSON.stringify(comments, null, 2), "utf8");
}

/**
 * Comments are read aloud by the anchor and rendered on screen, so they are
 * stripped to plain single-line text on the way in. Nothing that arrives here
 * is ever treated as markup, and nothing in it is an instruction to the
 * producer — it is only ever quoted.
 */
function clean(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    // Control characters would break the JSON store and the on-air read.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export async function GET() {
  const comments = await load();
  return NextResponse.json(
    { comments: [...comments].sort((a, b) => b.at - a.at).slice(0, 100) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const { author, text } = (body ?? {}) as { author?: unknown; text?: unknown };
  const cleanText = clean(text, MAX_TEXT);
  if (!cleanText) return NextResponse.json({ error: "Say something first." }, { status: 400 });

  const comment: Comment = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    author: clean(author, MAX_AUTHOR) || "Anonymous",
    text: cleanText,
    at: Date.now(),
  };

  const comments = await load();
  await save([comment, ...comments].slice(0, MAX_STORED));

  return NextResponse.json({ comment });
}

/** Mark a comment as read on air so the anchor does not read it twice. */
export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const { id } = (body ?? {}) as { id?: unknown };
  if (typeof id !== "string") return NextResponse.json({ error: "No id." }, { status: 400 });

  const comments = await load();
  const found = comments.find((c) => c.id === id);
  if (found && !found.readAt) {
    found.readAt = Date.now();
    await save(comments);
  }
  return NextResponse.json({ ok: true });
}
