# Phase 3 — Show Identity, Performance, and Editorial Language

**Status:** Proposed final roadmap  
**Revised:** August 2, 2026

## Vision

Phase 3 will turn the engine from a capable scene renderer into a system that produces work recognizable as belonging to a specific original show.

A show's identity should remain coherent across scripts, characters, sets, wardrobe, voices, performances, camera choices, editing, sound, and titles. That identity must be explicitly defined by the creator—not inferred from names, uncontrolled random rolls, or references to existing television shows.

The production renderer will remain deterministic and based on structured scene data, SVG, approved assets, and a frame-locked audio timeline. Local generative models may propose structured plans or create reviewed source assets, but they will not generate the final frames of ordinary scenes.

Phase 3 is complete when the engine can produce a polished 30–60 second reel that:

- Looks, sounds, and moves like one internally consistent show.
- Produces a clearly different result when another identity profile is selected.
- Preserves authored choices through regeneration and redirection.
- Reproduces the same result from the same pinned inputs.

## Product principles

1. **Identity is data, not prompt prose.** Every project uses a versioned, portable `ShowIdentity` profile.
2. **Author intent has precedence.** Explicit character, set, scene, and beat instructions override show defaults and generated suggestions.
3. **Generation is advisory.** Models return schema-constrained proposals. The engine validates, previews, diffs, and applies them through an explicit workflow.
4. **The final renderer remains deterministic.** Approved structured plans, SVG, audio, fonts, and baked assets are the production path.
5. **Variation stays inside a defined identity.** Randomness uses named seed namespaces, compatibility rules, and bounded ranges. Renaming a character must not redesign or recast them.
6. **Rendering does not silently rewrite creative decisions.** Preparation may be invoked automatically as an idempotent preflight, but accepted voices, assets, and manual edits remain stable.
7. **Models are optional capabilities.** A project remains renderable when an optional model is unavailable.
8. **Downloads are explicit and governed.** Models are version-pinned, license-checked, benchmarked, and stored under `F:\ai-models`; rendering never triggers an unannounced download.
9. **Originality is deliberate.** Replace imitation-oriented prompts with concrete, show-owned rules for line, shape, palette, performance, sound, and editing.

## Target architecture

```text
Screenplay + ShowIdentity + Approved Asset Library
                         │
                         ▼
          Optional Writer / Director Model
             (schema-constrained proposals)
                         │
                         ▼
       Cast + Set + Performance + Shot Plans
                         │
                         ▼
                      SceneIR
                    ┌────┴────┐
                    ▼         ▼
              SVG Renderer  Audio Bus
                    └────┬────┘
                         ▼
                    Final Export

 Image model → Offline Asset Lab → Review/approve → Asset Library
 Video model → Isolated experiment → Review/bake → Special insert only
```

### `ShowIdentity` profile

The profile has a stable ID, semantic version, content hash, seed, and explicit precedence:

```text
show defaults → character/set overrides → scene overrides → beat overrides → locks
```

It owns five related identity bibles:

- **Visual bible:** palette roles, shape language, line and texture treatment, set motifs, outfit families, ensemble contrast, typography, and title-card templates.
- **Performance bible:** acting styles, gaze behavior, reaction latency, gesture arcs, listening behavior, idle motion, and intensity limits.
- **Editorial bible:** shot grammar, shot-size budgets, continuity rules, cut rhythm, camera punctuation, and title/end sequences.
- **Audio bible:** voice assignments and provenance, vocal personality, acoustic spaces, ambience recipes, stings, and mix targets.
- **Variation policy:** allowed ranges, exclusions, compatibility constraints, named seed namespaces, and locked properties.

The identity ID, version, and hash must propagate into rigs, sets, shot lists, SceneIR, model proposals, audio manifests, and cache keys. Structural character appearance, scene-specific outfits, voice casting, and acting profile are separate data so one can change without accidentally changing the others.

## Delivery roadmap

### M17 — Identity foundation and safe migration

Build the shared foundation before adding more variation.

**Deliverables**

