export type Category =
  | "top"
  | "world"
  | "business"
  | "technology"
  | "science"
  | "sport"
  | "culture"
  | "television"
  | "startups";

export interface Story {
  id: string;
  title: string;
  summary: string;
  source: string;
  category: Category;
  link: string;
  publishedAt: number;
  /** The publisher's own lead image, when the feed item carries one. */
  image?: string;
  /** Set on stories that came from grounded search rather than an RSS feed. */
  live?: boolean;
}

/**
 * A single item on the rundown. One segment builds exactly one FastH3 clip.
 *
 * A story is covered as a package rather than a single clip: the anchor reads
 * the intro to camera, the pictures take over while the voice continues, and
 * the bigger stories then go to a correspondent on location. Every clip in a
 * package carries the same `packageId`, which is what lets the rundown rail
 * show the coverage as one item instead of the same headline three times.
 */
export type SegmentKind =
  | "open"
  | "story"
  | "broll"
  | "reporter"
  | "tag"
  | "bumper"
  | "viewer"
  | "signoff";

/**
 * How a cutaway is shot. A package that stays at eye level for two minutes
 * flattens; cutting between an aerial, the street and a close detail is what
 * gives a long story shape.
 */
export type Framing = "aerial" | "ground" | "interior" | "detail";

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
  /** Ties every clip covering one story together, for the rail and for counting. */
  packageId?: string;
  /** For a b-roll segment: what the footage shows, and how it is shot. */
  shot?: string;
  framing?: Framing;
  /** For a reporter segment: where they are standing, and what the place looks like. */
  location?: string;
  scene?: string;
  /** Runs the breaking band over the lower third. */
  breaking?: boolean;
  /** For a viewer segment: who is being quoted on air. */
  author?: string;
}

/** Lifecycle of a segment as it moves through the model's two queues. */
export type ClipPhase = "queued" | "building" | "ready" | "onair" | "played" | "failed";

export interface TrackedClip {
  clipId: string;
  segment: Segment;
  phase: ClipPhase;
  queuedAt: number;
}

/** One comment from the channel's audience. */
export interface Comment {
  id: string;
  author: string;
  text: string;
  at: number;
  /** Set once the anchor has read it on air, so it is not read twice. */
  readAt?: number;
}
