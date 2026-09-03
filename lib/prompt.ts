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

export function wordBudget(clipSeconds: number): number {
  return Math.max(6, Math.floor((clipSeconds - HEAD_TAIL_SECONDS) * WORDS_PER_SECOND));
}

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
    return buildBrollPrompt(segment.shot, script, program, clipSeconds);
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
 */
function buildBrollPrompt(
  shot: string,
  script: string,
  program: Program,
  clipSeconds: number,
): string {
  const shotText = shot.replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
  const parts = [
    `Documentary news footage, no presenter on screen, no text or graphics:`,
    `${cap(shotText)}.`,
    `Steady handheld camera, natural light, real location.`,
    `S1 (an unseen news anchor, voiceover over the footage, ${program.tone}): "${script}"`,
    `Audio: the location's own atmosphere under the voice; no studio music.`,
  ];

  let prompt = parts.join(" ").replace(/\s+/g, " ").trim();
  if (prompt.length > PROMPT_LIMIT) {
    // The look clause is the first thing worth losing; the shot and the voice are not.
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