- Define and validate `ShowIdentity v1`.
- Add stable IDs for shows, characters, sets, scenes, outfits, and assets.
- Implement precedence, per-property locks, and named RNG streams.
- Replace the global style switch and name-derived identity rolls with profile-owned rules and stable character seeds.
- Remove hard-coded references to named existing shows from writer/director prompts.
- Add profile create, edit, validate, import, export, clone, and compare workflows across CLI, API, and UI.
- Add a version-aware legacy migration command with dry-run, backup, and visible diff.
- Selectively backfill missing fields instead of treating schema defaults as a creative migration.
- Preserve hand-authored rig, voice, outfit, and idle properties during upgrades and regeneration.
- Create two deliberately contrasting fixture profiles and one common evaluation script.
- Add profile, migration, determinism, and UI-build checks to CI.

**Exit gate**

- The same script under the two fixture profiles is visibly and audibly different.
- Existing projects upgrade without losing hand-authored choices.
- Locked fields survive regeneration, directing, preview, and rendering.
- Renaming a character does not change design, voice, or seeded behavior.

### M18 — Voice casting and production audio

Stabilize voice identity and the audio pipeline before expanding acting behavior.

**Deliverables**

- Replace path-only voice caching with content-addressed reference files.
- Include reference bytes, engine/model version, synthesis settings, voice persona, and identity version in cache keys.
- Add an explicit **Prepare Voices** workflow; render invokes the same idempotent preflight for genuinely missing Chatterbox references.
- Generate two or three stable candidates in one batch, audition them together, and commit the winner atomically.
- Preserve the current voice until a candidate is accepted; support cancel and rollback.
- Exclude recorded dialogue, deduplicate aliases sharing a rig, and lock preparation per rig.
- Reset Chatterbox conditioning between every speaker so one character cannot inherit another character's reference state.
- Reuse a long-lived synthesis worker where practical and keep its cache/temp paths on `F:`.
- Add bounded `VoicePersona` values for energy, pace, pitch range, and delivery intensity.
- Introduce a fixed master-bus format, deterministic resampling, floating-point accumulation, headroom, fades, limiting, and loudness/peak targets.
- Separate the acoustic profile from the visual palette.
- Add deterministic ambience, title/end stings, and intentional silence as profile-owned options.
- Use one soundtrack assembly path for preview, voice generation, and final export.
- Fingerprint the soundtrack from timing, references, synthesis settings, ambience, cards, and identity version so stale audio is never played against a new edit.

**Exit gate**

- Six characters are distinguishable in a blind voice-only test.
- One character stays recognizable across neutral, quiet, excited, and angry deliveries.
- Replacing a reference cannot return stale cached speech.
- Mixed referenced/unreferenced batches have no conditioning bleed.
- Dialogue, ambience, stings, and silence render without clipping, sample-rate changes, or abrupt seams.
- An ambience-only scene works when there is no dialogue.

### M19 — Visual bible, cast design, sets, and titles

Turn visual variation into an ensemble-level design system.

**Deliverables**

- Separate immutable character structure from wardrobe and scene-specific costume.
- Define profile-owned outfit archetypes, costume families, silhouette categories, palette roles, and compatibility rules.
- Apply harmony and contrast across the cast instead of independently rolling every clothing field.
- Preserve costume continuity across shots and scenes.
- Add sleeves, collars, neckwear, patterns, hats, shoes, and accents through those outfit archetypes.
- Split SVG fill, clipped pattern, and outline passes; namespace all clip IDs.
- Update face bounds and framing rules for hats, tall hair, and silhouette accessories.
- Define set motifs, materials, prop families, palette relationships, and approved variation ranges.
- Add a versioned asset manifest containing source, license, model revision, prompt, seed, hash, and approval status.
- Bundle a licensed font or approved vector glyph assets instead of depending on machine fonts.
- Create profile-owned title, subtitle, credit, and end-card templates.
- Store card mode, content, template, and integer-frame duration in the project; escape all authored text safely.
- Add silhouette, outfit, set, framing, pattern-clipping, and card golden tests.

**Exit gate**

