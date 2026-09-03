"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currentProgram, type Program } from "@/lib/programs";
import type { Segment } from "@/lib/types";
import { Deck, type ClipMeta, type DeckStats } from "./Deck";
import {
  AnchorControl,
  ChannelBug,
  Clock,
  LowerThird,
  RundownRail,
  ScheduleRail,
  StatusRail,
  Ticker,
} from "./Chrome";

/**
 * Two decks keep one unbroken channel across session boundaries.
 *
 * A session can be minted for up to 24 hours, so rotation is not the routine
 * event it would be under a short cap — it is a hedge. The channel rotates on
 * a long planned interval, and reacts immediately if a session dies before it.
 *
 * Either way the mechanism is the same: bring the standby deck up early, let it
 * build and play off-air, and cut to it only once it has real picture. Cutting
 * to a deck that is already showing something is what removes the seam.
 */
const PLANNED_SESSION_MS = Number(process.env.NEXT_PUBLIC_ROTATE_MINUTES ?? 50) * 60_000;
/** A standby deck needs roughly one clip build to have picture. 90s is generous. */
const PREROLL_LEAD_MS = 90_000;
/** Don't strand the channel on a standby deck that never came up. */
const PREROLL_GIVE_UP_MS = 4 * 60_000;

type Slot = 0 | 1;
const other = (s: Slot): Slot => (s === 0 ? 1 : 0);

