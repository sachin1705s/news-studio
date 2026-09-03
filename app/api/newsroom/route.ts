import { NextResponse } from "next/server";
import { NEWSROOM_MODEL, type NewsroomRequest, type ProducedItem } from "@/lib/newsroom";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Produce a block.
 *
 * One request writes the whole block rather than one per story: it is cheaper,
 * it is faster than a dozen round trips, and — the real reason — only a
 * producer looking at the whole block can decide which story deserves three
 * minutes and which deserves twenty seconds. That judgement is the difference
 * between a bulletin and a list.
 *
 * The model is the small one on purpose. This is short-form editorial against
 * a fixed brief, and the block has to be written before the playout queue drains.
 */
const SYSTEM = `You are the producer of a rolling 24-hour news channel. For each story you are given, you decide how much airtime it gets and you write what goes on air.

First choose "treatment" for every story:
- "short" — a story worth a mention. The anchor reads it and that is all, or one picture behind them. About 20 seconds.
- "medium" — a normal story. The anchor introduces it, two or three pictures carry it. About a minute.
- "long" — the story the block is actually about. Aerials, several pictures, a correspondent on location, and the anchor closing it out. Up to three minutes.
Most stories are "short" or "medium". You will be told the maximum number of "long" stories allowed; never exceed it, and give "long" only to a story with enough substance to hold three minutes.

For EVERY story write:

"read" — what the anchor says to camera to introduce the story. One sentence, 18-24 words, broadcast register. State what happened. Do not greet the audience, do not say "welcome back", do not editorialise.

"cuts" — the pictures that follow the read, in order. Each cut is an object with "shot", "voiceover" and "framing".
Number of cuts by treatment: "short" → 0 or 1. "medium" → 2 or 3. "long" → 5 to 7.

  "shot" — what the CAMERA SEES, 25 words or fewer. One continuous shot: name the subject, the setting, the light, and one thing that MOVES. Documentary look, real location.
  CRITICAL: never choose a subject whose purpose is to display words or numbers. No scoreboards, no stock tickers, no newsstands, no shop signage, no banners, no screens showing text, no lecterns with name boards. Cameras render lettering as nonsense in this pipeline. Cut to the physical place or object the story touches instead: the building, the street, the factory floor, the empty office, the hands doing the work.

  "framing" — one of "aerial", "ground", "interior", "detail".
  "aerial" is a helicopter or drone shot looking down on a place from above. "ground" is street level. "interior" is inside a building. "detail" is a close shot of one object or a pair of hands.
  Vary them. A "long" story must open on an "aerial" and must use at least three different framings. Never use the same framing twice in a row.

  "voiceover" — what the anchor says over that picture. 18-26 words.
  CRITICAL: the cuts together form one continuous script that DEVELOPS. Each line carries the story further than the last: what happened, then the number, then who it affects, then the context, then what happens next. No line may restate the read or any earlier line, and no line may repeat a phrase from another.

"reporter" — a correspondent on location, OR null.
Every "long" story gets one. Otherwise give one only to a story with a real physical place worth standing in, and never more than the number you are told. When you do:
  "location" — where they are standing, as it appears on screen. Short. "Outside the company's Dublin office", "At the Nasdaq, New York".
  "scene" — what the camera sees behind them, 20 words or fewer, same no-lettering rule as "shot".
  "standup" — their piece to camera. 20-28 words, first person, present tense, said on location. Add something neither the read nor any voiceover said. End by handing back to the studio.

"tag" — for "long" stories ONLY, the anchor's closing line back at the desk. 15-20 words. It lands the story; it does not summarise what was just said. Empty string for every other treatment.

"breaking" — true ONLY if the story is actively developing right now. At most one story per block. Default false.

Return one item per story, in the order given, echoing each story's id exactly.`;

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          treatment: { type: "string", enum: ["short", "medium", "long"] },
          read: { type: "string" },
          cuts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                shot: { type: "string" },
                voiceover: { type: "string" },
                framing: { type: "string", enum: ["aerial", "ground", "interior", "detail"] },
              },
              required: ["shot", "voiceover", "framing"],
            },
          },
          reporter: {
            type: "object",
            nullable: true,
            properties: {
              location: { type: "string" },
              scene: { type: "string" },
              standup: { type: "string" },
            },
            required: ["location", "scene", "standup"],
          },
          tag: { type: "string" },
          breaking: { type: "boolean" },
        },
        required: ["id", "treatment", "read", "cuts", "breaking"],
      },
    },
  },
  required: ["items"],
};

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // The channel runs on library footage and wire headlines without this.
    return NextResponse.json({ error: "GEMINI_API_KEY is not set.", items: [] }, { status: 503 });
  }

  const body = (await request.json()) as NewsroomRequest;
  const { stories, lookFor, tone, reporterBudget, longBudget } = body;
  if (!Array.isArray(stories) || stories.length === 0) {
    return NextResponse.json({ error: "No stories supplied.", items: [] }, { status: 400 });
  }

  const brief = [
    `This block is about ${lookFor}.`,
    `The anchor reads in this register: ${tone}.`,
    `At most ${longBudget} of these stories may be "long". At most ${reporterBudget} may have a correspondent.`,
    "Mix the rest between short and medium so the block does not run at one pace.",
    "",
    "Stories:",
    ...stories.map(
      (s, i) =>
        `${i + 1}. id: ${s.id}\n   headline: ${s.title}\n   wire copy: ${s.summary || "(none)"}\n   source: ${s.source}`,
    ),
  ].join("\n");

  try {
    const res = await fetch(`${ENDPOINT}/${NEWSROOM_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: brief }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192,
          // No thinkingConfig: the lite model rejects the field outright with a
          // bare INVALID_ARGUMENT, and it is fast enough without tuning.
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
        },
      }),
      // A block that takes longer than this is late for air; fall back instead.
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json(
        { error: `Gemini ${res.status}: ${detail.slice(0, 160)}`, items: [] },
        { status: 502 },
      );
    }

    const payload = await res.json();
    const candidate = payload?.candidates?.[0];
    if (candidate?.finishReason && !["STOP", "MAX_TOKENS"].includes(candidate.finishReason)) {
      return NextResponse.json(
        { error: `Producer stopped: ${candidate.finishReason}.`, items: [] },
        { status: 502 },
      );
    }

    const text: string = (candidate?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? "")
      .join("");

    const parsed = JSON.parse(text) as { items?: ProducedItem[] };
    const items = Array.isArray(parsed.items) ? parsed.items : [];

    return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message =
      err instanceof Error && err.name === "TimeoutError"
        ? "The producer did not answer in time."
        : err instanceof Error
          ? err.message
          : "The producer failed.";
    return NextResponse.json({ error: message, items: [] }, { status: 502 });
  }
}
