import { NextResponse } from "next/server";

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
  try {
    const body = (await request.json()) as { sessionId?: unknown };
    if (typeof body?.sessionId === "string" && body.sessionId) sessionId = body.sessionId;
  } catch {
    // No body is the origin case.
  }

  const constraints: Record<string, number> = sessionId
    ? // A viewer never needs to create one. The floor the API accepts is 1, so
      // this cannot be zero — a short expiry is what bounds it instead.
      { max_sessions: 1 }
    : { max_sessions: 24, max_session_duration_seconds: MAX_SESSION_SECONDS };

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
