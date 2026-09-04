"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FileRef } from "@reactor-team/js-sdk";
import type { FastH3StateUpdateMessage } from "@reactor-models/fast-h3";
import {
  FastH3MainVideoView,
  FastH3Provider,
  useFastH3,
  useFastH3ClipFailed,
  useFastH3ClipStarted,
  useFastH3CommandError,
  useFastH3StateUpdate,
} from "@reactor-models/fast-h3";
import type { ProducedItem } from "@/lib/newsroom";
import type { Program } from "@/lib/programs";
import { buildPrompt, clipSecondsFor, FIRST_CLIP_SECONDS } from "@/lib/prompt";
import { buildRundown, headlinesFor } from "@/lib/rundown";
import { markPinnedRun, nextCycle, shouldRunPinned } from "@/lib/history";
import { PINNED_LEAD } from "@/lib/pinned";
import { openingActive, strandOnAir, type Strand } from "@/lib/strands";
import { stockShot } from "@/lib/stock-shots";
import type { Segment, Story } from "@/lib/types";

/** A comment the anchor is going to answer, with the answer already written. */
export interface ViewerTake {
  id: string;
  author: string;
  text: string;
  reply: string;
}

/** Metadata rides with every clip and comes back on every message about it, so
 *  the on-screen chrome is driven by the picture rather than by a parallel timer. */
export interface ClipMeta {
  /** The segment this clip was built from, so the rundown can retire it on air. */
  id: string;
  slug: string;
  strap: string;
  kind: Segment["kind"];
  program: string;
  strand: string;
  kicker: string;
  /** Set on correspondent clips: goes on the LIVE super. */
  location?: string;
  breaking?: boolean;
  /** Set on viewer clips: who is being quoted. */
  author?: string;
}

export interface DeckStats {
  building: number;
  buildCapacity: number;
  ready: number;
  readyCapacity: number;
  clipsPlayed: number;
  secondsSent: number;
}

interface DeckProps {
  program: Program;
  anchorStill: Blob | null;
  /**
   * When each story was last broadcast, shared across decks so a rotation does
   * not repeat itself and a long run does not come back round to this morning.
   */
  usedStoryIds: React.MutableRefObject<Map<string, number>>;
  /** When the opening block ends. Before it, the channel is on the startup desk. */
  openingUntil: number | null;
  /** Hands over the next viewer comment, or null when there is nothing to answer. */
  takeComment: (coverage: string[]) => Promise<ViewerTake | null>;
  onPictureLive: () => void;
  /** The session ended — expired, evicted, or dropped. The channel needs a new one. */
  onSessionLost: () => void;
  onSegment: (meta: ClipMeta) => void;
  onStats: (stats: DeckStats) => void;
  onQueuePreview: (segments: Segment[]) => void;
  onError: (message: string) => void;
  /** The session this deck created, so the channel can be registered for viewers. */
  onSessionId: (sessionId: string) => void;
  live: boolean;
}

/**
 * Tokens are cached per role.
 *
 * The origin's token may create sessions; a viewer's is bound to the one
 * session the channel is broadcasting from and can do nothing else. They are
 * different credentials and must never be shared between the two.
 */
const tokenCache = new Map<string, { jwt: string; expiresAt: number }>();
const inFlight = new Map<string, Promise<string>>();

