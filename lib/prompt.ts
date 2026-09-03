import type { Program } from "./programs";
import type { Segment } from "./types";

export const PROMPT_LIMIT = 800;

/**
 * Words the anchor can actually land inside a clip of this length. FastH3 reads
 * at a broadcast pace; overshooting the budget gets the line cut off mid-word at
 * the clip boundary, so the script is trimmed to fit rather than the clip stretched.
 */
const WORDS_PER_SECOND = 2.3;
/** Leading and trailing frames go to the anchor settling and the cut. */
const HEAD_TAIL_SECONDS = 1.6;

/**
 * Clip lengths the channel is allowed to ask for.
 *
 * A length the deployment has not built before pays a one-off compile cost, so
 * this is a short fixed set rather than a number computed per clip.
 *
 * Cutaways are the long ones on purpose. A shot needs time to be footage rather
 * than a glimpse — the eye has to find the subject before the movement in it
 * means anything — and the b-roll is where the story's detail is spoken, so it
 * has more to carry than the anchor's one-line introduction.
 */
export const CLIP_TIERS = {
  /** Bumpers, links and viewer mail. */
  brief: 6.5,
  /** The anchor's read to camera. */
  read: 9.5,
  /** Cutaways and correspondent standups. */
  footage: 11.0,
} as const;

export function wordBudget(clipSeconds: number): number {
  return Math.max(6, Math.floor((clipSeconds - HEAD_TAIL_SECONDS) * WORDS_PER_SECOND));
}

/**
 * How long this particular clip should run.
 *
 * Length follows the job the clip is doing. A cutaway carrying the story's
 * detail gets the model's longest clip; a bumper reading two headlines does
 * not need it and burns GPU time it cannot fill.
 */
export function clipSecondsFor(segment: Segment, sessionDefault: number): number {
  switch (segment.kind) {
    case "broll":
    case "reporter":
      return CLIP_TIERS.footage;
    case "bumper":
    case "viewer":
      return CLIP_TIERS.brief;
    case "tag":
    default:
      return sessionDefault || CLIP_TIERS.read;
  }
}

/**
 * How each framing is actually shot.
 *
 * The framing is the difference between a package that moves and one that sits
 * at eye level for two minutes, so it is spent on camera language rather than
 * on more description of the subject.
 */
const FRAMING: Record<string, string> = {
  aerial:
    "Aerial helicopter shot looking down, the camera flying slowly forward and banking, the ground far below",
  ground: "Street-level handheld news camera, slight movement, people passing",
  interior: "Handheld interior shot, available light through windows, the camera drifting slowly",
  detail: "Tight close shot, shallow focus, the camera easing in on one small movement",
};

/**
 * Words that leave a line hanging when a trim lands on them. Cutting after
 * "on US currency in" reads as a dropped feed; cutting after "currency" reads
 * as an edit.
 */
const DANGLING =
  /^(a|an|the|and|or|but|of|to|in|on|at|by|for|from|with|into|over|under|after|before|as|that|which|who|is|are|was|were|has|have|had|its|his|her|their|this|these|those|about|between|during|per|than|then|so)$/i;

export function trimDangling(words: string[]): string[] {
  const out = [...words];
  while (out.length > 3 && DANGLING.test(out[out.length - 1].replace(/[^A-Za-z]/g, ""))) out.pop();
  return out;
}

/** Trim to a whole number of words, never mid-word, and close the sentence. */
export function fitWords(text: string, budget: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= budget) return words.join(" ");
  const kept = trimDangling(words.slice(0, budget)).join(" ").replace(/[,;:\-–—]+$/, "");
  return /[.!?]$/.test(kept) ? kept : `${kept}.`;
}

/**
 * Fit the segment into the clip's word budget.
 *
 * The headline is the line that has to land, so the context sentence is either
 * spoken in full or dropped in full — half a sentence cut off at the clip
 * boundary reads worse than no sentence at all. Only a headline that overruns
 * the budget on its own gets trimmed.
 */
