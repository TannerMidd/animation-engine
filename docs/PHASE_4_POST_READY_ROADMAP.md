# Phase 4 - Post-Ready Performance and Production

**Status:** Recommended successor to Phase 3  
**Based on:** `The Circle Back` final proof-of-concept render  
**Purpose:** Turn the stable identity renderer into a system capable of producing short clips that feel acted, directed, mixed, and ready to publish.

> **Implementation note (2026-08-02):** M22-M27 now have working deterministic
> foundations, but this document remains the target specification, not a completion claim.
> Current conversion QA is acoustic cadence/signal analysis plus human audition; ASR,
> transcript verification, target-speaker verification, and verified phoneme alignment are not
> implemented. Conversion records detected snapshot/runtime provenance, but the installer does
> not yet enforce an approved revision or independent weights checksum. Publishing emits
> VTT/SRT sidecars rather than burned-in captions, and audio export does not yet include the
> planned archival master or full post-processing chain. Draft video pixels are not visibly
> watermarked. The human acceptance reels in this roadmap still determine release readiness.

## Executive decision

Phase 3 built a useful foundation: deterministic rendering, coherent character designs, a consistent palette, stable lip-sync, voice and asset plumbing, and a recognizable visual seed. The final test also exposes the present ceiling clearly.

The output behaves like a talking-character layout engine rather than an animation director. The next phase should therefore prioritize performance, staging, and dialogue editorial control - not more random variation and not a larger scene-generation model.

Four rules govern this roadmap:

1. **Approve dialogue before animating.** Accepted voice takes and authored response timing become the master clock for performance, camera, and sound.
2. **Never silently ignore an action.** A stage direction must animate, be deliberately rewritten, or fail preflight. It must never become unexplained dead time.
3. **Stillness must be chosen.** Limited animation can be stylish, but a held pose needs intention, readable subtext, and a motivated composition.
4. **Creator direction is first-class data.** Generated staging and acting are editable starting points. Direct manipulation, recorded performance, manual timing, and locks must survive every automated rerun.

## What the proof of concept revealed

The 125.92-second test is technically stable, but only about 69 seconds contain audible speech. Roughly 22 seconds come from TTS padding and unconditional line tails rather than authored comic timing.

| Signal | Observed result | Why it matters |
| --- | --- | --- |
| Scene actions | All five action beats become static WIDE/HOLD shots | Entrances, exits, sitting, mug business, and table taps do not happen |
| Blocking | All actors remain visible at fixed marks | Janice appears before arriving; Brent never enters or leaves; Paul says he is sitting while standing |
| Acting vocabulary | 20 generic TALK gestures, 18 NONE, 1 POINT across 39 lines | Characters share one motion language and repeat the same held arm poses |
| Editing | About 55 framing changes, mostly five recropped layouts | The camera changes frequently without revealing new story information |
| Camera motion | 46 HOLD and 9 PUSH_IN shots | Every pause receives similar punctuation, so the device loses meaning |
| Voice timing | Raw WAV length plus a fixed 160 ms tail controls placement | Variable TTS padding creates inconsistent 475-710 ms conversational gaps |
| Voice pace | Approximately 52-316 WPM across ordinary lines | Adjacent lines lurch between dragged and rushed delivery |
| Voice source | Three synthetic, pitch/formant-shifted minted references | Synthetic prosody and artifacts are cloned into the final performances |
| Final audio | 24 kHz mono with ambience but almost no Foley | Silent actions feel like playback stalls rather than intentional beats |

Representative failures include:

- `0:01.75-0:04.95`: Brent's scripted entrance is a static tableau; he is already present.
- Around `0:08`: Paul says he is already sitting while visibly standing.
- `0:19.87-0:24.80`: nearly five seconds pass across a pause and Janice's unanimated arrival.
- `0:60.45-0:60.57`: "Doug!" contains only about 120 ms of audible speech and sounds clipped rather than performed.
- `1:08.75-1:13.50`: all three actors hold sticker-like reactions without evolving gaze, posture, or intent.
- `1:13.50-1:16.67`: Brent's mug action is not shown or heard.
- `1:41.88-1:46.70`: another long pause/action block contains no table tap, body action, or Foley.
- `1:57.60-1:58.91`: Brent's departure does not change his visibility or position.

The failure is therefore not simply "too little motion." The screenplay describes events that the current scene model cannot represent, while the pipeline silently spends time on them anyway.