async function fetchToken(adopt: string | null): Promise<string> {
  const key = adopt ?? "origin";
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.jwt;

  const running = inFlight.get(key);
  if (running) return running;

  const request = (async () => {
    try {
      // The origin id identifies this browser to the token gate, so the
      // browser already holding the channel can renew while everyone else is
      // refused.
      let originId = "";
      try {
        originId = window.localStorage.getItem("r24.origin") ?? "";
      } catch {
        originId = "";
      }

      const res = await fetch("/api/reactor/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(adopt ? { sessionId: adopt } : { originId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Token request failed (${res.status})`);
      tokenCache.set(key, { jwt: body.jwt, expiresAt: body.expires_at * 1000 });
      return body.jwt as string;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, request);
  return request;
}

const originToken = () => fetchToken(null);

/**
 * Forget the origin token.
 *
 * `max_sessions` counts sessions a token has ever created, so a token that has
 * been through a few broadcasts is spent. Dropping it when a session ends means
 * the next start asks for a fresh one instead of retrying with a credential
 * that will be refused.
 */
export function releaseOriginToken(): void {
  tokenCache.delete("origin");
}

export function Deck(props: DeckProps) {
  return (
    <FastH3Provider jwtToken={originToken} connectOptions={{ autoConnect: true }}>
      <DeckInner {...props} />
    </FastH3Provider>
  );
}

/**
 * A viewer of the channel.
 *
 * It attaches to the session the origin created rather than starting one of
 * its own, which is what makes this a channel instead of a per-visitor render
 * farm: any number of these cost nothing beyond the one session already
 * running, and every one of them is looking at the same frame.
 *
 * It is strictly receive-only. It never configures the session, never queues a
 * clip and never touches the producer — the origin owns all of that. All it
 * does is show the picture and read the metadata riding on each clip so the
 * lower third says the right thing.
 */
export function ViewerDeck({
  sessionId,
  program,
  muted,
  onSegment,
  onPictureLive,
  onSessionLost,
  onDeadSession,
  onError,
}: {
  sessionId: string;
  program: Program;
  /** Viewers join muted: browsers refuse unmuted autoplay without a gesture. */
  muted: boolean;
  onSegment: (meta: ClipMeta) => void;
  onPictureLive: () => void;
  onSessionLost: () => void;
  /** Attached, but the broadcast never produced a frame — the session is dead. */
  onDeadSession: () => void;
  onError: (message: string) => void;
}) {
  const jwt = useCallback(() => fetchToken(sessionId), [sessionId]);
  return (
    <FastH3Provider
      jwtToken={jwt}
      connectOptions={{ autoConnect: true, sessionId }}
    >
      <ViewerInner
        program={program}
        muted={muted}
        onSegment={onSegment}
        onPictureLive={onPictureLive}
        onSessionLost={onSessionLost}
        onDeadSession={onDeadSession}
        onError={onError}
      />
    </FastH3Provider>
  );
}

function ViewerInner({
  muted,
  onSegment,
  onPictureLive,
  onSessionLost,
  onDeadSession,
  onError,
}: {
  program: Program;
  muted: boolean;
  onDeadSession: () => void;
  onSegment: (meta: ClipMeta) => void;
  onPictureLive: () => void;
  onSessionLost: () => void;
  onError: (message: string) => void;
}) {
  const { status } = useFastH3();
  const sawPicture = useRef(false);
  const wasReady = useRef(false);
  const reported = useRef(false);

  useEffect(() => {
    console.debug(`[viewer] status: ${status}`);
    if (status === "ready") wasReady.current = true;
    // The broadcast this viewer attached to has gone. The page decides whether
    // to start a new one; this component only reports it.
    if (wasReady.current && status === "disconnected" && !reported.current) {
      reported.current = true;
      onSessionLost();
    }
  }, [status, onSessionLost]);

  useFastH3ClipStarted((message) => {
    if (!sawPicture.current) {
      sawPicture.current = true;
      onPictureLive();
    }
    const meta = parseMeta(message.clip.metadata);
    if (meta) onSegment(meta);
  });

  /**
   * A registration can outlive the broadcast it names — the origin's tab is
   * killed, its beacon never fires, and the record sits there until it ages
   * out. A viewer that adopts one attaches to nothing and stares at black
   * forever, so an adoption that produces no picture is treated as a dead
   * session rather than a slow one.
   */
  useEffect(() => {
    const id = setTimeout(() => {
      if (!sawPicture.current) onDeadSession();
    }, 30_000);
    return () => clearTimeout(id);
  }, [onDeadSession]);

  useFastH3CommandError((message) => {
    onError(`${message.command}: ${message.reason}`);
  });

  return (
    <FastH3MainVideoView
      audioTrack="main_audio"
      muted={muted}
      className="deck-video"
      videoObjectFit="cover"
    />
  );
}

/** A bulletin read lands ~20 words; the model clamps this to what it can build. */
const TARGET_CLIP_SECONDS = 12;

/**
 * How long a story stays retired.
 *
 * A channel running for hours will exhaust any single feed, and the honest
 * options are then to repeat or to widen. It does both, in that order: it
 * widens the wire first, and only lets a story back on air after six hours,
 * by which point it is a different bulletin covering a story again rather than
 * the same bulletin stuck in a loop.
 */
const RETIRE_MS = 6 * 60 * 60 * 1000;

/**
 * How far ahead the channel commits its running order.
 *
 * The generation queue holds twenty, and filling it meant the next three
 * minutes were decided before a viewer had finished typing — nothing could be
 * slotted in without shoving it in front of a story already half told. Keeping
 * a shallower buffer is what lets the anchor turn to the audience between
 * stories instead of interrupting one.
 *
 * Eight clips is roughly ninety seconds of picture: enough that a slow build
 * cannot open a hole, short enough that a comment waits a story, not a block.
 */
const MAX_LOOKAHEAD = 8;

/**
 * Crop a publisher's photograph to the canvas shape.
 *
 * A starting frame has to match the session's aspect or the model letterboxes
 * it into the shot. Press pictures are every shape there is, so each one is
 * centre-cropped to 16:9 before it goes up.
 */
async function to16x9(blob: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const W = 1280;
    const H = 720;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const scale = Math.max(W / bitmap.width, H / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    ctx.drawImage(bitmap, (W - w) / 2, (H - h) / 2, w, h);
    bitmap.close();

    return await new Promise((resolve) =>
      canvas.toBlob((out) => resolve(out), "image/jpeg", 0.9),
    );
  } catch {
    return null;
  }
}

/**
 * Deal the block out in no particular order.
 *
 * Seeded on the cycle so one refill is stable — a re-render must not reorder a
 * rundown that is already being queued — while consecutive blocks land
 * differently.
 */
function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = (seed + 1) * 2654435761;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function DeckInner({
  program,
  anchorStill,
  usedStoryIds,
  openingUntil,
  takeComment,
  onSessionId,
  onPictureLive,
  onSessionLost,
  onSegment,
  onStats,
  onQueuePreview,
  onError,
  live,
}: DeckProps) {
  const { status, sessionId, sendCommand, setCanvas, setAutoplay, setClipSeconds, setFlushOnClipEnd, setSeed, enqueue, uploadFile } =
    useFastH3();

  const [configured, setConfigured] = useState(false);
  /** Flips once so the configure effect re-runs when the first broadcast lands. */
  const [stateArrived, setStateArrived] = useState(false);
  const sessionState = useRef<FastH3StateUpdateMessage | null>(null);
  const configuring = useRef(false);
  const clipSeconds = useRef(TARGET_CLIP_SECONDS);
  const still = useRef<FileRef | null>(null);
  const pending = useRef<Segment[]>([]);
  /**
   * The block as written, kept whole.
   *
   * The rail shows what is still to come, and "still to come" is not the same
   * as "not yet queued": with twenty slots free the deck queues an entire block
   * in one pass, which used to leave the rail reading "waiting on the wire"
   * while twenty clips were building. Segments are retired from here when they
   * reach air instead.
   */
  const block = useRef<Segment[]>([]);
  /** Headlines already broadcast this session, for answering viewers in context. */
  const coverage = useRef<string[]>([]);
  const cycle = useRef(0);
  const feeding = useRef(false);
  /** Nothing has been queued yet, so the next clip is the one keeping the
   *  screen black — it is built at the shortest length the model offers. */
  const openingClip = useRef(true);
  /**
   * A number that is different every time the channel starts.
   *
   * Without it the shuffle is seeded on the cycle counter, which begins at zero
   * on every page load — so every run dealt the same story list into the same
   * order and opened on the same headline, which looked exactly like hardcoded
   * news. The wire cache made it worse: within its four-minute window the list
   * was identical too. This is what makes two runs a minute apart differ.
   */
  const runSeed = useRef(0);
  const sawPicture = useRef(false);
  const producerWarned = useRef(false);
  const reportedLoss = useRef(false);
  const capacity = useRef({ free: 0 });
  /** Clips committed but not yet aired: generation queue plus playout queue. */
  const ahead = useRef(0);
  /** The package currently being fed, so boundaries can be spotted. */
  const lastPackage = useRef<string | null>(null);
  /** Uploaded press photographs, keyed by story id: one upload per story, not per clip. */
  const frames = useRef<Map<string, FileRef | null>>(new Map());

  // Seeded in an effect so the value never differs between server and client.
  useEffect(() => {
    runSeed.current = Math.floor(Math.random() * 1_000_000);
    // Carry on from the last block this browser saw rather than restarting at
    // zero, so a refresh advances the running order instead of repeating it.
    cycle.current = nextCycle();
  }, []);

  /**
   * Configure the session once the GPU is assigned.
   *
   * Readiness is the SDK's own `status`, not a probe. `get_state` cannot serve
   * as one: its answer is the `state_update` broadcast, which reaches every
   * client rather than the caller, so `sendCommand` has no caller-scoped reply
   * to resolve and hands back `undefined` no matter how ready the session is.
   */
  useEffect(() => {
    if (status !== "ready" || configured || configuring.current) return;

    const state = sessionState.current;
    if (!state) {
      void sendCommand("get_state").catch(() => {});
      return;
    }

    configuring.current = true;
    let cancelled = false;

    (async () => {
      try {
        console.debug("[deck] configuring", {
          aspect: state.aspect,
          clipSeconds: `${state.clip_seconds_min}-${state.clip_seconds_max}`,
          generation: state.generation_capacity,
          playout: state.playout_capacity,
        });

        clipSeconds.current = Math.min(
          Math.max(TARGET_CLIP_SECONDS, state.clip_seconds_min),
          state.clip_seconds_max,
        );

        // Canvas is idle-gated: it has to be set before anything is queued.
        if (state.aspect !== "16:9") await setCanvas({ aspect: "16:9" });
        // Hold the last frame between segments instead of flashing to black.
        await setFlushOnClipEnd({ enabled: false });
        const length = await setClipSeconds({ seconds: clipSeconds.current });
        if (length) clipSeconds.current = length.clip_seconds;
        // A pinned seed keeps the anchor recognisable when there is no still to lock to.
        await setSeed({ seed: 20260903 });

        if (anchorStill) {
          try {
            still.current = await uploadFile(anchorStill, { name: "anchor.jpg" });
          } catch {
            onError("Anchor still failed to upload; running on the written description.");
          }
        }

        await setAutoplay({ enabled: true });
        if (!cancelled) {
          console.debug("[deck] configured; clip length", clipSeconds.current);
          setConfigured(true);
        }
      } catch (err) {
        configuring.current = false;
        onError(err instanceof Error ? err.message : "Failed to configure the session.");
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, stateArrived, configured]);

  /**
   * Gather the block's stories.
   *
   * RSS is the wire and covers most subjects well. The startup desk is the one
   * block it covers badly — funding rounds and acquisitions reach the feeds
   * late or never — so that block also asks the grounded live desk, and runs
   * those items first because they are the freshest thing the channel has.
   */
  const gather = useCallback(
    async (strand: Strand, widen: boolean, angle: string): Promise<Story[]> => {
      // Widening pulls the neighbouring desks in rather than going quiet: a
      // startup block short of startup news is still a technology block.
      const categories = widen
        ? Array.from(new Set([...strand.categories, ...program.categories, "top", "world"]))
        : strand.categories;
      const params = new URLSearchParams({ categories: categories.join(",") });
      const res = await fetch(`/api/news?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`News fetch failed (${res.status})`);
      const { stories } = (await res.json()) as { stories: Story[] };

      // Every block searches the web. RSS is fast and reliable but it is only
      // as current as its publishers' feeds; a grounded search is what makes
      // the channel's claim to be live true rather than decorative.
      let live: Story[] = [];
      try {
        const wire = await fetch(`/api/wire?subject=${encodeURIComponent(angle)}`, {
          cache: "no-store",
        });
        if (wire.ok) {
          const body = (await wire.json()) as { stories?: Story[] };
          live = body.stories ?? [];
        }
      } catch {
        // Search failing is not worth taking the bulletin off air: the RSS wire
        // has already delivered a full block on its own.
      }

      const seen = new Set<string>();
      const all = [...live, ...stories].filter((s) => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return true;
      });

      // Shuffled, not ranked. Sorted by recency the block leads with whichever
      // wire published last and the live desk's funding rounds take every top
      // slot, so the channel reads as a funding feed with news attached. A
      // bulletin should feel like a bulletin: a raise, then a court ruling,
      // then a launch, in no particular order.
      return shuffle(all, runSeed.current + cycle.current);
    },
    [program.categories],
  );

  const refill = useCallback(async () => {
    // Read fresh each refill, so a block boundary changes what the channel
    // covers on the next batch without interrupting what is on air.
    const { strand } = strandOnAir(openingUntil, new Date());

    const angles = strand.searchAngles;
    const angle = angles[(runSeed.current + cycle.current) % angles.length];

    // Let go of anything retired long enough to run again. The map is pruned
    // here rather than capped by size, so memory tracks time on air instead of
    // a story count that a busy hour would blow through.
    const now = Date.now();
    for (const [id, at] of usedStoryIds.current) {
      if (now - at > RETIRE_MS) usedStoryIds.current.delete(id);
    }

    let all = await gather(strand, false, angle);
    let fresh = all.filter((s) => !usedStoryIds.current.has(s.id));

    // The strand's own feeds are spent. Widen to the neighbouring desks before
    // considering anything already broadcast.
    if (fresh.length < 4) {
      all = await gather(strand, true, angle);
      fresh = all.filter((s) => !usedStoryIds.current.has(s.id));
    }

    // Still short: run the least recently broadcast stories rather than go
    // silent, oldest first, so a repeat is the furthest thing from what just aired.
    const stale = all
      .filter((s) => usedStoryIds.current.has(s.id))
      .sort((a, b) => (usedStoryIds.current.get(a.id) ?? 0) - (usedStoryIds.current.get(b.id) ?? 0));
    const pool = [...fresh, ...stale].slice(0, 8);

    // The channel introduces itself first, and only to someone who has not been
    // watching recently — pinned ahead of the shuffle so it genuinely leads,
    // rather than being dealt into the middle of the block.
    if (openingActive(openingUntil) && shouldRunPinned()) {
      markPinnedRun();
      pool.unshift(PINNED_LEAD);
      pool.length = Math.min(pool.length, 8);
    }

    pool.forEach((s) => usedStoryIds.current.set(s.id, now));

    // The library is the floor: every story gets footage even with no producer
    // reachable, so the channel always cuts away.
    const produced = new Map<string, ProducedItem>();
    const writeable = headlinesFor(pool);
    writeable.forEach((story, i) => {
      const shot = stockShot(story, strand.id, i);
      if (shot) produced.set(story.id, { id: story.id, shot });
    });

    if (writeable.length) {
      try {
        const res = await fetch("/api/newsroom", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stories: writeable.map((s) => ({
              id: s.id,
              title: s.title,
              summary: s.summary,
              source: s.source,
            })),
            lookFor: strand.lookFor,
            tone: program.tone,
            // Roughly one story in three goes to a correspondent. More than
            // that and the format stops meaning anything.
            reporterBudget: Math.max(1, Math.round(writeable.length / 3)),
            // One story a block gets the three-minute treatment. More than
            // that and the block stops being a bulletin.
            longBudget: 1,
          }),
        });
        const body = (await res.json()) as { items?: ProducedItem[]; error?: string };
        if (res.ok) {
          (body.items ?? []).forEach((item) => {
            if (!item?.id) return;
            const floor = produced.get(item.id);
            produced.set(item.id, { ...floor, ...item, shot: item.shot || floor?.shot });
          });
        } else if (!producerWarned.current) {
          producerWarned.current = true;
          onError(`${body.error ?? "The producer failed."} Running on wire copy and library footage.`);
        }
      } catch {
        if (!producerWarned.current) {
          producerWarned.current = true;
          onError("The producer is unreachable. Running on wire copy and library footage.");
        }
      }
    }

    const rundown = buildRundown(pool, program, strand, cycle.current++, produced);

    pending.current = rundown;
    block.current = rundown;
    onQueuePreview(block.current.slice(0, 12));
  }, [gather, onQueuePreview, onError, openingUntil, program, usedStoryIds]);

  /**
   * The picture a cutaway starts from.
   *
   * When the publisher ran a photograph with the story, the cutaway begins on
   * it and moves — which puts the actual company, building or person on screen
   * rather than a generic library shot of the world they live in. One upload
   * per story, reused across the clips in its package.
   */
  const frameFor = useCallback(
    async (story: Story | undefined): Promise<FileRef | null> => {
      if (!story) return null;
      const source = story.image || story.link;
      if (!source) return null;
      if (frames.current.has(story.id)) return frames.current.get(story.id) ?? null;

      // Claim the slot first so two clips in one package do not both upload.
      frames.current.set(story.id, null);
      try {
        const res = await fetch(`/api/image?url=${encodeURIComponent(source)}`);
        if (!res.ok) return null;
        const raw = await res.blob();
        const shaped = await to16x9(raw);
        if (!shaped) return null;
        const ref = await uploadFile(shaped, { name: "story.jpg" });
        frames.current.set(story.id, ref);
        return ref;
      } catch {
        return null;
      }
    },
    [uploadFile],
  );

  /** Keep the generation queue as full as the model will allow. */
  /** Queue one segment for building. */
  const queueSegment = useCallback(
    async (segment: Segment) => {
      const strand = strandOnAir(openingUntil, new Date()).strand;
      const meta: ClipMeta = {
        id: segment.id,
        slug: segment.slug,
        strap: segment.strap,
        kind: segment.kind,
        program: program.name,
        strand: strand.name,
        kicker: strand.kicker,
        location: segment.location,
        breaking: segment.breaking,
        author: segment.author,
      };

      // The anchor still opens anchor shots only. A cutaway and a reporter
      // standup are different scenes entirely, so seeding either from the
      // studio frame would fight the shot.
      const inStudio = segment.kind !== "broll" && segment.kind !== "reporter";
      const startingFrame = inStudio
        ? still.current
        : segment.kind === "broll"
          ? await frameFor(segment.story)
          : null;

      const seconds = openingClip.current
        ? FIRST_CLIP_SECONDS
        : clipSecondsFor(segment, clipSeconds.current);
      openingClip.current = false;

      await enqueue({
        prompt: buildPrompt(segment, program, seconds, inStudio && !!still.current),
        seconds,
        metadata: JSON.stringify(meta),
        ...(startingFrame ? { starting_frame: startingFrame } : {}),
      });
      capacity.current.free -= 1;
      ahead.current += 1;
    },
    [enqueue, frameFor, openingUntil, program],
  );

  /**
   * The next comment the anchor has something to say about, written as a
   * segment. Null when the audience is quiet or nothing is worth answering.
   */
  const nextViewerSegment = useCallback(async (): Promise<Segment | null> => {
    const take = await takeComment(coverage.current.slice(-12));
    if (!take) return null;

    const strand = strandOnAir(openingUntil, new Date()).strand;
    return {
      programId: program.id,
      strandId: strand.id,
      id: `viewer-${take.id}`,
      kind: "viewer",
      slug: `${take.author} writes`,
      strap: "From the R24 community",
      author: take.author,
      // The reply is the whole spoken line: the producer names the viewer and
      // answers them in one breath, so the comment is not recited first.
      script: take.reply,
    };
  }, [openingUntil, program.id, takeComment]);

  /**
   * Keep the running order fed, and hand to the audience between stories.
   *
   * The channel commits only a short way ahead, so this runs constantly rather
   * than emptying a block into the queue in one pass. At each package boundary
   * — the moment one story is fully queued and the next has not started — the
   * audience gets the floor. That is what makes the anchor answer viewers
   * between stories rather than cutting into the middle of one.
   */
  const topUp = useCallback(async () => {
    if (!configured || feeding.current) return;
    feeding.current = true;
    try {
      while (capacity.current.free > 0 && ahead.current < MAX_LOOKAHEAD) {
        if (pending.current.length === 0) await refill();
        const next = pending.current[0];
        if (!next) break;

        // A new story is about to start. Before it does, take a comment.
        const boundary = Boolean(next.packageId) && next.packageId !== lastPackage.current;
        if (boundary) {
          lastPackage.current = next.packageId ?? null;
          const viewer = await nextViewerSegment();
          if (viewer) {
            await queueSegment(viewer);
            continue;
          }
        }

        pending.current.shift();
        await queueSegment(next);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to queue a segment.");
    } finally {
      feeding.current = false;
    }
  }, [configured, nextViewerSegment, onError, queueSegment, refill]);

  useFastH3StateUpdate((state) => {
    sessionState.current = state;
    if (!stateArrived) setStateArrived(true);
    capacity.current.free = state.generation_capacity - state.generation_queued;
    ahead.current = state.generation_queued + state.playout_queued;
    onStats({
      building: state.generation_queued,
      buildCapacity: state.generation_capacity,
      ready: state.playout_queued,
      readyCapacity: state.playout_capacity,
      clipsPlayed: state.clips_played,
      secondsSent: state.seconds_sent,
    });
    void topUp();
  });

  // state_update only arrives on change, so a settled session gets a nudge too.
  useEffect(() => {
    if (!configured) return;
    void topUp();
    const id = setInterval(() => void topUp(), 4000);
    return () => clearInterval(id);
  }, [configured, topUp]);

  useEffect(() => {
    console.debug(`[deck] status: ${status}`);
  }, [status]);

  // Published as soon as it exists, so viewers can attach to this broadcast
  // rather than starting one of their own.
  useEffect(() => {
    if (sessionId) onSessionId(sessionId);
  }, [sessionId, onSessionId]);

  /**
   * A session that has been up and then reports disconnected is gone: the SDK
   * reconnects a recoverable drop on its own, so reaching this state means it
   * could not. Reported once — the parent tears this deck down in response.
   */
  useEffect(() => {
    if (!configured || reportedLoss.current) return;
    if (status === "disconnected") {
      reportedLoss.current = true;
      onSessionLost();
    }
  }, [status, configured, onSessionLost]);

  useFastH3ClipStarted((message) => {
    if (!sawPicture.current) {
      sawPicture.current = true;
      onPictureLive();
    }
    const meta = parseMeta(message.clip.metadata);
    if (!meta) return;
    onSegment(meta);

    // Everything up to and including this segment has now been on air.
    const at = block.current.findIndex((s) => s.id === meta.id);
    if (at >= 0) {
      block.current = block.current.slice(at + 1);
      onQueuePreview(block.current.slice(0, 12));
    }
    if (meta.kind === "story") {
      coverage.current.push(meta.slug);
      if (coverage.current.length > 40) coverage.current.shift();
    }
  });

  useFastH3ClipFailed((message) => {
    const meta = parseMeta(message.clip.metadata);
    onError(`Segment failed to build${meta ? `: ${meta.slug}` : ""}. Skipping.`);
  });

  useFastH3CommandError((message) => {
    // A full queue is the normal steady state, not a fault.
    if (/full/i.test(message.reason)) return;
    onError(`${message.command}: ${message.reason}`);
  });

  return (
    <FastH3MainVideoView
      audioTrack="main_audio"
      muted={!live}
      className="deck-video"
      videoObjectFit="cover"
    />
  );
}

function parseMeta(raw: string): ClipMeta | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ClipMeta;
    return parsed?.slug ? parsed : null;
  } catch {
    return null;
  }
}
