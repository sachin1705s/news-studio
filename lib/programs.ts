import type { Category } from "./types";

export interface Program {
  id: string;
  name: string;
  /** Local hour the program takes air. Blocks run until the next one starts. */
  startHour: number;
  categories: Category[];
  /** Drives the anchor's read: pace, warmth, register. */
  tone: string;
  /** Set + lighting. Used in full when no anchor still is loaded, as accent when one is. */
  set: string;
  /** Music bed and room sound for this daypart. */
  bed: string;
  /** Strap line under the lower third. */
  strap: string;
  /** How the program open introduces its lead story at this hour. */
  leadIn: string;
  accent: string;
}

/**
 * A 24-hour wheel. `currentProgram` picks the block whose start hour is the
 * latest one at or before now, wrapping through midnight.
 */
export const SCHEDULE: Program[] = [
  {
    id: "overnight",
    leadIn: "Overnight",
    name: "Overnight Wire",
    startHour: 0,
    categories: ["world", "top"],
    tone: "low, unhurried, steady late-night register",
    set: "a dim overnight news studio, one warm key light on the desk, the rest of the room in shadow, a dark blue video wall behind",
    bed: "quiet room tone, the faint hum of studio air conditioning, a sparse low synth pad",
    strap: "Rolling coverage through the night",
    accent: "#4f7cff",
  },
  {
    id: "morning",
    leadIn: "This morning",
    name: "Morning Brief",
    startHour: 5,
    categories: ["top", "world", "business"],
    tone: "bright, brisk, awake and welcoming",
    set: "a bright morning news studio, cool daylight through a window wall, a pale desk, a city skyline on the screen behind",
    bed: "light room tone, a soft optimistic piano and strings bed, distant newsroom murmur",
    strap: "Your first look at the day",
    accent: "#ff9e3d",
  },
  {
    id: "markets",
    leadIn: "At the open",
    name: "Markets Open",
    startHour: 9,
    categories: ["business", "technology"],
    tone: "quick, precise, clipped financial delivery",
    set: "a financial news studio, a wall of green and red ticker boards behind the desk, hard white key light",
    bed: "busy trading-floor murmur, keyboard clatter, a tense percussive underscore",
    strap: "Markets, moves and money",
    accent: "#37d67a",
  },
  {
    id: "midday",
    leadIn: "Our lead at midday",
    name: "Midday Bulletin",
    startHour: 12,
    categories: ["top", "world"],
    tone: "even, neutral, authoritative bulletin read",
    set: "a clean flagship news studio, a curved glass desk, a wide blue video wall, even broadcast lighting",
    bed: "controlled studio silence, a low sustained news bed, a faint gallery talkback murmur",
    strap: "The headlines at midday",
    accent: "#4f7cff",
  },
  {
    id: "thefeed",
    leadIn: "Today",
    name: "The Feed",
    startHour: 14,
    categories: ["technology", "science"],
    tone: "curious, conversational, a shade faster than a bulletin read",
    set: "a modern tech-desk studio, magenta and cyan strip lighting, a matte black desk, code and charts drifting on the screen behind",
    bed: "clean room tone, a bright electronic pulse bed, soft interface blips",
    strap: "Technology, science and the internet",
    accent: "#c86bff",
  },
  {
    id: "evening",
    leadIn: "Tonight",
    name: "Evening Edition",
    startHour: 17,
    categories: ["top", "world", "business"],
    tone: "warm, weighted, measured evening-anchor gravity",
    set: "a flagship evening news studio, deep amber and blue key lights, a dark polished desk, a dusk skyline on the wall behind",
    bed: "still studio air, a slow cinematic string bed, a distant newsroom hum",
    strap: "The day, told in full",
    accent: "#ff6b4f",
  },
  {
    id: "crosstalk",
    leadIn: "Tonight",
    name: "The Crosstalk",
    startHour: 20,
    categories: ["culture", "sport"],
    tone: "relaxed, wry, conversational",
    set: "a softer late studio, warm lamps, a low couch-height desk, a muted amber wall behind",
    bed: "loose room tone, a laid-back brushed-drum and upright bass bed",
    strap: "Culture, sport and the long read",
    accent: "#ffd23d",
  },
  {
    id: "nightdesk",
    leadIn: "Tonight",
    name: "Night Desk",
    startHour: 22,
    categories: ["top", "science", "world"],
    tone: "calm, quiet, close to the microphone",
    set: "a near-empty night studio, a single pool of light on the anchor, the newsroom dark and out of focus behind",
    bed: "deep room tone, a slow ambient drone, the occasional far-off phone ring",
    strap: "Last word before the wire resets",
    accent: "#7a8cff",
  },
];

export function currentProgram(now = new Date()): Program {
  const h = now.getHours();
  let pick = SCHEDULE[SCHEDULE.length - 1];
  for (const p of SCHEDULE) if (p.startHour <= h) pick = p;
  return pick;
}

/** The schedule rendered forward from now, for the on-screen programme rail. */
export function upcoming(now = new Date(), count = 5) {
  const cur = currentProgram(now);
  const i = SCHEDULE.findIndex((p) => p.id === cur.id);
  const out: { program: Program; startsAt: Date; live: boolean }[] = [];
  for (let n = 0; n < count; n++) {
    const p = SCHEDULE[(i + n) % SCHEDULE.length];
    const d = new Date(now);
    d.setHours(p.startHour, 0, 0, 0);
    // Anything at or before the current block that we have already wrapped past belongs to tomorrow.
    if (n > 0 && p.startHour <= cur.startHour) d.setDate(d.getDate() + 1);
    out.push({ program: p, startsAt: d, live: n === 0 });
  }
  return out;
}
