# R24 — a news channel that generates itself

A continuous, generated news broadcast. Live wire copy goes in; a lip-synced
anchor with native audio comes out, segment after segment, cutting to footage
and back, on a schedule, without stopping.

![The channel on air](docs/screenshot.jpg)

Everything on screen was generated seconds earlier from a headline that was on
the wire minutes before that. The anchor, the studio, the ticker wall behind
them, the voice — none of it is stock, and none of it is pre-rendered.

---

## Why this is interesting

Generating one talking-head clip is a solved demo. Running a **channel** is a
different problem: something has to be on screen at all times, the next segment
has to be built before the current one ends, and the whole thing has to survive
session limits, dead feeds, and failed generations without ever going to black.

Most of the code here is about that gap.

---

## What it does

**Reads the wire.** A dozen public RSS feeds — BBC, Guardian, NPR, Al Jazeera,
NYT, CNBC, Variety, Deadline, Hollywood Reporter, TechCrunch, Ars Technica,
Hacker News. Deduped across outlets so four papers running one story produce one
segment.

**Writes a rundown.** Not a list of headlines — the shape a bulletin actually
has: a strand open, story packages in blocks of three, a bumper between blocks.

**Builds each segment as one clip.** Every segment becomes exactly one
generation, prompt-engineered against an 800-character cap.

**Cuts to footage.** Stories with context run as packages: the anchor reads the
intro to camera, then the pictures take over while their voice continues
underneath.

![Cutaway package](docs/screenshot-package.jpg)

**Follows a schedule.** Eight dayparts, each rotating 10-minute strands —
Bulletin, Screen Desk, Markets, The Feed, Courtside. *Markets Open* at 9am pulls
business wires and reads clipped and fast; *Night Desk* at 10pm pulls world and
science and reads quiet and close.

---

## Quick start

```bash
git clone <your-fork>
cd live-news-studio
npm install

echo "REACTOR_API_KEY=rk_..." > .env.local   # from reactor.inc

npm run dev
```

Open <http://localhost:3000> and press **Take air**.

The button exists because audio is part of the generation, and browsers refuse
to autoplay unmuted video without a gesture.

### Read this before you press it

**Generation is billed per GPU-second, and it is not cheap.**

| | |
|---|---|
| FastH3 rate | $0.42 / minute |
| One hour on air | $25.20 |
| Literal 24/7 | ~$605 / day |

Billing runs from the moment the session reaches `ready` until it terminates —
**idle or not**, because you are paying for the GPU rather than for the
generation. `connecting` and `waiting` are free.

**The meter stops when you close the tab.** Nothing else stops it. Sessions are
minted with a 1-hour hard cap (`REACTOR_MAX_SESSION_SECONDS`) specifically so a
crashed tab or a closed laptop can't bill for a day.

Treat 24/7 as the design target, not an instruction to leave it running.

### Optional configuration

Everything below is optional — the channel runs fully without any of it.

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Claude writes cutaway shots for the actual headline instead of using the built-in footage library. Strictly an upgrade; nothing breaks without it. |
| `REACTOR_MAX_SESSION_SECONDS` | Hard cap on a single session. Default `3600`. |
| `NEXT_PUBLIC_ROTATE_MINUTES` | Planned session rotation interval. Default `50`. |

**The anchor still.** Load a 16:9 studio photo in the Anchor panel and it is
uploaded once per session and passed as `starting_frame` on every anchor clip,
so the same presenter opens every segment. Without one the anchor is described
in words against a pinned seed — recognisable, but it drifts.

---

## How it works

### Keeping something on screen

FastH3 exposes two queues — clips being **generated**, and built clips waiting to
**play** — and the client owns playback order. The channel turns autoplay on and
then keeps the generation queue as full as the model will accept, so a built clip
is always waiting when the current one ends. `set_flush_on_clip_end(false)` holds
the last frame between segments instead of flashing to black.

