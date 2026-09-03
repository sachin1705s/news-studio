import { NextResponse } from "next/server";
import { readJson, writeJson } from "@/lib/store";
import type { Comment } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The channel's audience.
 *
 * Storage lives behind `lib/store`, which is Blob in production and a file
 * locally. This route's own job is to never fail in a way the browser cannot
 * read: every response is JSON, including the failures. An earlier version let
 * a read-only-filesystem error escape the handler, so Next returned an HTML
 * error page, the client's `res.json()` threw on it, and a comment that had
 * been accepted was reported to the viewer as "could not reach the studio".
 */
const KEY = "comments";
const MAX_STORED = 500;
const MAX_AUTHOR = 32;
const MAX_TEXT = 240;

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

async function load(): Promise<Comment[]> {
  const stored = await readJson<Comment[]>(KEY, []);
  return Array.isArray(stored) ? stored : [];
}

export async function GET() {
  try {
    const comments = await load();
    return NextResponse.json(
      { comments: [...comments].sort((a, b) => b.at - a.at).slice(0, 100) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ comments: [] }, { headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request) {
  try {
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
    const stored = await writeJson(KEY, [comment, ...comments].slice(0, MAX_STORED));

    // The comment is on air either way — the deck reads the list, not the disk —
    // so a storage failure is reported as what it is: it will not be kept.
    return NextResponse.json({ comment, stored });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not post that." },
      { status: 500 },
    );
  }
}

/** Mark a comment as read on air so the anchor does not read it twice. */
export async function PUT(request: Request) {
  try {
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
      await writeJson(KEY, comments);
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false });
  }
}
