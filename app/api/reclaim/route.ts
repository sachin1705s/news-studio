import { NextResponse } from "next/server";
import { forgetSessionCache, openSessions, terminateSession } from "@/lib/reactor-sessions";
import { writeJson } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Clear a broadcast that exists but is not broadcasting.
 *
 * A session outlives the browser that was driving it: the tab is closed, the
 * session stays ACTIVE, and nothing queues clips into it any more. That state
 * is worse than no channel at all, because it deadlocks the whole thing — every
 * arrival is told to adopt the session and sees nothing, while the gate refuses
 * to let anyone start a real one because a session is technically open.
 *
 * Only a client that has actually attached and waited is in a position to say
 * this, which is why it is reported from the viewer rather than inferred here.
 * The check below is the guard against that report being wrong: a session that
 * has just started is left alone.
 */
const MIN_AGE_MS = 60_000;

export async function POST(request: Request) {
  const apiKey = process.env.REACTOR_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "No API key." }, { status: 500 });

  let sessionId = "";
  try {
    const body = (await request.json()) as { sessionId?: unknown };
    if (typeof body?.sessionId === "string") sessionId = body.sessionId;
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  if (!sessionId) return NextResponse.json({ error: "No session." }, { status: 400 });

  try {
    const open = await openSessions(apiKey);
    const target = open.find((s) => s.sessionId === sessionId);

    // Already gone, or never ours to close.
    if (!target) {
      await writeJson("channel", null);
      return NextResponse.json({ reclaimed: true, alreadyClosed: true });
    }

    // Too young to be stuck — it is probably still coming up.
    if (Date.now() - target.createdAt < MIN_AGE_MS) {
      return NextResponse.json({ reclaimed: false, reason: "too young" });
    }

    const killed = await terminateSession(apiKey, sessionId);
    if (killed) {
      forgetSessionCache();
      await writeJson("channel", null);
    }
    return NextResponse.json({ reclaimed: killed });
  } catch {
    return NextResponse.json({ error: "Could not reach Reactor." }, { status: 502 });
  }
}