- Main characters are recognizable from small silhouette thumbnails.
- Costume changes do not alter core character identity.
- A cast reads as a designed ensemble, not independent random combinations.
- Hats and patterns work across all supported bodies, hair, close-ups, and sheets.
- Title cards render identically without relying on the developer's installed fonts.
- The visual bible can change without editing renderer code.

### M20 — Performance language

Move from one expression and gesture per beat to a timed, reusable performance system.

**Deliverables**

- Add timed tracks for face, body, gaze, speech activity, and reactions.
- Represent gesture onset, apex, hold, and recovery separately.
- Add addressee and gaze targets so characters can listen and react.
- Allow facial expression, mouth activity, and body motion to overlap independently.
- Add deterministic reaction latency, glance behavior, and listening poses.
- Introduce reusable motion clips with identity-specific variants.
- Roll or author acting profiles for gesture frequency, restraint, head movement, posture, fidget style, and reaction speed.
- Use held, frame-grid-aligned weight shifts or explicit steps; avoid continuous fidgets that destroy frame deduplication or cause foot sliding.
- Preserve explicit pauses and `[BEAT]` durations exactly.
- Treat generated timing or performance changes as reviewable suggestions, not automatic rewrites.
- Add repeated-compile and performance-track determinism tests.

**Exit gate**

- A character visibly listens and reacts while another speaks.
- Short and long lines produce coherent motion arcs instead of repeated toggles.
- Explicit pauses remain exact after directing and recompilation.
- Performance remains stable across rerenders while clearly changing between identity profiles.

### M21 — Camera grammar, editorial integration, and identity UX

Join the identity systems into one authoring and export workflow.

**Deliverables**

- Define profile-owned shot grammar, shot-size distribution, cut cadence, screen direction, eyelines, and continuity constraints.
- Implement moves such as `SNAP_IN` as optional profile primitives with exact frames, thresholds, cooldowns, quotas, and precedence.
- Preserve explicit authored shots and edits.
- Change **Direct** from destructive replacement to propose, diff, merge, lock, and apply.
- Store all timeline durations as integer frames.
- Prepend/append cards without advancing the actors' local performance clock.
- Unify preview and export timeline calculations and return canonical beat starts from compilation.
- Add identity preflight for missing fonts, references, assets, models, stale audio, invalid locks, and unsupported scene actions.
- Add side-by-side identity-profile comparison and a compact evaluation-reel builder.
- Produce the final Phase 3 reel.

**Exit gate**

- Removing card frames from a cards-on render produces the same performance sequence as cards-off.
- Repeated renders with pinned inputs produce identical SceneIR, SVG, timing, and soundtrack bytes.
- Director reruns preserve locked and hand-edited beats.
- Camera choices follow the selected grammar without breaking screen direction or continuity.
- A 30–60 second reel demonstrates cast, wardrobe, set, voice, performance, camera, sound, and titles as one coherent identity.

## Optional parallel track — Local Model Asset Lab

Specialized local models are useful, but the best specialization target is the asset workflow—not final scene rendering.

### Download after M17: FLUX.2 Klein 4B

Use the distilled `black-forest-labs/FLUX.2-klein-4B` for:

- Character and wardrobe concept sheets.
- Set plates and set-dressing studies.
- Prop, poster, texture, and title-card exploration.
- Multi-reference visual ideation.
- Source images that are reviewed, simplified, traced, layered, or rebuilt as deterministic project assets.

