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
 * Reactor ends a session at 20 minutes. To keep one continuous channel, two
 * decks are run against the clock: the standby deck is brought up and left to
 * build and play off-air, and once it has real picture the channel cuts to it
 * and the spent session is dropped. Nothing on screen stops.
 */
const HARD_LIMIT_MS = 20 * 60_000;
const PREROLL_AT_MS = 15.5 * 60_000;
/** If the standby deck never produces picture, cut anyway rather than run into the cap. */
const FORCE_CUT_AT_MS = 18.5 * 60_000;

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

  const handlePictureLive = useCallback(
    (slot: Slot) => {
      if (slot === liveRef.current) {
        // The on-air deck just produced its first frames.
        if (airStart.current === null) airStart.current = Date.now();
        return;
      }
      // The standby deck has picture — take it.
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

      const standby = other(liveRef.current);
      if (elapsed >= PREROLL_AT_MS && !rotatingRef.current) {
        setRotating(true);
        setMounted((prev) => {
          const next: [boolean, boolean] = [...prev];
          next[standby] = true;
          return next;
        });
      }
      if (elapsed >= FORCE_CUT_AT_MS && rotatingRef.current) {
        cutTo(standby);
      }
      if (elapsed >= HARD_LIMIT_MS) {
        // The session is gone; restart the current slot rather than sit on a dead feed.
        airStart.current = Date.now();
        setEpoch((prev) => {
          const next: [number, number] = [...prev];
          next[liveRef.current] += 1;
          return next;
        });
      }
    }, 500);
    return () => clearInterval(id);
  }, [onAir, cutTo]);

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
