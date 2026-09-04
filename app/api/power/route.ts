import { NextResponse } from "next/server";
import { readJson, writeJson } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The channel's off switch.
 *
 * Killing sessions is not the same as stopping the channel: every open tab
 * starts a broadcast the moment it finds none running, so terminating one
 * simply provokes the next. Turning the channel off has to be a state the
 * clients read, not an action taken against the symptom.
 *
 * It lives in the store rather than an environment variable so it can be
 * flipped without a deploy — which is the whole point of an off switch.
 */
const KEY = "power";

interface Power {
  off: boolean;
  at: number;
  reason?: string;
}

export async function GET() {
  const power = await readJson<Power | null>(KEY, null);
  return NextResponse.json(
    { off: Boolean(power?.off), reason: power?.reason ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const secret = process.env.OPS_SECRET;
  let body: { off?: unknown; key?: unknown; reason?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  // Without a configured secret this is only usable off production, rather
  // than leaving anyone able to take the channel down.
  if (secret ? body.key !== secret : process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available." }, { status: 404 });
  }

  const off = Boolean(body.off);
  await writeJson(KEY, {
    off,
    at: Date.now(),
    reason: typeof body.reason === "string" ? body.reason : undefined,
  } satisfies Power);

  // Turning it off also retires the registration, so nothing is left pointing
  // at a session that is about to be terminated.
  if (off) await writeJson("channel", null);

  return NextResponse.json({ off });
}
