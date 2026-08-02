# Format reference

Everything you need to go from an idea to a finished scene.

---

## From an idea

Two routes. With a local model installed (Ollama), the engine writes it for you — the
**Write…** button in the Scenes panel, or:

```bash
npm run anim -- write "Office Space tone, but the coffee machine has become a middle manager"
```

Sets too — **Describe a new set…** in the Sets panel, or:

```bash
npm run anim -- sets describe "a cramped break room at night with a vending machine"
```

Set generation is constrained by JSON Schema built from the live prop registry, so the model
*cannot* name a prop or palette that doesn't exist. Scripts get validated by the same parser
the engine uses, with one retry if the output isn't renderable.

The model is unloaded the moment it responds, and again before any render — a 14B model plus
Chatterbox on one 16GB card is where a machine starts thrashing, and they never need to be
resident together.

### Without a local model

Claude Code is the writer. Paste this, with your premise swapped in:

> Write a scene for my animation engine at `F:\Development\animation-engine`.
> Read `docs/FORMAT.md` first for the exact format.
>
> **Premise:** *Office Space tone, but with Douglas Adams cosmic absurdity — the office is
> being relocated three seconds into the past for tax reasons.*
>
> Constraints:
> - 2–3 characters, 15–25 lines, roughly 60–90 seconds
> - Everyone is standing in a room talking — no action the puppets can't do
> - Deadpan is the default; put the joke in the pause, not in a punchline
> - Use `[BEAT ...]` liberally, and vary the lengths
> - Parentheticals on most lines — they drive the vocal performance, not just the face
>
> Save it to `scripts/<name>.md`, then run `npm run anim -- check <name>.md` and fix
> anything it flags.

Then render it. That's the whole loop: premise → script → check → MP4.

The constraints matter more than they look. The engine animates people standing and
talking, so a script that calls for a car chase produces two people describing a car chase.
Write to what it does well and it does it well.

---

## The workflow

```bash
npm run anim -- new my-scene
```

```bash
npm run anim -- check my-scene.md
```

```bash
npm run anim -- render my-scene.md --set office
```

`new` scaffolds a script with the format documented inline. `check` parses, directs and
validates in under a second — use it as the tight loop while writing. `render` does the
slow part: voices, lipsync, frames, mux.

**Characters are cast automatically.** Any name that speaks and has no puppet gets one
generated, with a look, palette and voice derived from the name. There is no setup step.

---

## Script format

