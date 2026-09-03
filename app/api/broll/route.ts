import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Turn headlines into footage.
 *
 * A headline names a subject but rarely describes a picture — "NBA suspends
 * Clippers owner" has no shot in it. This asks Claude for the shot a news
 * editor would actually cut to, which is the difference between usable b-roll
 * and a video model's guess at an abstraction.
 *
 * The whole block is written in one request rather than one per story: it is
 * cheaper, it is faster than a dozen round trips, and it lets the model vary
 * the shots across a block instead of repeating the same establishing wide.
 */

const SYSTEM = `You are a news picture editor choosing cutaway footage for a live bulletin.

For each headline you are given, describe the single shot a broadcast editor would cut to while the anchor reads it.

Rules for every shot:
- Describe what the CAMERA SEES. No narration, no dialogue, no anchor, no presenter, no text or graphics on screen.
- One continuous shot. Name the subject, the setting, the light, and one thing that MOVES — footage is not a photograph.
- Concrete and literal. If a story is abstract (a ruling, an earnings figure, a suspension), cut to the physical place or object it touches: the arena, the storefront, the trading floor, the empty office.
- Real-world documentary look. No captions, no logos, no recognisable living person's face in close-up.
- 25 words or fewer. No sentence-ending flourish, just the shot.

Return one shot per headline, in the same order.`;

interface BrollRequest {
  headlines: string[];
  lookFor?: string;
}

export async function POST(request: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // The channel runs anchor-only without this. Say so once, clearly, and let
    // the caller carry on rather than taking the bulletin off air.
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set; b-roll is disabled.", shots: [] },
      { status: 503 },
    );
  }

  const { headlines, lookFor } = (await request.json()) as BrollRequest;
  if (!Array.isArray(headlines) || headlines.length === 0) {
    return NextResponse.json({ error: "No headlines supplied.", shots: [] }, { status: 400 });
  }

  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 2000,
      // Short, well-specified job — low effort is the right spend, and it keeps
      // the block's shots turning around fast enough to stay ahead of playout.
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              shots: {
                type: "array",
                items: { type: "string" },
                description: "One shot description per headline, same order.",
              },
            },
            required: ["shots"],
            additionalProperties: false,
          },
        },
      },
      // The system prompt is byte-identical on every call, so it caches.
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            lookFor ? `This block is about ${lookFor}.` : "",
            "Headlines:",
            ...headlines.map((h, i) => `${i + 1}. ${h}`),
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return NextResponse.json(
        { error: "Shot descriptions were declined.", shots: [] },
        { status: 502 },
      );
    }

    const text = response.content.find((b) => b.type === "text");
    const parsed = text && text.type === "text" ? JSON.parse(text.text) : { shots: [] };
    const shots: string[] = Array.isArray(parsed.shots) ? parsed.shots : [];

    return NextResponse.json(
      { shots: shots.slice(0, headlines.length) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: "Rate limited.", shots: [] }, { status: 429 });
    }
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json(
        { error: `Claude API error ${err.status}.`, shots: [] },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Shot lookup failed.", shots: [] },
      { status: 500 },
    );
  }
}
