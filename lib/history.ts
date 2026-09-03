/**
 * What this browser has already watched.
 *
 * Without this, a refresh is a rewind: the story history lives in a ref, the
 * block counter restarts at zero, and the channel deals the same opening block
 * it dealt a minute ago. That is the single thing that makes a rolling channel
 * feel like a loop.
 *
 * So the history outlives the page. A reload picks up where the viewer left
 * off — stories already broadcast stay retired, the block counter keeps
 * climbing, and the pinned opener does not re-introduce itself to someone who
 * has been watching for an hour.
 *
 * It is per-browser rather than shared, which is the right scope: it answers
 * "what has this viewer already seen", not "what has the channel aired".
 */

const KEY = "r24.history.v1";

/** Stories are let back in after this long. Matches the deck's retirement window. */
const RETIRE_MS = 6 * 60 * 60 * 1000;

/** A gap longer than this and the channel may introduce itself again. */
const REINTRODUCE_AFTER_MS = 3 * 60 * 60 * 1000;

interface Stored {
  /** Story id -> when it last went to air. */
  aired: Record<string, number>;
  /** Keeps climbing across reloads so block ordering advances. */
  cycle: number;
  /** When the pinned opener last ran. */
  pinnedAt?: number;
  /** When this browser last had the channel on. */
  seenAt?: number;
}

const EMPTY: Stored = { aired: {}, cycle: 0 };

function read(): Stored {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Stored;
    return {
      aired: parsed.aired ?? {},
      cycle: typeof parsed.cycle === "number" ? parsed.cycle : 0,
      pinnedAt: parsed.pinnedAt,
      seenAt: parsed.seenAt,
    };
  } catch {
    // A private window, cleared site data, or storage the browser refuses to
    // hand over. The channel runs fine without it, it just forgets.
    return EMPTY;
  }
}

function write(value: Stored): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Quota or a blocked store. Nothing here is worth failing a broadcast over.
  }
}

/** Everything still retired, as the map the deck works with. */
export function loadAired(now = Date.now()): Map<string, number> {
  const stored = read();
  const out = new Map<string, number>();
  for (const [id, at] of Object.entries(stored.aired)) {
    if (now - at <= RETIRE_MS) out.set(id, at);
  }
  return out;
}

export function saveAired(aired: Map<string, number>, now = Date.now()): void {
  const stored = read();
  const kept: Record<string, number> = {};
  for (const [id, at] of aired) {
    if (now - at <= RETIRE_MS) kept[id] = at;
  }
  write({ ...stored, aired: kept, seenAt: now });
}

/**
 * The block number to carry on from.
 *
 * Ordering is seeded on this, so resuming at the next number is what stops a
 * reload dealing the same block again.
 */
export function nextCycle(): number {
  const stored = read();
  const cycle = stored.cycle + 1;
  write({ ...stored, cycle });
  return cycle;
}

/**
 * Should the channel open on the pinned story?
 *
 * Only for a viewer who has not been watching recently. Someone refreshing
 * mid-session has already heard it, and hearing it again is exactly the repeat
 * this is all meant to avoid.
 */
export function shouldRunPinned(now = Date.now()): boolean {
  const { pinnedAt } = read();
  return !pinnedAt || now - pinnedAt > REINTRODUCE_AFTER_MS;
}

export function markPinnedRun(now = Date.now()): void {
  write({ ...read(), pinnedAt: now });
}
