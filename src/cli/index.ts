#!/usr/bin/env -S npx tsx
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, OUT_DIR, CAST_DIR, SCRIPTS_DIR, SETS_DIR, sceneDir } from '../core/paths.ts';
import { MODELS_ROOT, HF_CACHE, OLLAMA_MODELS, strayCacheLocations } from '../core/models.ts';
import { loadSet, saveSet, listSets, validateSet, setPath, renderSet } from '../sets/index.ts';
import { BUILTIN_SETS, BUILTIN_SET_NAMES } from '../sets/builtins.ts';
import { propManifest, propTags } from '../sets/props/index.ts';
import { PALETTE_NAMES } from '../sets/palettes.ts';
import { buildPlaceholderRig, buildPlaceholderSvg } from '../cast/placeholder.ts';
import { facePlates, bodyPlate, sheetHtml, type Plate } from '../cast/sheet.ts';
import { createRig, regenerateRig } from '../cast/authoring.ts';
import { assignEnsemble } from '../cast/ensemble.ts';
import { activeIdentity } from '../show/context.ts';
import { saveRig, loadRig, listRigs, validateRig, type LoadedRig } from '../cast/store.ts';
import { compileScene, DEFAULT_PLAN, type ActorPlan, type ScenePlan } from '../compile/index.ts';
import { estimateLineMs } from '../compile/scene.ts';
import { checkScript, loadRigsForShotList } from '../pipeline/check.ts';
import { renderScene } from '../pipeline/render.ts';
import { readShotList, writeShotList, shotlistPath, writeScript } from '../pipeline/scene.ts';
import { Ollama, pickModel } from '../llm/ollama.ts';
import { initShow, loadProfile, listProfiles, activeProfileId, setActiveProfileId, compareProfiles } from '../show/store.ts';
import { setActiveIdentity } from '../show/context.ts';
import { identityHash, type ShowIdentity } from '../schema/identity.ts';
import { planMigration, applyMigration } from '../show/migrate.ts';
import { generateScript } from '../llm/script.ts';
import { generateSet } from '../llm/set.ts';
import { renderFrames } from '../render/capture.ts';
import { encodeMp4, ffmpegVersion, ffmpegPath } from '../render/encode.ts';
import { parseScript } from '../parse/index.ts';
import { autoDirect, buildCapabilityManifest, validateShotList } from '../direct/index.ts';
import { synthesizeLines, loadRecordedVo, listVoices, getEngine, ENGINE_NAMES, type LineTiming, type VoiceLine } from '../voice/index.ts';
import { findRhubarb } from '../voice/rhubarb.ts';
import { ShotList } from '../schema/script.ts';

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

