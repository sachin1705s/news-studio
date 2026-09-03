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
}

export const STRANDS: Record<string, Strand> = {
  bulletin: {
    id: "bulletin",
    name: "Bulletin",
    categories: ["top", "world"],
    kicker: "BREAKING",
    intro: "Now, the headlines.",
    lookFor: "news actuality — streets, buildings, crowds, officials at podiums",
  },
  screen: {
    id: "screen",
    name: "Screen Desk",
    categories: ["television", "culture"],
    kicker: "SCREEN DESK",
    intro: "Now to the Screen Desk, and what people are watching.",
    lookFor: "production and premiere imagery — sets, red carpets, screens, studio backlots",
  },
  markets: {
    id: "markets",
    name: "Markets",
    categories: ["business"],
    kicker: "MARKETS",
    intro: "To the markets now.",
    lookFor: "trading floors, tickers, logistics, storefronts, factory lines",
  },
  feed: {
    id: "feed",
    name: "The Feed",
    categories: ["technology", "science"],
    kicker: "THE FEED",
    intro: "And now, technology.",
    lookFor: "hardware, labs, data centres, devices in real use",
  },
  courtside: {
    id: "courtside",
    name: "Courtside",
    categories: ["sport"],
    kicker: "SPORT",
    intro: "Now the sport.",
    lookFor: "stadiums, arenas, training grounds, crowds",
  },
};

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
  const strand = STRANDS[rotation[block % rotation.length]];

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
