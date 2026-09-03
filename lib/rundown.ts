import type { Program } from "./programs";
import { trimDangling } from "./prompt";
import type { Strand } from "./strands";
import type { Segment, Story } from "./types";

/**
 * Turn wire stories into an ordered rundown for one ten-minute strand.
 *
 * Stories that carry a summary and a shot description run as a package, the way
 * a real bulletin does it: the anchor reads the intro to camera, then the
 * pictures take over while their voice continues underneath. Stories without
 * both stay as a straight anchor read rather than cutting to invented footage.
 */
const STORIES_PER_BLOCK = 3;

export function buildRundown(
  stories: Story[],
  program: Program,
  strand: Strand,
  cycle: number,
  shots: Map<string, string>,
): Segment[] {
  const segments: Segment[] = [];
  const key = (n: string) => `${program.id}-${strand.id}-${cycle}-${n}`;
  const base = { programId: program.id, strandId: strand.id };

  segments.push({
    ...base,
    id: key("open"),
    kind: "open",
    slug: strand.name.toUpperCase(),
    strap: program.strap,
    script: `${strand.intro} ${stories[0] ? `${program.leadIn}: ${endSentence(clause(stripTail(stories[0].title), 11))}` : ""}`.trim(),
  });

  stories.forEach((story, i) => {
    if (i > 0 && i % STORIES_PER_BLOCK === 0) {
      segments.push({
        ...base,
        id: key(`bump-${i}`),
        kind: "bumper",
        slug: "COMING UP",
        strap: program.strap,
        script: bumperLine(stories.slice(i, i + STORIES_PER_BLOCK)),
      });
    }

    const shot = shots.get(story.id);
    const detail = story.summary ? endSentence(firstSentence(story.summary)) : undefined;

    segments.push({
      ...base,
      id: key(`story-${i}`),
      kind: "story",
      slug: story.title,
      strap: `${story.source} · ${relative(story.publishedAt)}`,
      story,
      script: storyLine(story, i === 0),
      // The context sentence moves to the b-roll when there is one to move it to.
      detail: shot && detail ? undefined : detail,
    });

    if (shot && detail) {
      segments.push({
        ...base,
        id: key(`broll-${i}`),
        kind: "broll",
        slug: story.title,
        strap: `${story.source} · ${relative(story.publishedAt)}`,
        story,
        shot,
        script: detail,
      });
    }
  });

  return segments;
}

/** Headlines the b-roll writer needs, paired back by story id. */
export function headlinesFor(stories: Story[]): { id: string; text: string }[] {
  return stories
    .filter((s) => s.summary)
    .map((s) => ({ id: s.id, text: stripTail(s.title) }));
}

function storyLine(story: Story, isLead: boolean): string {
  const lead = isLead ? "Our top story. " : "";
  return `${lead}${endSentence(stripTail(story.title))}`;
}

function bumperLine(next: Story[]): string {
  const titles = next.slice(0, 2).map((s) => clause(stripTail(s.title), 8).replace(/[.!?]+$/, ""));
  if (!titles.length) return "Still to come, more from the newsroom.";
  return `Still to come: ${titles.join(", and ")}.`;
}

/**
 * Cut a headline down to a speakable fragment. A natural clause break — comma,
 * dash, colon — beats a word count, so it is preferred whenever one falls in a
 * usable place.
 */
export function clause(title: string, maxWords: number): string {
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return title;

  const brk = title.search(/[,:]|\s[-–—]\s/);
  if (brk > 0) {
    const head = title.slice(0, brk).trim();
    const headWords = head.split(/\s+/).length;
    if (headWords >= 4 && headWords <= maxWords) return head;
  }
  return trimDangling(words.slice(0, maxWords)).join(" ").replace(/[,;:\-–—]+$/, "");
}

/** Wire headlines already end in "?" or "!" as often as not; don't stack a full stop on top. */
export function endSentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** Wire titles carry a source suffix: "Headline - BBC News". Drop it. */
export function stripTail(title: string): string {
  return title
    .replace(/\s+[-–|]\s+[A-Z][A-Za-z.& ]{2,30}$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const m = clean.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : clean).trim();
}

export function relative(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