function num(flags: Args['flags'], key: string, fallback: number): number {
  const v = flags[key];
  if (v === undefined || typeof v === 'boolean') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number, got "${v}"`);
  return n;
}

/** Default set coordinate space: 1:1 with a 720p frame, ground near the bottom. */
const STAGE = { w: 1280, h: 720, ground: 700 };

async function loadRigsFor(names: string[]): Promise<Map<string, LoadedRig>> {
  const map = new Map<string, LoadedRig>();
  for (const n of new Set(names)) {
    if (!map.has(n)) map.set(n, await loadRig(n));
  }
  return map;
}

/** Spread actors evenly across the frame, all facing centre. */
function autoStage(names: string[], scale: number): ActorPlan[] {
  return names.map((name, i) => {
    const slot = (i + 1) / (names.length + 1);
    const x = STAGE.w * slot;
    return {
      id: name,
      rig: name,
      x,
      y: STAGE.ground,
      scale,
      flip: x > STAGE.w / 2,
      pose: 'IDLE',
      expression: 'NEUTRAL',
    };
  });
}

// --- commands -------------------------------------------------------------

async function cmdCastNew(args: Args) {
  const name = args._[0];
  if (!name) throw new Error('usage: anim cast new <name>');
  if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error('character name must be alphanumeric (dashes and underscores allowed)');

  const { rig } = await createRig(name);

  console.log(`Created ${path.relative(process.cwd(), path.join(CAST_DIR, `${name}.rig.json`))}`);
  console.log(`        ${path.relative(process.cwd(), path.join(CAST_DIR, rig.svg))}`);
  console.log(`\n${rig.parts.length} parts, ${rig.swapSets.length} swap slots, ${rig.poses.length} poses, ${rig.expressions.length} expressions.`);
  console.log(`Preview it:  npm run anim -- still ${name}`);
}

async function cmdCastList() {
  const names = await listRigs();
  if (!names.length) {
    console.log('No characters yet. Create one with:  npm run anim -- cast new steve');
    return;
  }
  for (const n of names) {
    const { rig } = await loadRig(n);
    console.log(`${n.padEnd(16)} ${rig.parts.length} parts, voice=${rig.voice}`);
  }
}

async function cmdCastCheck(args: Args) {
  const names = args._.length ? args._ : await listRigs();
  if (!names.length) {
    console.log('No characters to check.');
    return;
  }
  let bad = 0;
  for (const name of names) {
    const loaded = await loadRig(name);
    const errors = validateRig(loaded);
    if (errors.length) {
      bad++;
      console.log(`FAIL ${name}`);
      for (const e of errors) console.log(`     - ${e}`);
    } else {
      console.log(`ok   ${name}`);
    }
  }
  if (bad) process.exitCode = 1;
}

/**
 * Redraw characters after the puppet generator changes.
 *
 * Voice settings and any hand-tuned idle survive; the art does not. Without
 * `--reroll` a character keeps the look they have, so this picks up new drawing
 * features without recasting anyone's face.
 */
async function cmdCastRegen(args: Args) {
  const names = args._.length ? args._ : await listRigs();
  if (!names.length) throw new Error('no characters — run: anim cast new steve');

  const reroll = Boolean(args.flags['reroll']);
  const redress = Boolean(args.flags['redress']);

  // Re-dressing runs the whole cast through the ensemble assigner together, so
  // family caps (two suits per scene, one walking wrong object) apply across
  // the group rather than per character in isolation.
  const wardrobe = redress
    ? assignEnsemble(activeIdentity(), await Promise.all(names.map(async (n) => (await loadRig(n)).rig.charId ?? n)))
    : null;

  for (const name of names) {
    const charId = (await loadRig(name)).rig.charId ?? name;
    const { rig } = await regenerateRig(name, {
      reroll,
      outfit: wardrobe?.get(charId)?.outfit,
    });
    const l = rig.look;
    const o = rig.outfit;
    console.log(
      `ok   ${name.padEnd(12)} ${l ? `${l.build}/${l.head}` : ''}` +
        (o ? `  ${wardrobe?.get(charId)?.family ?? ''} ${o.collar}/${o.neckwear}/${o.pattern}${o.hat !== 'none' ? '/' + o.hat : ''}` : ''),
    );
  }
  console.log(`\nRedrew ${names.length} character${names.length === 1 ? '' : 's'}.`);
}

/**
 * A contact sheet as a PNG.
 *
 * With a name, every expression that character has; without one, the whole cast
 * side by side. Both answer the question you actually have when you change the
 * puppet generator, which is never "does this one look right" but "does this one
 * look like a different person from that one".
 */
async function cmdCastSheet(args: Args) {
  const names = args._.length ? args._ : await listRigs();
  if (!names.length) throw new Error('no characters — run: anim cast new steve');

  let plates: Plate[];
  let label: string;

  if (args._.length === 1) {
    const loaded = await loadRig(names[0]!);
    plates = facePlates(loaded);
    label = `faces-${names[0]}`;
  } else {
    plates = [];
    const expression = typeof args.flags['expression'] === 'string' ? args.flags['expression'] : undefined;
    for (const n of names) {
      plates.push(bodyPlate(await loadRig(n), expression));
    }
    label = 'cast';
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1760, height: 900 } });
    await page.setContent(sheetHtml(plates, { columns: Math.min(plates.length, 8) }));
    const grid = await page.$('.grid');
    const out = path.join(OUT_DIR, `sheet-${label}.png`);
    await grid!.screenshot({ path: out });
    console.log(`Wrote ${path.relative(process.cwd(), out)}  (${plates.length} plates)`);
  } finally {
    await browser.close();
  }
}

async function cmdStill(args: Args) {
  const names = args._.length ? args._ : await listRigs();
  if (!names.length) throw new Error('no characters — run: anim cast new steve');

  const rigs = await loadRigsFor(names);
  const scale = num(args.flags, 'scale', 1.3);
  const actors = autoStage(names, scale);

  const pose = typeof args.flags['pose'] === 'string' ? args.flags['pose'] : 'IDLE';
  const expression = typeof args.flags['expression'] === 'string' ? args.flags['expression'] : 'NEUTRAL';
  for (const a of actors) {
    a.pose = pose;
    a.expression = expression;
  }

  const plan: ScenePlan = {
    scene: `still-${names.join('-')}`,
    fps: DEFAULT_PLAN.fps,
    characterFps: DEFAULT_PLAN.characterFps,
    width: STAGE.w,
    height: STAGE.h,
    seed: num(args.flags, 'seed', DEFAULT_PLAN.seed),
    durationSec: 1 / DEFAULT_PLAN.fps,
    camera: { x: 0, y: 0, w: STAGE.w, h: STAGE.h },
    set: null,
    audio: null,
    actors,
  };

  const ir = compileScene(plan, rigs);
  const dir = sceneDir(plan.scene);
  await fs.mkdir(dir, { recursive: true });

  const result = await renderFrames({ ir, rigs, dir, background: '#2b2f36' });
  const out = path.join(OUT_DIR, `${plan.scene}.png`);
  await fs.copyFile(path.join(result.framesDir, '000000.png'), out);
  console.log(`Wrote ${path.relative(process.cwd(), out)}`);
}

async function cmdIdle(args: Args) {
  const names = args._.length ? args._ : await listRigs();
  if (!names.length) throw new Error('no characters — run: anim cast new steve');

  const rigs = await loadRigsFor(names);
  const seconds = num(args.flags, 'seconds', 6);
  const fps = num(args.flags, 'fps', DEFAULT_PLAN.fps);
  const characterFps = num(args.flags, 'char-fps', DEFAULT_PLAN.characterFps);

  const plan: ScenePlan = {
    scene: `idle-${names.join('-')}`,
    fps,
    characterFps,
    width: STAGE.w,
    height: STAGE.h,
    seed: num(args.flags, 'seed', DEFAULT_PLAN.seed),
    durationSec: seconds,
    camera: { x: 0, y: 0, w: STAGE.w, h: STAGE.h },
    set: null,
    audio: null,
    actors: autoStage(names, num(args.flags, 'scale', 1.3)),
  };

  const ir = compileScene(plan, rigs);
  const dir = sceneDir(plan.scene);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'scene.ir.json'), JSON.stringify(ir, null, 2), 'utf8');

  let lastLogged = 0;
  const result = await renderFrames({
    ir,
    rigs,
    dir,
    background: '#2b2f36',
    onProgress: (done, total) => {
      if (done === total || done - lastLogged >= 24) {
        lastLogged = done;
        process.stdout.write(`\r  rendering ${done}/${total} frames`);
      }
    },
  });
  process.stdout.write('\n');

  const saved = Math.round((1 - result.captured / result.total) * 100);
  console.log(`  captured ${result.captured} unique of ${result.total} frames (${saved}% held)`);

  const out = path.join(dir, `${plan.scene}.mp4`);
  await encodeMp4({ framesDir: result.framesDir, fps, out });
  console.log(`Wrote ${path.relative(process.cwd(), out)}`);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const SCRIPT_TEMPLATE = `# YOUR TITLE HERE

// ─── FORMAT ────────────────────────────────────────────────────────────────
// # Title            the first one names the piece
// INT. PLACE - DAY   scene heading
// ALL CAPS ALONE     character cue — the next non-blank line is their dialogue
// (deadpan)          parenthetical, right under a cue. Sets how the line is
//                    both drawn and performed. See the list below.
// [BEAT 1200]        a pause, in milliseconds. Cuts to whoever is NOT talking.
// anything else      action. Held on a wide shot for a moment.
// // like this       a comment. Ignored entirely.
//
// PARENTHETICALS map to expressions by keyword:
//   deadpan / flat / monotone / blank  -> DEADPAN   (the default)
//   angry / annoyed / snaps / yells    -> ANGRY
//   shocked / surprised / alarmed      -> SHOCKED
//   smug / pleased / satisfied         -> SMUG
//   sad / defeated / deflated / quiet  -> SAD
//   confused / puzzled / unsure        -> CONFUSED
//   cheerful / bright / happy / warm   -> NEUTRAL
//
// Characters are cast automatically from the cues — no setup needed.
// Check it before rendering:   npm run anim -- check <this-file>
// ───────────────────────────────────────────────────────────────────────────

INT. OPEN PLAN OFFICE - MORNING

Someone approaches a desk holding a mug they never drink from.

ALICE
(deadpan)
Morning.

BOB
(flat)
Morning.

[BEAT 1200]

ALICE
So that'd be great.
`;

async function cmdNew(args: Args) {
  const name = args._[0];
  if (!name) throw new Error('usage: anim new <scene-name>');

  const base = name.endsWith('.md') ? name : `${name}.md`;
  const file = path.join(SCRIPTS_DIR, base);
  if (await fileExists(file)) throw new Error(`${path.relative(process.cwd(), file)} already exists`);

  await fs.mkdir(SCRIPTS_DIR, { recursive: true });
  await fs.writeFile(file, SCRIPT_TEMPLATE, 'utf8');

  console.log(`Created ${path.relative(process.cwd(), file)}`);
  console.log(`\nWrite it, then:`);
  console.log(`  npm run anim -- check ${base}`);
  console.log(`  npm run anim -- render ${base} --set office`);
}

/**
 * Parse, direct and validate a script without rendering anything.
 *
 * The whole point is speed: this runs in well under a second, so format
 * mistakes and pacing problems surface before you spend minutes on voices and
 * frames.
 */
async function cmdCheck(args: Args) {
  const scriptPath = await resolveScript(args._[0]);
  const scene = path.basename(scriptPath).replace(/\.[^.]+$/, '');
  const screenplay = parseScript(await fs.readFile(scriptPath, 'utf8'), scene);

  console.log(`${screenplay.title}`);
  console.log(`  ${path.relative(process.cwd(), scriptPath)}\n`);

  if (!screenplay.characters.length) {
    console.log('  No characters found. A cue must be ALL CAPS on its own line,');
    console.log('  with their dialogue on the next line.');
    process.exitCode = 1;
    return;
  }

  const names = screenplay.characters.map((c) => c.toLowerCase());
  const onDisk = new Set(await listRigs());

  // Stand in for missing characters in memory so validation can run without
  // writing anything to the cast folder.
  const rigs = new Map<string, LoadedRig>();
  for (const name of names) {
    rigs.set(
      name,
      onDisk.has(name)
        ? await loadRig(name)
        : { rig: buildPlaceholderRig(name), svg: buildPlaceholderSvg(name) },
    );
  }

  console.log(`  cast     ${names.map((n) => (onDisk.has(n) ? n : `${n} (new)`)).join(', ')}`);

  const shots = autoDirect(screenplay, rigs, {
    scene,
    seed: num(args.flags, 'seed', 7),
    resting: typeof args.flags['resting'] === 'string' ? args.flags['resting'] : 'DEADPAN',
  });

  const counts = { line: 0, pause: 0, action: 0 };
  let ms = 0;
  for (const beat of shots.beats) {
    counts[beat.kind]++;
    ms += beat.kind === 'line' ? estimateLineMs(beat.text) : beat.ms;
  }

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  console.log(
    `  beats    ${shots.beats.length} (${plural(counts.line, 'line')}, ` +
      `${plural(counts.pause, 'pause')}, ${counts.action} action)`,
  );
  console.log(`  runtime  ~${(ms / 1000).toFixed(0)}s estimated\n`);

  const errors = validateShotList(shots, buildCapabilityManifest(rigs));
  if (errors.length) {
    console.log('  NOT RENDERABLE:');
    for (const e of errors) console.log(`    - ${e}`);
    process.exitCode = 1;
    return;
  }

  const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
  console.log('  #   kind    shot      who       how        what');
  console.log('  ' + '─'.repeat(74));
  shots.beats.forEach((beat, i) => {
    const who = beat.kind === 'line' ? beat.speaker : (beat.focus[0] ?? '');
    const how = beat.kind === 'line' ? beat.expression : '';
    const what =
      beat.kind === 'line' ? `"${beat.text}"` : beat.kind === 'pause' ? `${beat.ms}ms` : beat.text;
    console.log(
      `  ${String(i).padEnd(4)}${pad(beat.kind, 8)}${pad(beat.shot, 10)}${pad(who, 10)}${pad(how, 11)}${pad(what, 30)}`,
    );
  });

  console.log(`\n  Looks renderable. Next:`);
  console.log(`    npm run anim -- render ${path.basename(scriptPath)} --set office`);
}

/**
 * Resolve a set by name, writing the builtin descriptor if it isn't on disk yet.
 *
 * Validated before returning, so a hand-edited or generated descriptor that
 * references a prop or palette that doesn't exist fails here with the offending
 * key named, rather than midway through a render.
 */
async function ensureSet(name: string): Promise<string> {
  const base = name.replace(/\.(json|svg)$/i, '');
  const file = setPath(base);

  if (!(await fileExists(file))) {
    const builtin = BUILTIN_SETS[base];
    if (!builtin) {
      const known = [...new Set([...(await listSets()), ...BUILTIN_SET_NAMES])].sort();
      throw new Error(`no set "${base}". Available: ${known.join(', ')}`);
    }
    await saveSet(builtin);
    console.log(`  set      generated ${path.relative(process.cwd(), file)}`);
  }

  const errors = validateSet(await loadSet(base));
  if (errors.length) {
    throw new Error(`set "${base}" is not renderable:\n  - ${errors.join('\n  - ')}`);
  }
  return base;
}

async function cmdSets(args: Args) {
  const sub = args._[0];

  if (sub === 'props') {
    const filter = typeof args.flags['tag'] === 'string' ? args.flags['tag'] : null;
    const props = propManifest().filter((p) => !filter || p.tags.includes(filter));
    for (const p of props) {
      const params = p.params.map((s) => s.key).join(', ') || '—';
      console.log(`${p.key.padEnd(18)} ${p.label.padEnd(20)} [${p.tags.join(' ')}]`);
      console.log(`${' '.repeat(18)} params: ${params}`);
    }
    console.log(`\n${props.length} props. Tags: ${propTags().join(', ')}`);
    return;
  }

  if (sub === 'palettes') {
    for (const name of PALETTE_NAMES) console.log(name);
    return;
  }

  if (sub === 'describe') {
    const description = args._.slice(1).join(' ').trim();
    if (!description) throw new Error('usage: anim sets describe "<description>" [--name my-set]');

    const model = await requireModel(typeof args.flags['model'] === 'string' ? args.flags['model'] : undefined);
    const name =
      typeof args.flags['name'] === 'string'
        ? args.flags['name']
        : description.toLowerCase().split(/\s+/).slice(0, 3).join('-').replace(/[^\w-]/g, '');

    console.log(`  model    ${model}`);
    console.log(`  designing…`);

    const { set, attempts, warnings } = await generateSet({ description, model, name });
    await saveSet(set);
    const count = set.layers.back.length + set.layers.mid.length + set.layers.fore.length;
    console.log(`  built    ${count} props, palette=${set.palette}${attempts > 1 ? ` (${attempts} attempts)` : ''}`);
    for (const w of warnings) console.log(`  note     ${w}`);
    console.log(`\nWrote ${path.relative(process.cwd(), setPath(set.name))}`);
    console.log(`  npm run anim -- sets preview ${set.name}`);
    return;
  }

  if (sub === 'preview') {
    const name = args._[1];
    if (!name) throw new Error('usage: anim sets preview <name> [--cast steve,paul]');
    const setFile = await ensureSet(name);

    // Stage real characters in it — a set is impossible to judge empty, since
    // the whole question is whether people read correctly against it.
    const requested = typeof args.flags['cast'] === 'string' ? args.flags['cast'].split(',') : [];
    const available = await listRigs();
    const names = requested.length ? requested : available.slice(0, 2);

    const rigs = new Map<string, LoadedRig>();
    const staged = names.length ? names : ['previewA', 'previewB'];
    for (const n of staged) {
      rigs.set(
        n,
        available.includes(n)
          ? await loadRig(n)
          : { rig: buildPlaceholderRig(n), svg: buildPlaceholderSvg(n) },
      );
    }

    const plan: ScenePlan = {
      scene: `set-${name}`,
      fps: DEFAULT_PLAN.fps,
      characterFps: DEFAULT_PLAN.characterFps,
      width: STAGE.w,
      height: STAGE.h,
      seed: num(args.flags, 'seed', 1),
      durationSec: 1 / DEFAULT_PLAN.fps,
      camera: { x: 0, y: 0, w: STAGE.w, h: STAGE.h },
      set: setFile,
      audio: null,
      actors: autoStage(staged, num(args.flags, 'scale', 1.25)),
    };

    const ir = compileScene(plan, rigs);
    const dir = sceneDir(plan.scene);
    await fs.mkdir(dir, { recursive: true });
    const result = await renderFrames({ ir, rigs, dir });
    const out = path.join(OUT_DIR, `${plan.scene}.png`);
    await fs.copyFile(path.join(result.framesDir, '000000.png'), out);

    const desc = await loadSet(setFile);
    const counts = `${desc.layers.back.length} back, ${desc.layers.mid.length} mid, ${desc.layers.fore.length} fore`;
    console.log(`${desc.name}  palette=${desc.palette}  (${counts})`);
    console.log(`Wrote ${path.relative(process.cwd(), out)}`);
    return;
  }

  const onDisk = await listSets();
  const all = [...new Set([...onDisk, ...BUILTIN_SET_NAMES])].sort();
  for (const name of all) {
    const where = onDisk.includes(name) ? 'sets/' : 'builtin';
    let detail = '';
    if (onDisk.includes(name)) {
      const desc = await loadSet(name);
      const count = desc.layers.back.length + desc.layers.mid.length + desc.layers.fore.length;
      detail = `  ${desc.palette}, ${count} props`;
    }
    console.log(`${name.padEnd(16)} ${where}${detail}`);
  }
  console.log(`\nanim sets props [--tag office]   list available props`);
  console.log(`anim sets palettes               list palettes`);
}

async function resolveScript(arg: string | undefined): Promise<string> {
  if (!arg) throw new Error('usage: anim check <script.md>');
  const p = path.isAbsolute(arg)
    ? arg
    : (await fileExists(arg))
      ? path.resolve(arg)
      : path.join(SCRIPTS_DIR, arg);
  if (!(await fileExists(p))) throw new Error(`no script at ${p}`);
  return p;
}

/**
 * Thin wrapper over the pipeline.
 *
 * All the orchestration lives in `src/pipeline/` so the CLI and the server run
 * the same code rather than two implementations that slowly disagree.
 */
async function cmdRender(args: Args) {
  const scriptPath = await resolveScript(args._[0]);
  const scene = path.basename(scriptPath).replace(/\.[^.]+$/, '');

  const setName = typeof args.flags['set'] === 'string' ? args.flags['set'] : null;
  const setFile = setName ? await ensureSet(setName) : null;

  let shots = args.flags['shotlist'] ? await readShotList(scene) : null;
  if (shots) {
    console.log(`  direct   using your edited ${path.relative(process.cwd(), shotlistPath(scene))}`);
  } else {
    const checked = await checkScript(await fs.readFile(scriptPath, 'utf8'), {
      scene,
      seed: num(args.flags, 'seed', 7),
      fps: num(args.flags, 'fps', 24),
      characterFps: num(args.flags, 'char-fps', 12),
      resting: typeof args.flags['resting'] === 'string' ? args.flags['resting'] : 'DEADPAN',
      set: setFile,
      createMissingCast: true,
    });

    for (const name of checked.newCharacters) console.log(`  cast     created placeholder for "${name}"`);

    if (!checked.shots || checked.errors.length) {
      console.error(`\nNot renderable:`);
      for (const e of checked.errors) console.error(`  - ${e}`);
      process.exitCode = 1;
      return;
    }

    shots = checked.shots;
    await writeShotList(scene, shots);
    console.log(`  direct   ${shots.beats.length} beats -> ${path.relative(process.cwd(), shotlistPath(scene))}`);
  }

  const rigs = await loadRigsForShotList(shots);
  const engineName = typeof args.flags['voice-engine'] === 'string' ? args.flags['voice-engine'] : 'chatterbox';

  let lastStage = '';
  const result = await renderScene(shots, rigs, {
    scene,
    engine: engineName,
    onStage: (p) => {
      if (p.stage !== lastStage) {
        if (lastStage) process.stdout.write('\n');
        lastStage = p.stage;
      }
      const detail = p.message ? `  ${p.message}` : '';
      process.stdout.write(`\r  ${p.stage.padEnd(8)} ${p.done}/${p.total}${detail}`);
    },
  });
  if (lastStage) process.stdout.write('\n');

  const held = Math.round((1 - result.captured / result.frames) * 100);
  console.log(`  frames   ${result.captured} unique of ${result.frames} (${held}% held)`);
  console.log(`\nWrote ${path.relative(process.cwd(), result.mp4)}  (${(result.durationMs / 1000).toFixed(1)}s)`);
  console.log(`Edit ${path.relative(process.cwd(), shotlistPath(scene))} and re-run with --shotlist to retime it.`);
}

async function cmdUi(args: Args) {
  const port = num(args.flags, 'port', 5178);
  const { startServer } = await import('../server/index.ts');
  const { port: actual } = await startServer(port);
  const url = `http://127.0.0.1:${actual}`;

  console.log(`\n  animation-engine UI\n  ${url}\n`);

  const distIndex = path.join(ROOT, 'ui', 'dist', 'index.html');
  if (!(await fileExists(distIndex))) {
    console.log(`  The UI has not been built yet. In another terminal:\n    npm run ui:build\n`);
  }
  console.log(`  Ctrl+C to stop.`);

  // Hold the process open; the server owns the lifetime from here.
  await new Promise<void>(() => {});
}