A loose [Fountain](https://fountain.io) subset. Plain text, any editor.

| You write | It becomes |
|---|---|
| `# Some Title` | the piece's title (first one wins) |
| `INT. OFFICE - DAY` | scene heading |
| `BRENT` alone on a line, ALL CAPS | character cue — next non-blank line is their dialogue |
| `(deadpan)` directly under a cue | how the line is drawn **and performed** |
| `[BEAT 1500]` | a pause in milliseconds |
| anything else | action — held on a wide shot |
| `// note to self` | comment, ignored entirely |

```
# THE RELOCATION

INT. OPEN PLAN OFFICE - MORNING

Brent approaches holding a clipboard he has never once written on.

BRENT
(deadpan)
We're relocating the office three seconds into the past. Effective Monday.

[BEAT 1500]

PAUL
(confused)
Why would we do that.

BRENT
(smug)
Tax reasons.
```

### Rules worth knowing

- A cue must be **all caps with no lowercase**. `BRENT` is a cue; `Brent` is action.
- An all-caps line with **nothing after it** is action, not a cue — so
  `SOMEWHERE, A PHONE RINGS` behaves as you'd expect.
- Dialogue **wraps freely**; consecutive lines are joined until a blank line.
- Beats are **explicit on purpose**. In this genre the pause is the joke, and its length is
  a writing decision, not something to infer. `[BEAT]` alone defaults to 800ms.

---

## Parentheticals

The parenthetical is the highest-leverage thing you write. It sets the face **and** the
vocal delivery — Chatterbox's emotion controls are driven from it, so a `(deadpan)` line is
performed flat and slow rather than merely drawn that way.

Matched by keyword, so write naturally — `(really quite annoyed)` hits `ANGRY`.

| Keywords | Expression | Delivery |
|---|---|---|
| deadpan, flat, monotone, blank | `DEADPAN` | flattest, slowest — **the default** |
| exhausted, weary, drained, worn out, tired | `EXHAUSTED` | hollow, head hangs |
| sad, defeated, deflated, quiet, resigned | `SAD` | subdued |
| suspicious, sceptical, doubtful, wary, dubious | `SUSPICIOUS` | guarded; eyes cut sideways |
| confused, puzzled, unsure, baffled | `CONFUSED` | mild, head tilt |
| warm, friendly, calm, even | `NEUTRAL` | baseline |
| smug, pleased, satisfied, smirking, proud | `SMUG` | slight lift, head tilt |
| delighted, thrilled, grinning, cheerful, happy | `JOY` | bright, quick |
| angry, annoyed, irritated, snaps, yells, mad | `ANGRY` | loud; shakes the camera on `!` |
| shocked, surprised, alarmed, startled, panicked | `SHOCKED` | loudest; blinking suppressed |

No parenthetical means `DEADPAN`. Override the baseline with `--resting NEUTRAL`.

Each expression sets a **resting mouth** as well as the eyes and brows — a `SMUG` character
holds a smirk between lines, a `SAD` one holds a frown. Lipsync overrides it only while they
are actually speaking, so the expression does its real work in the pauses, which in this
style is where the joke usually is.

If a character's rig predates an expression, the director falls back to the nearest one it
does have rather than failing — so an older hand-drawn puppet with six faces still renders.

---

## What the director decides for you

From the script alone it picks shots, staging, gestures, reactions and camera moves. The
rules that matter:

- **Short lines get close-ups.** Four words or fewer cuts tight.
- **Pauses cut to whoever is being spoken to** — specifically the person who spoke before
  the current speaker, not just any non-speaker. That's the reaction shot, and it's the
  single most useful move in this style.
- **Stillness beats gesticulating.** A deadpan character on a short line just stands there.
- **Long pauses push in slowly.** 1500ms or more gets a slow dolly, which makes the
  awkwardness worse, correctly.
- **Two people face each other** from `SL` and `SR`; a third takes `CENTER`.

### Vocabulary

Shots `WIDE` `MID` `CU` `ECU` `OTS` `TWO_SHOT` · Camera `HOLD` `PUSH_IN` `PULL_OUT` `PAN_L`
`PAN_R` `SHAKE` · Gestures `NONE` `TALK` `POINT` `SHRUG` `ARMS_UP` `LEAN_IN` · Marks
`FAR_L` `SL` `CENTER` `SR` `FAR_R`

---

## Overriding the director

`render` writes `out/<scene>/shotlist.json` — every decision, in a readable file.

```json
{
  "kind": "line",
  "speaker": "brent",
  "text": "Tax reasons.",
  "expression": "SMUG",
  "gesture": "NONE",
  "shot": "CU",
  "focus": ["brent"],
  "camera": "HOLD",
  "reactions": { "paul": "DEADPAN" }
}
```

Edit it, then re-render reusing your edits:

```bash
npm run anim -- render my-scene.md --set office --shotlist
```

Only genuinely changed lines re-synthesize — the voice cache is keyed by content, not by
line number. Changing `expression` changes both the face and the vocal performance.

`reactions` is where a lot of the comedy is: it sets what everyone *else* is doing while a
line lands.

---

## Sets

`--set office` uses a set. Three ship built in and are written to `sets/` on first use:
**office**, **dive-bar**, **roadside**.

```bash
npm run anim -- sets                    # what exists
npm run anim -- sets props --tag bar    # what a set can contain
npm run anim -- sets palettes           # available moods
npm run anim -- sets preview dive-bar   # render it with characters staged in it
```

A set is a JSON descriptor, not code — a palette, a layout, and props on three layers:

```json
{
  "name": "dive-bar",
  "palette": "bar-night",
  "layout": { "horizonY": 580, "ceilingY": 70, "marginX": 420, "marginY": 220 },
  "layers": {
    "back": [{ "prop": "room-wall" }, { "prop": "neon-sign", "x": 330, "params": { "text": "OPEN" } }],
    "mid":  [{ "prop": "bar-counter", "x": 950, "params": { "width": 520 } }],
    "fore": [{ "prop": "stool", "x": 760 }]
  }
}
```

### Layers are depth

**Characters render between `mid` and `fore`.** So `mid` props pass behind people and `fore`
props pass in front of them. Put a bar in `mid` and stools in `fore` and someone can stand
at the bar rather than on top of it.

### Palettes

Props never hardcode colours — they read slots from the active palette. Changing
`"palette": "bar-night"` to `"exterior-dusk"` retints the entire set. Available:
`office-fluorescent`, `bar-night`, `home-warm`, `exterior-day`, `exterior-dusk`, `void`.

### Margins

`marginX` / `marginY` make the artwork extend past the 1280×720 stage. This is not
decoration: close-ups and pans move the camera off-centre and it is deliberately not clamped
to the stage, so without margin the frame runs off the edge of the world. Keep them ≥ 400
unless every shot is a wide.

### Positioning

`x` and `y` are set coordinates; `y` defaults to the floor, which is what you want for
anything that stands on it. Props that hang or mount (`ceiling-light`, `clock`, `poster`,
`neon-sign`) place themselves or take a `y` param measured **off the floor, upward**.
Spanning props (`room-wall`, `room-floor`, `sky`) cover everything and ignore `x`.

Every prop is validated against the registry before rendering, so a typo names itself rather
than silently drawing nothing.

---

## Voices

| | |
|---|---|
| `--voice-engine chatterbox` | default. Neural, emotional, clones voices. Needs GPU + venv. |
| `--voice-engine sapi` | Windows built-in. Instant, no setup, sounds like 2009. Good for drafts. |

**Cloning.** Put ~5–10s of clean speech under `cast/`, then set `voiceRef` in
`cast/<name>.rig.json`. That character now sounds like that person.

**Your own performance.** Drop a WAV at `out/<scene>/vo/<NNN>-<speaker>.wav` — numbered by
beat index, which `check` prints — and that line uses your recording, lipsynced by Rhubarb
from the actual audio. Everything downstream is unchanged.

---

## Flags

| | |
|---|---|
| `--set office` | background set (generated on first use) |
| `--seed 7` | changes blinks, gesture jitter and shot variation |
| `--resting DEADPAN` | baseline expression for unmarked lines |
| `--fps 24 --char-fps 12` | render rate vs character rate. Lower char-fps is choppier and more "cheap TV" |
| `--voice-engine` | `chatterbox` or `sapi` |
| `--shotlist` | reuse your edited shot list |

---

## Troubleshooting

**"No characters found"** — a cue must be ALL CAPS alone on its line, with dialogue on the
next line.

**A joke lands flat** — usually the parenthetical. It drives the performance, so `(flat)`
and `(defeated)` produce genuinely different reads of the same words.

**Timing is off** — beats are explicit; change the number. `check` shows every beat and an
estimated runtime without rendering.

**Everyone sounds the same** — voices are rolled from character names. Rename, or set
`voice` / `voiceRef` in the rig file.

**It's too smooth / too slick** — drop `--char-fps` to 8. Limited animation is the point.
