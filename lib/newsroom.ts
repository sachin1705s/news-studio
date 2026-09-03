/**
 * The newsroom: what Gemini produces for a block, and what the deck does with it.
 *
 * The wire gives the channel facts. It does not give it television. A headline
 * is not a line an anchor can read, an abstraction has no picture in it, and
 * nothing in an RSS item says whether a story is worth sending someone to.
 * Those three judgements are the producer's, and they are what this asks for.
 */

/** Small, fast, and grounded — the work here is short-form editorial, not reasoning. */
export const NEWSROOM_MODEL = "gemini-flash-lite-latest";

export interface ProducedReporter {
  /** Where the correspondent is standing, as it goes on the LIVE super. */
  location: string;
  /** What the camera sees behind them. */
  scene: string;
  /** Their piece to camera, ending back with the studio. */
  standup: string;
}

/** One cutaway: the picture, how it is framed, and the line spoken over it. */
export interface Cut {
  shot: string;
  voiceover: string;
  framing: "aerial" | "ground" | "interior" | "detail";
}

export interface ProducedItem {
  /** Story id, echoed back so items pair with the wire they came from. */
  id: string;
  /** The anchor's introduction to camera. */
  read?: string;
  /** The cutaway that runs under the anchor's voice. */
  shot?: string;
  /**
   * What the anchor says over the cutaway. This must ADD to the read rather
   * than restate it — the same fact twice in a row is the single most obvious
   * tell that a bulletin was written by a machine.
   */
  voiceover?: string;
  /**
   * How much airtime the story gets.
   *
   * A bulletin that gives every story the same forty seconds has no editorial
   * judgement in it. "short" is a read and maybe one picture; "medium" runs
   * about a minute; "long" is the story the block is actually about and runs
   * to three, with an aerial, several cutaways, a correspondent and the anchor
   * closing it out.
   */
  treatment?: "short" | "medium" | "long";
  /** The cutaways in the order they are cut, each with the line over it. */
  cuts?: Cut[];
  /** The anchor's closing line to camera. Long packages only. */
  tag?: string;
  /** A correspondent on location, for the stories that carry one. */
  reporter?: ProducedReporter | null;
  /** Runs the breaking band. Reserved for genuinely developing stories. */
  breaking?: boolean;
}

export interface NewsroomResponse {
  items: ProducedItem[];
  error?: string;
}

/** What the producer is told about the block it is writing for. */
export interface NewsroomRequest {
  stories: { id: string; title: string; summary: string; source: string }[];
  /** The strand's subject, so the shots match the block. */
  lookFor: string;
  /** The daypart's register, so the copy is read in the right voice. */
  tone: string;
  /** How many stories in this block should go to a correspondent. */
  reporterBudget: number;
  /** How many should get the three-minute long treatment. Usually one. */
  longBudget: number;
}
