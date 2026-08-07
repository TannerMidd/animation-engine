import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildPlaceholderRig, buildPlaceholderSvg } from '../cast/placeholder.ts';
import { listRigs, loadRig, type LoadedRig } from '../cast/store.ts';
import { animationTimelineForTimings, compileShotList } from '../compile/scene.ts';
import {
  resolveAnimation,
  type AnimationTimeline,
} from '../compile/animation.ts';
import { CAST_DIR, sceneDir } from '../core/paths.ts';
import { buildCapabilityManifest, validateShotList } from '../direct/index.ts';
import { supportedText } from '../render/glyphs.ts';
import type { AnimationDocument } from '../schema/animation.ts';
import type { DialogueCue, DialogueDocument } from '../schema/dialogue.ts';
import type { ShowIdentity } from '../schema/identity.ts';
import { stampOf } from '../show/identity.ts';
import { type Screenplay, type ShotList } from '../schema/script.ts';
import { activeIdentity } from '../show/context.ts';
import { BUILTIN_SETS } from '../sets/builtins.ts';
import { interactionHandle, propHandlePoint, resolveSetProps } from '../sets/interaction.ts';
import { listSets, loadSet } from '../sets/index.ts';
import { STAGE, type SetDescriptor } from '../sets/schema.ts';
import { performanceAssetPath } from '../voice/recording.ts';
import { readAnimation } from './animation.ts';
import { dialogueScriptHash, readDialogueDocument } from './dialogue.ts';
import { applySceneOutfits } from './check.ts';
import { splitCaptionCues } from '../compile/captions.ts';
import { parseScript } from '../parse/index.ts';
import { beatSpine, screenplaySpine, spineDrift } from './propose.ts';
import { exists, readScript, readShotList } from './scene.ts';
import {
  collectGeneratedLineQa,
  estimateSelectedDialogueTimings,
  soundtrackIsCurrent,
  soundtrackManifestPath,
} from './voices.ts';
import type { LineQa } from '../voice/qa.ts';
import type { ProgrammeQualityGate } from '../audio/quality.ts';
import {
  evaluatePublishingSafety,
  type PublishingSafetyReport,
} from './publish.ts';
import { reframeScenePortrait } from './reframe.ts';
import {
  inspectGestureQuality,
  inspectResolvedMotionQuality,
  inspectWalkableBlocking,
} from './preflight/motion.ts';

export {
  GENERIC_TALK_WARNING_COUNT,
  LONG_POSE_HOLD_WARNING_MS,
  REPEATED_GESTURE_WARNING_COUNT,
} from './preflight/motion.ts';

export type ProductionPreflightLevel = 'error' | 'warn' | 'info';

/**
 * What a note is *about*, so the editor can put you in front of it.
 *
 * A message that names `sarah:line-19293i4` is unusable as a destination —
 * that id appears nowhere on screen. Carrying the reference structurally lets
 * a click select the thing rather than merely switch modes and hope.
 */
export interface ProductionPreflightTarget {
  kind: 'beat' | 'cue' | 'actor' | 'motion' | 'set';
  id: string;
}

export interface ProductionPreflightNote {
  code: string;
  level: ProductionPreflightLevel;
  /** Errors block a production-ready decision; warnings and information do not. */
  blocking: boolean;
  message: string;
  target?: ProductionPreflightTarget;
}

/**
 * `productionBlocked` means the scene is not fit to publish under this policy.
 * Preview remains the diagnostic path; POST /render enforces this gate so a
 * non-UI caller cannot accidentally label a broken export production-ready.
 */
export const PRODUCTION_PREFLIGHT_POLICY = {
  id: 'production-v1',
  blockingLevels: ['error'] as const,
  warningMeaning: 'review and explicit acknowledgement required; the underlying condition is not a production blocker',
  warningAcknowledgementRequired: true,
  infoMeaning: 'advisory or an automatic preparation step',
  renderEndpointEnforced: true,
} as const;

export interface ProductionPreflightReport {
  ok: boolean;
  productionBlocked: boolean;
  renderEndpointBlocked: boolean;
  policy: typeof PRODUCTION_PREFLIGHT_POLICY;
  notes: ProductionPreflightNote[];
}

/**
 * Every code preflight can raise.
 *
 * The list exists so the editor can be held to explaining all of them: a
 * blocker whose message states a fact but not a remedy is a dead end, and a
 * test over this list is what stops the next code from becoming one.
 */
export const PREFLIGHT_CODES = [
  'action-unstructured', 'action-unsupported', 'animation-contact-invalid',
  'animation-contact-set-missing', 'animation-invalid', 'animation-long-pose-hold',
  'animation-outside-walkable', 'animation-resolve-failed', 'animation-scene-mismatch',
  'animation-target-invalid', 'animation-timing-deferred', 'caption-reading-rate',
  'caption-safe-area-failed', 'capture-qc-missing', 'capture-qc-rejected', 'capture-qc-warning',
  'continuity-invalid', 'dialogue-approval-rejected', 'dialogue-approval-stale',
  'dialogue-approval-unresolved', 'dialogue-asset-missing', 'dialogue-asset-stale',
  'dialogue-cue-stale', 'dialogue-editorial-missing', 'dialogue-fps-drift',
  'dialogue-identity-drift', 'dialogue-invalid', 'dialogue-scene-mismatch',
  'dialogue-script-stale', 'dialogue-selection-unresolved', 'dialogue-take-stale',
  'dialogue-trim-unreviewed', 'dialogue-unapproved', 'dialogue-unlocked', 'director-locks',
  'identity-drift', 'performance-consent-expired', 'performance-consent-fallback',
  'performance-consent-missing', 'performance-consent-revoked', 'performance-consent-scope',
  'portrait-safe-area-failed', 'prop-action-invalid', 'prop-action-set-missing',
  'rig-invalid', 'rig-missing', 'scene-run-segment-qc-missing', 'scene-run-segment-qc-rejected',
  'scene-run-segment-qc-warning', 'scene-undirected', 'script-unreadable', 'set-invalid',
  'set-missing', 'set-unavailable', 'shotlist-invalid', 'shotlist-script-stale',
  'soundtrack-intentional-silence', 'soundtrack-loudness-failed', 'soundtrack-missing',
  'soundtrack-qc-missing', 'soundtrack-qc-passed', 'soundtrack-stale',
  'soundtrack-true-peak-failed', 'soundtrack-unverifiable', 'title-undrawable',
  'voice-conversion-source-stale', 'voice-conversion-source-unmapped', 'voice-consent-expired',
  'voice-consent-missing', 'voice-consent-reference-stale', 'voice-consent-revoked',
  'voice-consent-scope', 'voice-line-unintelligible', 'voice-reference-draft-only',
  'voice-reference-minted-in-use', 'voice-reference-missing', 'voice-render-draft-only',
  'voice-render-not-ready', 'voice-render-qc-warning', 'voice-render-rejected',
  'voice-target-reference-stale',
] as const;

