"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currentProgram, type Program } from "@/lib/programs";
import { loadAired, saveAired } from "@/lib/history";
import { STRAND_MINUTES } from "@/lib/strands";
import type { Comment, Segment } from "@/lib/types";
import { Deck, type ClipMeta, type DeckStats, type ViewerTake } from "./Deck";
import { ChannelBug, Clock, CommunityPanel, LowerThird, StatusRail, Ticker } from "./Chrome";
import { ReactorMark } from "./ReactorMark";

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

/**
 * How long the channel keeps generating for nobody.
 *
 * The GPU bills from the moment the session is ready until it disconnects,
 * whether or not anyone is watching and whether or not a clip is building. A
 * backgrounded tab is therefore the most expensive thing this app can do, so a
 * hidden page gets a short grace period and then the channel comes off air and
 * the session is dropped. Coming back is one click.
 *
 * The grace period is generous because tab switching is constant and a rebuild
 * costs about thirty-five seconds of dead air. Five minutes of a hidden tab is
 * about twelve cents of GPU — cheap next to taking the channel off a viewer who
 * only went to check their email.
 */
const UNWATCHED_GRACE_MS = 5 * 60_000;

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

  /** Off air because nobody was watching, as opposed to never started. */
  const [pausedForIdle, setPausedForIdle] = useState(false);
  /** An unattended run: keep transmitting even with the tab in the background. */
  const [transmitMode, setTransmitMode] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);

  /** The channel opens on the startup desk for one block, then joins the wheel. */
  const [openingUntil, setOpeningUntil] = useState<number | null>(null);

  const airStart = useRef<number | null>(null);
  const prerollStart = useRef<number | null>(null);
  /** Story id -> when it last went to air, so a long run does not loop. */
  const usedStoryIds = useRef<Map<string, number>>(new Map());
  const liveRef = useRef<Slot>(0);
  const rotatingRef = useRef(false);
  const commentsRef = useRef<Comment[]>([]);
  // Mirrored after commit rather than during render: these are read by timers
  // and network callbacks, never while rendering.
  useEffect(() => {
    liveRef.current = live;
    rotatingRef.current = rotating;
    commentsRef.current = comments;
  }, [live, rotating, comments]);

  useEffect(() => {
    setTransmitMode(new URLSearchParams(window.location.search).get("transmit") === "1");
  }, []);

  /**
   * Pick up where this browser left off.
   *
   * A refresh used to be a rewind: the aired-story map lived only in a ref, so
   * a reload dealt the same block again and the channel felt stuck. The history
   * is restored here and written back as it runs.
   */
  useEffect(() => {
    usedStoryIds.current = loadAired();
    const id = setInterval(() => saveAired(usedStoryIds.current), 20_000);
    const onLeave = () => saveAired(usedStoryIds.current);
    window.addEventListener("pagehide", onLeave);
    return () => {
      clearInterval(id);
      window.removeEventListener("pagehide", onLeave);
      saveAired(usedStoryIds.current);
    };
  }, []);

  // The channel follows the clock: when the daypart changes, so does the program.
  useEffect(() => {
    const id = setInterval(() => {
      const next = currentProgram();
      setProgram((prev) => (prev.id === next.id ? prev : next));
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  const loadComments = useCallback(async () => {
    try {
      const res = await fetch("/api/community", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { comments?: Comment[] };
      setComments(body.comments ?? []);
    } catch {
      // The community panel is not worth an on-air warning when it fails.
    }
  }, []);

  useEffect(() => {
    // Deferred so the first load is not a synchronous state write inside the
    // effect; the panel is a second behind at most.
    const id = setInterval(() => void loadComments(), 5000);
    const first = setTimeout(() => void loadComments(), 0);
    return () => {
      clearInterval(id);
      clearTimeout(first);
    };
  }, [loadComments]);

  const postComment = useCallback(
    async (author: string, text: string): Promise<string | null> => {
      try {
        const res = await fetch("/api/community", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ author, text }),
        });
        const body = (await res.json()) as { error?: string };
        if (!res.ok) return body.error ?? "Could not post that.";
        await loadComments();
        return null;
      } catch {
        return "Could not reach the studio.";
      }
    },
    [loadComments],
  );

  /**
   * Hand the deck a comment the anchor has something to say about.
   *
   * Oldest first, so the queue is fair rather than recency-biased. Every
   * candidate is marked read whether or not it is answered — a comment the
   * anchor has declined must not be reconsidered on the next block, or the
   * channel spends every refill asking about the same message.
   *
   * At most a few are considered per block: this runs on the path to air, and
   * a long queue of unanswerable comments must not hold up the bulletin.
   */
  const markRead = useCallback((id: string) => {
    setComments((prev) => prev.map((c) => (c.id === id ? { ...c, readAt: Date.now() } : c)));
    void fetch("/api/community", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  }, []);

  const takeComment = useCallback(async (coverage: string[]): Promise<ViewerTake | null> => {
    const unread = commentsRef.current.filter((c) => !c.readAt).sort((a, b) => a.at - b.at);

    for (const candidate of unread.slice(0, 3)) {
      markRead(candidate.id);
      try {
        const res = await fetch("/api/reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ author: candidate.author, text: candidate.text, coverage }),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as { answer?: boolean; reply?: string };
        if (body.answer && body.reply) {
          return {
            id: candidate.id,
            author: candidate.author,
            text: candidate.text,
            reply: body.reply,
          };
        }
      } catch {
        // The anchor stays silent rather than reciting an unanswered comment.
        return null;
      }
    }
    return null;
  }, [markRead]);

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

  /**
   * Drop every session and stop the clock. Unmounting the decks is what
   * actually ends the billing: the SDK disconnects on teardown.
   */
  const goOffAir = useCallback((idle: boolean) => {
    setOnAir(false);
    setPausedForIdle(idle);
    setMounted([false, false]);
    setRotating(false);
    setMeta(null);
    setStats(null);
    setPreview([]);
    airStart.current = null;
    prerollStart.current = null;
    setEpoch((prev) => [prev[0] + 1, prev[1] + 1]);
  }, []);

  const takeAir = useCallback(() => {
    setOnAir(true);
    setMounted([true, false]);
    setLive(0);
    setOpeningUntil(Date.now() + STRAND_MINUTES * 60_000);
    setPausedForIdle(false);
    airStart.current = Date.now();
  }, []);

  /**
   * Nobody is watching this tab. Give it a moment in case they are coming
   * straight back, then take the channel down and stop paying for it.
   *
   * `?transmit=1` opts out. That is for a deliberate unattended run — a
   * transmission tab left going for hours — where coming off air because the
   * operator looked at something else would defeat the point. It is a URL flag
   * rather than a setting because it should be an explicit act each time: this
   * is the one switch that lets the channel bill with nobody watching.
   */
  useEffect(() => {
    if (!onAir || transmitMode) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onVisibility = () => {
      if (document.hidden) {
        timer = setTimeout(() => goOffAir(true), UNWATCHED_GRACE_MS);
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    // A tab hidden before this mounted still counts.
    if (document.hidden) onVisibility();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer) clearTimeout(timer);
    };
  }, [onAir, goOffAir, transmitMode]);

  /**
   * Come back on air by itself when the viewer returns.
   *
   * A television that needed a button press every time you looked away would
   * not be a television. The browser allows this because the viewer already
   * gestured once to start the channel, and that permission holds for the life
   * of the page.
   */
  useEffect(() => {
    if (onAir || !pausedForIdle) return;

    const onVisibility = () => {
      if (!document.hidden) takeAir();
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [onAir, pausedForIdle, takeAir]);

  const deckProps = useMemo(
    () => ({
      program,
      anchorStill: null,
      usedStoryIds,
      onError: pushError,
      takeComment,
    }),
    [program, pushError, takeComment],
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
                  openingUntil={openingUntil}
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
                <h1 className="gate-title">
                  {pausedForIdle ? "Channel paused" : "Startups and technology, around the clock"}
                </h1>
                <p className="gate-copy">
                  {pausedForIdle
                    ? "This tab was in the background, so the channel came off air and released the GPU — it bills by the second whether or not anyone is watching."
                    : "A continuous bulletin built segment by segment from live wire feeds. The channel opens on the startup desk. Sound is part of the generation, so it needs your go-ahead to start."}
                </p>
                <button type="button" className="btn btn-primary" onClick={takeAir}>
                  {pausedForIdle ? "Back on air" : "Take air"}
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

        <StatusRail
          airtime={airtime}
          rotating={rotating}
          errors={errors}
          transmitMode={transmitMode}
        />

        <CommunityPanel comments={comments} onPost={postComment} />

        <a
          className="powered"
          href="https://reactor.inc"
          target="_blank"
          rel="noreferrer noopener"
        >
          <span>Powered by</span>
          <ReactorMark className="powered-mark" />
        </a>
      </aside>
    </div>
  );
}
