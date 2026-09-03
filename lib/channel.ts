import type { SegmentKind } from "./types";

/**
 * A segment that has been generated, recorded and stored.
 *
 * This is the channel's actual output. The studio produces these; the public
 * site plays them. Everything the on-screen chrome needs travels with the
 * recording, because the site that plays it has no session, no producer and no
 * wire — it only has the manifest.
 */
export interface AiredSegment {
  id: string;
  /** Blob URL of the recorded MP4. */
  url: string;
  seconds: number;
  kind: SegmentKind;
  slug: string;
  strap: string;
  kicker: string;
  program: string;
  strand: string;
  accent: string;
  location?: string;
  breaking?: boolean;
  author?: string;
  recordedAt: number;
}

export interface Manifest {
  segments: AiredSegment[];
  updatedAt: number;
}

/**
 * How much material the channel loops over.
 *
 * Long enough that a viewer does not notice the repeat inside a sitting, short
 * enough that yesterday's funding round is not still leading. Older segments
 * fall off the front as new ones arrive.
 */
export const WINDOW_SEGMENTS = 240;

/** Segments shorter than this were cut off mid-build and are not worth airing. */
const MIN_SECONDS = 3;

export function usableSegments(manifest: Manifest | null): AiredSegment[] {
  if (!manifest?.segments?.length) return [];
  return manifest.segments
    .filter((s) => s.url && s.seconds >= MIN_SECONDS)
    .sort((a, b) => a.recordedAt - b.recordedAt);
}

/**
 * What is on air right now, and how far into it we are.
 *
 * Position comes from the wall clock rather than from when a particular viewer
 * pressed play, which is the whole point: two people opening the channel a
 * minute apart are looking at the same frame, the way they would be if they had
 * turned on the same television.
 *
 * The epoch is fixed rather than derived from the manifest so that adding a
 * segment does not shift everyone who is already watching.
 */
const EPOCH = Date.UTC(2026, 0, 1);

export function nowPlaying(
  segments: AiredSegment[],
  now = Date.now(),
): { segment: AiredSegment; offset: number; index: number } | null {
  if (!segments.length) return null;

  const total = segments.reduce((sum, s) => sum + s.seconds, 0);
  if (total <= 0) return null;

  let cursor = ((now - EPOCH) / 1000) % total;
  if (cursor < 0) cursor += total;

  for (let i = 0; i < segments.length; i++) {
    if (cursor < segments[i].seconds) {
      return { segment: segments[i], offset: cursor, index: i };
    }
    cursor -= segments[i].seconds;
  }

  // Floating point drift at the very end of the loop.
  const last = segments.length - 1;
  return { segment: segments[last], offset: 0, index: last };
}

/** The segments queued behind the one on air, for the rundown rail. */
export function upNext(segments: AiredSegment[], index: number, count = 8): AiredSegment[] {
  if (!segments.length) return [];
  const out: AiredSegment[] = [];
  for (let i = 1; i <= count; i++) out.push(segments[(index + i) % segments.length]);
  return out;
}