/** Resolve the local model, failing with instructions rather than a stack trace. */
async function requireModel(preferred?: string): Promise<string> {
  const status = await new Ollama().available();
  if (!status.ok) throw new Error(status.reason);
  const model = pickModel(status.models, preferred);
  if (!model) throw new Error('no Ollama model installed. Try:  ollama pull mistral-small');
  return model;
}

async function cmdWrite(args: Args) {
  const premise = args._.join(' ').trim();
  if (!premise) throw new Error('usage: anim write "<premise>" [--name my-scene] [--seconds 75]');

  const model = await requireModel(typeof args.flags['model'] === 'string' ? args.flags['model'] : undefined);
  const name =
    typeof args.flags['name'] === 'string'
      ? args.flags['name']
      : premise.toLowerCase().split(/\s+/).slice(0, 4).join('-').replace(/[^\w-]/g, '');

  console.log(`  model    ${model}`);
  console.log(`  writing  this takes a minute on a local model…`);

  const result = await generateScript({
    premise,
    model,
    targetSeconds: num(args.flags, 'seconds', 75),
    characters: num(args.flags, 'characters', 2),
  });

  await writeScript(name, result.source);
  console.log(`  wrote    ${result.lineCount} lines, cast: ${result.characters.join(', ')}${result.attempts > 1 ? ` (${result.attempts} attempts)` : ''}`);
  console.log(`\nWrote scripts/${name}.md`);
  console.log(`  npm run anim -- check ${name}.md`);
}