export type SoundtrackState = 'missing' | 'current' | 'stale' | 'error';

export interface ProductionPreflightInput {
  scene: string;
  shots: ShotList | null;
  shotListError?: string;
  /**
   * The screenplay as it stands on disk, for detecting a shot list that has
   * fallen behind it. Omitted by callers that supply their own shot list and
   * have no script to compare against.
   */
  screenplay?: Screenplay | null;
  scriptError?: string;
  identity: ShowIdentity;
  rigs: Map<string, LoadedRig>;
  missingRigs?: ReadonlySet<string>;
  rigErrors?: ReadonlyMap<string, string>;
  /** Current SHA-256 by rig name for consent and conversion provenance checks. */
  voiceReferenceChecksums?: ReadonlyMap<string, string>;
  knownSets: ReadonlySet<string>;
  /** Loaded set geometry lets preflight validate prop identity and continuity. */
  setDescriptor?: SetDescriptor | null;
  setError?: string;
  dialogue: DialogueDocument | null;
  dialogueError?: string;
  missingDialogueAssets?: ReadonlySet<string>;
  staleDialogueAssets?: ReadonlySet<string>;
  /**
   * ASR verdicts by cue id for lines that would ship as generated takes.
   * A failed verdict means every seeded attempt was transcribed and none of
   * them said the script line.
   */
  generatedLineQa?: ReadonlyMap<string, LineQa>;
  animation: AnimationDocument | null;
  animationError?: string;
  soundtrack: SoundtrackState;
  soundtrackError?: string;
  /** Measurements embedded in the current soundtrack manifest. */
  soundtrackQuality?: ProgrammeQualityGate;
  /** Caption and recomposed-portrait checks from deterministic compiled IR. */
  publishingSafety?: PublishingSafetyReport;
}

function report(notes: ProductionPreflightNote[]): ProductionPreflightReport {
  const productionBlocked = notes.some((note) => note.blocking);
  return {
    ok: !productionBlocked,
    productionBlocked,
    renderEndpointBlocked: productionBlocked,
    policy: PRODUCTION_PREFLIGHT_POLICY,
    notes,
  };
}

function note(
  notes: ProductionPreflightNote[],
  level: ProductionPreflightLevel,
  code: string,
  message: string,
  target?: ProductionPreflightTarget,
): void {
  if (notes.some((item) => item.code === code && item.message === message)) return;
  notes.push({ code, level, blocking: level === 'error', message, ...(target ? { target } : {}) });
}

/**
 * A caption cue id back to the line it came from.
 *
 * A split caption's later pieces are suffixed (`line-abc~2`); the creator only
 * has the one line to go to, so strip it.
 */
function captionTarget(cueId: string): ProductionPreflightTarget {
  return { kind: 'cue', id: cueId.replace(/~\d+$/, '') };
}

function inspectReleaseQuality(input: ProductionPreflightInput, notes: ProductionPreflightNote[]): void {
  if (input.soundtrack === 'current') {
    const quality = input.soundtrackQuality;
    if (!quality) {
      note(
        notes,
        'warn',
        'soundtrack-qc-missing',
        'the current soundtrack predates integrated-loudness and true-peak QC; rebuild Voices before final release',
      );
    } else if (quality.intentionalSilence) {
      note(notes, 'info', 'soundtrack-intentional-silence', 'the programme is intentionally silent; loudness normalisation was not applied');
    } else {
      if (!quality.loudnessPassed) {
        note(
          notes,
          'error',
          'soundtrack-loudness-failed',
          `programme loudness is ${quality.metrics.integratedLufs ?? 'unmeasurable'} LUFS; ` +
          `target is ${quality.targetIntegratedLufs} ±${quality.loudnessToleranceLu} LU`,
        );
      }
      if (!quality.truePeakPassed) {
        note(
          notes,
          'error',
          'soundtrack-true-peak-failed',
          `programme true peak is ${quality.metrics.truePeakDbtp ?? 'unmeasurable'} dBTP; ` +
          `ceiling is ${quality.truePeakCeilingDbtp} dBTP`,
        );
      }
      if (quality.passed) {
        note(
          notes,
          'info',
          'soundtrack-qc-passed',
          `programme measures ${quality.metrics.integratedLufs} LUFS and ${quality.metrics.truePeakDbtp} dBTP`,
        );
      }
    }
  }

  const safety = input.publishingSafety;
  if (!safety) return;
  const overflowing = safety.captions.violations.filter((item) => item.reason === 'too-many-lines');
  if (overflowing.length) {
    const detail = overflowing
      .map((item) => `${item.speaker}:${item.cueId} (${item.estimatedLines} lines)`)
      .join(', ');
    note(
      notes,
      'error',
      'caption-safe-area-failed',
      `caption text exceeds the ${safety.captions.maxLines}-line mobile safe area: ${detail}`,
      captionTarget(overflowing[0]!.cueId),
    );
  }
  // A cue that fits but goes by too fast to read. Advisory: readability is a
  // judgement, where the line budget is a layout fact.
  const rushed = safety.captions.violations.filter((item) => item.reason === 'too-fast');
  if (rushed.length) {
    const detail = rushed
      .map((item) => `${item.speaker}:${item.cueId} (${item.charactersPerSecond}/s)`)
      .join(', ');
    note(
      notes,
      'warn',
      'caption-reading-rate',
      `caption is on screen too briefly to read at ${safety.captions.maxCharactersPerSecond} characters per second: ${detail}`,
      captionTarget(rushed[0]!.cueId),
    );
  }
  if (safety.portrait.status === 'fail') {
    const detail = safety.portrait.violations
      .map((item) => item.actor ? `${item.actor} at frame ${item.frame}` : `frame ${item.frame}`)
      .join(', ');
    note(
      notes,
      'error',
      'portrait-safe-area-failed',
      `the recomposed portrait master leaves action-safe composition: ${detail}`,
    );
  }
}

/**
 * Has the script moved on without the shot list?
 *
 * Everything downstream of directing — timeline, dialogue, animation, preview
 * and the render itself — reads the shot list, so a script edited after the
 * last Direct is invisible until someone applies it. Rendering that state
 * publishes a scene nobody is looking at, which is why this blocks.
 *
 * The comparison is the script-owned spine only, so staging a beat or
 * retiming a pause by hand never reads as the script having changed.
 */
