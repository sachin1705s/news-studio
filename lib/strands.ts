import { SCHEDULE, type Program } from "./programs";
import type { Category } from "./types";

/**
 * Inside a daypart the channel runs short strands rather than one undifferentiated
 * hour of headlines: ten minutes of bulletin, ten of the screen desk, ten of
 * markets. The daypart still sets the anchor's register and the set; the strand
 * decides what the block is actually about.
 */
export const STRAND_MINUTES = 10;

export interface Strand {
  id: string;
  name: string;
  /** Overrides the daypart's feeds for the length of the block. */
  categories: Category[];
  /** Lower-third kicker while this strand is on air. */
  kicker: string;
  /** How the anchor hands into the block. */
  intro: string;
  /** Steers the footage: what this subject tends to look like. */
  lookFor: string;
  /**
   * What the live desk searches the web for during this block, one angle per
   * refill. Asking the same question every time returns the same answers, so
   * each strand carries several and rotates through them.
   */
  searchAngles: string[];
}

export const STRANDS: Record<string, Strand> = {
  startups: {
    id: "startups",
    name: "Startup Desk",
    // Deliberately wide. A desk that only pulls startup feeds becomes a
    // funding wire; the block should carry a raise, a policy story and a
    // launch side by side.
    categories: ["startups", "technology", "business", "science"],
    kicker: "STARTUPS",
    intro: "This is R24. Now, the startup desk.",
    lookFor:
      "founders and operators at work — small offices, warehouses, workshops, laptops on shared desks, city business districts",
    searchAngles: [
      "startup funding rounds and new raises announced today",
      "startup acquisitions, exits and IPO filings this week",
      "AI product launches from startups",
      "venture capital fund closes and new funds",
      "startup shutdowns, layoffs and down rounds",
      "founder moves and notable hires at technology companies",
    ],
  },
  bulletin: {
    id: "bulletin",
    name: "Bulletin",
    categories: ["top", "world"],
    kicker: "BREAKING",
    intro: "Now, the headlines.",
    lookFor: "news actuality — streets, buildings, crowds, officials at podiums",
    searchAngles: [
      "top world news headlines today",
      "breaking international news in the last few hours",
      "major political developments today",
      "government policy announcements today",
    ],
  },
  screen: {
    id: "screen",
    name: "Screen Desk",
    categories: ["television", "culture"],
    kicker: "SCREEN DESK",
    intro: "Now to the Screen Desk, and what people are watching.",
    lookFor: "production and premiere imagery — sets, red carpets, screens, studio backlots",
    searchAngles: [
      "television and streaming news, renewals and cancellations",
      "film and series premieres announced this week",
      "box office and streaming viewership news",
      "casting and production news in film and television",
    ],
  },
  markets: {
    id: "markets",
    name: "Markets",
    categories: ["business"],
    kicker: "MARKETS",
    intro: "To the markets now.",
    lookFor: "trading floors, tickers, logistics, storefronts, factory lines",
    searchAngles: [
      "stock market moves and index performance today",
      "company earnings reported today",
      "central bank and interest rate news",
      "commodity and currency market news today",
    ],
  },
  feed: {
    id: "feed",
    name: "The Feed",
    categories: ["technology", "science"],
    kicker: "THE FEED",
    intro: "And now, technology.",
    lookFor: "hardware, labs, data centres, devices in real use",
    searchAngles: [
      "artificial intelligence research and model releases",
      "consumer technology product launches this week",
      "science research findings published this week",
      "space missions and astronomy news",
    ],
  },
  courtside: {
    id: "courtside",
    name: "Courtside",
    categories: ["sport"],
    kicker: "SPORT",
    intro: "Now the sport.",
    lookFor: "stadiums, arenas, training grounds, crowds",
    searchAngles: [
      "sports results from today",
      "football transfer news and signings",
      "major tournament and championship news",
      "athlete injury and squad news today",
    ],
  },
};

/**
 * The block the channel opens on, whatever the clock says.
 *
 * A rolling channel joined mid-block starts the viewer in the middle of a
 * subject they did not choose. Opening on the startup desk gives the channel a
 * front door: the first block after take-air is always startups and technology,
 * and the clock wheel resumes from the block after it.
 *
 * It is a window rather than a flag that the first refill consumes. The deck
 * and the on-screen schedule both have to agree about what is on air for the
 * whole ten minutes, and a flag cleared by whichever of them read it first
 * left the two disagreeing for the rest of the block.
 */
export const OPENING_STRAND = "startups";

/** Whether the opening block is still running at this instant. */
export function openingActive(openingUntil: number | null, now = Date.now()): boolean {
  return openingUntil !== null && now < openingUntil;
}

/** The block on air, honouring the opening window before the clock wheel. */
export function strandOnAir(openingUntil: number | null, now = new Date()) {
  const scheduled = strandAt(now);
  if (openingActive(openingUntil, now.getTime())) {
    return { ...scheduled, strand: STRANDS[OPENING_STRAND] ?? scheduled.strand };
  }
  return scheduled;
}

/** Which strand is on air at a given instant, and the block it belongs to. */
export function strandAt(now: Date): {
  program: Program;
  strand: Strand;
  startsAt: Date;
  endsAt: Date;
} {
  const program = programAt(now);
  const block = Math.floor((now.getHours() * 60 + now.getMinutes()) / STRAND_MINUTES);
  const rotation = program.strands;
  const strand = STRANDS[rotation[block % rotation.length]] ?? STRANDS.bulletin;

  const startsAt = new Date(now);
  startsAt.setHours(0, block * STRAND_MINUTES, 0, 0);
  const endsAt = new Date(startsAt.getTime() + STRAND_MINUTES * 60_000);

  return { program, strand, startsAt, endsAt };
}

/** The next few blocks, for the on-screen rail. Crosses daypart boundaries correctly. */
export function upcomingStrands(now: Date, count = 6) {
  const out: ReturnType<typeof strandAt>[] = [];
  const first = strandAt(now);
  out.push(first);
  for (let i = 1; i < count; i++) {
    const at = new Date(first.startsAt.getTime() + i * STRAND_MINUTES * 60_000);
    out.push(strandAt(at));
  }
  return out;
}

/** The daypart covering an instant. Wraps through midnight to the last block. */
export function programAt(now: Date): Program {
  const h = now.getHours();
  let pick = SCHEDULE[SCHEDULE.length - 1];
  for (const p of SCHEDULE) if (p.startHour <= h) pick = p;
  return pick;
}
