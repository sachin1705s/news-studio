import { NextResponse } from "next/server";
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
const STALE_MS = 5 * 60_000;

interface Registration {
  sessionId: string;
  /** Identifies the browser driving the channel, for handover. */
  originId: string;
  startedAt: number;
  heartbeatAt: number;
}

export async function GET() {
  const live = await readJson<Registration | null>(KEY, null);
  const fresh = live && Date.now() - live.heartbeatAt <= STALE_MS ? live : null;
  return NextResponse.json(
    { channel: fresh },
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
  if (typeof sessionId !== "string" || !sessionId || typeof originId !== "string" || !originId) {
    return NextResponse.json({ error: "Incomplete claim." }, { status: 400 });
  }

  const now = Date.now();
  const current = await readJson<Registration | null>(KEY, null);
  const fresh = current && now - current.heartbeatAt <= STALE_MS ? current : null;

  if (fresh && fresh.originId !== originId) {
    // Someone else is already broadcasting. Adopt theirs.
    return NextResponse.json({ channel: fresh, claimed: false });
  }

  const next: Registration = {
    sessionId,
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