function inspectScriptCurrency(
  input: ProductionPreflightInput,
  notes: ProductionPreflightNote[],
): void {
  const { shots, screenplay } = input;
  if (!shots) return;
  if (input.scriptError) {
    note(notes, 'warn', 'script-unreadable', `the screenplay cannot be read: ${input.scriptError}`);
    return;
  }
  if (!screenplay) return;

  const drift = spineDrift(screenplaySpine(screenplay), beatSpine(shots.beats));
  if (!drift) return;
  note(
    notes,
    'error',
    'shotlist-script-stale',
    `the script has ${drift} beat${drift === 1 ? '' : 's'} the shot list does not reflect; run Direct to apply it`,
  );
}

function classifyShotListError(message: string): string {
  if (/unsupported action|understood but not renderable/i.test(message)) return 'action-unsupported';
  if (/prose but no structured stage action/i.test(message)) return 'action-unstructured';
  if (/enter|exit|hidden|visible/i.test(message)) return 'continuity-invalid';
  return 'shotlist-invalid';
}

const PROP_STAGE_ACTIONS = new Set(['reach', 'pick_up', 'put_down', 'tap']);

function estimatedCompilerTimings(
  shots: ShotList,
  dialogue: DialogueDocument | null = null,
): Map<number, import('../voice/visemes.ts').LineTiming> {
  return estimateSelectedDialogueTimings(shots, dialogue);
}

/**
 * Build a conservative planning clock without synthesising audio.
 *
 * Beat/speech anchors and the default `word-N` anchors can be checked now.
 * Bespoke alignment IDs remain deferred and are surfaced as a warning rather
 * than a false production failure.
 */
export function estimatedAnimationTimeline(
  shots: ShotList,
  dialogue: DialogueDocument | null,
): AnimationTimeline {
  return animationTimelineForTimings(
    shots,
    estimateSelectedDialogueTimings(shots, dialogue),
  );
}

