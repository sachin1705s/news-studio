import { NextResponse } from "next/server";
import { WINDOW_SEGMENTS, type AiredSegment, type Manifest } from "@/lib/channel";
import { readJson, writeJson } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The channel's running order, as recordings.
 *
 * This is the seam between the studio and everyone watching. The studio holds
 * the one GPU session, records what it broadcasts and appends it here; the
 * public channel reads this and plays it. Viewers never touch a session, which
 * is what makes one stream serve any number of them at no extra cost.
 *
 * Appending is guarded by a shared secret. Without it anyone could push
 * arbitrary video into the channel, which is a worse hole than it first looks:
 * the URL is played full-screen to every viewer.
 */
const KEY = "manifest";

function authorised(request: Request): boolean {
  const expected = process.env.STUDIO_SECRET;
  // With no secret configured only local development can append, rather than
  // the channel defaulting to open.
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("x-studio-secret") === expected;
}

export async function GET() {
  const manifest = await readJson<Manifest>(KEY, { segments: [], updatedAt: 0 });
  return NextResponse.json(manifest, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Not the studio." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const segment = (body ?? {}) as Partial<AiredSegment>;
  if (!segment.id || !segment.url || typeof segment.seconds !== "number") {
    return NextResponse.json({ error: "Incomplete segment." }, { status: 400 });
  }
  // The URL is played to every viewer, so it must be one this channel stored.
  if (!/^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(segment.url)) {
    return NextResponse.json({ error: "Segment is not from this channel's store." }, { status: 400 });
  }

  const manifest = await readJson<Manifest>(KEY, { segments: [], updatedAt: 0 });
  const existing = manifest.segments ?? [];

  // A retry must not double-air a segment.
  if (existing.some((s) => s.id === segment.id)) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  const next: Manifest = {
    // Oldest fall off the front: the channel loops recent material, not an
    // archive that grows until yesterday's news is still in rotation.
    segments: [...existing, segment as AiredSegment].slice(-WINDOW_SEGMENTS),
    updatedAt: Date.now(),
  };

  const stored = await writeJson(KEY, next);
  return NextResponse.json({ ok: stored, count: next.segments.length });
}