async function cmdVoices() {
  const voices = await listVoices();
  if (!voices.length) {
    console.log('No SAPI voices found.');
    return;
  }
  for (const v of voices) console.log(v);
  console.log(`\nSet a character's voice in cast/<name>.rig.json ("voice" matches on substring).`);
}

async function cmdDoctor() {
  const ff = await ffmpegVersion();
  console.log(`ffmpeg     ${ff ? `${ff}  (${ffmpegPath()})` : 'NOT FOUND'}`);
  if (ff && /^[0-4]\./.test(ff)) {
    console.log(`           note: that build is old. It will work, but a recent static build is free and better.`);
  }

  let browser = 'NOT INSTALLED';
  try {
    const { chromium } = await import('playwright');
    const b = await chromium.launch({ headless: true });
    browser = `ok (${b.version()})`;
    await b.close();
  } catch (err) {
    browser = `FAILED — run: npx playwright install chromium\n           ${(err as Error).message.split('\n')[0]}`;
  }
  console.log(`chromium   ${browser}`);

  const rh = await findRhubarb();
  console.log(`rhubarb    ${rh ? `ok (${path.relative(ROOT, rh)})` : 'NOT FOUND — needed by every engine except sapi'}`);

  // Model weights are gigabytes. Anything landing on the system drive is a
  // problem worth seeing before that drive fills.
  console.log(`models     ${MODELS_ROOT}`);
  const systemDrive = path.parse(process.env['SystemRoot'] ?? 'C:\\').root.toLowerCase();
  if (MODELS_ROOT.toLowerCase().startsWith(systemDrive)) {
    console.log(`           WARNING: that is the system drive. Set ANIM_MODELS_ROOT elsewhere.`);
  }
  const dirSize = async (dir: string): Promise<number> => {
    let size = 0;
    const walk = async (d: string): Promise<void> => {
      for (const entry of await fs.readdir(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) size += (await fs.stat(full)).size;
      }
    };
    try {
      await walk(dir);
    } catch {
      return 0;
    }
    return size;
  };

  for (const [name, dir] of [['huggingface', HF_CACHE], ['ollama', OLLAMA_MODELS]] as const) {
    const size = await dirSize(dir);
    console.log(`  ${name.padEnd(12)} ${(size / 1024 ** 3).toFixed(1)} GB`);
  }

  // Anything that slipped onto the system drive. Ollama is the one that can do
  // this behind our back: it is a separate daemon, so we cannot set its
  // environment — if it was launched without OLLAMA_MODELS it writes here, and
  // the first symptom is a full disk.
  let strays = 0;
  for (const stray of strayCacheLocations()) {
    const size = await dirSize(stray.dir);
    if (size > 64 * 1024 * 1024) {
      strays++;
      console.log(`  STRAY  ${stray.label} has ${(size / 1024 ** 3).toFixed(1)} GB at ${stray.dir}`);
      console.log(`         fix: ${stray.fix}`);
    }
  }
  if (!strays) console.log(`  (nothing on the system drive)`);

  const llm = await new Ollama().available();
  console.log(`llm        ${llm.ok ? `ok (${llm.models.map((m) => m.name).join(', ')})` : llm.reason.split('\n')[0]}`);

  for (const name of ENGINE_NAMES) {
    const status = await getEngine(name).available();
    console.log(`voice:${name.padEnd(11)}${status.ok ? 'ok' : `unavailable — ${status.reason.split('\n')[0]}`}`);
  }

  const names = await listRigs();
  console.log(`cast       ${names.length ? names.join(', ') : '(none yet)'}`);
}

