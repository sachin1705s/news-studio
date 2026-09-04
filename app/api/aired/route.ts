import { NextResponse } from "next/server";
import { readJson, writeJson } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the channel has already broadcast.
 *
 * This used to live in the origin browser's localStorage, which made it the
 * browser's memory rather than the channel's. Every restart in a different
 * browser began with a blank history and replayed the same stories — and this
 * channel restarts often, so viewers saw the same bulletin come round again.
 *
 * It belongs on the server for the same reason the running order does: whoever
 * happens to be driving the broadcast is an implementation detail, and the
 * audience experiences one continuous channel.
 */
const KEY = "aired";

/** How long a story stays retired before it may run again. */
const RETIRE_MS = 6 * 60 * 60 * 1000;

/** Bounded so a long run cannot grow the document without limit. */
const MAX_TRACKED = 1500;

type Aired = Record<string, number>;

function live(aired: Aired, now: number): Aired {
  const entries = Object.entries(aired)
    .filter(([, at]) => now - at <= RETIRE_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TRACKED);
  return Object.fromEntries(entries);
}

export async function GET() {
  try {
    const aired = await readJson<Aired>(KEY, {});
    return NextResponse.json(
      { aired: live(aired, Date.now()) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ aired: {} }, { headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { ids?: unknown };
    const ids = Array.isArray(body?.ids) ? body.ids.filter((v): v is string => typeof v === "string") : [];
    if (!ids.length) return NextResponse.json({ ok: true });

    const now = Date.now();
    const aired = live(await readJson<Aired>(KEY, {}), now);
    for (const id of ids.slice(0, 100)) aired[id] = now;

    await writeJson(KEY, live(aired, now));
    return NextResponse.json({ ok: true, tracked: Object.keys(aired).length });
  } catch {
    return NextResponse.json({ ok: false });
  }
}