## Release target

The first Phase 4 release should produce one excellent 30-60 second clip, not another automatic two-minute render. It should meet all of these conditions:

- The story and emotional progression are readable with the audio muted.
- The conversation feels intentional with the picture hidden.
- Each character is identifiable by voice and movement alone.
- Every visible action persists correctly across cuts and has sound where appropriate.
- A creator can reshape important actions directly on the rig without editing code.
- A creator can perform a line, convert it to a character voice, and preserve the original cadence and timing.
- The camera creates emphasis and relationship, rather than cycling through crops.
- The output includes captions, a branded opening/ending, a thumbnail frame, and horizontal and vertical-safe exports.
- All authored take, timing, staging, performance, and shot locks survive regeneration.

## Core authoring model

Phase 4 should add two complementary production lanes. Automation supplies coverage and a usable first pass; the creator supplies taste, timing, and performance where it matters.

Editable intent should live in a versioned `AnimationDoc` above the current immutable `SceneIR`:

```text
ShotList + accepted dialogue + generated proposals + AnimationDoc
                              |
                              v
          resolve anchors -> blend tracks -> solve constraints
                              |
                              v
                   deterministic SceneIR -> preview/export
```

Every beat, line, actor, prop, handle, track, and key needs a stable ID. Key times should support semantic anchors such as `beatStart`, `speechStart`, a specific word, `speechEnd`, contact, or `beatEnd`, plus a frame offset. This lets an intentional nod remain attached to the word it punctuates when a take changes, while absolute-frame locks remain available when picture is fixed.

### Direct-manipulation animation

The editor should let a creator select an actor or rig controller, place the playhead at Point A, move to Point B, drag the controller to a valid target, and specify the elapsed frames. The engine then creates an editable `MotionSegment`, not an opaque generated clip.

For an actor root, the segment describes blocking through stage space. For a hand, head, torso, or gaze controller, it describes an animation-layer change in rig-local space. A segment stores:

- actor, controller, and coordinate space
- start/end frame and optional intermediate waypoints
- position/rotation/pose values
- path shape and easing
- planted/contact constraints
- anticipation, overshoot, hold, and recovery options
- prop attachment or interaction target
- semantic time anchor and affected channel mask
- author, approval, and lock state

Dragging a wrist should use inverse kinematics and joint limits; dragging an actor should respect stage bounds, foot planting, collision volumes, and usable paths. The UI should display reachable regions, motion paths, onion-skin/ghost poses, contact frames, and an immediate preview. Invalid targets should be visibly rejected or clamped with an explanation, never silently distorted.

Use deterministic analytic IK for simple limb chains where possible; a frame-order-dependent solver would undermine reproducibility and can cause elbow flips. Sets should expose walkable polygons, depth bands, placement surfaces, doors, seats, and interaction points. Rigs should expose semantic handles, joint limits, pole directions, attachment sockets, and contact pins.

Point A to Point B must not default to a robotic straight tween. The creator can choose a motion preset or ask the assist layer to propose an arc, anticipation, and recovery, then edit the resulting keyframes. Common operations include:

- drag an actor from one floor mark to another over 24 frames
- drag a hand to a mug, snap the grip at contact, then attach the mug
- pin both feet while posing the torso and arms
- align a gesture apex to a stressed word in the accepted audio
- draw or edit a curved hand/root path
- retime a selected motion without changing its endpoints
- copy a motion phrase and adapt it to another character's motion profile
- press record and puppeteer one controller over the playing audio, then simplify the sampled path into editable keys

The timeline needs separate, non-destructive tracks for dialogue, blocking/root motion, body/IK, face, gaze, props/constraints, camera, and sound. Precedence is:

```text
show defaults -> automatic plan -> selected motion clip -> creator keyframes/paths -> explicit locks
```

Manual work should be stored as normalized rig/stage data so it remains deterministic, diffable, undoable, and reusable. Manual motion should mask generated motion only on the claimed controllers and frame span, with editable blend handles at its boundaries. Overlapping authoritative edits should raise a visible conflict rather than produce an accidental blend. A directing rerun may propose around a locked performance, but may not overwrite it.

The identity profile may deliberately render animation on twos or threes, but direct-manipulation curves should retain full-resolution intent and be sampled according to that profile. Authoring at a forced 12 fps would make purposeful smooth motions accidentally choppy.

