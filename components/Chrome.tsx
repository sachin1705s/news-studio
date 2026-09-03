"use client";

import { useEffect, useRef, useState } from "react";
import type { Program } from "@/lib/programs";
import { upcoming } from "@/lib/programs";
import { stripTail } from "@/lib/rundown";
import type { Segment } from "@/lib/types";
import type { ClipMeta, DeckStats } from "./Deck";

export function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!now) return <span className="clock" />;
  return (
    <span className="clock">
      {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
    </span>
  );
}

export function ChannelBug({ program, onAir }: { program: Program; onAir: boolean }) {
  return (
    <div className="bug">
      <div className="bug-mark">R24</div>
      <div className={`bug-live ${onAir ? "is-live" : ""}`}>
        <span className="dot" />
        {onAir ? "LIVE" : "STANDBY"}
      </div>
      <div className="bug-prog" style={{ color: program.accent }}>
        {program.name}
      </div>
    </div>
  );
}

export function LowerThird({ meta, program }: { meta: ClipMeta | null; program: Program }) {
  if (!meta) return null;
  const kicker =
    meta.kind === "story" ? "BREAKING" : meta.kind === "bumper" ? "COMING UP" : program.name.toUpperCase();
  return (
    <div className="lower-third" key={meta.slug}>
      <div className="lt-kicker" style={{ background: program.accent }}>
        {kicker}
      </div>
      <div className="lt-body">
        <div className="lt-slug">{stripTail(meta.slug)}</div>
        <div className="lt-strap">{meta.strap}</div>
      </div>
    </div>
  );
}

export function Ticker({ segments }: { segments: Segment[] }) {
  const items = segments.filter((s) => s.kind === "story").map((s) => stripTail(s.slug));
  if (!items.length) return <div className="ticker"><div className="ticker-label">NEWS</div></div>;
  // Duplicated so the marquee has something to scroll into as it loops.
  const run = [...items, ...items];
  return (
    <div className="ticker">
      <div className="ticker-label">NEWS</div>
      <div className="ticker-viewport">
        <div className="ticker-run" style={{ animationDuration: `${items.length * 9}s` }}>
          {run.map((text, i) => (
            <span className="ticker-item" key={i}>
              {text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ScheduleRail({ program }: { program: Program }) {
  const [rows, setRows] = useState<ReturnType<typeof upcoming>>([]);
  useEffect(() => {
    const tick = () => setRows(upcoming(new Date(), 6));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [program.id]);

  return (
    <section className="panel">
      <h2 className="panel-title">Schedule</h2>
      <ol className="sched">
        {rows.map(({ program: p, startsAt, live }) => (
          <li key={`${p.id}-${startsAt.getTime()}`} className={live ? "sched-row is-live" : "sched-row"}>
            <time className="sched-time">
              {startsAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
            </time>
            <div className="sched-body">
              <div className="sched-name" style={live ? { color: p.accent } : undefined}>
                {p.name}
              </div>
              <div className="sched-strap">{p.strap}</div>
            </div>
            {live && <span className="sched-flag">ON AIR</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function RundownRail({ segments }: { segments: Segment[] }) {
  return (
    <section className="panel">
      <h2 className="panel-title">Rundown</h2>
      {segments.length === 0 ? (
        <p className="panel-empty">Waiting on the wire.</p>
      ) : (
        <ol className="rundown">
          {segments.map((s, i) => (
            <li key={s.id} className="run-row">
              <span className="run-index">{String(i + 1).padStart(2, "0")}</span>
              <div className="run-body">
                <div className="run-slug">{stripTail(s.slug)}</div>
                <div className="run-strap">{s.kind === "story" ? s.strap : s.kind.toUpperCase()}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function StatusRail({
  stats,
  airtime,
  rotating,
  errors,
}: {
  stats: DeckStats | null;
  airtime: number;
  rotating: boolean;
  errors: string[];
}) {
  const mins = Math.floor(airtime / 60);
  const secs = Math.floor(airtime % 60);
  return (
    <section className="panel">
      <h2 className="panel-title">Transmission</h2>
      <dl className="stats">
        <div>
          <dt>Airtime</dt>
          <dd>
            {String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}
          </dd>
        </div>
        <div>
          <dt>Building</dt>
          <dd>
            {stats ? `${stats.building}/${stats.buildCapacity}` : "—"}
          </dd>
        </div>
        <div>
          <dt>Ready</dt>
          <dd>{stats ? `${stats.ready}/${stats.readyCapacity}` : "—"}</dd>
        </div>
        <div>
          <dt>Segments run</dt>
          <dd>{stats ? stats.clipsPlayed : "—"}</dd>
        </div>
      </dl>
      {rotating && <p className="rotating">Pre-rolling the next session…</p>}
      {errors.length > 0 && (
        <ul className="errors">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AnchorControl({
  still,
  onChange,
}: {
  still: { blob: Blob; url: string } | null;
  onChange: (blob: Blob | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <section className="panel">
      <h2 className="panel-title">Anchor</h2>
      <p className="panel-note">
        Every segment opens from this still, so the same presenter and set carry across the whole
        broadcast. Without one the anchor is described in words and drifts between segments.
      </p>
      <div className="anchor-row">
        {still ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={still.url} alt="Anchor still" className="anchor-thumb" />
        ) : (
          <div className="anchor-thumb anchor-empty">none</div>
        )}
        <div className="anchor-actions">
          <button type="button" className="btn" onClick={() => input.current?.click()}>
            {still ? "Replace" : "Load still"}
          </button>
          {still && (
            <button type="button" className="btn btn-quiet" onClick={() => onChange(null)}>
              Clear
            </button>
          )}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onChange(file);
          e.target.value = "";
        }}
      />
      <p className="panel-note panel-note-dim">Applies at the next session rotation.</p>
    </section>
  );
}
