# animation-engine

Script → limited-animation scene, in the Adult Swim vein. Free, local, deterministic.

Nothing in the pipeline needs PyTorch, CUDA, an API key, or a network connection. That was a
deliberate design constraint — this machine's RTX 5070 Ti is Blackwell (sm_120) and stable
PyTorch still doesn't ship kernels for it, so anything torch-based would have been a setup
fight before it was a feature.

## Status

| Milestone | State |
|---|---|
| **M0** Schemas + placeholder puppet → still PNG | done |
| **M1** Deterministic render harness → idle MP4 | done |
| **M2** Voice + phoneme-accurate lipsync | done |
| **M3** Script → director → multi-character scene with cuts | done |
| **M3.5** Neural voices (Chatterbox) + Rhubarb lipsync | done |
| **M6** Declarative set system + foreground layering | done |
| **M7** Pipeline extraction + local server | done |
| **M8** UI shell: script editor + live preview | done |
| **M9–M11** Beat timeline, set designer, cast editor | done |
| **M12** Local LLM for script + set generation | next |
| **M5** Inkscape SVG ingestion (your own art) | |

## Model storage — read this first

Model weights are gigabytes, and every ML library defaults to a cache under your user
profile, i.e. the system drive. **This project keeps them off it.**

`src/core/models.ts` derives a models root from the drive the checkout is on
(`F:\ai-models` here) and passes `HF_HOME` / `TORCH_HOME` explicitly to every Python process
it spawns — not relying on an ambient variable, because a missing one means a silent
multi-gigabyte download to the wrong disk. Override with `ANIM_MODELS_ROOT`.

Ollama is separate software and needs telling once:

```bash
setx OLLAMA_MODELS "F:\ai-models\ollama"
```

Install Ollama itself to a custom location too — its default is under `%LOCALAPPDATA%`.
`npm run anim -- doctor` prints the models root, warns if it is the system drive, and
reports how much is in each cache.

## The UI

```bash
npm run ui:install && npm run ui:build
```

```bash
npm run ui
```

Then open **http://127.0.0.1:5178**. Three panels:

| | |
|---|---|
| **Scenes** | Script editor with Fountain highlighting, live scrubbable preview, beat timeline, and a per-beat inspector. Direct / Voices / Render as explicit steps. |
| **Sets** | Build environments: layer tabs (back / mid / **fore**), prop palette, controls generated from each prop's declared params, and a live preview with characters staged in it that you can **drag props around on**. Composition notes appear over the frame, and *Tidy composition* applies the mechanical fixes. |
| **Cast** | Edit what a character **looks like** — build, head shape, nose, ears, hair, facial hair, glasses, eye and brow style, four colour ramps and seven proportion sliders — with the puppet redrawn live. A *Faces* tab shows every expression at once. Voice settings, microphone recording for cloning, and a one-line audition to hear the result. |

**The preview is the renderer.** The iframe loads the exact page `buildPage` produces — the
one Playwright screenshots for the final MP4. Playback is a `requestAnimationFrame` loop
calling the same `window.__seek(frame)`. Preview and output are one code path and cannot
disagree.

Two fidelities: **estimated** (from word counts, available the instant you stop typing) and
**accurate** (real audio + Rhubarb cues, after pressing Voices). The badge on the transport
tells you which you're watching.

Editing a beat writes `shotlist.json` — the same file you'd edit by hand. Changing one
line's expression re-synthesizes only that line, because the voice cache is keyed by content.

### Appearance is data

A character's look is a descriptor on their rig, and the puppet generator is a pure function
of it. Editing a character rewrites the descriptor and redraws the SVG — so every control is
a real property of that character rather than a filter over one fixed puppet, and a look can
be committed, diffed and hand-edited like anything else here.

Undrawn characters roll a look from their name, so a script that names six people gets six
distinguishable people without anyone choosing. `cast regen` redraws everyone after the
generator gains a feature, keeping voices and any hand-tuned idle intact.

### Cloning a voice

Record straight from the microphone in the Cast panel, or drop in a file. Whatever arrives is
normalised to mono 24 kHz PCM at loudness on the way in, so a bad clip fails immediately with
a reason instead of three minutes into a render. *Hear it* synthesizes one line through the
exact path a render uses — the first take loads the model and takes a while, the rest are
cached.

