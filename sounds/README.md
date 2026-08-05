# Sounds

This directory is empty on purpose, and the app works with it empty.

`audio.js` looks every cue up optimistically and treats a missing file as
silence rather than as an error. So you can drop in one recording or a hundred,
in any order, and only the ones present will ever be heard. Nothing here needs
registering anywhere — the filename **is** the registration.

Both `.mp3` and `.ogg` are tried, in that order. Either is fine.

## Match cues

| File | When it plays |
|---|---|
| `hit.mp3` | a dart registers. Keep this very short and very quiet — it fires up to three times a visit |
| `bust.mp3` | a visit busted |
| `checkout.mp3` | a leg was won on the finishing dart |
| `win.mp3` | the match is over |

## The caller

| File | When it plays |
|---|---|
| `caller/<total>.mp3` | the announcer calling a completed visit, where `<total>` is 0–180 |

So `caller/180.mp3` is "one hundred and eighty", `caller/100.mp3` is "one
hundred", and so on.

**You do not need all 181.** Recording only the ones worth shouting about —
180, 140, 100, 26 — gives you a caller that speaks up on a big visit and stays
quiet otherwise, which is arguably better than one that reads out every score.
Missing totals are simply not called.

The caller has its own switch in Customize, separate from the other sounds, so
somebody can keep the bust and checkout cues without a voice.

## Recording notes

- Trim the leading silence. A caller that starts 300ms late lands after the
  player has already pulled their darts out.
- Normalise to roughly the same loudness across files. The volume slider is one
  control for all of them.
- Mono is fine and half the size.
