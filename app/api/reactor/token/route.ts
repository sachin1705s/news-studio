import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mints a session-scoped JWT for fast-h3.
 *
 * `max_sessions` counts sessions a token has EVER created, not concurrent ones,
 * so a channel that rotates sessions all day cannot reuse one token forever.
 * Each deck calls this when it needs to go live and gets its own budget.
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
          constraints: { max_sessions: 8 },
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
    { jwt, expires_at },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