// --- show identity --------------------------------------------------------

async function cmdShowList(active: ShowIdentity) {
  const profiles = await listProfiles();
  const activeId = await activeProfileId();

  if (!profiles.length) {
    console.log(`No identity profiles yet — running on the built-in "${active.id}" defaults.`);
    console.log(`Create the project profile with:  npm run anim -- migrate --apply`);
    return;
  }
  for (const p of profiles) {
    const marker = p.id === activeId ? '*' : ' ';
    console.log(`${marker} ${p.id.padEnd(20)} ${p.name.padEnd(24)} v${p.version}  ${p.hash}`);
  }
  console.log(`\n* active. Switch with:  anim show use <id>`);
}

async function cmdShowUse(args: Args) {
  const id = args._[0];
  if (!id) throw new Error('usage: anim show use <id>');
  await setActiveProfileId(id);
  const identity = await loadProfile(id);
  console.log(`Active show is now "${identity.name}" (${id} v${identity.version}, ${identityHash(identity)}).`);
}

async function cmdShowValidate() {
  const profiles = await listProfiles();
  if (!profiles.length) {
    console.log('No profiles to validate.');
    return;
  }
  // listProfiles already drops anything that fails to parse; loading each one
  // again surfaces the errors it swallowed.
  let bad = 0;
  for (const p of profiles) {
    try {
      await loadProfile(p.id);
      console.log(`ok   ${p.id}  v${p.version}  ${p.hash}`);
    } catch (err) {
      bad++;
      console.log(`FAIL ${p.id}: ${(err as Error).message}`);
    }
  }
  if (bad) process.exitCode = 1;
}