The 4B model is Apache 2.0, supports generation and multi-reference editing, and is documented at roughly 13 GB VRAM, so it is a realistic fit for the 16 GB GPU when other GPU-heavy applications are closed. It is an authoring tool: generate → review → bake/hash → render. It never runs during final rendering. See the [official model card](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B) and [FLUX.2 overview](https://docs.bfl.ai/flux_2/flux2_overview).

### Train after a style-corpus gate: FLUX.2 Klein Base 4B LoRA

Train a show-owned style LoRA only when there is a coherent, original, rights-cleared visual corpus and a held-out prompt suite. Start with 20–40 carefully curated source images, detailed captions, varied compositions, and separate validation prompts. The official guidance lists 12 GB VRAM and 32 GB RAM as the minimum for 4B Base training, with consumer-GPU LoRA runs typically taking 1–3 hours. This workstation qualifies at the floor, so training is feasible but should be treated as a scheduled GPU job. See the [official training guide](https://docs.bfl.ai/flux_2/flux2_klein_training).

The LoRA remains a design assistant. Accepted outputs are curated and baked into the asset library with provenance; they do not replace the SVG characters or SceneIR renderer.

### Keep now: Qwen3 14B and Chatterbox

- **Qwen3 14B** is adequate for profile drafting, screenplay structure, set descriptions, and schema-constrained `DirectingPatch`/performance proposals. Ollama can enforce JSON Schema outputs, which is more valuable now than swapping models. Improve the show bible, examples, validation, and evaluation loop first. See [Qwen3 14B](https://huggingface.co/Qwen/Qwen3-14B) and [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs).
- **Chatterbox** is adequate for local voice cloning once reference provenance, candidate casting, cache correctness, and worker isolation are fixed. Optionally benchmark Chatterbox Turbo for compute and expressive tags, but adopt it only if blind tests beat the current engine. See the [official Chatterbox repository](https://github.com/resemble-ai/chatterbox).

### Train later, only if data justifies it: director LoRA

Do not fine-tune a planner to compensate for a missing identity schema. First collect roughly 100–300 human-approved examples mapping screenplay + identity profile to a compact `DirectingPatch`, including rejected alternatives and the final edit. Keep a fixed held-out evaluation set.

If the current Qwen3 14B baseline still requires excessive manual correction, download a trainable 4B-class base checkpoint and run a QLoRA/PEFT bake-off. `Qwen/Qwen3.5-4B-Base` is an appropriate candidate because its official model card identifies fine-tuning and LoRA-style PEFT as intended uses. It must beat the existing 14B baseline on schema validity, edit count, show-rule adherence, and blind directing preference before adoption. The installed Ollama GGUF is an inference artifact, not the checkpoint to train. See the [Qwen3.5 4B Base model card](https://huggingface.co/Qwen/Qwen3.5-4B-Base).

### Experimental only: one baked generative-video insert

Video generation remains outside the production core. A future spike may test one 3–5 second pre-rendered gag or style-break clip:

- **LTX Desktop/LTX-2.3 inference:** the official Windows local floor is 16 GB VRAM, with 32 GB RAM and 160 GB free disk recommended. This machine is exactly at the VRAM/RAM threshold. Its default Windows data location is on the system drive, so it must not be installed under the standing `F:`-only model policy unless its entire data path is safely redirected. LTX training is not feasible here: the official low-VRAM trainer targets about 32 GB VRAM on Linux and recommends 80 GB for the standard configuration. See [LTX Desktop](https://github.com/Lightricks/LTX-Desktop) and the [LTX trainer quick start](https://github.com/Lightricks/LTX-2/blob/main/packages/ltx-trainer/docs/quick-start.md).
- **Wan2.1 T2V-1.3B:** the lighter alternative. Its official repository reports 8.19 GB VRAM and about four minutes on an RTX 4090 for five seconds at 480p. It is plausible for an isolated experiment, not a fast iteration loop. See [Wan2.1](https://github.com/Wan-Video/Wan2.1).

Do not plan around Wan2.2 on this GPU: the official repository requires at least 24 GB VRAM for TI2V-5B and 80 GB for its 14B paths. See [Wan2.2](https://github.com/Wan-Video/Wan2.2).

Any experimental clip must be reviewed, licensed, baked, hashed, and treated as an immutable asset. Measure generation time, peak VRAM/RAM, character drift, editability, and reproducibility before adding a special `GENERATED_CLIP` beat type.

## Model intake policy

Every downloaded model must have:

- Exact repository, revision SHA, checksum, license, intended purpose, and storage estimate in a model manifest.
- Model weights and caches under `F:\ai-models`; temporary generation data under an explicit `F:` workspace.
- Its own environment for image, voice, language, or video work; do not upgrade one model's environment to satisfy another.
- A small acceptance benchmark and an offline fallback or graceful feature disable.
- Provenance recorded for every baked output: model/revision, adapter, prompt, seed, source references, license, hash, and approval state.
- One GPU-heavy job at a time; unload or stop competing Ollama, image, video, and TTS jobs before a benchmark or training run.
- No implicit network access or model download during scene render.

## Dependency order

The milestones are not fully independent:

```text
M17 Identity foundation
 ├─→ M18 Voice/audio ─────────┐
 ├─→ M19 Visual/sets/cards ───┼─→ M20 Performance ─→ M21 Editorial/UX
 └─→ Asset Lab contract ──────┘
```

M18 and M19 can overlap after M17's schema, migration, fingerprint, and cache contracts are stable. M20 follows the canonical frame/audio timeline work. M21 integrates the whole system. The Asset Lab can begin after M17, but style-LoRA training waits for the M19 visual bible and rights-cleared corpus.

## Phase 3 acceptance suite

### Identity

- The same script under two profiles is distinguishable in a blind comparison.
- Different scripts under one profile still feel like the same show.
- Characters are recognizable in silhouette-only and voice-only tests.
- Wardrobe, sets, titles, motion, camera, and sound reinforce the same identity.

### Determinism and continuity

- Repeated renders from pinned inputs match.
- Renames do not recast characters.
- Costumes, props, and approved assets persist across shots.
- Cards do not shift performance timing.
- Explicit beats and locked choices survive every regeneration path.
- Generated proposals and assets are stored; they are never silently regenerated.

### Audio

- No stale reference cache or cross-character conditioning bleed.
- No clipping, unplanned silence, abrupt ambience seams, or accidental sample-rate changes.
- Dialogue-muted and ambience-only renders behave correctly.
- Preview and final export use the same soundtrack manifest and timing.

### Authoring workflow

- All generated changes have a visible diff.
- Identity upgrades and candidate voices can be previewed and rolled back.
- CLI, API, and UI expose the same identity concepts.
- Preflight finds missing assets, fonts, voices, models, stale audio, and unsupported actions before a long render begins.

## Principal risks and mitigations

- **Random variety is mistaken for identity.** Use profile-owned rules, outfit archetypes, ensemble constraints, and bounded variation.
- **Migration flattens existing characters into defaults.** Use selective backfill, stable IDs, dry runs, backups, and visible diffs.
- **Model output drifts between renders.** Store approved structured output and bake approved assets into the project.
- **Voice state or cache keys produce the wrong speaker.** Use content hashes, explicit worker resets, atomic references, and versioned settings.
- **Performance becomes busy rather than intentional.** Use timed acting tracks, quotas, held poses, gesture arcs, and identity-specific restraint.
- **Downloads consume the system drive or become unreproducible.** Centralize on `F:`, pin revisions, checksum weights, and record licenses.
- **A model is used to hide renderer limitations.** Add missing concepts to the schema, SceneIR, and renderer before adding an AI shortcut.
- **Generated material weakens originality.** Remove imitation prompts and train only on original or rights-cleared work that expresses the show's own visual rules.

## Explicitly out of scope for Phase 3

- Per-frame diffusion or generative video as the primary renderer.
- Fully autonomous directing that overwrites authored choices.
- Full 3D animation, physics, or motion capture.
- Automatic recreation of a named existing show's style.
- One-click useful model training from a handful of examples.
- Unreviewed generative assets in final exports.
- Complex multi-room staging, entrances, exits, and prop-driven action.

## Follow-on Phase 4 — Scene expressiveness

Once identity is stable, expand what the engine can stage:

- Per-beat character blocking, addressees, gaze, visibility, and depth layer.
- Entrances, exits, crossings, and restaging.
- Prop pickup, placement, transfer, use, and continuity.
- Action poses and multi-character physical interaction.
- Multi-room and multi-set sequences with transitions.
- Foreground/background staging and richer composition.
- Camera movement tied to blocking rather than dialogue heuristics alone.
- Schema-constrained Qwen proposals for blocking and action, validated against renderer capabilities.
- Optional baked assets from the Asset Lab when a set or prop benefits from them.

Phase 3 should make a dialogue scene unmistakably belong to a particular show. Phase 4 should let that show stage a much wider range of scenes.
