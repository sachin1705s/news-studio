import { NextResponse } from "next/server";
import { NEWSROOM_MODEL } from "@/lib/newsroom";
import type { Story } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const TTL_MS = 5 * 60_000;
let cache: { at: number; subject: string; stories: Story[] } | null = null;

/**
 * The live desk.
 *
 * RSS is the channel's wire and it is good at what it covers, but a startups
 * bulletin lives on funding rounds, launches and hires that reach the feeds
 * hours late or not at all. Grounded search closes that gap: it reads the web
 * at the moment the block is written.
 *
 * Search and structured output are mutually exclusive on this API, so the
 * producer is asked for a delimited block and it is parsed here. That is the
 * trade for grounding, and it is worth it — an ungrounded model writing
 * "startup news" invents companies, which is the one failure a news channel
 * cannot ship.
 */
const INSTRUCTION = `You are a wire desk for a startups and technology news channel.

Search for what has actually happened in the last 24 hours and report it. Funding rounds, acquisitions, launches, shutdowns, major hires, regulatory moves.

Report ONLY things you found in search results and can attribute. Never invent a company, a number, or a round. If you find fewer items than asked for, return fewer.

Format every item exactly like this, separated by a blank line, and write nothing else:

TITLE: <the headline, under 15 words, no source suffix>
SUMMARY: <one sentence of what happened, with the number or the name that matters>
SOURCE: <the publication you found it in>`;

function parseItems(text: string): Story[] {
  const blocks = text.split(/\n\s*\n/);
  const stories: Story[] = [];

  for (const block of blocks) {
    const title = block.match(/TITLE:\s*(.+)/)?.[1]?.trim();
    const summary = block.match(/SUMMARY:\s*(.+)/)?.[1]?.trim();
    const source = block.match(/SOURCE:\s*(.+)/)?.[1]?.trim();
    if (!title || !summary) continue;

    stories.push({
      // Deterministic on the headline so a repeat search does not re-run a story
      // the channel has already broadcast.
      id: `live:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`,
      title: title.replace(/^[*\-\d.\s]+/, ""),
      summary,
      source: source || "Wire",
      category: "startups",
      link: "",
      // Grounded search does not date its results; the desk treats them as now,
      // which is what "last 24 hours" was asked for.
      publishedAt: Date.now(),
      live: true,
    });
  }

  return stories.filter((s) => s.title.length > 12).slice(0, 8);
}

export async function GET(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GEMINI_API_KEY is not set.", stories: [] }, { status: 503 });
  }

  const subject =
    new URL(request.url).searchParams.get("subject") ??
    "startup funding rounds, acquisitions and product launches";

  if (cache && cache.subject === subject && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json({ stories: cache.stories, cached: true });
  }

  try {
    const res = await fetch(`${ENDPOINT}/${NEWSROOM_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: INSTRUCTION }] },
        contents: [
          {
            role: "user",
            parts: [{ text: `Find the six most significant items about ${subject} from the last 24 hours.` }],
          },
        ],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json(
        { error: `Live desk ${res.status}: ${detail.slice(0, 160)}`, stories: [] },
        { status: 502 },
      );
    }

    const payload = await res.json();
    const text: string = (payload?.candidates?.[0]?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? "")
      .join("");

    const stories = parseItems(text);
    if (stories.length) cache = { at: Date.now(), subject, stories };

    return NextResponse.json(
      { stories, grounded: Boolean(payload?.candidates?.[0]?.groundingMetadata) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const message =
      err instanceof Error && err.name === "TimeoutError"
        ? "The live desk did not answer in time."
        : err instanceof Error
          ? err.message
          : "The live desk failed.";
    return NextResponse.json({ error: message, stories: [] }, { status: 502 });
  }
}