async function cmdShowCompare(args: Args) {
  const [a, b] = args._;
  if (!a || !b) throw new Error('usage: anim show compare <idA> <idB>   (fixtures/<id> works too)');
  const diffs = compareProfiles(await loadProfile(a), await loadProfile(b));
  if (!diffs.length) {
    console.log('Identical.');
    return;
  }
  for (const d of diffs) {
    console.log(`${d.path}`);
    console.log(`  ${a}: ${JSON.stringify(d.a)}`);
    console.log(`  ${b}: ${JSON.stringify(d.b)}`);
  }
  console.log(`\n${diffs.length} differing field${diffs.length === 1 ? '' : 's'}.`);
}

/**
 * Bring a pre-identity project under a profile.
 *
 * Dry-run by default; --apply writes. With git in the tree the visible diff and
 * the rollback are both `git` — which is exactly why the repo exists.
 */
async function cmdMigrate(args: Args) {
  const plan = await planMigration();

  if (!plan.changes.length) {
    console.log('Nothing to migrate — everything is already under the active identity.');
    return;
  }

  console.log(`Migration against "${plan.identity.name}" (${plan.identity.id} v${plan.identity.version}):\n`);
  for (const change of plan.changes) {
    console.log(`  ${change.kind.padEnd(9)} ${change.target}`);
    for (const action of change.actions) console.log(`             - ${action}`);
  }

  if (!args.flags['apply']) {
    console.log(`\nDry run — nothing written. Apply with:  anim migrate --apply`);
    return;
  }

  await applyMigration(plan);
  console.log(`\nApplied ${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'}.`);
  console.log('Review with:  git diff    Roll back with:  git checkout -- .');
}

