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
import type { Program } from "@/lib/programs";
import { buildPrompt } from "@/lib/prompt";
import { buildRundown, headlinesFor } from "@/lib/rundown";
import { STRANDS, strandAt } from "@/lib/strands";
import { stockShot } from "@/lib/stock-shots";
import type { Segment, Story } from "@/lib/types";

/** Metadata rides with every clip and comes back on every message about it, so
 *  the on-screen chrome is driven by the picture rather than by a parallel timer. */
export interface ClipMeta {
  slug: string;
  strap: string;
  kind: Segment["kind"];
  program: string;
  strand: string;
  kicker: string;
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
  const { status, sendCommand, setCanvas, setAutoplay, setClipSeconds, setFlushOnClipEnd, setSeed, enqueue, uploadFile } =
    useFastH3();

  const [configured, setConfigured] = useState(false);
  /** Flips once so the configure effect re-runs when the first broadcast lands. */
  const [stateArrived, setStateArrived] = useState(false);
  const sessionState = useRef<FastH3StateUpdateMessage | null>(null);
  const configuring = useRef(false);
  const clipSeconds = useRef(TARGET_CLIP_SECONDS);
  const still = useRef<FileRef | null>(null);
  const pending = useRef<Segment[]>([]);
  const cycle = useRef(0);
  const feeding = useRef(false);
  const sawPicture = useRef(false);
  const brollWarned = useRef(false);
  const reportedLoss = useRef(false);
  const capacity = useRef({ free: 0 });

  /**
   * Configure the session once the GPU is assigned.
   *
   * Readiness is the SDK's own `status`, not a probe. `get_state` cannot serve
   * as one: its answer is the `state_update` broadcast, which reaches every
   * client rather than the caller, so `sendCommand` has no caller-scoped reply
   * to resolve and hands back `undefined` no matter how ready the session is.
   *
   * The same broadcast is where the session's real limits come from, and it is
   * emitted on connect, so by the time status flips to ready it has normally
   * already landed. If it has not, one `get_state` asks for it again and this
   * effect re-runs when it arrives.
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

  const refill = useCallback(async () => {
    // The strand is read fresh each refill, so a block boundary changes what
    // the channel covers on the next batch without interrupting what is on air.
    const { strand } = strandAt(new Date());

    const params = new URLSearchParams({ categories: strand.categories.join(",") });
    const res = await fetch(`/api/news?${params}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`News fetch failed (${res.status})`);
    const { stories } = (await res.json()) as { stories: Story[] };

    // Prefer stories this channel has not run yet; fall back to the full list
    // once the wire has been exhausted rather than going silent.
    const fresh = stories.filter((s) => !usedStoryIds.current.has(s.id));
    const pool = (fresh.length >= 4 ? fresh : stories).slice(0, 8);
    pool.forEach((s) => usedStoryIds.current.add(s.id));
    if (usedStoryIds.current.size > 400) usedStoryIds.current.clear();

    // Every story with a summary gets footage. The library is the floor, so the
    // channel always cuts away; Claude overwrites it with a shot written for the
    // actual headline whenever a key is configured and the call succeeds.
    const wanted = headlinesFor(pool);
    const shots = new Map<string, string>();
    wanted.forEach((w, i) => {
      const shot = stockShot(pool.find((p) => p.id === w.id)!, strand.id, i);
      if (shot) shots.set(w.id, shot);
    });

    if (wanted.length) {
      try {
        const shotRes = await fetch("/api/broll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            headlines: wanted.map((w) => w.text),
            lookFor: strand.lookFor,
          }),
        });
        const body = (await shotRes.json()) as { shots?: string[]; error?: string };
        if (shotRes.ok) {
          (body.shots ?? []).forEach((shot, i) => {
            const target = wanted[i];
            if (target && shot?.trim()) shots.set(target.id, shot.trim());
          });
        } else if (!brollWarned.current) {
          brollWarned.current = true;
          // Not a failure of the broadcast — say what the viewer is getting instead.
          onError(`${body.error ?? "Shot lookup failed."} Using library footage.`);
        }
      } catch {
        if (!brollWarned.current) {
          brollWarned.current = true;
          onError("Shot lookup unreachable. Using library footage.");
        }
      }
    }

    pending.current = buildRundown(pool, program, strand, cycle.current++, shots);
    onQueuePreview(pending.current.slice(0, 8));
  }, [program, usedStoryIds, onQueuePreview, onError]);

  /** Keep the generation queue as full as the model will allow. */
  const topUp = useCallback(async () => {
    if (!configured || feeding.current) return;
    feeding.current = true;
    try {
      while (capacity.current.free > 0) {
        if (pending.current.length === 0) await refill();
        const segment = pending.current.shift();
        if (!segment) break;

        const strand = STRANDS[segment.strandId] ?? strandAt(new Date()).strand;
        const meta: ClipMeta = {
          slug: segment.slug,
          strap: segment.strap,
          kind: segment.kind,
          program: program.name,
          strand: strand.name,
          kicker: strand.kicker,
        };

        // The anchor still opens anchor shots only. A cutaway is a different
        // scene entirely, so seeding it from the studio frame would fight the shot.
        const useStill = still.current && segment.kind !== "broll";

        await enqueue({
          prompt: buildPrompt(segment, program, clipSeconds.current, !!still.current),
          metadata: JSON.stringify(meta),
          ...(useStill ? { starting_frame: still.current } : {}),
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
    sessionState.current = state;
    if (!stateArrived) setStateArrived(true);
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
