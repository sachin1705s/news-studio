import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the channel has left to spend.
 *
 * The balance is the only honest measure of what is running. Everything else
 * this app knows is what it *believes* it started; a balance falling faster
 * than one session's rate is the only way to notice a session nobody is
 * tracking — an old tab on a stale build, a client that escaped the gate.
 *
 * At 70 credits a second, one fast-h3 session costs 4,200 credits a minute.
 * Divide the observed drop by that and you have the number of live sessions.
 */
const ACCOUNT_PATH = "https://api.reactor.inc/accounts";
const CREDITS_PER_DOLLAR = 10_000;

export async function GET(request: Request) {
  const apiKey = process.env.REACTOR_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "No API key." }, { status: 500 });

  // An account balance is not public information. Without a configured secret
  // this answers only in development, rather than defaulting to open.
  const secret = process.env.OPS_SECRET;
  const offered = new URL(request.url).searchParams.get("key");
  if (secret ? offered !== secret : process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available." }, { status: 404 });
  }

  try {
    const me = await fetch("https://api.reactor.inc/me", {
      headers: { "Reactor-API-Key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!me.ok) return NextResponse.json({ error: `Account lookup ${me.status}.` }, { status: 502 });
    const { account_id } = (await me.json()) as { account_id: string };

    const res = await fetch(`${ACCOUNT_PATH}/${account_id}/credits`, {
      headers: { "Reactor-API-Key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return NextResponse.json({ error: `Balance ${res.status}.` }, { status: 502 });

    const { balance } = (await res.json()) as { balance: number };
    return NextResponse.json(
      { balance, dollars: balance / CREDITS_PER_DOLLAR, at: Date.now() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Balance unavailable." }, { status: 502 });
  }
}
