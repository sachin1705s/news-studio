import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A hard ceiling on any single session, in seconds.
 *
 * Billing runs from session creation to termination, not from first frame, so
 * this is the blast radius of a session that escapes clean teardown — a closed
 * laptop, a crashed tab, a lost network. The API allows up to 24 hours; asking
 * for that would mean a day of billing for one orphan, which is a bad trade for
 * a channel that rotates sessions anyway. An hour is long enough to run
 * continuously and short enough to bound the damage.
 */
const MAX_SESSION_SECONDS = Number(process.env.REACTOR_MAX_SESSION_SECONDS ?? 3600);

/**
 * Mints a session-scoped JWT for fast-h3.
 *
 * Two constraints matter here and they count different things.
 *
 * `max_sessions` is how many sessions this token may EVER create, not how many
 * at once — closing one does not hand the budget back. A channel that rotates
 * sessions works through it steadily, so it is minted generously.
 *
 * `max_session_duration_seconds` caps a single session. Omitting it does not
 * mean unlimited: the account's own maximum applies wherever it is lower, and
 * that is what really decides how often the channel must rotate. Asking for the
 * ceiling leaves the account limit as the only one in play.
 */
export async function POST() {
  const apiKey = process.env.REACTOR_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "REACTOR_API_KEY is not set. Add it to .env.local and restart." },
      { status: 500 },
    );
  }

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
          resources: { models: { match: ["fast-h3"] } },
          constraints: {
            max_sessions: 24,
            max_session_duration_seconds: MAX_SESSION_SECONDS,
          },
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
    { jwt, expires_at, requestedSessionSeconds: MAX_SESSION_SECONDS },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