export function Broadcast() {
  const [onAir, setOnAir] = useState(false);
  const [live, setLive] = useState<Slot>(0);
  const [mounted, setMounted] = useState<[boolean, boolean]>([false, false]);
  const [epoch, setEpoch] = useState<[number, number]>([0, 0]);
  const [rotating, setRotating] = useState(false);

  const [program, setProgram] = useState<Program>(() => currentProgram());
  const [meta, setMeta] = useState<ClipMeta | null>(null);
  const [stats, setStats] = useState<DeckStats | null>(null);
  const [preview, setPreview] = useState<Segment[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [airtime, setAirtime] = useState(0);
  const [still, setStill] = useState<{ blob: Blob; url: string } | null>(null);

  const airStart = useRef<number | null>(null);
  const prerollStart = useRef<number | null>(null);
  const usedStoryIds = useRef<Set<string>>(new Set());
  const liveRef = useRef<Slot>(0);
  const rotatingRef = useRef(false);
  liveRef.current = live;
  rotatingRef.current = rotating;

  // The channel follows the clock: when the daypart changes, so does the program.
  useEffect(() => {
    const id = setInterval(() => {
      const next = currentProgram();
      setProgram((prev) => (prev.id === next.id ? prev : next));
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  const pushError = useCallback((message: string) => {
    setErrors((prev) => (prev[0] === message ? prev : [message, ...prev].slice(0, 4)));
  }, []);

  const cutTo = useCallback((slot: Slot) => {
    const spent = other(slot);
    setLive(slot);
    airStart.current = Date.now();
    setRotating(false);
    setMounted((prev) => {
      const next: [boolean, boolean] = [...prev];
      next[spent] = false;
      return next;
    });
    setEpoch((prev) => {
      const next: [number, number] = [...prev];
      next[spent] += 1;
      return next;
    });
  }, []);

  const beginPreroll = useCallback(() => {
    if (rotatingRef.current) return;
    setRotating(true);
    prerollStart.current = Date.now();
    setMounted((prev) => {
      const next: [boolean, boolean] = [...prev];
      next[other(liveRef.current)] = true;
      return next;
    });
  }, []);

  /**
   * The on-air session dropped. There is no warm deck to cut to yet, so the
   * channel shows a slate for as long as the standby takes to build its first
   * clip. Nothing is gained by waiting for the planned interval.
   */
  const handleSessionLost = useCallback(
    (slot: Slot) => {
      if (slot !== liveRef.current) return;
      pushError("The on-air session ended. Bringing up a fresh one.");
      setMeta(null);
      beginPreroll();
    },
    [beginPreroll, pushError],
  );

  const handlePictureLive = useCallback(
    (slot: Slot) => {
      if (slot === liveRef.current) {
        // The on-air deck just produced its first frames.
        if (airStart.current === null) airStart.current = Date.now();
        return;
      }
      // The standby deck has picture — take it.
      prerollStart.current = null;
      cutTo(slot);
    },
    [cutTo],
  );

  // Airtime clock plus the rotation state machine.
  useEffect(() => {
    if (!onAir) return;
    const id = setInterval(() => {
      const started = airStart.current;
      if (started === null) return;
      const elapsed = Date.now() - started;
      setAirtime(elapsed / 1000);

      if (elapsed >= PLANNED_SESSION_MS - PREROLL_LEAD_MS && !rotatingRef.current) {
        beginPreroll();
      }
      // A standby that has not produced picture in four minutes is not coming up.
      // Drop it and try again from scratch rather than hold two dead sessions.
      if (prerollStart.current !== null && Date.now() - prerollStart.current > PREROLL_GIVE_UP_MS) {
        prerollStart.current = null;
        setRotating(false);
        const standby = other(liveRef.current);
        setMounted((prev) => {
          const next: [boolean, boolean] = [...prev];
          next[standby] = false;
          return next;
        });
        setEpoch((prev) => {
          const next: [number, number] = [...prev];
          next[standby] += 1;
          return next;
        });
      }
    }, 500);
    return () => clearInterval(id);
  }, [onAir, cutTo, beginPreroll]);

  const takeAir = useCallback(() => {
    setOnAir(true);
    setMounted([true, false]);
    setLive(0);
    airStart.current = Date.now();
  }, []);

  const setAnchor = useCallback((blob: Blob | null) => {
    setStill((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return blob ? { blob, url: URL.createObjectURL(blob) } : null;
    });
  }, []);

  const deckProps = useMemo(
    () => ({
      program,
      anchorStill: still?.blob ?? null,
      usedStoryIds,
      onError: pushError,
    }),
    [program, still, pushError],
  );

  return (
    <div className="app" style={{ ["--accent" as string]: program.accent }}>
      <main className="stage">
        <div className="screen">
          {[0, 1].map((n) => {
            const slot = n as Slot;
            if (!mounted[slot]) return null;
            return (
              <div
                key={`${slot}-${epoch[slot]}`}
                className={`deck ${live === slot ? "is-live" : "is-standby"}`}
                aria-hidden={live !== slot}
              >
                <Deck
                  {...deckProps}
                  live={live === slot}
                  onPictureLive={() => handlePictureLive(slot)}
                  onSessionLost={() => handleSessionLost(slot)}
                  onSegment={(m) => {
                    if (liveRef.current === slot) setMeta(m);
                  }}
                  onStats={(s) => {
                    if (liveRef.current === slot) setStats(s);
                  }}
                  onQueuePreview={(segments) => {
                    if (liveRef.current === slot) setPreview(segments);
                  }}
                />
              </div>
            );
          })}

          {!onAir && (
            <div className="gate">
              <div className="gate-inner">
                <div className="gate-mark">R24</div>
                <h1 className="gate-title">Rolling news, generated live</h1>
                <p className="gate-copy">
                  A continuous bulletin built segment by segment from live wire feeds. Sound is part
                  of the generation, so the channel needs your go-ahead to start.
                </p>
                <button type="button" className="btn btn-primary" onClick={takeAir}>
                  Take air
                </button>
              </div>
            </div>
          )}

          {onAir && (
            <>
              <div className="overlay overlay-top">
                <ChannelBug program={program} onAir={stats !== null && meta !== null} />
                <Clock />
              </div>
              <div className="overlay overlay-bottom">
                <LowerThird meta={meta} program={program} />
                <Ticker segments={preview} />
              </div>
              {!meta && (
                <div className="slate">
                  <span className="slate-text">Building the first segment…</span>
                </div>
              )}
            </>
          )}
        </div>
      </main>

      <aside className="rail">
        <header className="rail-head">
          <div className="rail-mark">R24 CONTROL</div>
          <div className="rail-sub">{program.name}</div>
        </header>
        <StatusRail stats={stats} airtime={airtime} rotating={rotating} errors={errors} />
        <ScheduleRail program={program} />
        <RundownRail segments={preview} />
        <AnchorControl still={still} onChange={setAnchor} />
      </aside>
    </div>
  );
}
