import { NextResponse } from "next/server";
import { openSessions } from "@/lib/reactor-sessions";
import { readJson, writeJson } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which session the channel is currently broadcasting from.
 *
 * This is how one stream reaches everybody: the client that starts the channel
 * registers its session id here, and every later visitor reads it and attaches
 * to that same session instead of creating one of their own.
 *
 * The record is deliberately tiny and deliberately expirable. A registration
 * that outlives its session would send every new arrival to a session that no
 * longer exists, so the origin refreshes it while it broadcasts and the record
 * is ignored once that refresh stops.
 */
const KEY = "channel";

/**
 * A registration is stale if the origin has not refreshed it recently.
 *
 * Generous on purpose. This exists only to notice an origin that has genuinely
 * gone, and the cost of being impatient is the expensive mistake: a live
 * broadcast whose registration lapsed sends the next visitor off to start a
 * second GPU session. A background tab can have its timers throttled to once a
 * minute, so ninety seconds was not enough room.
 */
const STALE_MS = 8 * 60_000;

interface Registration {
  /**
   * Null while a browser has reserved the channel but has not yet brought a
   * session up. Reserving first is what stops two arrivals in the same moment
   * each paying for a GPU before one of them stands down.
   */
  sessionId: string | null;
  /** Identifies the browser driving the channel, for handover. */
  originId: string;
  startedAt: number;
  heartbeatAt: number;
}

/** A reservation is only honoured briefly: a browser that never brings a
 *  session up must not hold the channel shut. */
const RESERVE_MS = 60_000;

export async function GET() {
  const live = await readJson<Registration | null>(KEY, null);
  const now = Date.now();
  let fresh = live && now - live.heartbeatAt <= STALE_MS ? live : null;

  // A registration can also name a session that has since been closed, and
  // handing that to an arrival is worse than handing them nothing: they attach,
  // see no picture, and wait out the dead-session timeout before anyone starts
  // a real broadcast. So the registry is checked against Reactor rather than
  // trusted, and a registration whose session is gone is treated as absent.
  if (fresh?.sessionId) {
    const apiKey = process.env.REACTOR_API_KEY;
    if (apiKey) {
      try {
        const open = await openSessions(apiKey);
        if (!open.some((o) => o.sessionId === fresh?.sessionId)) {
          fresh = null;
          await writeJson(KEY, null);
        }
      } catch {
        // Reactor unreachable: trust the registration rather than blank the
        // channel on the strength of a failed lookup.
      }
    }
  }

  // The registry can be empty because nothing is running, or because the store
  // that holds it is unavailable. Those look identical from here and mean
  // opposite things, so when it is empty Reactor is asked directly — otherwise
  // a broken store tells every arrival to start its own broadcast.
  if (!fresh?.sessionId) {
    const apiKey = process.env.REACTOR_API_KEY;
    if (apiKey) {
      try {
        const open = await openSessions(apiKey);
        if (open.length > 0) {
          fresh = {
            sessionId: open[0].sessionId,
            originId: "unknown",
            startedAt: open[0].createdAt,
            heartbeatAt: now,
          };
        }
      } catch {
        // Leave it empty; the caller will start a broadcast.
      }
    }
  }

  // Only a registration with a session is something to join. A live
  // reservation is reported separately so an arrival waits rather than
  // starting a second broadcast of its own.
  return NextResponse.json(
    {
      channel: fresh?.sessionId ? fresh : null,
      reserved: Boolean(fresh && !fresh.sessionId && now - fresh.startedAt <= RESERVE_MS),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Claim or refresh the channel.
 *
 * The claim is first-come: if a live registration already exists it is handed
 * back rather than overwritten, so two people opening the page at the same
 * moment cannot end up starting two sessions. The loser adopts the winner's.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const { sessionId, originId } = (body ?? {}) as { sessionId?: unknown; originId?: unknown };
  if (typeof originId !== "string" || !originId) {
    return NextResponse.json({ error: "Incomplete claim." }, { status: 400 });
  }
  // Omitting the session id reserves the channel; supplying it fills the
  // reservation in once the session is up.
  const session = typeof sessionId === "string" && sessionId ? sessionId : null;

  const now = Date.now();
  const current = await readJson<Registration | null>(KEY, null);
  const fresh = current && now - current.heartbeatAt <= STALE_MS ? current : null;

  if (fresh && fresh.originId !== originId) {
    // Someone else holds the channel — broadcasting, or reserved and about to.
    // Either way this browser must not start a second one.
    return NextResponse.json({ channel: fresh, claimed: false });
  }

  const next: Registration = {
    sessionId: session ?? fresh?.sessionId ?? null,
    originId,
    startedAt: fresh?.startedAt ?? now,
    heartbeatAt: now,
  };
  await writeJson(KEY, next);
  return NextResponse.json({ channel: next, claimed: true });
}

/** The channel has gone off air; clear the registration so nobody adopts a dead session. */
export async function DELETE(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const { originId } = (body ?? {}) as { originId?: unknown };

  const current = await readJson<Registration | null>(KEY, null);
  // Only the origin may retire its own registration.
  if (current && (typeof originId !== "string" || current.originId === originId)) {
    await writeJson(KEY, null);
  }
  return NextResponse.json({ ok: true });
}
