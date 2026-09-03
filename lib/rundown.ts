import type { Program } from "./programs";
import { trimDangling } from "./prompt";
import type { Segment, Story } from "./types";

/**
 * Turn a pile of wire stories into an ordered rundown for one program block.
 *
 * The shape is the one a real bulletin uses: a program open, then story
 * packages in blocks of three separated by a station bumper, and a sign-off at
 * the end of the wheel. Each item becomes exactly one FastH3 clip.
 */
const STORIES_PER_BLOCK = 3;

export function buildRundown(stories: Story[], program: Program, cycle: number): Segment[] {
  const segments: Segment[] = [];
  const key = (n: string) => `${program.id}-${cycle}-${n}`;

  segments.push({
    id: key("open"),
    kind: "open",
    slug: program.name.toUpperCase(),
    strap: program.strap,
    programId: program.id,
    script: openLine(program, stories[0]),
  });

  stories.forEach((story, i) => {
    if (i > 0 && i % STORIES_PER_BLOCK === 0) {
      segments.push({
        id: key(`bump-${i}`),
        kind: "bumper",
        slug: "COMING UP",
        strap: program.strap,
        programId: program.id,
        script: bumperLine(stories.slice(i, i + STORIES_PER_BLOCK)),
      });
    }
    segments.push({
      id: key(`story-${i}`),
      kind: "story",
      slug: story.title,
      strap: `${story.source} · ${relative(story.publishedAt)}`,
      story,
      programId: program.id,
      script: storyLine(story, i === 0),
      detail: story.summary ? endSentence(firstSentence(story.summary)) : undefined,
    });
  });

  segments.push({
    id: key("signoff"),
    kind: "signoff",
    slug: program.name.toUpperCase(),
    strap: "Coverage continues",
    programId: program.id,
    script: `That is the latest from the newsroom. ${program.name} continues after this.`,
  });

  return segments;
}

function openLine(program: Program, lead?: Story): string {
  const hook = lead ? ` ${program.leadIn}: ${endSentence(clause(stripTail(lead.title), 11))}` : "";
  return `Live from the newsroom, this is ${program.name}.${hook}`;
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