function inspectDialogue(
  input: ProductionPreflightInput,
  notes: ProductionPreflightNote[],
): void {
  const { shots, dialogue } = input;
  if (!shots) return;
  const lines = shots.beats.filter((beat) => beat.kind === 'line');
  if (!lines.length) return;

  if (input.dialogueError) {
    note(notes, 'error', 'dialogue-invalid', `dialogue document cannot be read: ${input.dialogueError}`);
    return;
  }
  if (!dialogue) {
    note(
      notes,
      'error',
      'dialogue-editorial-missing',
      'there is no dialogue editorial document; sync, select, approve, and lock production dialogue before export',
    );
    return;
  }

  if (dialogue.scene !== input.scene) {
    note(notes, 'error', 'dialogue-scene-mismatch', `dialogue document belongs to scene "${dialogue.scene}"`);
  }
  const expectedScriptHash = dialogueScriptHash(shots);
  if (dialogue.scriptHash !== expectedScriptHash) {
    note(notes, 'error', 'dialogue-script-stale', 'dialogue selections were made against a different script revision; sync and review them again');
  }
  if (dialogue.identity && dialogue.identity.hash !== stampOf(input.identity).hash) {
    note(notes, 'warn', 'dialogue-identity-drift', `dialogue was edited under identity ${dialogue.identity.id}@${dialogue.identity.hash}`);
  }
  if (dialogue.fps !== shots.fps) {
    note(notes, 'warn', 'dialogue-fps-drift', `dialogue timing is ${dialogue.fps} fps but the scene is ${shots.fps} fps`);
  }

  const cues = new Map(dialogue.cues.map((cue) => [cue.id, cue]));
  const takes = new Map(dialogue.recordedTakes.map((take) => [take.id, take]));
  const renders = new Map(dialogue.voiceRenders.map((render) => [render.id, render]));
  const unapproved: string[] = [];
  const unlocked: string[] = [];

  for (const beat of lines) {
    const cue = cues.get(beat.id);
    // Every note below is about this one line; carrying the reference is what
    // lets a click in the readiness report select it.
    const at: ProductionPreflightTarget = { kind: 'cue', id: beat.id };
    if (!cue) {
      note(notes, 'error', 'dialogue-selection-unresolved', `line "${beat.id}" has no production dialogue cue or selected audio`, at);
      continue;
    }
    const label = `${cue.speaker}:${cue.id}`;
    if (cue.speaker !== beat.speaker || cue.displayText !== beat.text) {
      note(notes, 'error', 'dialogue-cue-stale', `dialogue cue "${label}" no longer matches its screenplay line`, at);
    }

    // The verdict map only carries lines that would ship generated, so a
    // failure here means the audience would hear a take that demonstrably
    // does not say the script line.
    const qa = input.generatedLineQa?.get(cue.id);
    if (qa && !qa.passed) {
      note(
        notes,
        'error',
        'voice-line-unintelligible',
        `generated take for "${label}" failed speech verification after ${qa.attempt + 1} seeded attempts ` +
          `(heard: ${qa.transcript ? `"${qa.transcript}"` : 'nothing'}) — reroll the line's seed, reword the line, or record it`,
        at,
      );
    }

    if (cue.approval.state === 'rejected' || cue.approval.state === 'stale' || cue.approval.state === 'unresolved') {
      note(notes, 'error', `dialogue-approval-${cue.approval.state}`, `dialogue cue "${label}" is ${cue.approval.state}`, at);
    } else if (cue.approval.state !== 'approved') {
      unapproved.push(label);
    }
    if (!cue.locked) unlocked.push(label);

    if (cue.voiceSource === 'generated') {
      // The creator explicitly chose the character's seeded synthesis for this
      // line; having nothing selected is the correct state. Approval and lock
      // are still demanded above — generated is a decision, not a default.
      continue;
    }

    if (!cue.selectedTakeId && !cue.selectedRenderId) {
      note(notes, 'error', 'dialogue-selection-unresolved', `dialogue cue "${label}" has no selected take or render`, at);
      continue;
    }

    const take = cue.selectedTakeId ? takes.get(cue.selectedTakeId) : undefined;
    if (cue.selectedTakeId && !take) {
      note(notes, 'error', 'dialogue-selection-unresolved', `dialogue cue "${label}" selects missing take "${cue.selectedTakeId}"`, at);
    }
    if (take) {
      const currentHash = crypto.createHash('sha256').update(cue.spokenText).digest('hex');
      const sceneRunSegment = take.cueId === null
        ? take.provenance.sceneRunSegments.find((segment) => segment.cueId === cue.id)
        : null;
      if (take.cueId === null && !sceneRunSegment) {
        note(
          notes,
          'error',
          'dialogue-take-stale',
          `Scene Run take "${take.id}" has no immutable segment mapping for "${label}"`,
        );
      } else if ((sceneRunSegment?.scriptTextHash ?? take.scriptTextHash) !== currentHash) {
        note(notes, 'error', 'dialogue-take-stale', `selected take "${take.id}" for "${label}" was recorded for different spoken text`);
      }
      if (sceneRunSegment) {
        if (!sceneRunSegment.quality) {
          note(
            notes,
            'error',
            'scene-run-segment-qc-missing',
            `selected Scene Run segment for "${label}" has no immutable segment-level capture QC`,
          );
        } else if (sceneRunSegment.quality.verdict === 'reject') {
          note(
            notes,
            'error',
            'scene-run-segment-qc-rejected',
            `selected Scene Run segment for "${label}" failed capture QC: ${sceneRunSegment.quality.flags.join('; ')}`,
          );
        } else if (sceneRunSegment.quality.verdict === 'warn') {
          note(
            notes,
            'warn',
            'scene-run-segment-qc-warning',
            `selected Scene Run segment for "${label}" has capture warnings: ${sceneRunSegment.quality.flags.join('; ')}`,
          );
        }
      }
      if (input.missingDialogueAssets?.has(`take:${take.id}`)) {
        note(notes, 'error', 'dialogue-asset-missing', `selected take "${take.id}" for "${label}" is missing its audio file`);
      } else if (input.staleDialogueAssets?.has(`take:${take.id}`)) {
        note(notes, 'error', 'dialogue-asset-stale', `selected take "${take.id}" for "${label}" no longer matches its immutable checksum`);
      }
      if (!take.quality) {
        note(notes, 'error', 'capture-qc-missing', `selected take "${take.id}" for "${label}" has no structured capture quality report`);
      } else if (take.quality.verdict === 'reject') {
        note(notes, 'error', 'capture-qc-rejected', `selected take "${take.id}" for "${label}" failed capture QC: ${take.quality.flags.join('; ')}`);
      } else if (take.quality.verdict === 'warn') {
        note(notes, 'warn', 'capture-qc-warning', `selected take "${take.id}" for "${label}" has capture warnings: ${take.quality.flags.join('; ')}`);
      }

      // Takes are immutable, so a recording captured before any rights record
      // existed can never be re-stamped. A live document-level record with
      // performance scope legitimately covers the creator's own recordings —
      // demand explicit binding only when nothing covers them at all.
      const fallbackConsent = dialogue.consents.find((item) =>
        !item.revokedAt &&
        (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()) &&
        item.permits.distribution &&
        (item.scope === 'performance' || item.scope === 'both'));
      const performanceConsent = (take.capture.consentId
        ? dialogue.consents.find((item) => item.id === take.capture.consentId)
        : undefined) ?? fallbackConsent;
      if (!performanceConsent) {
        note(
          notes,
          'error',
          'performance-consent-missing',
          `selected performance take "${take.id}" for "${label}" is not bound to a rights record and no active performance-scope record covers it`,
        );
      } else {
        if (!take.capture.consentId) {
          note(
            notes,
            'info',
            'performance-consent-fallback',
            `take "${take.id}" for "${label}" predates its rights record; covered by document-level record "${performanceConsent.id}"`,
          );
        }
        if (performanceConsent.revokedAt) {
          note(notes, 'error', 'performance-consent-revoked', `performance consent "${performanceConsent.id}" for take "${take.id}" was revoked at ${performanceConsent.revokedAt}`);
        }
        if (performanceConsent.expiresAt && Date.parse(performanceConsent.expiresAt) <= Date.now()) {
          note(notes, 'error', 'performance-consent-expired', `performance consent "${performanceConsent.id}" for take "${take.id}" expired at ${performanceConsent.expiresAt}`);
        }
        if (!performanceConsent.permits.distribution) {
          note(notes, 'error', 'performance-consent-scope', `performance consent "${performanceConsent.id}" does not permit distribution`);
        }
        if (performanceConsent.scope !== 'performance' && performanceConsent.scope !== 'both') {
          note(notes, 'error', 'performance-consent-scope', `consent "${performanceConsent.id}" does not cover the recorded performance`);
        }
      }
    }

    const render = cue.selectedRenderId ? renders.get(cue.selectedRenderId) : undefined;
    if (cue.selectedRenderId && !render) {
      note(notes, 'error', 'dialogue-selection-unresolved', `dialogue cue "${label}" selects missing render "${cue.selectedRenderId}"`, at);
    }
    if (render) {
      if (render.state !== 'ready') {
        note(notes, 'error', 'voice-render-not-ready', `selected voice render "${render.id}" for "${label}" is ${render.state}`);
      }
      if (render.quality.verdict === 'reject') {
        note(notes, 'error', 'voice-render-rejected', `selected voice render "${render.id}" for "${label}" failed voice quality review`);
      } else if (render.quality.verdict === 'warn') {
        note(notes, 'warn', 'voice-render-qc-warning', `selected voice render "${render.id}" for "${label}" has unresolved quality warnings`);
      }
      if (render.source.kind === 'draft-tts') {
        note(notes, 'error', 'voice-render-draft-only', `selected voice render "${render.id}" for "${label}" is draft TTS, not production dialogue`);
      }
      if (render.source.kind === 'voice-conversion') {
        const conversionSource = render.source;
        const consent = dialogue.consents.find((item) => item.id === conversionSource.consentId);
        if (!consent) {
          note(notes, 'error', 'voice-consent-missing', `voice render "${render.id}" names missing consent record "${conversionSource.consentId}"`);
        } else {
          if (consent.revokedAt) {
            note(notes, 'error', 'voice-consent-revoked', `consent "${consent.id}" for voice render "${render.id}" was revoked at ${consent.revokedAt}`);
          }
          if (consent.expiresAt && Date.parse(consent.expiresAt) <= Date.now()) {
            note(notes, 'error', 'voice-consent-expired', `consent "${consent.id}" for voice render "${render.id}" expired at ${consent.expiresAt}`);
          }
          if (!consent.permits.voiceConversion || !consent.permits.distribution) {
            note(notes, 'error', 'voice-consent-scope', `consent "${consent.id}" does not permit voice conversion and distribution`);
          }
          if (consent.scope !== 'target-voice' && consent.scope !== 'both') {
            note(notes, 'error', 'voice-consent-scope', `consent "${consent.id}" does not cover a target voice`);
          }
          if (consent.referenceChecksum !== render.source.targetReferenceChecksum) {
            note(notes, 'error', 'voice-consent-reference-stale', `consent "${consent.id}" does not cover the target reference used by "${render.id}"`);
          }
        }
        const member = shots.cast.find((item) => item.id === cue.speaker);
        const currentReference = member ? input.voiceReferenceChecksums?.get(member.rig) : undefined;
        if (!currentReference || currentReference !== render.source.targetReferenceChecksum) {
          note(notes, 'error', 'voice-target-reference-stale', `target voice reference changed after render "${render.id}" was generated`);
        }
        if (!render.source.sourceAudioChecksum || render.source.sourceAudioChecksum !== take?.audio.checksum) {
          note(notes, 'error', 'voice-conversion-source-stale', `voice render "${render.id}" is not bound to the selected immutable source take bytes`);
        }
        if (!render.source.sourceTrim || render.source.sourceCueId !== cue.id) {
          note(notes, 'error', 'voice-conversion-source-unmapped', `voice render "${render.id}" lacks an immutable source segment for cue "${cue.id}"`);
        }
      }
      if (input.missingDialogueAssets?.has(`render:${render.id}`)) {
        note(notes, 'error', 'dialogue-asset-missing', `selected voice render "${render.id}" for "${label}" is missing its audio file`);
      } else if (input.staleDialogueAssets?.has(`render:${render.id}`)) {
        note(notes, 'error', 'dialogue-asset-stale', `selected voice render "${render.id}" for "${label}" no longer matches its recorded checksum`);
      }
    }
    if (!cue.trim) {
      note(notes, 'warn', 'dialogue-trim-unreviewed', `dialogue cue "${label}" has no reviewed trim and speech boundaries`, at);
    }
  }

  // These aggregate every offending cue, so they point at the first one — far
  // more use than a mode switch when the list runs to dozens of lines.
  const firstOf = (labels: string[]): ProductionPreflightTarget | undefined => {
    const id = labels[0]?.split(':').slice(1).join(':');
    return id ? { kind: 'cue', id } : undefined;
  };
  if (unapproved.length) {
    note(
      notes,
      'error',
      'dialogue-unapproved',
      `${unapproved.length} dialogue cue(s) are not approved: ${unapproved.join(', ')}`,
      firstOf(unapproved),
    );
  }
  if (unlocked.length) {
    note(
      notes,
      'error',
      'dialogue-unlocked',
      `${unlocked.length} dialogue cue(s) are not fully locked: ${unlocked.join(', ')}`,
      firstOf(unlocked),
    );
  }
}

