# Creator workflow

This is the production path for turning a clip idea into an editable, post-ready 16:9 and 9:16 master.

## 1. Start and direct

```powershell
npm run ui:build
npm run ui
```

Open `http://127.0.0.1:5178`, select a scene, and press **Direct**. The director creates a proposal; applying it preserves locked beats. In the Beat inspector:

- set each beat's shot purpose, framing, focus, and camera move;
- edit ordered stage actions rather than relying on prose;
- establish initial visibility, mark, depth, and seated/standing state;
- lock any accepted physical or editorial beat before rerunning direction.

Unsupported prose is never converted into unexplained elapsed time. Rewrite it or author a supported action before production export.

For interaction-heavy proof scenes, select the checked-in `production-office` set. It leaves
`office` untouched and provides stable `desk-main`, `mug-hero`, `laptop-main`,
`monitor-main`, `chair-host`, and `chair-guest` IDs. The desk has a non-portable
`work-surface` contact handle; screenplay references to “the table” resolve to the single
desk only when no direct table match exists.

Seating is always explicit. A screenplay direction such as `VERN sits in chair-host.`
lowers to `{ "type": "sit", "actor": "vern", "seat": "chair-host" }`; standing must
occur before that actor moves or exits. Use `sits on the floor` only when floor-seating is
intentional. Phrases such as `sits at the desk` do not guess which nearby chair was meant and
will fail validation until the creator selects a seat in the Beat inspector. Foreground seats
are excluded because the current whole-prop depth model would draw them over the performer.

Surface placement is explicit too. `MEL puts down the mug on the desk.` binds the release to
the desk's semantic placement handle, so the mug lands on the desktop instead of a generic
floor-adjacent fallback. The Beat inspector exposes valid placement targets separately from
the portable prop being carried.

Blocking may use named marks or explicit stage coordinates. For exact proof-scene staging,
`VERN moves to x 760.` preserves the actor's current Y while placing the root at that authored
X. `x 845, y 572, depth -1` also authors an upstage perspective move. The same position remains
directly editable or draggable in the scene UI, and carried props accept explicit `(x, y)`
release coordinates when a creator needs a particular clear spot on a surface.

## 2. Perform the dialogue

Select a line and open **Perform**.

### Line Booth

1. Play the preceding exchange for context.
2. Record or import as many immutable takes as needed.
3. Select a take and edit nondestructive trim and speech boundaries on the waveform.
4. Author pickup, response gap, pause-after, and overlap/interruption timing.
5. Choose Follow Performance, Fit Locked Window, or Re-record to Picture, plus what downstream animation should do if timing changes.

### Scene Run

Use headphones, set measured capture-latency correction, and record one character's unlocked
lines against a guide mix. The open cues for that character are muted; already locked lines by
the same character remain audible as punch-in context. The continuous raw take remains
immutable; the engine maps editable source segments onto the individual cues.

### Character voice conversion

Enter the performer and voice-rights record IDs, select Preserve Performer Register or Adapt
to Character, and convert the selected performance. A production source take needs active
performance/distribution rights; conversion also needs active target-voice/conversion rights
bound to the exact reference checksum. One `both` record may cover both scopes when that is
legally accurate.

The converter targets the character timbre while using the performed duration and acoustic
energy envelope as its cadence reference. Current automated QA measures duration, speech
ratio, clipping, and an energy-envelope cadence proxy. It does **not** run ASR, verify words or
target-speaker identity, or supply verified phoneme timing. Candidate seeds are explicit and
increment after a successful conversion, so hero lines can have multiple auditionable
candidates.

Reject weak candidates. Only approve and lock the take/render you intend to publish. A
warning-bearing candidate requires an explicit audition acknowledgement, which is stored in
the cue's approval notes; it remains a warning rather than becoming an automatic pass.
Production preflight rejects draft TTS, failed/stale/rejected renders, missing performance or
target-voice rights, changed source/reference bytes, and unlocked/unapproved cues.

## 3. Physically direct the actors

Open **Animate**, select an actor and controller, place the playhead at Point A, set the duration in frames, then drag to Point B.