const HELP = `anim — script to limited-animation scene

  write "<premise>"      write a scene with the local model (needs Ollama)
                           --name my-scene --seconds 75 --characters 2
  new <name>             scaffold a script with the format documented inline
  check <script.md>      parse, direct and validate — fast, renders nothing
  render <script.md>     script -> MP4. Casts any missing characters for you.
                           --seed 7 --fps 24 --char-fps 12
                           --resting DEADPAN   baseline expression
                           --set office        background set (generated if missing)
                           --voice-engine chatterbox | sapi
                           --shotlist          reuse your edited shotlist.json
  cast new <name>        create a placeholder character
  cast list              list characters
  cast check [name...]   validate rigs against their SVGs
  cast regen [name...]   redraw art after a generator change, keeping voices
                           --reroll            roll a new look as well
  cast sheet [name]      contact sheet PNG: one name gives every expression,
                         no name gives the whole cast side by side
  still [name...]        render one frame to a PNG
                           --pose IDLE --expression NEUTRAL --scale 1.3
  idle [name...]         render an idling MP4
                           --seconds 6 --fps 24 --char-fps 12 --seed 1
  sets                   list sets. "sets props" and "sets palettes" show the
                         vocabulary a descriptor can draw from.
                         "sets describe <text>" designs one with the local model.
                         "sets preview <name>" renders it with characters in it
  voices                 list installed SAPI voices
  doctor                 check the toolchain
  show                   list identity profiles; "show use <id>" switches,
                         "show compare <a> <b>" diffs two, "show validate" checks all.
                         Any command takes --show <id> for a one-off override
                         (fixtures/<id> reaches the evaluation profiles).
  migrate                bring a pre-identity project under a profile.
                         Dry-run by default; --apply writes (review via git diff)

Run via:  npm run anim -- <command>
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = parseArgs(argv.slice(1));

  await fs.mkdir(OUT_DIR, { recursive: true });

  // Identity first: everything downstream — style, prompts, directing defaults,
  // seed streams — reads the active profile synchronously.
  const identity = await initShow();
  // `--show fixtures/<id>` (or any profile id) overrides for one invocation,
  // which is how the evaluation renders the same scene under two identities.
  if (typeof rest.flags['show'] === 'string') {
    setActiveIdentity(await loadProfile(rest.flags['show']));
  }

  switch (cmd) {
    case 'show': {
      const sub = rest._[0];
      const subArgs = { _: rest._.slice(1), flags: rest.flags };
      if (sub === 'list' || sub === undefined) return cmdShowList(identity);
      if (sub === 'use') return cmdShowUse(subArgs);
      if (sub === 'validate') return cmdShowValidate();
      if (sub === 'compare') return cmdShowCompare(subArgs);
      throw new Error(`unknown: anim show ${sub}`);
    }
    case 'migrate':
      return cmdMigrate(rest);
    case 'cast': {
      const sub = rest._[0];
      const subArgs = { _: rest._.slice(1), flags: rest.flags };
      if (sub === 'new') return cmdCastNew(subArgs);
      if (sub === 'list') return cmdCastList();
      if (sub === 'check') return cmdCastCheck(subArgs);
      if (sub === 'sheet') return cmdCastSheet(subArgs);
      if (sub === 'regen') return cmdCastRegen(subArgs);
      throw new Error(`unknown: anim cast ${sub ?? ''}`);
    }
    case 'write':
      return cmdWrite(rest);
    case 'new':
      return cmdNew(rest);
    case 'check':
      return cmdCheck(rest);
    case 'ui':
      return cmdUi(rest);
    case 'render':
      return cmdRender(rest);
    case 'still':
      return cmdStill(rest);
    case 'idle':
      return cmdIdle(rest);
    case 'sets':
      return cmdSets(rest);
    case 'voices':
      return cmdVoices();
    case 'doctor':
      return cmdDoctor();
    case undefined:
    case 'help':
    case '--help':
      console.log(HELP);
      return;
    default:
      throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main().catch((err) => {
  console.error(`\nerror: ${(err as Error).message}`);
  process.exitCode = 1;
});