/**
 * How a line leans on the rig's voice reference.
 *
 * 'undecided' — synthesis or conversion would use the rig voice with no
 * explicit creator decision behind it. 'chosen' — the creator approved the
 * character's voice for this line, generated or converted into. 'none' — an
 * original performance carries the line; the rig voice is not involved.
 */
function rigVoiceUse(cue: DialogueCue | undefined, document: DialogueDocument | null): 'undecided' | 'chosen' | 'none' {
  if (!cue || !document) return 'undecided';
  if (cue.voiceSource === 'generated') {
    return cue.approval.state === 'approved' ? 'chosen' : 'undecided';
  }
  if (!cue.selectedRenderId) return cue.selectedTakeId ? 'none' : 'undecided';
  const render = document.voiceRenders.find((item) => item.id === cue.selectedRenderId);
  if (!render) return 'undecided';
  // A conversion names its target voice and binds a rights record to that
  // reference's checksum, so approving one is as explicit a decision as
  // approving the generated voice. Draft TTS is nobody's decision.
  if (render.source.kind === 'voice-conversion') {
    return cue.approval.state === 'approved' ? 'chosen' : 'undecided';
  }
  return render.source.kind === 'draft-tts' ? 'undecided' : 'none';
}

function inspectVoiceReferences(input: ProductionPreflightInput, notes: ProductionPreflightNote[]): void {
  const { shots } = input;
  if (!shots) return;
  const cues = new Map(input.dialogue?.cues.map((cue) => [cue.id, cue]) ?? []);
  const undecidedByRig = new Map<string, string[]>();
  const chosenByRig = new Map<string, string[]>();
  for (const member of shots.cast) {
    const lines = shots.beats.filter((beat) => beat.kind === 'line' && beat.speaker === member.id);
    const uses = lines.map((beat) => rigVoiceUse(cues.get(beat.id), input.dialogue));
    const bucket = uses.some((use) => use === 'undecided')
      ? undecidedByRig
      : uses.some((use) => use === 'chosen')
        ? chosenByRig
        : null;
    if (!bucket) continue;
    const actors = bucket.get(member.rig) ?? [];
    actors.push(member.id);
    bucket.set(member.rig, actors);
  }

  for (const [rigName, actors] of undecidedByRig) {
    const rig = input.rigs.get(rigName)?.rig;
    if (!rig?.voiceRef || rig.voiceProvenance?.source !== 'minted') continue;
    note(
      notes,
      'error',
      'voice-reference-draft-only',
      `minted draft voice reference "${rig.voiceRef}" is still used for ${actors.join(', ')}; approve a recorded/uploaded reference, select an original performance, or approve the character voice per line — generated, or converted from your own take`,
      actors[0] ? { kind: 'actor', id: actors[0] } : undefined,
    );
  }
  for (const [rigName, actors] of chosenByRig) {
    const rig = input.rigs.get(rigName)?.rig;
    if (!rig?.voiceRef || rig.voiceProvenance?.source !== 'minted') continue;
    note(
      notes,
      'warn',
      'voice-reference-minted-in-use',
      `${actors.join(', ')} speak with the minted voice reference "${rig.voiceRef}"${rig.voiceProvenance?.bankVoice ? ` (bank voice ${rig.voiceProvenance.bankVoice})` : ''} by explicit approval; audition it before release, or record/upload a reference in the cast editor`,
      actors[0] ? { kind: 'actor', id: actors[0] } : undefined,
    );
  }
}