- Root drags are clamped to the set-authored walkable area.
- Wrist drags use deterministic two-bone IK and show the reachable region.
- Motion is saved as an editable `MotionSegment`, not a baked clip.
- Add, move, retime, lock, or remove normalized waypoints.
- Choose path shape/easing and editable anticipation, overshoot, hold, and recovery.
- Turn on onion skins and ghost paths to inspect the phrase.
- **Record drag** captures one controller in real time, then deterministically smooths and reduces it to editable waypoints.
- Undo/redo and track/segment locks persist in `animation.json`.

Creator-owned motion overrides only its claimed actor/controller/span. Ambiguous same-rank ownership blocks export instead of producing an accidental blend.

Use the 16:9 view while manipulating controllers. The **9:16 view** shows the actor-aware publishing reframe and native portrait cards.

## 4. Mix, inspect, and publish

Press **Voices** after changing accepted dialogue. This writes the exact editor/final soundtrack plus:

```text
out/<scene>/dialogue.wav
out/<scene>/stems/dialogue.wav
out/<scene>/stems/ambience.wav
out/<scene>/stems/foley.wav
out/<scene>/stems/stings.wav
out/<scene>/stems/foley.events.json
out/<scene>/stems/guides/*.wav
```

Press **Preflight**. Errors block the render API as well as the UI. Warnings require an
explicit creator acknowledgement before render. The acknowledgement is append-only and bound
to the exact warning list, policy, shot list, dialogue, animation, set, rigs, identity, and
soundtrack state; any relevant edit makes it stale and requires a new review.

The CLI enforces the same production gate: `npm run anim -- render <script.md> --shotlist`
refuses every blocking preflight error and any unacknowledged warning. After reviewing the
listed warnings, rerun with `--ack-warnings` to append an acknowledgement for that exact scene
revision. `--draft` is an explicit diagnostic escape hatch; it prints a prominent warning and
labels `productionStatus.state` as `draft` in the export manifest. It does not watermark the
video pixels, so draft MP4s must not be distributed as approved masters.

Press **Render** only after preflight passes. The publishing bundle contains:

```text
out/<scene>/<scene>.mp4
out/<scene>/<scene>.vertical.mp4
out/<scene>/<scene>.captions.vtt
out/<scene>/<scene>.captions.srt
out/<scene>/<scene>.thumbnail-*.png
out/<scene>/<scene>.export.json
```

The vertical master is captured from a second actor-aware camera plan; it is not a
center-cropped horizontal encode. Captions are WebVTT/SRT sidecars and are **not** burned into
either MP4. The export manifest inventories dimensions, duration, hashes, caption sidecars,
thumbnails, programme audio, stems, Foley provenance, approval/lock hashes, and any
input-bound preflight warning acknowledgement.

The current bundle has a social programme master and stems. It does not yet create a separate
less-compressed archival master or provide a complete EQ/de-ess/compression/room-matching post
chain.

## Files that preserve creator intent

| File | Owns |
|---|---|
| `shotlist.json` | cast state, stable beats, shot purpose, staging, camera, beat locks |
| `dialogue.json` | raw-take provenance, selected derivatives, trims, cadence timing, approval and locks |
| `animation.json` | layers, tracks, semantic anchors, motion segments, waypoints, events and locks |
| `soundtrack.json` | exact audio/timing fingerprint and production audio inventory |
| `<scene>.export.json` | final publish artifact hashes and provenance |

Raw recordings, consent records, and derived-render audit rows are append-only. A new
cleanup/conversion candidate can supersede the selected result without rewriting the source
performance or an earlier candidate.

## Local models and downloads

- Install and prefetch model runtimes deliberately; workers run offline and fail when weights
  are missing rather than downloading during render/conversion.
- Keep Hugging Face/Torch caches under `F:\ai-models` (or set `ANIM_MODELS_ROOT`).
- Conversion provenance records detected Hugging Face snapshot commit(s), installed package
  RECORD fingerprints, and the worker hash. Installation still follows an unpinned repository
  ref and does not independently checksum/approve the weights, so pin and review a known model
  installation before treating reproducibility as archival.
- Use rights-cleared performances and target references; record performance, distribution, and
  target-voice/conversion scope before approval.
- Image models are best used offline for curated sets, props, textures, and title assets. Bake approved assets into the deterministic project rather than using generative video as the renderer.