### Performance capture and character voice conversion

The dialogue UI should support four explicit modes per character or line:

1. draft TTS
2. creator performance plus character voice conversion
3. unconverted recorded performance
4. imported approved audio

For the preferred publish path, the creator selects a line, records one or more takes, auditions them, and accepts a performance take. The local voice converter changes vocal identity while preserving duration, words, pauses, stress, breaths, emotion, and conversational pickups as closely as possible. The accepted performance - not a new TTS estimate - becomes the scene clock.

The recording workflow needs two views:

- **Line Booth:** play the preceding line for context, count in, record one script line, and compare takes in the exchange.
- **Scene Run:** perform one character's full track while the other approved/draft lines play, with latency compensation, automatic segmentation, and punch-in replacement.

Both views need input-level checks, script display, waveform, target-window indicator, take comparison, noise/clipping warnings, and nondestructive rerecording. One performer may record several characters and route each accepted take through a different approved character voice.

Offer three explicit timing policies:

1. **Follow Performance** (default): the take defines line duration and downstream timing reflows.
2. **Fit Locked Window:** the creator performs against picture; silence is adjusted first and voiced material receives only small, alignment-aware correction.
3. **Re-record to Picture:** required when the take cannot fit naturally.

Do not promise to fit any performance into any duration. An initial policy can warn around 3% voiced stretching and reject around 5%, subject to listening-test calibration. Favor silence and sustained vowels; avoid warping attacks and plosives.

Each converted take should retain links to:

- original performance take and checksum
- target character voice and consent/provenance record
- converter/model revision and settings
- converted file and quality report
- source-to-output time map, register policy, and duration policy
- exact frame duration and word/phoneme timing
- approval, lock, and downstream timing version

Voice conversion should be duration-preserving. After conversion, align source and result; reject missing, added, repeated, or reordered words and visibly shifted breaths/pauses. In a locked window, final duration should match exactly at the audio-sample level and speech anchors should remain within one video frame. Small timing correction must use alignment-aware, formant-preserving stretch and remain visible to the creator.

For cross-register characters, preserve the creator's relative intonation contour while mapping it into the character's approved pitch range. Copying the creator's absolute pitch or flattening the contour will both weaken the character performance.

Changing an accepted performance after animation exists requires an explicit choice: ripple later beats, proportionally retime attached motion within the line, or preserve absolute animation timing and show a sync warning. Nothing should silently move.

Raw takes should be immutable. Cleanup and voice conversions are derived assets with instant rollback. Script changes mark incompatible takes stale without deleting them. A conversion failure must offer retry, original take, draft TTS, or unresolved status; it must never silently substitute a different voice.

## R0 - Rescue the current proof of concept

This is a deliberately authored rescue pass, not the final automatic-engine demonstration. Its purpose is to establish the quality bar before expanding automation.

### Deliverable A: 30-45 second hero cut

Retain the strongest escalation, one clear mug/table action, and the best final callback. Open on the premise within the first few seconds and remove repeated exchanges that do not change the power dynamic.

1. Record performance takes for the three characters and convert them with clean, rights-cleared character references. Keep clean human-reference TTS as the fallback path.
2. Generate two to four candidates for important or suspicious lines; audition and lock a take per line.
3. VAD-trim take boundaries and author every response gap. Repair the rushed questions, stretched one-word lines, clipped "Doug!", and the register jump on "Decide it."
4. Manually stage visibility, sitting/standing, gaze, the mug, table taps, and the final exit.
5. Hand-author a small number of performance phrases and listener reactions against the accepted audio.
6. Recut with motivated masters, singles, two-shots, reactions, and one or two purposeful camera moves.
7. Add synchronized Foley, captions, title/end branding, a thumbnail frame, and publishing exports.

### Deliverable B: optional 80-95 second full sketch

Only make the longer version after the hero cut passes review. Remove repeated pauses, compress redundant lines, and ensure every remaining hold contains a new reaction, action, or shift in relationship.

### Rescue exit gate

- Three to five people who did not build it rate voice naturalness, timing, acting, and overall watchability at a median of at least 4/5.
- No reviewer needs the screenplay to understand entrances, exits, addressees, or the mug/table business.
- No accidental speech-to-speech gap exceeds 900 ms.
- No unapproved draft voice or failed take reaches the export.
- At least one frame is strong enough to use as the post thumbnail.

