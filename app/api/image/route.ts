import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fetch the picture a story was published with.
 *
 * Two jobs. Feeds that carry `media:content` hand over an image URL directly.
 * Feeds that carry nothing — which is most of the startup wires — only give a
 * link, so the article is fetched and its `og:image` read instead. Either way
 * the result is the photograph the publisher chose for the story.
 *
 * It goes through the server rather than the browser because the deck has to
 * hand the bytes to Reactor: publishers do not send CORS headers, so a fetch
 * from the page could never read the pixels.
 */
const MAX_BYTES = 8 * 1024 * 1024;
const resolved = new Map<string, string | null>();

/**
 * A URL proxy will fetch whatever it is told to, including the machine it is
 * running on. Only public http(s) hosts are allowed through.
 */
function isPublicHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host === "[::1]" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return null;
  }
  return url;
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

/** Pull the social preview image out of an article page. */
function findOgImage(html: string, base: URL): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const hit = html.match(re)?.[1];
    if (hit) {
      try {
        return new URL(hit, base).toString();
      } catch {
        continue;
      }
    }
  }
  return null;
}

export async function GET(request: Request) {
  const target = new URL(request.url).searchParams.get("url");
  if (!target) return NextResponse.json({ error: "No url." }, { status: 400 });

  const start = isPublicHttpUrl(target);
  if (!start) return NextResponse.json({ error: "Blocked url." }, { status: 400 });

  const cached = resolved.get(target);
  if (cached === null) return NextResponse.json({ error: "No image." }, { status: 404 });

  try {
    let imageUrl = cached ?? target;

    // Unless it is already known to be an image, look at what comes back first.
    if (!cached) {
      const probe = await fetch(start, {
        headers: { "User-Agent": BROWSER_UA, Accept: "image/*,text/html;q=0.9" },
        signal: AbortSignal.timeout(12_000),
        redirect: "follow",
      });
      if (!probe.ok) {
        resolved.set(target, null);
        return NextResponse.json({ error: `Source ${probe.status}.` }, { status: 404 });
      }

      const type = probe.headers.get("content-type") ?? "";
      if (type.startsWith("image/")) {
        const buf = await probe.arrayBuffer();
        if (buf.byteLength > MAX_BYTES) {
          return NextResponse.json({ error: "Image too large." }, { status: 413 });
        }
        resolved.set(target, target);
        return new NextResponse(buf, {
          headers: { "Content-Type": type, "Cache-Control": "public, max-age=3600" },
        });
      }

      const html = (await probe.text()).slice(0, 400_000);
      const og = findOgImage(html, new URL(probe.url));
      if (!og || !isPublicHttpUrl(og)) {
        resolved.set(target, null);
        return NextResponse.json({ error: "No image on the page." }, { status: 404 });
      }
      resolved.set(target, og);
      imageUrl = og;
    }

    const checked = isPublicHttpUrl(imageUrl);
    if (!checked) return NextResponse.json({ error: "Blocked url." }, { status: 400 });

    const res = await fetch(checked, {
      headers: { "User-Agent": BROWSER_UA, Accept: "image/*" },
      signal: AbortSignal.timeout(12_000),
      redirect: "follow",
    });
    if (!res.ok) return NextResponse.json({ error: `Image ${res.status}.` }, { status: 404 });

    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) {
      return NextResponse.json({ error: "Not an image." }, { status: 415 });
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return NextResponse.json({ error: "Image too large." }, { status: 413 });
    }

    return new NextResponse(buf, {
      headers: { "Content-Type": type, "Cache-Control": "public, max-age=3600" },
    });
  } catch (err) {
    const message =
      err instanceof Error && err.name === "TimeoutError"
        ? "The image source timed out."
        : err instanceof Error
          ? err.message
          : "Image fetch failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
