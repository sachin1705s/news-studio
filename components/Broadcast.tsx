"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currentProgram, type Program } from "@/lib/programs";
import { loadAired, saveAired } from "@/lib/history";
import { STRAND_MINUTES } from "@/lib/strands";
import type { Comment, Segment } from "@/lib/types";
import {
  Deck,
  ViewerDeck,
  releaseOriginToken,
  type ClipMeta,
  type DeckStats,
  type ViewerTake,
} from "./Deck";
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
/**
 * Rotation is off.
 *
 * It existed to hand over before a session's ceiling by bringing a second deck
 * up early and cutting to it once it had picture — which means two GPUs billing
 * at once, deliberately, every rotation. That is the opposite of running one
 * stream and nothing more, and at 70 credits a second the overlap is not a
 * rounding error. The session ceiling is an hour; when it ends the channel
 * restarts, and a viewer sees a gap rather than a seam.
 */
const ROTATION_ENABLED = false;

/**
 * How long the channel keeps broadcasting to an empty room.
 *
 * The GPU bills from assignment to disconnect regardless of whether anyone is
 * watching, so an audience of nobody is pure loss. The grace period only exists
 * so a viewer refreshing the page, or the count momentarily missing a write,
 * does not take the channel off air underneath them.
 */
const NO_AUDIENCE_GRACE_MS = 90_000;

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
  /** ?ops=1 — shows the operator's controls. Off for everyone else. */
  const [opsMode, setOpsMode] = useState(false);
  /** How many people have the channel open right now. */
  const [watching, setWatching] = useState<number | null>(null);

  /**
   * Whether this browser is running the channel or watching one.
   *
   * Exactly one browser holds the GPU session; everyone else attaches to it.
   * The role is decided at take-air by whether a live channel is already
   * registered, which is what stops a second visitor starting a second stream.
   */
  const [role, setRole] = useState<"idle" | "origin" | "viewer">("idle");
  const [adoptSessionId, setAdoptSessionId] = useState<string | null>(null);
  /** Viewers join muted, because browsers refuse unmuted autoplay without a gesture. */
  const [muted, setMuted] = useState(true);
  /** Bumped to retry the join while another browser is still starting up. */
  const [joinAttempt, setJoinAttempt] = useState(0);
  /** Media is flowing. Distinct from having a lower third to show. */
  const [hasPicture, setHasPicture] = useState(false);
  /** When the audience last stood at zero, for the empty-room shutdown. */
  const emptySince = useRef<number | null>(null);
  /** Live balance and the rate it is falling, which is how many sessions are up. */
  const [credits, setCredits] = useState<{ balance: number; perSecond: number | null } | null>(null);
  const lastBalance = useRef<{ balance: number; at: number } | null>(null);
  const originId = useRef<string>("");
  const [comments, setComments] = useState<Comment[]>([]);

  /** The channel opens on the startup desk for one block, then joins the wheel. */
  const [openingUntil, setOpeningUntil] = useState<number | null>(null);

  const airStart = useRef<number | null>(null);
  /** The session id of the broadcast this browser created, once it has one. */
  const liveSessionId = useRef<string | null>(null);
  const lastRegisterAt = useRef(0);
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
    const params = new URLSearchParams(window.location.search);
    setTransmitMode(params.get("transmit") === "1");
    // The operator's controls are not the audience's business: the account
    // balance, what it is burning and the button that takes the channel off
    // air have no place on a page anyone can open.
    setOpsMode(params.get("ops") === "1");
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

  const pushError = useCallback((message: string) => {
    setErrors((prev) => (prev[0] === message ? prev : [message, ...prev].slice(0, 4)));
  }, []);

  useEffect(() => {
    const KEY = "r24.origin";
    try {
      originId.current = window.localStorage.getItem(KEY) ?? "";
      if (!originId.current) {
        originId.current = crypto.randomUUID();
        window.localStorage.setItem(KEY, originId.current);
      }
    } catch {
      originId.current = crypto.randomUUID();
    }
  }, []);

  /**
   * Register the session this browser created, so others attach to it.
   *
   * The claim is first-come. Losing it means someone else started the channel
   * in the moments between the check and the session coming up — so this
   * browser stands down and watches theirs instead of running a second stream.
   */
  const registerChannel = useCallback(async (sessionId: string, force = false) => {
    if (!force && Date.now() - lastRegisterAt.current < 60_000) return;
    lastRegisterAt.current = Date.now();
    try {
      const res = await fetch("/api/channel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, originId: originId.current }),
      });
      if (!res.ok) return;
      const body = (await res.json()) as {
        claimed?: boolean;
        channel?: { sessionId: string } | null;
      };
      if (body.claimed === false && body.channel?.sessionId) {
        pushError("Another browser is already broadcasting. Watching theirs.");
        setAdoptSessionId(body.channel.sessionId);
        setRole("viewer");
      }
    } catch {
      // The registry is how others find this broadcast; failing to reach it
      // does not stop this browser watching its own.
    }
  }, [pushError]);

  // Keep the registration warm while broadcasting; retire it on the way out.
  useEffect(() => {
    if (role !== "origin" || !onAir) return;
    const id = setInterval(() => {
      const sid = liveSessionId.current;
      if (sid) void registerChannel(sid, true);
    }, 60_000);

    const retire = () => {
      navigator.sendBeacon?.(
        "/api/channel",
        new Blob([JSON.stringify({ originId: originId.current })], { type: "application/json" }),
      );
    };
    window.addEventListener("pagehide", retire);
    return () => {
      clearInterval(id);
      window.removeEventListener("pagehide", retire);
    };
  }, [role, onAir, registerChannel]);

  /**
   * Take over the channel because nothing is actually broadcasting.
   *
   * Clears the registration first: it names a session that is gone, and any
   * other arrival that reads it would attach to the same corpse.
   */
  const takeOverDeadChannel = useCallback(async () => {
    // Fresh credential for a fresh broadcast. Done here, before a session
    // exists — swapping the token under a running one leaves the SDK holding a
    // credential that did not create the session, which cannot even terminate
    // it, and the connection churns.
    releaseOriginToken();
    try {
      await fetch("/api/channel", { method: "DELETE" });
      // Reserve the channel BEFORE bringing a session up. Creating first and
      // claiming after meant two arrivals in the same moment each paid for a
      // GPU before one stood down — real money, on a metered account.
      const res = await fetch("/api/channel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ originId: originId.current }),
      });
      const body = (await res.json()) as { claimed?: boolean };
      if (body.claimed === false) {
        // Someone beat us to it. Wait for their session and adopt it.
        setRole("idle");
        return;
      }

      // Ask for the credential before mounting anything. The gate refuses if a
      // broadcast came up while this browser was reserving, and finding that
      // out here means becoming a viewer of it — rather than mounting a deck
      // whose connection then fails with nothing on screen and no way back.
      const tok = await fetch("/api/reactor/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ originId: originId.current }),
      });
      if (tok.status === 409) {
        const held = (await tok.json()) as { sessionId?: string };
        if (held.sessionId) {
          setAdoptSessionId(held.sessionId);
          setRole("viewer");
          setMuted(true);
          setOnAir(true);
          airStart.current = Date.now();
          return;
        }
        setRole("idle");
        return;
      }
    } catch {
      // Unreachable registry: better a broadcast than a dead channel.
    }
    setAdoptSessionId(null);
    setRole("origin");
    setMounted([true, false]);
    setLive(0);
    setOpeningUntil(Date.now() + STRAND_MINUTES * 60_000);
    setOnAir(true);
    // No click has happened, so sound has to wait for the prompt.
    setMuted(true);
    airStart.current = Date.now();
  }, []);

  /**
   * Join whatever is already on air, without being asked.
   *
   * A viewer arriving at a running channel should see the channel, not a door.
   * The join is muted because browsers refuse unmuted autoplay without a
   * gesture — the picture starts immediately and one tap brings the sound.
   */
  useEffect(() => {
    if (onAir || role !== "idle") return;
    let cancelled = false;
    const retry = setTimeout(() => setJoinAttempt((n) => n + 1), 6000);

    (async () => {
      try {
        const res = await fetch("/api/channel", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as {
          channel?: { sessionId: string } | null;
          reserved?: boolean;
        };
        const sid = body.channel?.sessionId;
        if (cancelled) return;
        // Somebody is mid-start. Leave them to it and pick them up next tick.
        if (!sid && body.reserved) return;
        if (!sid) {
          // Nobody is broadcasting. Rather than show a door, be the channel.
          void takeOverDeadChannel();
          return;
        }
        setAdoptSessionId(sid);
        setRole("viewer");
        setMuted(true);
        setOnAir(true);
        airStart.current = Date.now();
      } catch {
        // Nothing on air, or unreachable: the gate stays and offers to start one.
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [onAir, role, takeOverDeadChannel, joinAttempt]);

  /**
   * Drop every session and stop the clock. Unmounting the decks is what
   * actually ends the billing: the SDK disconnects on teardown.
   */
  const goOffAir = useCallback((idle: boolean) => {
    setOnAir(false);
    setHasPicture(false);
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

  /**
   * Join the channel.
   *
   * If someone is already broadcasting, this browser attaches to their session
   * and watches it. Only when nobody is does it start one — so the first person
   * through the door pays for the GPU and everybody after them is free.
   */
  /**
   * Stop broadcasting to an empty room.
   *
   * This is the only thing standing between an unattended tab and a bill: a
   * session left running overnight with nobody watching costs the same as one
   * with an audience. Transmission mode does not exempt it — that flag is about
   * a backgrounded tab, not about paying for nobody.
   */
  useEffect(() => {
    if (role !== "origin" || !onAir || watching === null) return;

    if (watching > 0) {
      emptySince.current = null;
      return;
    }

    if (emptySince.current === null) emptySince.current = Date.now();
    if (Date.now() - emptySince.current < NO_AUDIENCE_GRACE_MS) return;

    emptySince.current = null;
    void fetch("/api/channel", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ originId: originId.current }),
    }).catch(() => {});
    setRole("idle");
    goOffAir(true);
  }, [role, onAir, watching, goOffAir]);

  /**
   * Watch the balance, and infer from it what is actually running.
   *
   * Every other number here is what this browser believes it started. The
   * balance is the only one that reflects the truth: a session started by an
   * old tab on a stale build is invisible to the registry but not to the
   * meter. Divide the rate of fall by one session's rate and you have the
   * count — which is why the burn is shown as a multiple.
   */
  useEffect(() => {
    if (!opsMode) return;
    let alive = true;

    const read = async () => {
      try {
        const res = await fetch("/api/credits", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { balance?: number; at?: number };
        if (!alive || typeof body.balance !== "number") return;

        const now = body.at ?? Date.now();
        const prev = lastBalance.current;
        // Only over a long enough gap to be meaningful, and only while falling.
        const perSecond =
          prev && now - prev.at > 30_000 && prev.balance > body.balance
            ? ((prev.balance - body.balance) / (now - prev.at)) * 1000
            : null;

        setCredits((was) => ({ balance: body.balance!, perSecond: perSecond ?? was?.perSecond ?? null }));
        if (!prev || now - prev.at > 30_000) lastBalance.current = { balance: body.balance, at: now };
      } catch {
        // A missing balance is not worth interrupting a broadcast over.
      }
    };

    void read();
    const id = setInterval(() => void read(), 45_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [opsMode]);

  /**
   * Announce this viewer, and read back how many others are here.
   *
   * A heartbeat rather than connect/disconnect: the web has no reliable
   * disconnect, so viewers are counted while they keep announcing themselves
   * and forgotten when they stop. Only a visible tab beats, because a
   * backgrounded tab is not somebody watching.
   */
  useEffect(() => {
    const KEY = "r24.viewer";
    let id = "";
    try {
      id = window.localStorage.getItem(KEY) ?? "";
      if (!id) {
        id = crypto.randomUUID();
        window.localStorage.setItem(KEY, id);
      }
    } catch {
      // Private window or blocked storage: still count, just not across reloads.
      id = crypto.randomUUID();
    }

    let alive = true;
    const beat = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch("/api/presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (!res.ok) return;
        const body = (await res.json()) as { watching?: number };
        if (alive && typeof body.watching === "number") setWatching(body.watching);
      } catch {
        // The counter is decoration; its failure is not worth surfacing.
      }
    };

    const first = setTimeout(() => void beat(), 0);
    const id2 = setInterval(() => void beat(), 60_000);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(id2);
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
        // Read as text first: a crashed route replies with an HTML error page,
        // and calling res.json() on that throws, which used to be reported as
        // an unreachable studio for a comment the studio had accepted.
        const raw = await res.text();
        let body: { error?: string; stored?: boolean } = {};
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          return `The studio replied with something unreadable (${res.status}).`;
        }
        if (!res.ok) return body.error ?? "Could not post that.";
        await loadComments();
        // It is going on air regardless; say so plainly if it will not be kept.
        return body.stored === false ? "On air, but not saved — storage is unavailable." : null;
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
      // The lower third is left standing. Blanking it turns a gap the viewer
      // might not notice into an obviously dead channel.
      beginPreroll();
    },
    [beginPreroll, pushError],
  );

  const handlePictureLive = useCallback(
    (slot: Slot) => {
      setHasPicture(true);
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

      if (ROTATION_ENABLED && !rotatingRef.current) {
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

  const takeAir = useCallback(async () => {
    setPausedForIdle(false);

    let existing: string | null = null;
    try {
      const res = await fetch("/api/channel", { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { channel?: { sessionId: string } | null };
        existing = body.channel?.sessionId ?? null;
      }
    } catch {
      // Unreachable registry: start a broadcast rather than show nothing.
    }

    if (existing) {
      setAdoptSessionId(existing);
      setRole("viewer");
      // Started by a click, so sound is allowed.
      setMuted(false);
      setOnAir(true);
      airStart.current = Date.now();
      return;
    }

    releaseOriginToken();
    setRole("origin");
    setAdoptSessionId(null);
    setMuted(false);
    setOnAir(true);
    setMounted([true, false]);
    setLive(0);
    setOpeningUntil(Date.now() + STRAND_MINUTES * 60_000);
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
          {role === "viewer" && adoptSessionId && (
            <div className="deck is-live">
              <ViewerDeck
                sessionId={adoptSessionId}
                program={program}
                muted={muted}
                onSegment={setMeta}
                onPictureLive={() => {
                  setHasPicture(true);
                  if (airStart.current === null) airStart.current = Date.now();
                }}
                onSessionLost={() => {
                  // The broadcast this viewer was watching ended. Rejoin
                  // whatever is running now, or start one — never drop the
                  // viewer back to a door they already walked through.
                  setAdoptSessionId(null);
                  void takeAir();
                }}
                onDeadSession={() => {
                  // Attached, waited, saw nothing. Have the stuck session
                  // closed before starting a new one — otherwise the gate
                  // refuses, because from its side a session is still open.
                  const dead = adoptSessionId;
                  void (async () => {
                    if (dead) {
                      await fetch("/api/reclaim", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ sessionId: dead }),
                      }).catch(() => {});
                    }
                    await takeOverDeadChannel();
                  })();
                }}
                onError={pushError}
              />
            </div>
          )}

          {role === "origin" && [0, 1].map((n) => {
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
                    // Driven by the picture rather than a timer: a backgrounded
                    // tab has its intervals throttled to about once a minute,
                    // which let the registration lapse and invited the next
                    // visitor to start a second session.
                    const sid = liveSessionId.current;
                    if (sid) void registerChannel(sid);
                  }}
                  onStats={(s) => {
                    if (liveRef.current === slot) setStats(s);
                  }}
                  onQueuePreview={(segments) => {
                    if (liveRef.current === slot) setPreview(segments);
                  }}
                  onSessionId={(sid) => {
                    if (liveSessionId.current === sid) return;
                    liveSessionId.current = sid;
                    void registerChannel(sid);
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
                    ? "Nobody was watching, so the channel came off air and released the GPU — it bills by the second whether or not anyone is here."
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
                <ChannelBug program={program} watching={watching} />
                <Clock />
              </div>
              <div className="overlay overlay-bottom">
                <LowerThird meta={meta} program={program} />
                <Ticker segments={preview} />
              </div>
              {!hasPicture && (
                <div className="slate">
                  <span className="slate-text">
                    {role === "viewer" ? "Joining the channel…" : "Building the first segment…"}
                  </span>
                </div>
              )}
              {muted && role === "viewer" && (
                <button
                  type="button"
                  className="unmute"
                  onClick={() => setMuted(false)}
                  aria-label="Turn on sound"
                >
                  <span>Tap for sound</span>
                </button>
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

        {opsMode && role === "origin" && onAir && (
          <button
            type="button"
            className="btn btn-stop"
            onClick={() => {
              // Unmounting the decks is what ends the session and the billing.
              void fetch("/api/channel", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ originId: originId.current }),
              }).catch(() => {});
              setRole("idle");
              goOffAir(false);
            }}
          >
            Stop broadcast · releases the GPU
          </button>
        )}

        <StatusRail
          airtime={airtime}
          rotating={rotating}
          errors={errors}
          transmitMode={transmitMode}
          watching={watching}
          credits={opsMode ? credits : null}
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