## M22 - Dialogue editorial, performance capture, and production voices

Accepted speech must become editable production material rather than a transient result of TTS generation.

### Deliverables

- Fix the current persona propagation defect: persona values affect cache keys but are omitted from synthesis on a cache miss.
- Fix synthesis environment/version fingerprinting and invalidate soundtracks when placement or program duration changes.
- Add a persistent `DialogueCue` per line containing:
  - selected take ID and seed
  - synthesis text separate from display text
  - delivery, emphasis, and pronunciation notes
  - speech onset/end and trim handles
  - start frame, pickup, turn gap, and pause after
  - optional overlap/interruption
  - approval and lock state
- Add waveform auditioning with play, compare, reroll, trim, nudge, accept, and lock controls.
- Add line-by-line and continuous-scene recording with input monitoring, count-in, take lanes, punch-in, and automatic segmentation.
- Play neighboring dialogue/animatic context during capture and compensate for input/output latency so response timing is preserved.
- Store the original performance separately from the converted character take; either can be auditioned, reverted, or exported.
- Keep raw recordings immutable and version cleanup/conversion derivatives, notes, ratings, approvals, and locks.
- Add a duration-preserving local voice-conversion path that keeps the recorded cadence, pauses, stress, breaths, and emotional contour.
- Add source/output forced alignment and a time map used by lip sync, word anchors, gesture accents, and conversion quality checks.
- Add Follow Performance, Fit Locked Window, and Re-record to Picture timing policies with explicit downstream retiming choices.
- Add Preserve My Register / Adapt to Character register behavior while retaining relative pitch contour.
- Support one performer recording multiple characters while maintaining separate approved character voice identities.
- Generate multiple candidates for hero lines and automatically flag suspect ordinary takes.
- Reject or reroll excessive padding, clipped speech, transcript mismatches, implausible duration, unstable pitch, low speech ratio, and speaker drift.
- Handle very short utterances with contextual synthesis or alternate takes instead of accepting tiny vocal fragments.
- Make `spokenText` independent of screenplay punctuation so questions, stress, and pronunciations reach the voice engine correctly.
- Treat auto-minted synthetic references as **draft-only**. Production voices require a clean consented reference, recorded performance, or an engine/voice combination that wins a blind benchmark.
- Record voice ownership/consent and model provenance; never permit an unapproved real-person voice target in a production project.
- Keep recordings/references local by default, support deletion/revocation, and invalidate future renders whose permission is no longer valid.
- Never silently fall back to a different voice, engine, or draft take after conversion failure.
- Normalize dialogue per take before the final bus; keep character medians within roughly 1-1.5 dB.

### Voice strategy

