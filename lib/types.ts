export type Category =
  | "top"
  | "world"
  | "business"
  | "technology"
  | "science"
  | "sport"
  | "culture"
  | "television";

export interface Story {
  id: string;
  title: string;
  summary: string;
  source: string;
  category: Category;
  link: string;
  publishedAt: number;
}

/** A single item on the rundown. One segment builds exactly one FastH3 clip. */
export type SegmentKind = "open" | "story" | "broll" | "bumper" | "signoff";

export interface Segment {
  id: string;
  kind: SegmentKind;
  /** Lower-third headline text. */
  slug: string;
  /** The line the anchor must land. Never dropped, only trimmed as a last resort. */
  script: string;
  /** An extra sentence of context, spoken only when the clip is long enough to hold it. */
  detail?: string;
  /** Ticker/strap under the slug. */
  strap: string;
  story?: Story;
  programId: string;
  strandId: string;
  /** For a b-roll segment: what the footage shows. Written by Claude from the headline. */
  shot?: string;
}

/** Lifecycle of a segment as it moves through the model's two queues. */
export type ClipPhase = "queued" | "building" | "ready" | "onair" | "played" | "failed";

export interface TrackedClip {
  clipId: string;
  segment: Segment;
  phase: ClipPhase;
  queuedAt: number;
}