function composeScript(segment: Segment, budget: number): string {
  const lead = segment.script.trim();
  const leadWords = countWords(lead);
  if (leadWords > budget) return fitWords(lead, budget);
  if (segment.detail) {
    const combined = `${lead} ${segment.detail.trim()}`;
    if (countWords(combined) <= budget) return combined;
  }
  return lead;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Quotes inside the script would terminate the quoted line in the prompt. */
function sanitiseScript(s: string): string {
  return s
    .replace(/["“”]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the clip prompt.
 *
 * Two modes, per the model's prompt guide: with a starting frame the still
 * already carries the set, so the prompt spends its characters on motion and
 * sound; without one it has to describe the whole scene every time, because
 * clips share no memory.
 */
export function buildPrompt(
  segment: Segment,
  program: Program,
  clipSeconds: number,
  hasAnchorStill: boolean,
): string {
  const script = sanitiseScript(composeScript(segment, wordBudget(clipSeconds)));

  if (segment.kind === "broll" && segment.shot) {
    return buildBrollPrompt(segment, script, program, clipSeconds);
  }
  if (segment.kind === "reporter" && segment.scene) {
    return buildReporterPrompt(segment, script, program, clipSeconds);
  }

  const audio = `Audio: ${program.bed}; the anchor's voice close and dry on a broadcast microphone.`;

  const parts = hasAnchorStill
    ? [
        `The anchor in the frame begins speaking straight to camera, small natural head movements, blinking, one measured hand gesture on the desk.`,
        `Locked medium shot, no camera move.`,
        `S1 (the anchor, ${program.tone}): "${script}"`,
        audio,
      ]
    : [
        `${cap(program.set)}.`,
        `A news anchor in a dark suit sits at the desk facing camera, hands resting on the desk, an earpiece visible.`,
        `Locked medium shot, no camera move.`,
        `S1 (the anchor, ${program.tone}): "${script}"`,
        audio,
      ];

  let prompt = parts.join(" ").replace(/\s+/g, " ").trim();

  // Hard cap. Drop the set clause first, then re-trim the script, so the spoken
  // line survives intact for as long as possible.
  if (prompt.length > PROMPT_LIMIT) {
    prompt = [parts[0], parts[parts.length - 2], audio].join(" ").replace(/\s+/g, " ").trim();
  }
  if (prompt.length > PROMPT_LIMIT) {
    const overflow = prompt.length - PROMPT_LIMIT;
    const shorter = fitWords(script, Math.max(6, wordBudget(clipSeconds) - Math.ceil(overflow / 5)));
    prompt = prompt.replace(script, shorter);
  }
  return prompt.slice(0, PROMPT_LIMIT);
}

/**
 * The cutaway.
 *
 * The anchor is not in this shot — they are heard over it. The prompt has to
 * say that plainly, because a model given a news script and no instruction will
 * put a presenter back in frame. Everything the picture needs comes from the
 * shot description; everything the sound needs is the voiceover plus the
 * location's own atmosphere, which replaces the studio bed for these seconds.
 *
 * These clips run the model's full length, so the shot is asked to develop
 * rather than hold: a fourteen-second static frame reads as a freeze.
 */
function buildBrollPrompt(
  segment: Segment,
  script: string,
  program: Program,
  clipSeconds: number,
): string {
  const shotText = (segment.shot ?? "").replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
  const look = FRAMING[segment.framing ?? "ground"] ?? FRAMING.ground;
  const parts = [
    `Documentary news footage, no presenter on screen, no lettering, no signage, no text or graphics anywhere in frame:`,
    `${cap(shotText)}.`,
    `${look}.`,
    `The shot develops across its full length: continuous movement, never a held frame.`,
    `S1 (an unseen news anchor, voiceover over the footage, ${program.tone}): "${script}"`,
    `Audio: the location's own atmosphere under the voice; no studio music.`,
  ];

  let prompt = parts.join(" ").replace(/\s+/g, " ").trim();
  if (prompt.length > PROMPT_LIMIT) {
    // The development clause goes first; the framing and the voice do not.
    prompt = [parts[0], parts[1], parts[2], parts[4], parts[5]].join(" ").replace(/\s+/g, " ").trim();
  }
  if (prompt.length > PROMPT_LIMIT) {
    prompt = [parts[0], parts[1], parts[4], parts[5]].join(" ").replace(/\s+/g, " ").trim();
  }
  if (prompt.length > PROMPT_LIMIT) {
    const shorter = fitWords(script, Math.max(6, wordBudget(clipSeconds) - 8));
    prompt = prompt.replace(script, shorter);
  }
  return prompt.slice(0, PROMPT_LIMIT);
}

/**
 * The correspondent.
 *
 * The one shot in the channel that is neither the studio nor silent footage: a
 * person on location, talking to camera, with the place audible behind them.
 * It is what separates a bulletin being read from a story being covered, so the
 * prompt spends its characters on the two things that sell it — that the
 * reporter is outdoors holding a microphone, and that the location has its own
 * noise.
 */
function buildReporterPrompt(
  segment: Segment,
  script: string,
  program: Program,
  clipSeconds: number,
): string {
  const scene = (segment.scene ?? "").replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
  const parts = [
    `On-location television news report, no lettering or signage in frame.`,
    `A news correspondent stands facing camera holding a microphone, ${scene} behind them.`,
    `Medium shot, slight handheld movement, available daylight, people passing in the background.`,
    `S1 (the correspondent, clear field-report delivery, a shade more urgent than a studio read): "${script}"`,
    `Audio: the location's own background noise around the voice; no studio music.`,
  ];

  let prompt = parts.join(" ").replace(/\s+/g, " ").trim();
  if (prompt.length > PROMPT_LIMIT) {
    prompt = [parts[0], parts[1], parts[3], parts[4]].join(" ").replace(/\s+/g, " ").trim();
  }
  if (prompt.length > PROMPT_LIMIT) {
    const shorter = fitWords(script, Math.max(6, wordBudget(clipSeconds) - 8));
    prompt = prompt.replace(script, shorter);
  }
  return prompt.slice(0, PROMPT_LIMIT);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