Keep the current Chatterbox engine for the first controlled test, but feed it clean human references. This isolates the reference-chain problem from the model itself. Then compare the current engine, current Chatterbox variants, and a performance-first voice-conversion path using the same characters and evaluation lines. The official Chatterbox project includes both TTS and voice-conversion workflows: [Resemble AI Chatterbox](https://github.com/resemble-ai/chatterbox).

The preferred local path is creator performance followed by character voice conversion. Human cadence is the performance source; the model supplies the approved character timbre. This is more likely to produce convincing comic timing than asking independent TTS calls to invent the performance line by line.

Adopt a new engine only if a blind test wins on naturalness, short-line quality, speaker consistency, emotional range, and generation reliability.

### Exit gate

- Every line can be independently auditioned, timed, accepted, and locked.
- A creator can record, convert, compare, and accept a take without leaving the scene timeline.
- Line Booth and Scene Run capture both preserve conversational context and measured device latency.
- Converted takes remain within one frame of the accepted source performance and preserve its perceived cadence.
- Transcript, word order, pauses, breaths, and emotional accents survive conversion; incompatible or over-stretched takes are rejected visibly.
- Lip-sync median error remains below 50 ms and the 95th percentile below 100 ms.
- No raw TTS padding controls the edit.
- No unexplained two-times pace swing or collapsed short utterance remains.
- Listeners identify recurring characters from voice alone and rate them as natural and consistent.

## M23 - Stateful staging, action primitives, and a usable rig

Build M23 in parallel with M22, then integrate it against the accepted dialogue timeline.

### Deliverables

- Add beat-level stage state for presence, visibility, mark, depth, facing, pose, gaze target, and prop bindings.
- Define named root/body/head/hand/gaze controllers with rig-local limits, IK chains, and interaction handles that the editor can manipulate directly.
- Add a stage graph containing doors, seats, surfaces, interaction anchors, safe paths, and camera-aware depth positions.
- Extend sets with walkable polygons, placement surfaces, depth bands, interaction sockets, and simple collision bounds.
- Replace prose-only actions with validated `StageAction` data.
- Implement the smallest useful action vocabulary first:
  - enter, exit, cross
  - sit, stand, lean, turn, look
  - reach, recoil, point
  - pick up, hold, put down, transfer
  - tap and simple repeated contact
- Add prop attachment and continuity state across beats and cuts.
- Represent prop behavior as deterministic attach, contact, detach, and place events. Detach must create a world-space key to prevent a one-frame jump; contact can emit a synchronized Foley marker.
- Split root, pelvis, torso, neck, shoulders, wrists/hands, and planted feet so breathing and upper-body motion do not slide the whole puppet.
- Add reachable volumes, joint limits, foot/contact pins, collision checks, prop sockets, and stage-bound validation.
- Add an action capability manifest and unsupported-action preflight. Unsupported text must block production export or require an explicit rewrite/waiver.
- Allow manual staging locks and preserve them through directing reruns.

### Exit gate

- Every action in the test script visibly occurs or is intentionally removed.
- Janice is absent before her entrance; Brent is absent after his exit; Paul can actually sit.
- Mug placement, pickup, and table taps remain continuous across shots.
- Feet remain planted unless a step is scheduled.
- Direct manipulation cannot create an unreachable limb, broken joint, sliding contact, or off-stage path without a visible validation error.
- A mute viewer understands who entered, left, moved, handled an object, and addressed whom.

## M24 - Creator animation studio and character motion identity

Replace one-pose-per-line acting with editable performance phrases and give the creator direct physical control of the rigs.

### Deliverables

- Add independent tracks for root/body, head, gaze, brows/eyes, mouth/visemes, left hand, right hand, listener response, and secondary motion.
- Add a dope-sheet/timeline editor with selectable rig controllers, keyframes, `MotionSegment` paths, frame snapping, easing, onion skinning, ghost trails, and looped preview.
- Let the creator create Point A-to-Point B root or body-part motion by positioning controls at two playhead times and setting the duration in frames.
- Add direct path editing, intermediate waypoints, endpoint/segment retiming, copy/paste, undo/redo, and lock controls.
- Add IK posing for hands/feet, planted contacts, prop snapping, reach visualization, and immediate invalid-pose feedback.
- Add optional motion assist that converts endpoints into editable anticipation, arc, apex, overshoot, hold, and recovery keys.
- Add a live puppeteering pass for recording one selected controller over audio, followed by constrained smoothing and editable key reduction.
- Give every gesture explicit preparation, onset, apex, hold, recovery, and new resting state.
- Extract word timestamps, pauses, energy, and stress cues from accepted audio; place accents around meaningful words rather than alternating `TALK_A`/`TALK_B` on a timer.
- Add listening behaviors that can begin under another character's line: eye acquisition, head follow, delayed blink, posture change, restrained reaction, and recovery.
- Preserve actor state across cuts instead of visually resetting at every beat.
- Snap gesture accents, contact frames, and reactions to selected words or waveform markers from the accepted performance take.
- When dialogue timing changes, offer explicit ripple, proportional-retime, or preserve-and-warn behavior for attached animation.
- Create reusable motion clips for small/open/emphatic speech, explanation, dismissal, counting, uncertainty, interruption, embarrassment, anger restraint, and prop business.
- Give every recurring character a motion profile:
  - resting posture and center of gravity
  - preferred hand and gesture size
  - head-led versus body-led movement
  - anticipation and recovery speed
  - eye/blink behavior
  - escalation pattern
  - signature and prohibited gestures
  - stillness and repetition budgets
- Add no-repeat and pose-hold linting, while allowing intentional callbacks.
- Store auto and creator-authored animation on separate layers; creator keys and locks always win.
- Mask generated motion by controller and time span when a manual layer takes ownership; surface collisions between manual override tracks before export.

### Exit gate

- With mouths hidden, the scene still reads as an interaction rather than three idle puppets.
- A creator can author a reach-to-mug, table tap, head turn, and actor cross entirely in the UI, preview them immediately, and reopen them as editable data.
- A manually locked motion survives re-directing, voice regeneration, recompilation, and camera changes.
- Each character is recognizable from movement alone.
- Long lines have selected accents instead of metronomic pose toggling.
- Contact and invasion of space produce reactions.
- Held poses feel intentional, and no generic gesture repeats merely because the same character speaks again.

## M25 - Sequence-level directing and editorial grammar

The director must design coverage for a scene, not classify each line in isolation.

### Deliverables

- Plan shot runs across multiple beats so a good composition can survive an exchange.
- Add explicit shot functions: establish, master, speaker, listener reaction, relationship two-shot, over-the-shoulder, insert, action detail, reveal, escalation, reset, and final button.
- Compose around the focal actor instead of recropping a fixed three-person lineup.
- Track screen direction, eyelines, actor orientation, prop state, recent coverage, and visual dominance.
- Add shot/gesture/camera repetition budgets and cooldowns.
- Reserve push-ins, snaps, and other signature moves for selected story turns.
- Make identity rules executable: shot-duration ranges, cut density, preferred coverage, movement quotas, reaction style, and intentional exceptions.
- Keep generated directing proposals schema-constrained, validated against renderer capabilities, diffable, and lock-aware.
- Route shots around creator-authored actions and contacts; never cut away from or overwrite a locked physical beat unless explicitly requested.

### Exit gate

- Pauses no longer automatically create the same close-up/push-in pattern.
- Shot choice changes because of story purpose, action, or relationship.
- Entrances, prop actions, reactions, and punchlines receive appropriate coverage.
- The final button has a unique visual setup and payoff.
- Director reruns preserve accepted dialogue, staging, performance, and shot locks.

## M26 - Sound storytelling and final mix

### Deliverables

- Maintain separate dialogue, ambience, Foley, sting, and optional music stems.
- Build a small licensed or creator-recorded Foley library for doors, chairs, mugs, table taps, paper, laptops, clothing, and footsteps.
- Attach sound events to stage actions so contact sounds follow the same frame-locked state.
- Add per-character trim, light EQ, de-essing, compression, room matching, dialogue-aware ambience ducking, and transparent limiting.
- Validate integrated loudness and true peak rather than relying only on whole-program RMS.
- Export a 48 kHz stereo master with centered dialogue and restrained spatial ambience/Foley.
- Preserve intentional silence; do not use sound to conceal missing performance.

### Exit gate

- Every important visible contact has synchronized sound where appropriate.
- Dialogue remains clear on phone speakers and headphones.
- Speaker levels stay within the chosen range and no short line becomes unexpectedly hot.
- The social master meets the selected platform target, with a less-compressed archival master retained.

## M27 - Short-form publishing and human quality gates

### Deliverables

- Add 20-60 second runtime presets and script checks for hook, escalation, turn, and final button.
- Add horizontal and vertical-safe composition zones, caption-safe areas, and reframing previews.
- Export 16:9 and 9:16 versions, caption files/burn-ins, thumbnail candidates, and a clean master.
- Replace screenplay-slug title cards and generic `THE END` cards with a series mark, episode title, creator identity, and a restrained end signature.
- Add a one-click production preflight for:
  - draft or unapproved voices
  - rejected/unlocked takes
  - unsupported actions
  - missing props/Foley
  - stale audio or timing
  - continuity errors
  - repeated motion/shot warnings
  - caption and safe-area violations
- Add an evaluation reel builder and retain review scores with the approved render.

### Exit gate

- The clip passes a blind review for voice naturalness, timing, readable acting, visual identity, and watchability.
- It works without captions, while captions improve mobile viewing rather than repair comprehension.
- The vertical version is recomposed, not merely center-cropped.
- No production preflight blocker or unreviewed generative asset remains.

## Dependency order

```text
M22 Dialogue editorial ---------+
                                +--> M24 Performance --> M25 Directing --> M26 Sound --> M27 Publish
M23 Staging and action ----------+
```

M22 and M23 may proceed in parallel. M24 depends on approved dialogue and the richer rig. M25 depends on reliable blocking and performance state. M26 can build its asset library early, but final sound follows action timing. M27 owns the release gate.

## Local-model and download policy

Relaxing the zero-download policy is reasonable, but downloads should solve measured bottlenecks.

### Worth doing now

- **Voice benchmark:** current Chatterbox with clean human references, current official variants, and creator-performance voice conversion. Local voice work is feasible on this machine.
- **Asset lab:** a 4B-class local image model can help ideate sets, props, posters, wardrobe, title assets, and textures. Curate and bake approved outputs into deterministic project assets.
- **Structured directing proposals:** the existing local language model is adequate for proposing validated stage actions and directing patches once the schema can represent them.

### Not the next move

- Do not fine-tune a "scene model" to compensate for missing visibility, blocking, props, gaze, or action primitives.
- Do not use local generative video as the main renderer. It weakens continuity, editability, repeatability, and show identity on this hardware.
- Do not train a director LoRA until the project has a meaningful corpus of human-approved screenplay-to-plan examples and a held-out evaluation set.

All downloaded models should remain pinned, license-reviewed, benchmarked, and stored under `F:\ai-models`. Rendering should never trigger an implicit download. Worker processes now run offline, and conversions record detected Hugging Face snapshot commit(s), package RECORD fingerprints, and the worker hash. The explicit installer still follows an unpinned repository ref, however, and an approved-model manifest plus independent weights checksums remain release work. The RTX 5070 Ti 16 GB / 32 GB RAM machine is suitable for local TTS/voice conversion and 4B-class image authoring; heavy generative video remains an optional offline experiment, not a production dependency.

Voice references and creator recordings should remain local by default. Store consent scope, distribution rights, training permission, expiry/revocation state, source/output hashes, model revision, and conversion history in the project manifest. Public-figure impersonation and unconsented third-party character voices are not valid production targets.

## Quality program

Passing unit tests is necessary but no longer sufficient. Phase 4 needs audience-facing gates.

### Golden fixtures

1. **25-35 second acting reel:** interruption, skepticism, embarrassment, a prop interaction, and a punchline.
2. **Dialogue stress reel:** one-word exclamation, whisper, fast pickup, long sentence, interruption, question, emotional turn, and two similar-sounding characters, performed by the creator and voice-converted.
3. **Staging reel:** entrance, sit/stand, crossing, pickup/placement, contact reaction, and exit, with at least two actions directly edited in the UI.
4. **Publishing reel:** captions, horizontal/vertical composition, title/end package, thumbnail, and final mix.

### Automated checks

- Persona values reach the actual synthesis request.
- Dialogue placement changes invalidate the soundtrack.
- Short-utterance and speaker-drift quality rejection works.
- Voice references pass speech ratio, noise, clipping, and transcript checks.
- Audio/video sync stays within one frame at accepted boundaries.
- Voice conversion preserves the source duration within one frame and retains word/pause alignment.
- Conversion QA rejects missing/repeated words, lost breaths/pauses, pitch breaks, excessive source-speaker leakage, weak target identity, and impermissible timing warp.
- Script edits mark old takes incompatible without destroying their raw files or silently reusing them.
- Visibility, entrance/exit, planted feet, prop attachment, and continuity persist across cuts.
- IK limits, reachable regions, stage bounds, collisions, and contact pins reject invalid direct-manipulation edits.
- Manual keyframes and locks survive regeneration, recompilation, retiming choices, and project reopen.
- Gesture onset/apex/recovery and reaction recovery compile deterministically.
- Repetition budgets apply across the whole sequence, not one beat at a time.
- No unsupported action silently compiles to elapsed time.

### Human checks

- **Eyes closed:** timing, character identity, and comic rhythm work as audio.
- **Muted:** addressees, emotional progression, actions, and punchline remain readable.
- **Voice only:** recurring characters are distinguishable and natural.
- **Motion only:** recurring characters are distinguishable by acting style.
- **Cold audience:** reviewers understand and enjoy the clip without implementation context.

## Scope discipline

Do not spend the next cycle adding more random gestures, more camera templates, or more identity prose. Those additions would increase apparent variety without increasing intention.

The highest-leverage sequence is:

1. Perform, convert, curate, and lock human-sounding dialogue.
2. Make the scene physically capable of doing what the script says.
3. Let the creator physically direct the rigs, then use assistance to fill and polish around those choices.
4. Direct the sequence around story turns.
5. Add sound, branding, and publishing discipline.

Phase 4 is complete when the engine can repeatedly produce a short clip that the creator would publish without apologizing for the voices, timing, staging, or animation.