## Quick start

```bash
npm install && npx playwright install chromium
```

For the default Chatterbox voices (GPU). Install torch **after** chatterbox — chatterbox
pins `torch==2.6.0`, which has no sm_120 kernels and silently downgrades you to a CPU
build on a Blackwell card:

```bash
python -m venv .venv && .venv\Scripts\python -m pip install chatterbox-tts
```

```bash
.venv\Scripts\python -m pip install --force-reinstall torch torchaudio --index-url https://download.pytorch.org/whl/cu128
```

Chatterbox runs fine on torch 2.11 despite the pin. Then put `rhubarb.exe` under `tools/`
([releases](https://github.com/DanielSWolf/rhubarb-lip-sync/releases)) and:

```bash
npm run anim -- render the-template.md --set office
```

Check everything at once with `npm run anim -- doctor`. No GPU? Add `--voice-engine sapi`,
which needs none of the above.

That's the whole loop. It parses the script, casts anyone missing, directs the scene,
speaks every line, lipsyncs it, renders, and muxes — from an empty `cast/` folder.

### Commands

| | |
|---|---|
| `new <name>` | scaffold a script with the format documented inline |
| `check <script.md>` | parse, direct and validate — sub-second, renders nothing |
| `render <script.md>` | script → MP4. `--set office --seed 7 --resting DEADPAN --shotlist` |
| `cast new <name>` | create a placeholder character |
| `cast check [name...]` | validate rigs against their SVGs |
| `cast regen [name...]` | redraw art after a generator change, keeping voices — `--reroll` |
| `cast sheet [name]` | contact sheet PNG: one name gives every expression, none gives the cast |
| `still [name...]` | one frame to a PNG — `--pose`, `--expression` |
| `idle [name...]` | an idling MP4 — `--seconds`, `--char-fps` |
| `sets` | list sets; `sets props`, `sets palettes`, `sets preview <name>` |
| `voices` | list installed SAPI voices |
| `doctor` | check the toolchain |

## Writing a script

**Full reference: [docs/FORMAT.md](docs/FORMAT.md)**, including a copy-paste prompt for
going from a bare premise to a finished script. The loop is:

```bash
npm run anim -- new my-scene && npm run anim -- check my-scene.md
```

A loose Fountain subset — write it in any editor.

```
INT. OPEN PLAN OFFICE - MORNING

Brent approaches the desk holding a coffee mug he never drinks from.

BRENT
(deadpan)
Yeah, listen. Did you get a chance to send through that Q3 rollup?

PAUL
(flat)
Friday. I sent it Friday.

[BEAT 1500]
```

All-caps line = character cue. `(parenthetical)` = emotion hint the director reads.
`[BEAT 1500]` = a pause, in milliseconds.

Beats are explicit rather than inferred. In this genre the pause *is* the joke, and its
length is a writing decision — not something to guess at.

## How it works

```
script.md
 → [1 parse]    screenplay.json   cues, parentheticals, beats
 → [2 direct]   shotlist.json     shots, staging, expressions, camera  ← EDIT THIS
 → [3 voice]    SAPI              WAV + viseme events per line
 → [4 time]     mouth cues        SAPI viseme ids → Rhubarb A–X shapes
 → [5 compile]  scene.ir.json     per-frame transforms — no AI in this stage
 → [6 render]   frames/*.png      Playwright seek+shot, deduped
 → [7 mux]      out/<scene>.mp4   native WAV mix + ffmpeg
```

### Voices

Two engines, chosen with `--voice-engine`:

| | |
|---|---|
| **chatterbox** (default) | Resemble AI's, MIT. Emotion control + zero-shot voice cloning. Needs the Python venv and a GPU. |
| **sapi** | Windows built-in. No downloads, no GPU, no Python. Sounds its age, but always works. |

**Expression drives delivery.** The director already decides each line's expression, so the
compiler feeds it straight into Chatterbox's emotion controls — a `DEADPAN` line is
performed flat and slow, not merely drawn that way. In this genre that's most of the joke.

| expression | exaggeration | guidance |
|---|---|---|
| `DEADPAN` | 0.25 | 0.30 |
| `NEUTRAL` | 0.50 | 0.50 |
| `SMUG` | 0.60 | 0.45 |
| `ANGRY` | 0.85 | 0.60 |
| `SHOCKED` | 0.90 | 0.60 |

**Voice cloning.** Point a character's `voiceRef` at ~5–10s of clean speech under `cast/`
and they'll sound like that person instead of like a TTS preset.

### Lipsync

SAPI reports a **viseme id with an audio timestamp** for every mouth position it passes
through, so it supplies its own mouth timing for free. Neural engines return bare audio,
so those go through **Rhubarb**, which analyses the waveform directly and emits the same
A–X alphabet the rigs already speak. The mouth vocabulary was built around Rhubarb's set
from the start for exactly this reason.

Rhubarb is also what makes recorded VO work properly: drop
`out/<scene>/vo/<NNN>-<speaker>.wav` next to a scene and that line uses your voice, lipsynced
from the actual recording. Without Rhubarb installed it falls back to a text-driven estimate.

### Four principles

1. **Audio is the clock.** Every beat's length comes from the dialogue in it. Picture and
   sound are generated from one timeline, so they cannot drift.
2. **The director can only ask for things that exist.** Its output is validated against a
   capability manifest built from the loaded rigs — nothing renders referencing a pose or
   expression no puppet has. That's what makes the stage safe to hand to an LLM later.
3. **Seeded determinism.** Same inputs → byte-identical frames, enforced by a test. That
   property is what lets the renderer skip held frames, resume, and render out of order.
4. **Limited animation is the spec, not a compromise.** Characters run on twos while the
   camera runs on ones (`--char-fps`). Held poses, two-step snaps, hard cuts. Roughly half
   of all frames are held, and dedup skips every one of them.

### The shot list is yours

`out/<scene>/shotlist.json` is a readable file, not an internal intermediate. Change a
shot, retime a beat, swap an expression, then:

```bash
npm run anim -- render the-template.md --set office --shotlist
```

Comedy is timing. When a joke lands wrong you fix the shot list, not a prompt.

## The puppet contract

`cast/<name>.rig.json` declares parts, pivots, swap sets, poses and expressions.
`cast/<name>.svg` supplies artwork whose element ids match. The engine never knows whether
it's driving generated shapes or a drawing, so replacing placeholder art is a file swap.
`anim cast check` names any id that doesn't line up.

Placeholder characters derive their look, palette and voice from their **name**, so `brent`
is the same guy on every machine and two characters are never accidentally identical.

Rigs supply all nine mouth shapes, four eye states and six brow states. `DEADPAN` is a
first-class expression alongside `NEUTRAL` — in this genre the blank unimpressed stare does
most of the work, so it's the default baseline.

## Layout

```
src/
  schema/     zod contracts: rig, scene IR, screenplay, shot list
  core/       seeded RNG, paths
  cast/       placeholder generator, rig loading + validation
  parse/      script → screenplay
  direct/     screenplay → shot list, + capability validation
  voice/      engines (chatterbox, sapi), Rhubarb, WAV read/write/mix
  compile/    shot list + timing → per-frame IR   ← core logic, no AI
  render/     browser runtime, page builder, framing, capture, ffmpeg
  sets/       descriptors, prop registry, palettes
  pipeline/   check / voices / preview / render   ← shared by CLI and server
  server/     local HTTP API + SSE jobs
  cli/        the `anim` command
ui/           Vite + React app
```

## Tests

```bash
npm test
```

The load-bearing one is `render > produces byte-identical frames across two runs`. If that
fails, frame dedup, resumability and out-of-order rendering are all unsafe.

## Notes

- `ffmpeg` here is 4.2.3 (2020, bundled with ImageMagick). It works. A current static build
  is free and worth grabbing; override the path with the `FFMPEG` env var.
- The dialogue track is mixed natively rather than with ffmpeg's `amix` — lines never
  overlap, so it's sample placement, and it avoids both `amix`'s renormalisation as inputs
  drop out and its `normalize` option not existing before ffmpeg 4.4.
- Chromium runs with GPU rasterisation disabled; software rendering is what keeps frames
  reproducible.
- Sets are drawn wider than the frame on purpose. The camera is not clamped to the stage,
  because clamping shoves a close-up subject out of the centre of their own shot.