### Surviving session boundaries

A session can be minted for up to 24 hours, but sessions still end — expiry,
eviction, a dropped network. Two decks run against that:

```
deck A  ──────── on air ────────┐
deck B          ┌── building off-air ──┴─── on air ────────
                └ cut happens here, once B reports real picture
```

The standby deck connects early, configures, and starts **building and playing
off-air**. The channel cuts only once it reports `clip_started` — cutting to a
deck that is already showing something is what removes the seam. It also reacts
immediately to a session that dies before the planned rotation.

### Writing the prompts

Three modes, because clips share no memory and each prompt must re-establish
everything:

- **Anchor, with a still** — the still carries the set, so the prompt spends its
  characters on motion and sound.
- **Anchor, without one** — has to describe the whole studio every time.
- **Cutaway** — states plainly that *no presenter is on screen* and the anchor is
  heard over the footage. Handed a news script and no such instruction, the model
  puts a presenter back in frame.

The script is fitted to the clip rather than the clip to the script — roughly 2.3
words per second, less head and tail. Context sentences are spoken whole or
dropped whole, because half a sentence cut off at a clip boundary sounds like a
dropped feed. Trims are clause-aware and never land on a dangling preposition.

### Choosing the footage

A headline names a subject but rarely describes a picture. "NBA suspends Clippers
owner Ballmer" has no shot in it.

Building a shot from the headline's own words fails exactly there — abstractions
produce literal nonsense. Broadcasters solved this long before AI: cut to
generic but coherent library footage of the world the story lives in. So each
strand carries a small library of real shots, picked by a stable hash of the
story id so a block never opens the same wide twice.

With `ANTHROPIC_API_KEY` set, Claude writes a shot for the actual headline
instead — the whole block in one request, so shots vary across it.

---

## Project structure

```
lib/feeds.ts        RSS sources by category (each verified live)
lib/programs.ts     the 24h daypart wheel
lib/strands.ts      10-minute blocks inside each daypart
lib/rundown.ts      stories -> ordered segments and packages
lib/prompt.ts       segments -> FastH3 prompts, inside the 800-char cap
lib/stock-shots.ts  the footage library
components/Deck.tsx       one Reactor session that directs itself
components/Broadcast.tsx  two decks, the rotation state machine, the chrome
app/api/news              feed aggregation, dedupe, entity decoding, cache
app/api/broll             Claude shot descriptions (optional)
app/api/reactor/token     scoped fast-h3 JWT, server-side only
```

---

## Notes for anyone building on FastH3

Things that cost time to find out:

- **`get_state` never resolves a value.** Its answer is the `state_update`
  *broadcast*, which reaches every client rather than the caller, so the SDK's
  `sendCommand` has nothing caller-scoped to resolve and returns `undefined`
  however ready the session is. Gate on `status === "ready"` instead.
- **`set_canvas` is idle-gated.** Set the aspect before anything is queued.
- **`set_clip_seconds` replies with `clip_seconds`**, not `seconds`.
- **Clip `metadata`** is echoed back on every message about that clip. Put your
  lower-third text in it and drive the graphics from `clip_started` — then they
  can't drift out of sync with the picture.
- **`max_sessions` counts sessions ever created**, not concurrent ones. A
  rotating channel exhausts a small budget quickly.
- **Two overlapping sessions bill at double.** Keep rotation overlap short.

---

## Limitations

- Reactor allows 5 concurrent sessions; this uses 2 during a rotation.
- A clip that fails to build is skipped, not retried.
- The channel lives in the tab. Close it and the broadcast ends.
- Cutaway footage is generic unless `ANTHROPIC_API_KEY` is set, and even then it
  is generated, not real footage of the actual event. **Nothing this produces is
  a record of anything.** It is a generated presentation of real headlines.

---

## Built with

[Reactor](https://reactor.inc) FastH3 · Next.js · TypeScript

## License

MIT — see `LICENSE`.
