"use client";

import { useEffect, useState } from "react";
import type { Program } from "@/lib/programs";
import { relative, stripTail } from "@/lib/rundown";
import type { Comment, Segment } from "@/lib/types";
import type { ClipMeta } from "./Deck";

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

export function ChannelBug({
  program,
  onAir,
  watching,
}: {
  program: Program;
  onAir: boolean;
  watching: number | null;
}) {
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
      {watching !== null && watching > 0 && (
        <div className="bug-watching" title="People with the channel open right now">
          {watching} watching
        </div>
      )}
    </div>
  );
}

/**
 * The lower third.
 *
 * Four states, because four kinds of clip go to air. A studio read carries the
 * strand's kicker and the headline. A cutaway keeps them up so the story does
 * not lose its label when the anchor leaves the screen. A correspondent gets
 * the red LIVE flag and where they are standing, which is the whole point of
 * sending them. Viewer mail is credited to whoever wrote it.
 */
export function LowerThird({ meta, program }: { meta: ClipMeta | null; program: Program }) {
  if (!meta) return null;

  if (meta.kind === "reporter") {
    return (
      <div className="lower-third is-reporter" key={meta.slug}>
        <div className="lt-row">
          <div className="lt-kicker is-live">
            <span className="dot" />
            LIVE
          </div>
          <div className="lt-body">
            <div className="lt-slug">{stripTail(meta.slug)}</div>
            <div className="lt-strap">{meta.location ?? "On location"}</div>
          </div>
        </div>
      </div>
    );
  }

  if (meta.kind === "viewer") {
    return (
      <div className="lower-third is-viewer" key={meta.slug}>
        <div className="lt-row">
          <div className="lt-kicker" style={{ background: program.accent }}>
            YOUR VIEW
          </div>
          <div className="lt-body">
            <div className="lt-slug">{meta.author ?? "A viewer"} writes</div>
            <div className="lt-strap">{meta.strap}</div>
          </div>
        </div>
      </div>
    );
  }

  const kicker =
    meta.kind === "bumper"
      ? "COMING UP"
      : meta.kind === "story" || meta.kind === "broll"
        ? meta.kicker
        : meta.strand.toUpperCase();

  return (
    <div className="lower-third" key={meta.slug}>
      {meta.breaking && <div className="breaking-band">BREAKING NEWS</div>}
      <div className="lt-row">
        <div className="lt-kicker" style={{ background: program.accent }}>
          {kicker}
        </div>
        <div className="lt-body">
          <div className="lt-slug">{stripTail(meta.slug)}</div>
          <div className="lt-strap">{meta.strap}</div>
        </div>
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

export function StatusRail({
  airtime,
  rotating,
  errors,
  transmitMode,
  watching,
}: {
  airtime: number;
  rotating: boolean;
  errors: string[];
  transmitMode?: boolean;
  watching: number | null;
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
          <dt>Watching</dt>
          <dd>{watching === null ? "—" : watching}</dd>
        </div>
      </dl>
      {transmitMode && (
        <p className="transmit">Transmission mode · will not pause when unwatched</p>
      )}
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

/**
 * The community.
 *
 * Comments are the audience's, so they are shown verbatim and credited. Every
 * one of them goes to the anchor, who answers it on air within about a minute —
 * which is what makes this part of the channel rather than a chat box beside it.
 */
export function CommunityPanel({
  comments,
  onPost,
}: {
  comments: Comment[];
  onPost: (author: string, text: string) => Promise<string | null>;
}) {
  const [author, setAuthor] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">Community</h2>
        <span className="panel-note-inline">Every comment goes on air</span>
      </div>

      <form
        className="comment-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim() || busy) return;
          setBusy(true);
          setError(null);
          const failure = await onPost(author, text);
          setBusy(false);
          if (failure) setError(failure);
          else setText("");
        }}
      >
        <input
          className="field field-name"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          placeholder="Your name"
          maxLength={32}
        />
        <textarea
          className="field field-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Say something about what's on air…"
          maxLength={240}
          rows={2}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
          {busy ? "Sending…" : "Post"}
        </button>
        {error && <p className="comment-error">{error}</p>}
      </form>

      {comments.length === 0 ? (
        <p className="panel-empty">No one has said anything yet.</p>
      ) : (
        <ul className="comments">
          {comments.map((c) => (
            <li key={c.id} className="comment">
              <div className="comment-head">
                <span className="comment-author">{c.author}</span>
                <span className="comment-time">{relative(c.at)}</span>
                {c.readAt && <span className="comment-read">READ ON AIR</span>}
              </div>
              <p className="comment-text">{c.text}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