/** Validate contact targets against set-instance catalogue handles. */
function inspectInteractionSurfaces(input: ProductionPreflightInput, notes: ProductionPreflightNote[]): void {
  const contacts = input.animation?.events.filter((event) => event.kind === 'contact') ?? [];
  if (!contacts.length) return;
  if (!input.setDescriptor) {
    note(notes, 'error', 'animation-contact-set-missing', 'animation contact events require a loaded set with interaction geometry');
    return;
  }

  let props: ReturnType<typeof resolveSetProps>;
  try {
    props = resolveSetProps(input.setDescriptor);
  } catch (error) {
    note(notes, 'error', 'animation-contact-invalid', `set interaction geometry cannot be resolved: ${(error as Error).message}`);
    return;
  }
  const propsById = new Map(props.map((prop) => [prop.id, prop]));
  for (const event of contacts) {
    const prop = propsById.get(event.targetId);
    if (!prop) {
      note(notes, 'error', 'animation-contact-invalid', `contact event "${event.id}" references missing stable set prop "${event.targetId}"`);
      continue;
    }
    if (!prop.interaction) {
      note(notes, 'error', 'animation-contact-invalid', `contact event "${event.id}" targets "${event.targetId}", which declares no interaction surface`);
      continue;
    }
    let handle = event.targetHandleId
      ? prop.interaction.handles.find((candidate) => candidate.id === event.targetHandleId)
      : undefined;
    if (!event.targetHandleId) {
      try {
        handle = interactionHandle(prop, 'contact', `contact event "${event.id}"`);
      } catch (error) {
        note(notes, 'error', 'animation-contact-invalid', (error as Error).message);
        continue;
      }
    }
    if (!handle) {
      note(notes, 'error', 'animation-contact-invalid', `contact event "${event.id}" references missing target handle "${event.targetHandleId}" on "${event.targetId}"`);
      continue;
    }
    const point = propHandlePoint(prop, handle);
    if (point.x < 0 || point.x > STAGE.width || point.y < 0 || point.y > STAGE.height) {
      note(notes, 'error', 'animation-contact-invalid', `contact event "${event.id}" resolves outside the stage at ${Math.round(point.x)},${Math.round(point.y)}`);
    }
  }
}

