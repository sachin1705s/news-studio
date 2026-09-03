import type { Story } from "./types";

/**
 * Cutaway footage without a language model.
 *
 * The temptation is to build a shot out of the headline's own words, but that
 * fails exactly where cutaways matter: an abstraction ("suspends", "backs
 * takeover bid", "probe") has no picture in it, and a template that tries
 * produces literal nonsense. Broadcasters solved this long before AI — they cut
 * to generic, coherent library footage of the world the story lives in.
 *
 * So each strand carries a small library of real shots. They are not specific
 * to the story, and they are not pretending to be; they are correct, which is
 * the bar that matters. A key in the environment upgrades this to Claude
 * writing a shot for the actual headline.
 */
const LIBRARY: Record<string, string[]> = {
  bulletin: [
    "A wet city street at dusk, traffic passing, pedestrians crossing under streetlights",
    "A government building's stone facade, flags moving in wind, people climbing the steps",
    "A press room before a briefing, empty lectern, camera operators adjusting tripods",
    "A crowded pavement outside a station, commuters streaming past a newsstand",
    "An aerial drift over dense rooftops at golden hour, distant traffic threading through",
    "A police cordon tape moving in the breeze, blue lights flashing out of focus behind",
  ],
  screen: [
    "A darkened cinema auditorium, empty seats, projector light flickering across the rows",
    "A film set between takes, boom mic overhead, crew moving cables under hot lamps",
    "A red carpet at night, step-and-repeat board, camera flashes firing in bursts",
    "A living room in low light, a large television glowing, remote on the arm of a sofa",
    "A studio backlot street at dusk, facades and lighting rigs, a golf cart passing",
    "A row of editing suites, colour-graded footage on monitors, an editor scrubbing a timeline",
  ],
  markets: [
    "A trading floor, tiered screens flickering red and green, traders moving between desks",
    "A stock ticker wrapping a building exterior at night, numbers scrolling past",
    "A container port at first light, cranes lifting, stacked freight in long rows",
    "A shuttered high-street storefront, morning traffic reflected in the darkened window",
    "A warehouse aisle, forklift moving between racking, shrink-wrapped pallets stacked high",
    "A glass office tower lobby, workers crossing the atrium, turnstiles cycling",
  ],
  feed: [
    "Rows of servers behind glass, status lights flickering, a technician walking the aisle",
    "A circuit board in shallow focus, a probe moving across it under bright bench light",
    "A robotic arm on an assembly line repeating a precise movement under white light",
    "A phone screen held in one hand on a busy street, thumb scrolling, city out of focus",
    "A laboratory bench, gloved hands moving samples under a fume hood",
    "A satellite dish array against evening sky, dishes slowly tracking",
  ],
  courtside: [
    "An empty stadium at night, floodlights buzzing on, groundstaff marking the pitch",
    "A packed terrace erupting, scarves and flags lifting in unison",
    "A training ground at dawn, cones set out, breath visible in cold air",
    "A tunnel from the pitch, studs clattering on concrete, daylight at the far end",
    "A scoreboard clock ticking down, crowd blurred behind it",
    "An arena court being mopped under bright lights, empty seats rising into darkness",
  ],
};

/**
 * Pick a shot for a story, stable per story and spread across the library so a
 * block does not open the same wide six times running.
 */
export function stockShot(story: Story, strandId: string, offset = 0): string | undefined {
  const shelf = LIBRARY[strandId] ?? LIBRARY.bulletin;
  if (!shelf.length) return undefined;
  return shelf[(hash(story.id) + offset) % shelf.length];
}

/** Deterministic so a re-render or a retry does not change the picture mid-block. */
function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}
