import { NextResponse } from "next/server";
import { readJson } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A hard ceiling on any single session, in seconds.
 *
 * Billing runs from GPU assignment to termination, not from first frame, so
 * this is the blast radius of a session that escapes clean teardown — a closed
 * laptop, a crashed tab, a lost network. The API allows up to 24 hours; asking
 * for that would mean a day of billing for one orphan. An hour is long enough
 * to run continuously and short enough to bound the damage.
 */
const MAX_SESSION_SECONDS = Number(process.env.REACTOR_MAX_SESSION_SECONDS ?? 3600);

/**
 * Mints a session-scoped JWT for fast-h3.
 *
 * Two kinds of token come out of here, and the difference is the whole of the
 * channel's safety model.
 *
 * The **origin** token creates the one session the channel broadcasts from. It
 * may create sessions, so it is only ever handed to the client that is starting
 * the channel.
 *
 * A **viewer** token is minted against a session that already exists, named in
 * `resources.sessions.bind`. A session-scoped token can otherwise only act on
 * sessions it created; binding authorises it for this one and no other. That is
 * what lets any number of people watch one broadcast without any of them being
 * able to start a second GPU session on the account.
 */
export async function POST(request: Request) {
  const apiKey = process.env.REACTOR_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "REACTOR_API_KEY is not set. Add it to .env.local and restart." },
      { status: 500 },
    );
  }

  let sessionId: string | undefined;
  let originId = "";
  try {
    const body = (await request.json()) as { sessionId?: unknown; originId?: unknown };
    if (typeof body?.sessionId === "string" && body.sessionId) sessionId = body.sessionId;
    if (typeof body?.originId === "string") originId = body.originId;
  } catch {
    // No body is the origin case.
  }

  // The off switch, checked before anything else. No origin token means no
  // browser can start a broadcast, which is what "off" has to mean when every
  // open tab is trying to start one.
  if (!sessionId) {
    // Environment first, and deliberately so. The store is eventually
    // consistent and a write to it can be lost — acceptable for a comment,
    // useless for the control that stops the account being billed. CHANNEL_OFF
    // is read from the deployment itself and cannot fail to apply.
    if (process.env.CHANNEL_OFF === "1") {
      return NextResponse.json({ error: "The channel is switched off." }, { status: 503 });
    }
    const power = await readJson<{ off?: boolean } | null>("power", null);
    if (power?.off) {
      return NextResponse.json({ error: "The channel is switched off." }, { status: 503 });
    }
  }

  // The origin gate. A browser cannot start a broadcast without a token, and
  // this is the only place tokens come from — so refusing here is the one
  // control that actually holds. Everything client-side is advisory: a stale
  // read, a lost race or a hand-edited page can all get past it.
  if (!sessionId) {
    const live = await readJson<{
      sessionId: string | null;
      originId: string;
      heartbeatAt: number;
      startedAt: number;
    } | null>("channel", null);

    const held =
      live &&
      (live.sessionId
        ? Date.now() - live.heartbeatAt <= 5 * 60_000
        : Date.now() - live.startedAt <= 60_000);

    if (held && live && live.originId !== originId) {
      return NextResponse.json(
        {
          error: "A broadcast is already running. Watch that one instead.",
          sessionId: live.sessionId,
        },
        { status: 409 },
      );
    }
  }

  const constraints: Record<string, number> = sessionId
    ? // A viewer never needs to create one. The floor the API accepts is 1, so
      // this cannot be zero — a short expiry is what bounds it instead.
      { max_sessions: 1 }
    : // Not 1. `max_sessions` counts sessions the token has EVER created, not
      // how many at once, and the SDK caches a token for its lifetime — so a
      // cap of one meant the first broadcast worked and every restart after it
      // was refused, leaving the channel unable to come back. A small allowance
      // covers reconnects and restarts within the token's hour; the single
      // broadcast is guaranteed by the gate above, which is a real check rather
      // than a side effect of a counter.
      { max_sessions: 6, max_session_duration_seconds: MAX_SESSION_SECONDS };

  const res = await fetch("https://api.reactor.inc/tokens", {
    method: "POST",
    headers: {
      "Reactor-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expires_after: 3600,
      authorization_details: [
        {
          type: "session",
          resources: {
            models: { match: ["fast-h3"] },
            ...(sessionId ? { sessions: { bind: [sessionId] } } : {}),
          },
          constraints,
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    return NextResponse.json(
      { error: `Reactor token request failed (${res.status})`, detail },
      { status: 502 },
    );
  }

  const { jwt, expires_at } = await res.json();
  return NextResponse.json(
    { jwt, expires_at, role: sessionId ? "viewer" : "origin" },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