function inspectEditorialTimeline(
  input: ProductionPreflightInput,
  notes: ProductionPreflightNote[],
): AnimationTimeline | null {
  if (!input.shots) return null;
  try {
    return estimatedAnimationTimeline(input.shots, input.dialogue);
  } catch (error) {
    note(
      notes,
      'error',
      'dialogue-timing-invalid',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

function inspectAnimation(
  input: ProductionPreflightInput,
  notes: ProductionPreflightNote[],
  timeline: AnimationTimeline | null,
): void {
  const { shots, animation } = input;
  if (!shots) return;
  if (input.animationError) {
    note(notes, 'error', 'animation-invalid', `animation document cannot be read: ${input.animationError}`);
    return;
  }
  if (!animation) return;
  if (animation.scene !== input.scene) {
    note(notes, 'error', 'animation-scene-mismatch', `animation document belongs to scene "${animation.scene}"`);
    return;
  }

  const cast = new Map(shots.cast.map((member) => [member.id, member]));
  for (const track of animation.tracks) {
    const at: ProductionPreflightTarget = { kind: 'motion', id: track.id };
    const actor = cast.get(track.actorId);
    if (!actor) {
      note(notes, 'error', 'animation-target-invalid', `animation track "${track.id}" references unknown actor "${track.actorId}"`, at);
      continue;
    }
    if (track.channel === 'part.transform') {
      const rig = input.rigs.get(actor.rig)?.rig;
      if (!rig?.parts.some((part) => part.id === track.partId)) {
        note(notes, 'error', 'animation-target-invalid', `animation track "${track.id}" references missing part "${track.partId}" on "${track.actorId}"`, at);
      }
    }
  }
  // Segments carry the same actor reference as tracks and are validated just
  // as strictly by the compiler, which throws rather than reporting. Left out
  // here, a scene re-directed onto a new cast fails as an opaque 500 from the
  // preview instead of a named blocker anyone can act on.
  for (const segment of animation.segments) {
    const at: ProductionPreflightTarget = { kind: 'motion', id: segment.id };
    const actor = cast.get(segment.actorId);
    if (!actor) {
      note(notes, 'error', 'animation-target-invalid', `motion segment "${segment.id}" references unknown actor "${segment.actorId}"`, at);
      continue;
    }
    if (segment.channel === 'part.transform') {
      const rig = input.rigs.get(actor.rig)?.rig;
      if (!rig?.parts.some((part) => part.id === segment.partId)) {
        note(notes, 'error', 'animation-target-invalid', `motion segment "${segment.id}" references missing part "${segment.partId}" on "${segment.actorId}"`, at);
      }
    }
  }
  for (const event of animation.events) {
    if ((event.kind === 'attach' || event.kind === 'contact') && !cast.has(event.actorId)) {
      note(notes, 'error', 'animation-target-invalid', `animation event "${event.id}" references unknown actor "${event.actorId}"`, { kind: 'motion', id: event.id });
    }
  }
  inspectInteractionSurfaces(input, notes);
  if (!timeline) return;

  try {
    // Paced, because preflight is a prediction of the render and the render
    // walks at the engine's pace rather than at the drag's.
    const resolved = resolveAnimation(animation, timeline, { paceWalks: true });
    inspectResolvedMotionQuality(resolved, input, notes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cues = new Map(input.dialogue?.cues.map((cue) => [cue.id, cue]) ?? []);
    const selectedTimingIsAuthoritative = shots.beats.every((beat) => {
      if (beat.kind !== 'line') return true;
      const cue = cues.get(beat.id);
      if (!cue) return false;
      if (cue.selectedTakeId) {
        return input.dialogue?.recordedTakes.some((take) => take.id === cue.selectedTakeId) ?? false;
      }
      if (!cue.selectedRenderId) return false;
      return input.dialogue?.voiceRenders.some((render) => (
        render.id === cue.selectedRenderId && render.state === 'ready' && render.audio !== null
      )) ?? false;
    });
    if (/missing word/i.test(message) && !selectedTimingIsAuthoritative) {
      note(
        notes,
        'warn',
        'animation-timing-deferred',
        `animation timing cannot be fully confirmed until measured dialogue alignment exists: ${message}`,
      );
    } else {
      note(notes, 'error', 'animation-resolve-failed', message);
    }
  }
}

/** Pure policy evaluation, useful to the server, CLI, tests and future publish job. */
export function evaluateProductionPreflight(input: ProductionPreflightInput): ProductionPreflightReport {
  const notes: ProductionPreflightNote[] = [];
  const { shots } = input;
  if (!shots) {
    note(
      notes,
      'error',
      input.shotListError ? 'shotlist-invalid' : 'scene-undirected',
      input.shotListError
        ? `the directed shot list cannot be read: ${input.shotListError}`
        : 'the scene has not been directed yet',
    );
    return report(notes);
  }

  const currentIdentity = stampOf(input.identity);
  if (shots.identity && shots.identity.hash !== currentIdentity.hash) {
    note(
      notes,
      'warn',
      'identity-drift',
      `directed under identity ${shots.identity.id}@${shots.identity.hash}, but ${currentIdentity.id}@${currentIdentity.hash} is active — re-direct to pick up the current show`,
    );
  }

  for (const member of shots.cast) {
    const at: ProductionPreflightTarget = { kind: 'actor', id: member.id };
    if (input.rigErrors?.has(member.rig)) {
      note(notes, 'error', 'rig-invalid', `rig "${member.rig}" cannot be read: ${input.rigErrors.get(member.rig)}`, at);
    } else if (input.missingRigs?.has(member.rig)) {
      note(notes, 'warn', 'rig-missing', `"${member.rig}" has no saved rig — a placeholder will be cast at render time`, at);
    }
    const rig = input.rigs.get(member.rig)?.rig;
    if (rig && !rig.voiceRef) {
      note(notes, 'info', 'voice-reference-missing', `"${member.rig}" has no voice yet — one will be minted during Voices`, at);
    }
  }

  if (shots.set && !input.knownSets.has(shots.set)) {
    note(notes, 'error', 'set-missing', `set "${shots.set}" does not exist`, { kind: 'set', id: shots.set });
  }
  if (shots.cards && shots.title && !supportedText(shots.title).trim()) {
    note(notes, 'warn', 'title-undrawable', 'the title contains no characters the card alphabet can draw');
  }

  try {
    const validation = validateShotList(shots, buildCapabilityManifest(input.rigs));
    for (const message of validation) {
      note(notes, 'error', classifyShotListError(message), message);
    }
  } catch (error) {
    note(notes, 'error', 'shotlist-invalid', `shot-list capability validation failed: ${(error as Error).message}`);
  }
  inspectScriptCurrency(input, notes);
  inspectGestureQuality(shots, notes);
  inspectWalkableBlocking(input, notes);

  const hasPropActions = shots.beats.some((beat) => (
    beat.kind === 'action' && beat.stage.some((action) =>
      PROP_STAGE_ACTIONS.has(action.type) || (action.type === 'sit' && Boolean(action.seat)),
    )
  ));
  const hasInitialHeldProps = shots.cast.some((member) => member.heldProp !== null);
  const hasInitialSeats = shots.cast.some((member) => member.seat !== null);
  if (hasPropActions || hasInitialHeldProps || hasInitialSeats) {
    if (!shots.set) {
      note(notes, 'error', 'prop-action-set-missing', 'structured prop actions and initial carried props require an active set');
    } else if (input.setError) {
      note(notes, 'error', 'set-invalid', `set "${shots.set}" cannot be read: ${input.setError}`);
    } else if (!input.setDescriptor) {
      note(notes, 'error', 'set-unavailable', `set "${shots.set}" was not loaded for prop-action validation`);
    } else {
      try {
        // The compiler is the continuity authority. Running it on conservative
        // estimated line timings catches the same missing/ambiguous target,
        // hidden performer, reach and pickup/putdown errors as final render —
        // which means it needs the authored animation too, since that is what
        // says where a dragged puppet is standing when it reaches for something.
        compileShotList(
          shots,
          input.rigs,
          estimatedCompilerTimings(shots),
          input.animation,
          input.setDescriptor,
        );
      } catch (error) {
        note(notes, 'error', 'prop-action-invalid', (error as Error).message);
      }
    }
  }

  inspectDialogue(input, notes);
  inspectVoiceReferences(input, notes);
  const animationTimeline = inspectEditorialTimeline(input, notes);
  inspectAnimation(input, notes, animationTimeline);

  if (input.soundtrack === 'missing') {
    note(notes, 'error', 'soundtrack-missing', 'production audio has not been built — run Voices before export');
  } else if (input.soundtrack === 'stale') {
    note(notes, 'error', 'soundtrack-stale', 'the rendered audio is stale — run Voices again before production playback or publish');
  } else if (input.soundtrack === 'error') {
    note(notes, 'error', 'soundtrack-unverifiable', `the rendered audio could not be verified: ${input.soundtrackError ?? 'unknown error'}`);
  }
  inspectReleaseQuality(input, notes);

  const locked = shots.beats.filter((beat) => beat.locked).length;
  if (locked) {
    note(notes, 'info', 'director-locks', `${locked} locked beat(s) will survive director reruns`);
  }

  return report(notes);
}

async function assetState(
  scene: string,
  file: string,
  expectedChecksum: string,
): Promise<'current' | 'missing' | 'stale'> {
  try {
    const bytes = await fs.readFile(performanceAssetPath(scene, file));
    return crypto.createHash('sha256').update(bytes).digest('hex') === expectedChecksum
      ? 'current'
      : 'stale';
  } catch {
    return 'missing';
  }
}

function programmeQuality(value: unknown): ProgrammeQualityGate | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const quality = value as Record<string, unknown>;
  const metrics = quality['metrics'];
  if (!metrics || typeof metrics !== 'object') return undefined;
  const measured = metrics as Record<string, unknown>;
  const nullableNumber = (item: unknown) => item === null || typeof item === 'number';
  if (
    quality['standard'] !== 'ITU-R-BS.1770-style' ||
    typeof quality['targetIntegratedLufs'] !== 'number' ||
    typeof quality['loudnessToleranceLu'] !== 'number' ||
    typeof quality['truePeakCeilingDbtp'] !== 'number' ||
    typeof quality['loudnessPassed'] !== 'boolean' ||
    typeof quality['truePeakPassed'] !== 'boolean' ||
    typeof quality['intentionalSilence'] !== 'boolean' ||
    typeof quality['passed'] !== 'boolean' ||
    !nullableNumber(measured['integratedLufs']) ||
    !nullableNumber(measured['truePeakDbtp']) ||
    !nullableNumber(measured['samplePeakDbfs'])
  ) return undefined;
  return value as ProgrammeQualityGate;
}

/** Load local production state, then apply the reusable policy above. */
export async function runProductionPreflight(
  scene: string,
  suppliedShots?: ShotList | null,
): Promise<ProductionPreflightReport> {
  let shots = suppliedShots;
  let shotListError: string | undefined;
  if (shots === undefined) {
    try {
      shots = await readShotList(scene);
    } catch (error) {
      shots = null;
      shotListError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!shots) {
    return evaluateProductionPreflight({
      scene,
      shots: null,
      shotListError,
      identity: activeIdentity(),
      rigs: new Map(),
      knownSets: new Set(),
      dialogue: null,
      animation: null,
      soundtrack: 'missing',
    });
  }

  // The screenplay the shot list is supposed to be telling. A script that no
  // longer parses is worth saying out loud, but it is not a render blocker —
  // the directed shot list is what renders.
  let screenplay: Screenplay | null = null;
  let scriptError: string | undefined;
  try {
    screenplay = parseScript(await readScript(scene), scene);
  } catch (error) {
    scriptError = error instanceof Error ? error.message : String(error);
  }

  const onDisk = new Set(await listRigs());
  const missingRigs = new Set<string>();
  const rigErrors = new Map<string, string>();
  const rigs = new Map<string, LoadedRig>();
  for (const member of shots.cast) {
    if (rigs.has(member.rig)) continue;
    if (!onDisk.has(member.rig)) {
      missingRigs.add(member.rig);
      rigs.set(member.rig, { rig: buildPlaceholderRig(member.rig), svg: buildPlaceholderSvg(member.rig) });
      continue;
    }
    try {
      rigs.set(member.rig, await loadRig(member.rig));
    } catch (error) {
      rigErrors.set(member.rig, error instanceof Error ? error.message : String(error));
      rigs.set(member.rig, { rig: buildPlaceholderRig(member.rig), svg: buildPlaceholderSvg(member.rig) });
    }
  }
  applySceneOutfits(shots, rigs);

  let dialogue: DialogueDocument | null = null;
  let dialogueError: string | undefined;
  try {
    dialogue = await readDialogueDocument(scene);
  } catch (error) {
    dialogueError = error instanceof Error ? error.message : String(error);
  }

  let animation: AnimationDocument | null = null;
  let animationError: string | undefined;
  try {
    animation = await readAnimation(scene);
  } catch (error) {
    animationError = error instanceof Error ? error.message : String(error);
  }

  // Verification verdicts for generated takes. Cache-only reads: preflight
  // must never wake the engine, and a line with no cached take simply has no
  // verdict yet (its absence is already reported as a stale soundtrack).
  let generatedLineQa: ReadonlyMap<string, LineQa> | undefined;
  if (dialogue) {
    try {
      generatedLineQa = await collectGeneratedLineQa(scene, shots, rigs, dialogue);
    } catch {
      // Unreadable cache metadata is not itself a release question.
    }
  }

  const missingDialogueAssets = new Set<string>();
  const staleDialogueAssets = new Set<string>();
  if (dialogue) {
    const takes = new Map(dialogue.recordedTakes.map((take) => [take.id, take]));
    const renders = new Map(dialogue.voiceRenders.map((render) => [render.id, render]));
    for (const cue of dialogue.cues) {
      const take = cue.selectedTakeId ? takes.get(cue.selectedTakeId) : undefined;
      if (take) {
        const state = await assetState(scene, take.audio.file, take.audio.checksum);
        if (state === 'missing') missingDialogueAssets.add(`take:${take.id}`);
        if (state === 'stale') staleDialogueAssets.add(`take:${take.id}`);
      }
      const render = cue.selectedRenderId ? renders.get(cue.selectedRenderId) : undefined;
      if (render?.audio) {
        const state = await assetState(scene, render.audio.file, render.audio.checksum);
        if (state === 'missing') missingDialogueAssets.add(`render:${render.id}`);
        if (state === 'stale') staleDialogueAssets.add(`render:${render.id}`);
      }
    }
  }

  let soundtrack: SoundtrackState = 'missing';
  let soundtrackError: string | undefined;
  let soundtrackQuality: ProgrammeQualityGate | undefined;
  if (await exists(path.join(sceneDir(scene), 'dialogue.wav'))) {
    try {
      soundtrack = await soundtrackIsCurrent(scene, shots, rigs) ? 'current' : 'stale';
      if (soundtrack === 'current') {
        const stored = JSON.parse(await fs.readFile(soundtrackManifestPath(scene), 'utf8')) as {
          production?: { quality?: unknown };
        };
        soundtrackQuality = programmeQuality(stored.production?.quality);
      }
    } catch (error) {
      soundtrack = 'error';
      soundtrackError = error instanceof Error ? error.message : String(error);
    }
  }

  let knownSets: Set<string>;
  try {
    knownSets = new Set([...(await listSets()), ...Object.keys(BUILTIN_SETS)]);
  } catch {
    knownSets = new Set(Object.keys(BUILTIN_SETS));
  }

  let setDescriptor: SetDescriptor | null = null;
  let setError: string | undefined;
  if (shots.set && knownSets.has(shots.set)) {
    try {
      setDescriptor = BUILTIN_SETS[shots.set] ?? await loadSet(shots.set);
    } catch (error) {
      setError = error instanceof Error ? error.message : String(error);
    }
  }

  // A stand-in for when the scene will not compile: real line text in beat
  // order, stamped with the index rather than a clock. It goes through the
  // same split the compiler applies, so the layout verdict matches what would
  // ship — but its windows are fiction, so it is marked as such.
  const captionCues = splitCaptionCues(shots.beats.flatMap((beat, index) => beat.kind === 'line' ? [{
    id: beat.id,
    speaker: beat.speaker,
    text: beat.text,
    startMs: index,
    endMs: index + 1,
  }] : []));
  let publishingSafety = evaluatePublishingSafety(captionCues, null, { timings: 'placeholder' });
  try {
    const compiledForSafety = compileShotList(
      shots,
      rigs,
      estimatedCompilerTimings(shots),
      animation,
      setDescriptor,
    );
    publishingSafety = evaluatePublishingSafety(
      compiledForSafety.captions,
      reframeScenePortrait(compiledForSafety.ir),
    );
  } catch {
    // Other preflight checks report the compiler or animation error. Caption
    // safety remains enforceable even when portrait composition is deferred.
  }

  // A missing reference file makes a minted/recorded voice unusable even if
  // its rig metadata still points at it. Surface that as an invalid rig input.
  const voiceReferenceChecksums = new Map<string, string>();
  for (const [name, loaded] of rigs) {
    if (!loaded.rig.voiceRef) continue;
    if (path.basename(loaded.rig.voiceRef) !== loaded.rig.voiceRef) {
      rigErrors.set(name, `voice reference "${loaded.rig.voiceRef}" must be a file inside cast/`);
      continue;
    }
    try {
      const reference = path.join(CAST_DIR, loaded.rig.voiceRef);
      const bytes = await fs.readFile(reference);
      voiceReferenceChecksums.set(name, crypto.createHash('sha256').update(bytes).digest('hex'));
    } catch {
      rigErrors.set(name, `voice reference "${loaded.rig.voiceRef}" is missing`);
    }
  }

  return evaluateProductionPreflight({
    scene,
    shots,
    screenplay,
    scriptError,
    identity: activeIdentity(),
    rigs,
    missingRigs,
    rigErrors,
    voiceReferenceChecksums,
    knownSets,
    setDescriptor,
    setError,
    dialogue,
    dialogueError,
    missingDialogueAssets,
    staleDialogueAssets,
    generatedLineQa,
    animation,
    animationError,
    soundtrack,
    soundtrackError,
    soundtrackQuality,
    publishingSafety,
  });
}
