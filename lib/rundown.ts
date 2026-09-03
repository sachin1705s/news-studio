import type { ProducedItem } from "./newsroom";
import type { Program } from "./programs";
import { trimDangling } from "./prompt";
import type { Strand } from "./strands";
import type { Framing, Segment, Story } from "./types";

/**
 * Turn wire stories into an ordered rundown for one strand.
 *
 * A story is covered as a package, the way a bulletin actually does it: the
 * anchor reads the introduction to camera, the pictures take over while the
 * voice continues underneath, and the stories worth travelling for then go to
 * a correspondent standing in the place it happened. Every clip in a package
 * shares a `packageId`, so the rail shows one story rather than the same
 * headline three times.
 */
const STORIES_PER_BLOCK = 3;

export function buildRundown(
  stories: Story[],
  program: Program,
  strand: Strand,
  cycle: number,
  produced: Map<string, ProducedItem>,
): Segment[] {
  const segments: Segment[] = [];
  const key = (n: string) => `${program.id}-${strand.id}-${cycle}-${n}`;
  const base = { programId: program.id, strandId: strand.id };

  const leadRead = readFor(stories[0], produced, true);

  // The open teases the lead, but only when the tease is not the read that
  // follows it thirty seconds later. Hearing the same sentence twice is the
  // fastest way to sound automated, so the tease is dropped rather than risked.
  const tease = stories[0] ? endSentence(clause(stripTail(stories[0].title), 11)) : "";
  const openScript =
    tease && !tooSimilar(tease, leadRead)
      ? `${strand.intro} ${program.leadIn}: ${tease}`
      : `${strand.intro} ${program.strap}.`;

  segments.push({
    ...base,
    id: key("open"),
    kind: "open",
    slug: strand.name.toUpperCase(),
    strap: program.strap,
    script: openScript.replace(/\s+/g, " ").trim(),
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

    const item = produced.get(story.id);
    const packageId = key(`pkg-${i}`);
    const strap = `${story.source} · ${relative(story.publishedAt)}`;
    const read = readFor(story, produced, i === 0);
    const breaking = Boolean(item?.breaking);

    segments.push({
      ...base,
      id: key(`story-${i}`),
      kind: "story",
      packageId,
      slug: story.title,
      strap,
      story,
      breaking,
      script: read,
    });

    // The cutaways. A feature runs several, each carrying the script a step
    // further; a brief runs one, or none at all when the only line available
    // repeats what was just said — silence beats an echo.
    const spoken = [read];
    for (const cut of cutawaysFor(story, item, spoken)) {
      segments.push({
        ...base,
        id: key(`broll-${i}-${segments.length}`),
        kind: "broll",
        packageId,
        slug: story.title,
        strap,
        story,
        shot: cut.shot,
        framing: cut.framing,
        breaking,
        script: cut.script,
      });
      spoken.push(cut.script);
    }

    const reporter = item?.reporter;
    if (reporter?.standup && reporter.scene && !spoken.some((line) => tooSimilar(reporter.standup, line))) {
      segments.push({
        ...base,
        id: key(`rep-${i}`),
        kind: "reporter",
        packageId,
        slug: story.title,
        strap: reporter.location,
        story,
        location: reporter.location,
        scene: reporter.scene,
        breaking,
        script: reporter.standup,
      });
      spoken.push(reporter.standup);
    }

    // The long treatment comes back to the desk to land the story. Without the
    // tag a three-minute package just stops, which reads as a dropped feed.
    const tag = item?.tag?.trim();
    if (item?.treatment === "long" && tag && !spoken.some((line) => tooSimilar(tag, line))) {
      segments.push({
        ...base,
        id: key(`tag-${i}`),
        kind: "tag",
        packageId,
        slug: story.title,
        strap,
        story,
        breaking,
        script: endSentence(tag),
      });
    }
  });

  return segments;
}

/** The anchor's introduction: the producer's line when there is one, the headline when there is not. */
function readFor(
  story: Story | undefined,
  produced: Map<string, ProducedItem>,
  isLead: boolean,
): string {
  if (!story) return "";
  const written = produced.get(story.id)?.read?.trim();
  if (written) return isLead ? `Our top story. ${endSentence(written)}` : endSentence(written);
  return `${isLead ? "Our top story. " : ""}${endSentence(stripTail(story.title))}`;
}

/**
 * How many cutaways each treatment is allowed.
 *
 * The producer is asked for these counts, but the counts are enforced here:
 * a story told at the wrong length is worse than a story told plainly, and a
 * chatty producer must not be able to run three minutes on a passing mention.
 */
const MAX_CUTS: Record<string, number> = { short: 1, medium: 2, long: 4 };

/**
 * The cutaways a story gets, with the line spoken over each.
 *
 * Nothing goes to air that repeats a line already spoken in the package. The
 * guard runs against everything said so far, not just the anchor's
 * introduction, because the fourth shot echoing the second is the same failure
 * as the first echoing the read.
 */
function cutawaysFor(
  story: Story,
  item: ProducedItem | undefined,
  spoken: string[],
): { shot: string; script: string; framing?: Framing }[] {
  const echoes = (line: string) => spoken.some((prior) => tooSimilar(line, prior));
  const out: { shot: string; script: string; framing?: Framing }[] = [];

  const limit = MAX_CUTS[item?.treatment ?? "medium"] ?? 3;
  const cuts = item?.cuts ?? [];

  if (cuts.length) {
    const said: string[] = [];
    for (const cut of cuts) {
      if (out.length >= limit) break;
      const shot = cut?.shot?.trim();
      const line = cut?.voiceover?.trim();
      if (!shot || !line) continue;
      if (echoes(line) || said.some((prior) => tooSimilar(line, prior))) continue;
      said.push(line);
      out.push({ shot, script: endSentence(line), framing: cut.framing });
    }
    if (out.length) return out;
  }

  // No producer reachable. The library supplies one picture and the wire copy
  // supplies the line — but only when that line says something the read did not,
  // because wire copy usually restates its own headline.
  const shot = item?.shot;
  if (!shot || !story.summary) return out;

  const first = endSentence(firstSentence(story.summary));
  if (!echoes(first)) return [{ shot, script: first }];

  const rest = story.summary.slice(firstSentence(story.summary).length).trim();
  if (rest) {
    const second = endSentence(firstSentence(rest));
    if (second.split(/\s+/).length > 5 && !echoes(second)) return [{ shot, script: second }];
  }
  return out;
}

/**
 * Do these two lines say the same thing?
 *
 * Content-word overlap, not string distance: "Adobe acquires Rilo" and "Adobe
 * has acquired the AI startup Rilo" share almost no characters in order but are
 * plainly the same sentence on air.
 */
export function tooSimilar(a: string, b: string, threshold = 0.5): boolean {
  const setA = contentWords(a);
  const setB = contentWords(b);
  if (setA.size < 3 || setB.size < 3) return false;

  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared += 1;
  // Against the smaller set: a short tease fully contained in a longer read is
  // a repeat, even though it covers little of it.
  return shared / Math.min(setA.size, setB.size) >= threshold;
}

const STOPWORDS = new Set(
  "a an the and or but of to in on at by for from with into over under after before as that which who is are was were has have had its his her their this these those about between during per than then so we our you it they he she will would can could says said new more most first also up out".split(
    " ",
  ),
);

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      // Crude stemming so "acquires" and "acquired" count as the same word.
      .map((w) => w.replace(/(ing|ed|es|s)$/, "")),
  );
}

/** Stories the producer needs to write, paired back by id. */
export function headlinesFor(stories: Story[]): Story[] {
  return stories.filter((s) => s.summary || s.live);
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
