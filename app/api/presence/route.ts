import { NextResponse } from "next/server";
import { readJson, writeJson } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who is watching right now.
 *
 * Presence is a heartbeat rather than a connect/disconnect pair, because there
 * is no reliable disconnect on the web: a closed laptop, a killed tab and a
 * dead network all look the same and none of them send anything. So viewers
 * announce themselves periodically and are forgotten when they stop.
 *
 * The count is approximate by construction. The store is last-write-wins, so
 * two viewers heartbeating at the same instant can lose one of the two writes —
 * which is why the window is several heartbeats long: a lost write is picked up
 * again on the next beat, well before the viewer would drop out of the count.
 */
const KEY = "presence";

/** How long a viewer stays counted after their last heartbeat. */
const WINDOW_MS = 60_000;

/** Beyond this many, the store is being abused rather than watched. */
const MAX_TRACKED = 500;

type Seen = Record<string, number>;

function live(seen: Seen, now: number): Seen {
  const out: Seen = {};
  for (const [id, at] of Object.entries(seen)) {
    if (now - at <= WINDOW_MS) out[id] = at;
  }
  return out;
}

export async function GET() {
  try {
    const seen = await readJson<Seen>(KEY, {});
    const now = Date.now();
    return NextResponse.json(
      { watching: Object.keys(live(seen, now)).length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ watching: 0 }, { headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ watching: 0 });
    }

    const { id } = (body ?? {}) as { id?: unknown };
    if (typeof id !== "string" || !id || id.length > 64) {
      return NextResponse.json({ watching: 0 });
    }

    const now = Date.now();
    const seen = live(await readJson<Seen>(KEY, {}), now);
    seen[id] = now;

    const ids = Object.keys(seen);
    if (ids.length <= MAX_TRACKED) {
      // A failed write is not worth an error: the viewer is still watching, and
      // the next heartbeat will try again.
      await writeJson(KEY, seen);
    }

    return NextResponse.json(
      { watching: ids.length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ watching: 0 });
  }
}
