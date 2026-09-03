"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FileRef } from "@reactor-team/js-sdk";
import {
  FastH3MainVideoView,
  FastH3Provider,
  useFastH3,
  useFastH3ClipFailed,
  useFastH3ClipStarted,
  useFastH3CommandError,
  useFastH3StateUpdate,
} from "@reactor-models/fast-h3";
import type { Program } from "@/lib/programs";
import { buildPrompt } from "@/lib/prompt";
import { buildRundown } from "@/lib/rundown";
import type { Segment, Story } from "@/lib/types";

/** Metadata rides with every clip and comes back on every message about it, so
 *  the on-screen chrome is driven by the picture rather than by a parallel timer. */
export interface ClipMeta {
  slug: string;
  strap: string;
  kind: Segment["kind"];
  program: string;
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
  /** Story ids already broadcast, shared across decks so a rotation doesn't repeat itself. */
  usedStoryIds: React.MutableRefObject<Set<string>>;
  onPictureLive: () => void;
  /** The session ended — expired, evicted, or dropped. The channel needs a new one. */
  onSessionLost: () => void;
  onSegment: (meta: ClipMeta) => void;
  onStats: (stats: DeckStats) => void;
  onQueuePreview: (segments: Segment[]) => void;
  onError: (message: string) => void;
  live: boolean;
}

let tokenCache: { jwt: string; expiresAt: number } | null = null;
let inFlight: Promise<string> | null = null;

/** Scoped tokens last an hour; decks that rotate every ~17 minutes can share one. */
async function fetchToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.jwt;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch("/api/reactor/token", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Token request failed (${res.status})`);
      tokenCache = { jwt: body.jwt, expiresAt: body.expires_at * 1000 };
      return body.jwt as string;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function Deck(props: DeckProps) {
  return (
    <FastH3Provider jwtToken={fetchToken} connectOptions={{ autoConnect: true }}>
      <DeckInner {...props} />
    </FastH3Provider>
  );
}

/** A bulletin read lands ~20 words; the model clamps this to what it can build. */
const TARGET_CLIP_SECONDS = 12;
/** A readiness probe that has not answered in this long is treated as lost. */
const PROBE_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function DeckInner({
  program,
  anchorStill,
  usedStoryIds,
  onPictureLive,
  onSessionLost,
  onSegment,
  onStats,
  onQueuePreview,
  onError,
  live,
}: DeckProps) {
  const { status, getState, setCanvas, setAutoplay, setClipSeconds, setFlushOnClipEnd, setSeed, enqueue, uploadFile } =
    useFastH3();

  const [configured, setConfigured] = useState(false);
  const clipSeconds = useRef(TARGET_CLIP_SECONDS);
  const still = useRef<FileRef | null>(null);
  const pending = useRef<Segment[]>([]);
  const cycle = useRef(0);
  const feeding = useRef(false);
  const sawPicture = useRef(false);
  const reportedLoss = useRef(false);
  const capacity = useRef({ free: 0 });

  /**
   * The SDK's status event is known to skip waiting -> ready, so readiness is
   * probed directly: `get_state` is refused until the session is up, and the
   * first reply that comes back is the signal to configure.
   *
   * The probe is raced against a timeout. `sendCommand` awaits the model's
   * reply, and a command sent before the GPU is assigned can sit unanswered
   * rather than being refused — without the race a single hung probe would
   * deadlock the deck forever, with the retry below never reached.
   */
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;

    const attempt = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const state = await withTimeout(getState(), PROBE_TIMEOUT_MS, "get_state");
        if (!state) throw new Error("get_state returned no state");
        if (cancelled) return;
        console.debug(`[deck] ready after ${attempts} probe(s)`, {
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
        if (!cancelled) setConfigured(true);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Refusals before the GPU is assigned are expected; log sparsely so the
        // pattern is visible without burying the console.
        if (attempts === 1 || attempts % 10 === 0) {
          console.debug(`[deck] not ready yet (probe ${attempts}): ${reason}`);
        }
        if (attempts === 40) {
          onError("The session has not come up after a minute. Still trying.");
        }
        timer = setTimeout(attempt, 1500);
      }
    };

    attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refill = useCallback(async () => {
    const params = new URLSearchParams({ categories: program.categories.join(",") });
    const res = await fetch(`/api/news?${params}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`News fetch failed (${res.status})`);
    const { stories } = (await res.json()) as { stories: Story[] };

    // Prefer stories this channel has not run yet; fall back to the full list
    // once the wire has been exhausted rather than going silent.
    const fresh = stories.filter((s) => !usedStoryIds.current.has(s.id));
    const pool = (fresh.length >= 4 ? fresh : stories).slice(0, 9);
    pool.forEach((s) => usedStoryIds.current.add(s.id));
    if (usedStoryIds.current.size > 400) usedStoryIds.current.clear();

    pending.current = buildRundown(pool, program, cycle.current++);
    onQueuePreview(pending.current.slice(0, 8));
  }, [program, usedStoryIds, onQueuePreview]);

  /** Keep the generation queue as full as the model will allow. */
  const topUp = useCallback(async () => {
    if (!configured || feeding.current) return;
    feeding.current = true;
    try {
      while (capacity.current.free > 0) {
        if (pending.current.length === 0) await refill();
        const segment = pending.current.shift();
        if (!segment) break;

        const meta: ClipMeta = {
          slug: segment.slug,
          strap: segment.strap,
          kind: segment.kind,
          program: program.name,
        };

        await enqueue({
          prompt: buildPrompt(segment, program, clipSeconds.current, !!still.current),
          metadata: JSON.stringify(meta),
          ...(still.current ? { starting_frame: still.current } : {}),
        });
        capacity.current.free -= 1;
        onQueuePreview(pending.current.slice(0, 8));
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to queue a segment.");
    } finally {
      feeding.current = false;
    }
  }, [configured, enqueue, onError, onQueuePreview, program, refill]);

  useFastH3StateUpdate((state) => {
    capacity.current.free = state.generation_capacity - state.generation_queued;
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

  /**
   * A session that has been up and then reports disconnected is gone: the SDK
   * reconnects a recoverable drop on its own, so reaching this state means it
   * could not. Reported once — the parent tears this deck down in response.
   */
  useEffect(() => {
    console.debug(`[deck] status: ${status}`);
  }, [status]);

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
    if (meta) onSegment(meta);
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
