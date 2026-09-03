import { NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";
import { FEEDS } from "@/lib/feeds";
import type { Category, Story } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

/** Wire feeds don't change faster than this, and the channel polls constantly. */
const TTL_MS = 4 * 60_000;
const cache = new Map<string, { at: number; stories: Story[] }>();

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cats = (url.searchParams.get("categories") ?? "top")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean) as Category[];

  const batches = await Promise.all(cats.map(fetchCategory));
  const seen = new Set<string>();
  const stories: Story[] = [];

  // Interleave categories so a program drawing on two feeds alternates between
  // them instead of running one dry before it starts the other.
  const maxLen = Math.max(0, ...batches.map((b) => b.length));
  for (let i = 0; i < maxLen; i++) {
    for (const batch of batches) {
      const s = batch[i];
      if (!s) continue;
      const key = dedupeKey(s.title);
      if (seen.has(key)) continue;
      seen.add(key);
      stories.push(s);
    }
  }

  return NextResponse.json(
    { stories, fetchedAt: Date.now() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

async function fetchCategory(category: Category): Promise<Story[]> {
  const hit = cache.get(category);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.stories;

  const feeds = FEEDS[category] ?? [];
  const results = await Promise.all(
    feeds.map(async ({ url, source }) => {
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; LiveNewsStudio/1.0)" },
          signal: AbortSignal.timeout(9000),
          cache: "no-store",
        });
        if (!res.ok) return [];
        return parseFeed(await res.text(), source, category);
      } catch {
        // One dead feed must never take the channel off air.
        return [];
      }
    }),
  );

  const stories = results
    .flat()
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, 40);

  // Serve the previous batch rather than nothing if every feed just failed.
  if (!stories.length && hit) return hit.stories;
  cache.set(category, { at: Date.now(), stories });
  return stories;
}

function parseFeed(xml: string, source: string, category: Category): Story[] {
  const doc = parser.parse(xml);
  const raw = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? [];
  const items = Array.isArray(raw) ? raw : [raw];

  return items
    .map((item: Record<string, unknown>): Story | null => {
      const title = text(item.title);
      if (!title) return null;
      const link = text(item.link) || linkHref(item.link);
      const summary = stripHtml(
        text(item.description) || text(item.summary) || text(item["content:encoded"]),
      );
      const dateText = text(item.pubDate) || text(item.published) || text(item.updated);
      const parsed = dateText ? Date.parse(dateText) : NaN;
      return {
        id: `${source}:${text(item.guid) || link || title}`,
        title: stripHtml(title),
        summary,
        source,
        category,
        link,
        publishedAt: Number.isNaN(parsed) ? Date.now() : parsed,
      };
    })
    .filter((s): s is Story => s !== null);
}

function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["#text"] === "string") return o["#text"];
  }
  return "";
}

/** Atom links carry the URL on an attribute rather than as the node's text. */
function linkHref(v: unknown): string {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["@_href"] === "string") return o["@_href"];
  }
  return "";
}

/** The handful of named entities wire feeds actually emit. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  pound: "\u00A3",
  euro: "\u20AC",
};

/**
 * Strip markup and decode entities.
 *
 * Feeds emit numeric entities far more often than named ones — `&#8217;` for an
 * apostrophe is near universal — and this text becomes the anchor's spoken
 * script, so anything left encoded is read aloud as literal punctuation names.
 * Decoding runs last so an entity that encodes a bracket cannot reintroduce a
 * tag after the markup has been removed.
 */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => safeChar(Number(code)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&([a-zA-Z]+);/g, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/g, " ")
    .trim();
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return " ";
  try {
    return String.fromCodePoint(code);
  } catch {
    return " ";
  }
}


/** Four outlets running the same story shouldn't get four segments. */
function dedupeKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6)
    .join(" ");
}
