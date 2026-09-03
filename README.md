# R24 — Live News Studio

A rolling news channel that generates itself. Live wire copy goes in one end;
a lip-synced anchor with native audio comes out the other, segment after
segment, without stopping.

Built on Reactor's **FastH3** (`fast-h3`) — the one model in the catalogue that
generates picture and sound together and exposes a client-driven playout queue,
which is what makes a continuous channel possible rather than a series of clips.

## Running it

```bash
echo "REACTOR_API_KEY=rk_..." > .env.local
npm install
npm run dev
```

Open http://localhost:3000 and press **Take air**. The button exists because
audio is part of the generation, and browsers refuse to autoplay unmuted video
without a gesture.

## How it works

**The wire → a rundown.** `app/api/news` pulls a dozen public RSS feeds, strips
the markup, dedupes stories that four outlets are all running, and interleaves
categories so a program drawing on two feeds alternates instead of exhausting
one. `lib/rundown.ts` shapes the result the way a bulletin is actually shaped:
a program open, story packages in blocks of three, a bumper between blocks, and
a sign-off.

**A rundown → prompts.** Each segment becomes exactly one clip. FastH3 clips
share no memory, so every prompt re-establishes its scene from nothing, inside
an 800-character cap. `lib/prompt.ts` spends those characters differently
depending on whether an anchor still is loaded: with one, the still carries the
set and the prompt buys motion and sound; without one, it has to describe the
whole studio every time.

The spoken line is fitted to the clip's length rather than the clip stretched to
the line — roughly 2.3 words a second, less the head and tail. Context sentences
are spoken whole or dropped whole, because half a sentence cut off at a clip
boundary sounds like a dropped feed.

**Prompts → continuous picture.** `set_autoplay` keeps the playout queue
draining on its own; the deck keeps the generation queue as full as the model
will allow, so a built clip is always waiting. `set_flush_on_clip_end(false)`
holds the last frame between segments instead of flashing to black.

**Sessions → 24/7.** Reactor ends a session at twenty minutes. Two decks run
against that clock: at 15m30s the standby deck connects, configures, and starts
building and playing *off-air*; the moment it reports real picture the channel
cuts to it and the spent session is dropped. The seam is a 240ms crossfade
between two live video elements. Nothing on screen stops.

## The anchor

Load a 16:9 studio still in the **Anchor** panel. It is uploaded once per
session and passed as `starting_frame` on every clip, so the same presenter and
the same set open every segment — which is what makes the output read as one
broadcast rather than a reel. It applies at the next rotation.

Without a still the channel still runs: the anchor is described in words against
a pinned seed, so they stay in the same register but the face drifts between
segments.

## Programming

`lib/programs.ts` is a 24-hour wheel — eight dayparts, each with its own feeds,
set, music bed, anchor register and lead-in phrasing. The channel reads the
clock and follows it, so *Markets Open* at 9am pulls business wires and reads
clipped and fast, while *Night Desk* at 10pm pulls world and science and reads
quiet and close. Editing the array changes the schedule; the on-screen rail
renders whatever is in it.

## Layout

```
lib/feeds.ts      RSS sources, one per category (all verified live)
lib/programs.ts   the 24h schedule wheel
lib/rundown.ts    stories -> ordered segments
lib/prompt.ts     segments -> FastH3 prompts, inside the 800-char cap
components/Deck.tsx       one Reactor session that directs itself
components/Broadcast.tsx  two decks, the rotation state machine, the chrome
app/api/news              feed aggregation + dedupe + 4min cache
app/api/reactor/token     scoped fast-h3 JWT, server-side only
```

## Known limits

- Reactor allows 5 concurrent sessions; this uses 2 during a rotation.
- Generation is not free — the channel bills for GPU time from assignment to
  disconnect, continuously, by design.
- A clip that fails to build is skipped, not retried; the queue moves on.
