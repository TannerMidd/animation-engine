import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildPlaceholderRig } from '../src/cast/placeholder.ts';
import type { LoadedRig } from '../src/cast/store.ts';
import {
  estimatedAnimationTimeline,
  evaluateProductionPreflight,
  type ProductionPreflightInput,
} from '../src/pipeline/preflight.ts';
import { autoDirect } from '../src/direct/index.ts';
import { parseScript } from '../src/parse/index.ts';
import { dialogueScriptHash } from '../src/pipeline/dialogue.ts';
import { AnimationDocument } from '../src/schema/animation.ts';
import { DialogueDocument } from '../src/schema/dialogue.ts';
import { DEFAULT_IDENTITY } from '../src/schema/identity.ts';
import { ShotList, type ShotList as ShotListType } from '../src/schema/script.ts';
import { SetDescriptor } from '../src/sets/schema.ts';
import { evaluatePublishingSafety } from '../src/pipeline/publish.ts';

function rig(name = 'alice'): LoadedRig {
  return { rig: buildPlaceholderRig(name), svg: '<svg />' };
}

function actionScene(action: Record<string, unknown>): ShotListType {
  return ShotList.parse({
    scene: 'preflight-action',
    cards: false,
    fps: 24,
    characterFps: 12,
    cast: [{ id: 'alice', rig: 'alice', mark: 'SL' }],
    beats: [{ kind: 'action', id: 'action-1', text: 'Alice moves.', ms: 1000, ...action }],
  });
}

function lineScene(): ShotListType {
  return ShotList.parse({
    scene: 'preflight-line',
    cards: false,
    fps: 24,
    characterFps: 12,
    cast: [{ id: 'alice', rig: 'alice', mark: 'SL' }],
    beats: [{
      kind: 'line',
      id: 'line-1',
      speaker: 'alice',
      text: 'This is the line.',
      expression: 'NEUTRAL',
      gesture: 'TALK',
    }],
  });
}

function input(shots: ShotListType, loaded = rig()): ProductionPreflightInput {
  return {
    scene: shots.scene,
    shots,
    identity: DEFAULT_IDENTITY,
    rigs: new Map([['alice', loaded]]),
    knownSets: new Set(),
    dialogue: null,
    animation: null,
    soundtrack: 'current',
  };
}

describe('production preflight policy', () => {
  it('blocks unstructured actions and obvious entrance continuity errors at production export', () => {
    const unstructured = evaluateProductionPreflight(input(actionScene({ stage: [], unsupported: [] })));
    expect(unstructured.notes.some((item) => item.code === 'action-unstructured')).toBe(true);
    expect(unstructured.productionBlocked).toBe(true);

    const unsupported = evaluateProductionPreflight(input(actionScene({
      stage: [],
      unsupported: ['Alice cartwheels.'],
    })));
    expect(unsupported.notes.some((item) => item.code === 'action-unsupported')).toBe(true);

    const doubleEntrance = evaluateProductionPreflight(input(actionScene({
      stage: [{ type: 'enter', actor: 'alice' }],
      unsupported: [],
    })));
    expect(doubleEntrance.notes.some((item) => item.code === 'continuity-invalid')).toBe(true);
    expect(doubleEntrance.ok).toBe(false);
    expect(doubleEntrance.renderEndpointBlocked).toBe(true);
    expect(doubleEntrance.policy.renderEndpointEnforced).toBe(true);
  });

  it('runs prop identity and pickup/putdown continuity through the canonical compiler', () => {
    const shots = ShotList.parse({
      ...actionScene({
        stage: [{ type: 'pick_up', actor: 'alice', prop: 'mug' }],
        unsupported: [],
      }),
      set: 'props',
    });
    const ambiguous = SetDescriptor.parse({
      name: 'props',
      layers: {
        mid: [
          { id: 'mug-a', prop: 'mug', x: 400, y: 540 },
          { id: 'mug-b', prop: 'mug', x: 500, y: 540 },
        ],
      },
    });
    const result = evaluateProductionPreflight({
      ...input(shots),
      knownSets: new Set(['props']),
      setDescriptor: ambiguous,
    });

    expect(result.notes.find((item) => item.code === 'prop-action-invalid')?.message).toMatch(
      /ambiguous.*stable instance ids/i,
    );
    expect(result.productionBlocked).toBe(true);

    const validShots = ShotList.parse({
      ...shots,
      beats: [{
        ...shots.beats[0],
        stage: [{ type: 'pick_up', actor: 'alice', prop: 'mug-a' }],
      }],
    });
    const valid = evaluateProductionPreflight({
      ...input(validShots),
      knownSets: new Set(['props']),
      setDescriptor: ambiguous,
    });
    expect(valid.notes.some((item) => item.code === 'prop-action-invalid')).toBe(false);
    expect(valid.productionBlocked).toBe(false);
  });

  describe('a shot list left behind by its script', () => {
    const rigs = new Map([
      ['alice', { rig: buildPlaceholderRig('alice'), svg: '<svg />' }],
      ['bob', { rig: buildPlaceholderRig('bob'), svg: '<svg />' }],
    ]);
    const SOURCE = [
      '# STALE', '', 'INT. OFFICE - DAY', '',
      'ALICE', '(deadpan)', 'Morning.', '',
      'BOB', '(flat)', 'Morning.', '',
      '[BEAT 1200]', '',
      'ALICE', 'Did you file it?', '',
    ].join('\n');

    const direct = (source: string) =>
      autoDirect(parseScript(source, 'stale'), rigs, { scene: 'stale', seed: 7 });

    const check = (shots: ShotListType, source: string) => evaluateProductionPreflight({
      ...input(shots, rigs.get('alice')!),
      rigs,
      screenplay: parseScript(source, 'stale'),
    });

    it('stays quiet while the shot list still tells the script’s story', () => {
      const report = check(direct(SOURCE), SOURCE);
      expect(report.notes.some((item) => item.code === 'shotlist-script-stale')).toBe(false);
    });

    it('blocks the render once the script has moved on', () => {
      const shots = direct(SOURCE);
      const rewritten = SOURCE.replace('Did you file it?', 'The building has been sold.');
      const report = check(shots, rewritten);

      const stale = report.notes.find((item) => item.code === 'shotlist-script-stale');
      expect(stale?.message).toMatch(/1 beat the shot list does not reflect.*run Direct/i);
      expect(stale?.blocking).toBe(true);
      expect(report.renderEndpointBlocked).toBe(true);
    });

    it('counts a line added to the middle of the script', () => {
      const shots = direct(SOURCE);
      const extended = SOURCE.replace('[BEAT 1200]', 'BOB\nStill here.\n\n[BEAT 1200]');
      const report = check(shots, extended);
      expect(report.notes.some((item) => item.code === 'shotlist-script-stale')).toBe(true);
    });

    // The whole point of comparing spines rather than beats: staging and
    // retiming are the creator's, and doing either must not read as the script
    // having changed underneath them.
    it('ignores hand-edited framing, camera and pause timing', () => {
      const shots = direct(SOURCE);
      const handEdited = ShotList.parse({
        ...shots,
        beats: shots.beats.map((beat) => (beat.kind === 'pause'
          ? { ...beat, ms: beat.ms + 900, shot: 'ECU', camera: 'PUSH_IN' }
          : { ...beat, shot: 'ECU', camera: 'SHAKE', focus: [], locked: true })),
      });
      expect(handEdited).not.toEqual(shots);

      const report = check(handEdited, SOURCE);
      expect(report.notes.some((item) => item.code === 'shotlist-script-stale')).toBe(false);
    });

    it('says so, without blocking, when the script cannot be read at all', () => {
      const report = evaluateProductionPreflight({
        ...input(direct(SOURCE), rigs.get('alice')!),
        rigs,
        scriptError: 'ENOENT: no such file',
      });
      const note = report.notes.find((item) => item.code === 'script-unreadable');
      expect(note?.blocking).toBe(false);
      expect(report.notes.some((item) => item.code === 'shotlist-script-stale')).toBe(false);
    });
  });

  it('blocks rejected selections, non-ready renders, draft TTS, and a minted voice still in use', () => {
    const shots = lineScene();
    const loaded = rig();
    loaded.rig.voiceRef = 'alice.ref.wav';
    loaded.rig.voiceProvenance = { source: 'minted', seed: 7, hash: 'abc' };
    const dialogue = DialogueDocument.parse({
      schemaVersion: 1,
      scene: shots.scene,
      revision: 1,
      fps: 24,
      scriptHash: dialogueScriptHash(shots),
      recordedTakes: [],
      voiceRenders: [{
        id: 'draft-1',
        source: { kind: 'draft-tts', seed: 1, voiceId: null, referenceChecksum: null },
        state: 'rejected',
        audio: null,
        model: {
          engine: 'test',
          model: 'test',
          revision: '1',
          settings: {},
          generatedAt: '2026-08-02T12:00:00.000Z',
        },
        quality: { verdict: 'reject', flags: ['robotic'] },
      }],
      cues: [{
        id: 'line-1',
        beatIndex: 0,
        speaker: 'alice',
        displayText: 'This is the line.',
        spokenText: 'This is the line.',
        selectedRenderId: 'draft-1',
        approval: { state: 'rejected', notes: ['replace it'] },
        locked: false,
        provenance: { origin: 'generated', revision: 1 },
      }],
    });
    const result = evaluateProductionPreflight({ ...input(shots, loaded), dialogue });
    const codes = new Set(result.notes.map((item) => item.code));

    expect(codes.has('dialogue-approval-rejected')).toBe(true);
    expect(codes.has('voice-render-not-ready')).toBe(true);
    expect(codes.has('voice-render-rejected')).toBe(true);
    expect(codes.has('voice-render-draft-only')).toBe(true);
    expect(codes.has('voice-reference-draft-only')).toBe(true);
    expect(result.productionBlocked).toBe(true);

    for (const state of ['stale', 'unresolved'] as const) {
      const changed = DialogueDocument.parse({
        ...dialogue,
        cues: dialogue.cues.map((cue) => ({ ...cue, approval: { ...cue.approval, state } })),
      });
      const checked = evaluateProductionPreflight({ ...input(shots, loaded), dialogue: changed });
      expect(checked.notes.some((item) => item.code === `dialogue-approval-${state}` && item.blocking)).toBe(true);
    }
  });

  it('covers a pre-rights recording with a document-level performance record', () => {
    const shots = lineScene();
    const spokenText = 'This is the line.';
    const base = {
      schemaVersion: 1,
      scene: shots.scene,
      revision: 1,
      fps: 24,
      scriptHash: dialogueScriptHash(shots),
      recordedTakes: [{
        id: 'take-1',
        cueId: 'line-1',
        speaker: 'alice',
        displayText: spokenText,
        spokenText,
        scriptTextHash: crypto.createHash('sha256').update(spokenText).digest('hex'),
        audio: {
          file: 'dialogue/takes/take-1.wav',
          checksum: 'a'.repeat(64),
          byteLength: 96044,
          mediaType: 'audio/wav',
          sampleRate: 48000,
          channels: 1,
          sampleCount: 48000,
          durationMs: 1000,
        },
        quality: { verdict: 'pass' as const, peakDb: -6, rmsDb: -20, speechRatio: 0.8, flags: [] },
        capture: {
          mode: 'line-booth' as const,
          recordedAt: '2026-08-02T12:00:00.000Z',
          performerId: 'creator',
          inputDevice: null,
          latencyCompensationMs: 0,
          countInMs: 0,
          sourceFileName: null,
          consentId: null,
        },
      }],
      voiceRenders: [],
      cues: [{
        id: 'line-1',
        beatIndex: 0,
        speaker: 'alice',
        displayText: spokenText,
        spokenText,
        selectedTakeId: 'take-1',
        trim: { inMs: 0, outMs: 1000, speechOnsetMs: 80, speechEndMs: 920 },
        approval: { state: 'approved', by: 'creator', at: '2026-08-02T12:05:00.000Z' },
        locked: true,
        provenance: { origin: 'recorded', revision: 1 },
      }],
    };

    const uncovered = evaluateProductionPreflight({ ...input(shots), dialogue: DialogueDocument.parse(base) });
    expect(uncovered.notes.find((item) => item.code === 'performance-consent-missing')?.level).toBe('error');

    const covered = evaluateProductionPreflight({
      ...input(shots),
      dialogue: DialogueDocument.parse({
        ...base,
        consents: [{
          id: 'creator-owned-voice',
          subject: 'creator',
          basis: 'self-owned',
          scope: 'both',
          referenceChecksum: null,
          permits: { voiceConversion: true, distribution: true, training: false },
          createdAt: '2026-08-02T13:00:00.000Z',
          expiresAt: null,
          revokedAt: null,
          notes: [],
        }],
      }),
    });
    expect(covered.notes.some((item) => item.code === 'performance-consent-missing')).toBe(false);
    expect(covered.notes.find((item) => item.code === 'performance-consent-fallback')?.level).toBe('info');
  });

  it('accepts an approved generated-voice line and downgrades the minted reference to a warning', () => {
    const shots = lineScene();
    const loaded = rig();
    loaded.rig.voiceRef = 'alice.ref.wav';
    loaded.rig.voiceProvenance = { source: 'minted', seed: 7, hash: 'abc' };
    const dialogue = DialogueDocument.parse({
      schemaVersion: 1,
      scene: shots.scene,
      revision: 1,
      fps: 24,
      scriptHash: dialogueScriptHash(shots),
      recordedTakes: [],
      voiceRenders: [],
      cues: [{
        id: 'line-1',
        beatIndex: 0,
        speaker: 'alice',
        displayText: 'This is the line.',
        spokenText: 'This is the line.',
        voiceSource: 'generated',
        approval: { state: 'approved', by: 'creator', at: '2026-08-02T12:00:00.000Z' },
        locked: true,
        provenance: { origin: 'generated', revision: 1 },
      }],
    });
    const result = evaluateProductionPreflight({ ...input(shots, loaded), dialogue });
    const codes = new Set(result.notes.map((item) => item.code));

    expect(codes.has('dialogue-selection-unresolved')).toBe(false);
    expect(codes.has('dialogue-unapproved')).toBe(false);
    expect(codes.has('dialogue-unlocked')).toBe(false);
    expect(codes.has('voice-reference-draft-only')).toBe(false);
    expect(result.notes.find((item) => item.code === 'voice-reference-minted-in-use')?.level).toBe('warn');
    expect(result.notes.filter((item) => item.blocking && item.code.startsWith('dialogue')).length).toBe(0);
  });

  it('treats an approved conversion into a minted reference as a decision, not a draft', () => {
    const shots = lineScene();
    const spokenText = 'This is the line.';
    const loaded = rig();
    loaded.rig.voiceRef = 'alice.ref.wav';
    loaded.rig.voiceProvenance = { source: 'minted', seed: 7, hash: 'abc' };
    const audio = (file: string) => ({
      file,
      checksum: 'a'.repeat(64),
      byteLength: 96044,
      mediaType: 'audio/wav' as const,
      sampleRate: 48000,
      channels: 1,
      sampleCount: 48000,
      durationMs: 1000,
    });
    const base = {
      schemaVersion: 1,
      scene: shots.scene,
      revision: 1,
      fps: 24,
      scriptHash: dialogueScriptHash(shots),
      consents: [{
        id: 'creator-owned-voice',
        subject: 'creator',
        basis: 'self-owned' as const,
        scope: 'both' as const,
        referenceChecksum: 'b'.repeat(64),
        permits: { voiceConversion: true, distribution: true, training: false },
        createdAt: '2026-08-02T12:00:00.000Z',
        expiresAt: null,
        revokedAt: null,
        notes: [],
      }],
      recordedTakes: [{
        id: 'take-1',
        cueId: 'line-1',
        speaker: 'alice',
        displayText: spokenText,
        spokenText,
        scriptTextHash: crypto.createHash('sha256').update(spokenText).digest('hex'),
        audio: audio('dialogue/takes/take-1.wav'),
        quality: { verdict: 'pass' as const, peakDb: -6, rmsDb: -20, speechRatio: 0.8, flags: [] },
        capture: {
          mode: 'line-booth' as const,
          recordedAt: '2026-08-02T12:00:00.000Z',
          performerId: 'creator',
          inputDevice: null,
          latencyCompensationMs: 0,
          countInMs: 0,
          sourceFileName: null,
          consentId: 'creator-owned-voice',
        },
      }],
      voiceRenders: [{
        id: 'vc-1',
        source: {
          kind: 'voice-conversion' as const,
          takeId: 'take-1',
          targetVoiceId: 'alice',
          targetReferenceChecksum: 'b'.repeat(64),
          consentId: 'creator-owned-voice',
          registerPolicy: 'adapt-to-character' as const,
          sourceCueId: 'line-1',
          sourceAudioChecksum: 'a'.repeat(64),
        },
        state: 'ready' as const,
        audio: audio('dialogue/renders/vc-1.wav'),
        model: {
          engine: 'chatterbox-vc',
          model: 'ResembleAI/chatterbox:ChatterboxVC',
          revision: 'ResembleAI/chatterbox@abc1234',
          settings: {},
          generatedAt: '2026-08-02T12:10:00.000Z',
        },
        quality: { verdict: 'pass' as const, flags: [] },
      }],
      cues: [{
        id: 'line-1',
        beatIndex: 0,
        speaker: 'alice',
        displayText: spokenText,
        spokenText,
        selectedTakeId: 'take-1',
        selectedRenderId: 'vc-1',
        trim: { inMs: 0, outMs: 1000, speechOnsetMs: 0, speechEndMs: 1000 },
        approval: { state: 'approved' as const, by: 'creator', at: '2026-08-02T12:15:00.000Z' },
        locked: true,
        provenance: { origin: 'recorded' as const, revision: 1 },
      }],
    };

    const approved = evaluateProductionPreflight({
      ...input(shots, loaded),
      dialogue: DialogueDocument.parse(base),
    });
    expect(approved.notes.some((item) => item.code === 'voice-reference-draft-only')).toBe(false);
    expect(approved.notes.find((item) => item.code === 'voice-reference-minted-in-use')?.level).toBe('warn');

    // Until the creator approves it, the conversion is still just a candidate
    // and the minted reference stays an unmade decision.
    const candidate = evaluateProductionPreflight({
      ...input(shots, loaded),
      dialogue: DialogueDocument.parse({
        ...base,
        cues: base.cues.map((cue) => ({
          ...cue,
          locked: false,
          approval: { state: 'candidate' as const, by: null, at: null },
        })),
      }),
    });
    expect(candidate.notes.find((item) => item.code === 'voice-reference-draft-only')?.level).toBe('error');
  });

  it('blocks candidate and unlocked dialogue until the creator approves and locks it', () => {
    const shots = lineScene();
    const spokenText = 'This is the line.';
    const dialogue = DialogueDocument.parse({
      schemaVersion: 1,
      scene: shots.scene,
      revision: 1,
      fps: 24,
      scriptHash: dialogueScriptHash(shots),
      recordedTakes: [{
        id: 'take-1',
        cueId: 'line-1',
        speaker: 'alice',
        displayText: spokenText,
        spokenText,
        scriptTextHash: crypto.createHash('sha256').update(spokenText).digest('hex'),
        audio: {
          file: 'dialogue/takes/take-1.wav',
          checksum: 'a'.repeat(64),
          byteLength: 96044,
          mediaType: 'audio/wav',
          sampleRate: 48000,
          channels: 1,
          sampleCount: 48000,
          durationMs: 1000,
        },
        capture: {
          mode: 'line-booth',
          recordedAt: '2026-08-02T12:00:00.000Z',
          performerId: null,
          inputDevice: null,
          latencyCompensationMs: 0,
          countInMs: 0,
          sourceFileName: null,
          consentId: null,
        },
      }],
      voiceRenders: [],
      cues: [{
        id: 'line-1',
        beatIndex: 0,
        speaker: 'alice',
        displayText: spokenText,
        spokenText,
        selectedTakeId: 'take-1',
        trim: { inMs: 0, outMs: 1000, speechOnsetMs: 80, speechEndMs: 920 },
        approval: { state: 'candidate' },
        locked: false,
        provenance: { origin: 'recorded', revision: 1 },
      }],
    });
    const result = evaluateProductionPreflight({ ...input(shots), dialogue });

    expect(result.notes.find((item) => item.code === 'dialogue-unapproved')?.level).toBe('error');
    expect(result.notes.find((item) => item.code === 'dialogue-unlocked')?.level).toBe('error');
    expect(result.productionBlocked).toBe(true);

    const tampered = evaluateProductionPreflight({
      ...input(shots),
      dialogue,
      staleDialogueAssets: new Set(['take:take-1']),
    });
    expect(tampered.notes.some((item) => item.code === 'dialogue-asset-stale' && item.blocking)).toBe(true);
  });

  it('requires distribution rights for every selected recorded performance', () => {
    const shots = lineScene();
    const spokenText = 'This is the line.';
    const take = {
      id: 'take-rights',
      cueId: 'line-1',
      speaker: 'alice',
      displayText: spokenText,
      spokenText,
      scriptTextHash: crypto.createHash('sha256').update(spokenText).digest('hex'),
      audio: {
        file: 'dialogue/takes/take-rights.wav', checksum: 'b'.repeat(64), byteLength: 96044,
        mediaType: 'audio/wav', sampleRate: 48000, channels: 1, sampleCount: 48000, durationMs: 1000,
      },
      quality: { verdict: 'pass' as const, peakDb: -6, rmsDb: -20, speechRatio: 0.6, flags: [] },
      capture: {
        mode: 'line-booth' as const, recordedAt: '2026-08-02T12:00:00.000Z', performerId: 'creator',
        inputDevice: null, latencyCompensationMs: 0, countInMs: 0, sourceFileName: null,
        consentId: 'creator-performance',
      },
      provenance: { createdBy: 'creator', notes: [], sceneRunSegments: [] },
    };
    const consent = {
      id: 'creator-performance', subject: 'Creator', basis: 'self-owned' as const,
      scope: 'performance' as const, referenceChecksum: null,
      permits: { voiceConversion: true, distribution: true, training: false },
      createdAt: '2026-08-02T12:00:00.000Z', expiresAt: null, revokedAt: null, notes: [],
    };
    const dialogue = DialogueDocument.parse({
      schemaVersion: 1, scene: shots.scene, revision: 1, fps: 24,
      scriptHash: dialogueScriptHash(shots), consents: [consent], recordedTakes: [take], voiceRenders: [],
      cues: [{
        id: 'line-1', beatIndex: 0, speaker: 'alice', displayText: spokenText, spokenText,
        selectedTakeId: take.id,
        trim: { inMs: 0, outMs: 1000, speechOnsetMs: 80, speechEndMs: 920 },
        approval: { state: 'approved', by: 'creator', at: '2026-08-02T12:05:00.000Z', notes: [] },
        locked: true, provenance: { origin: 'recorded', revision: 1 },
      }],
    });
    const valid = evaluateProductionPreflight({ ...input(shots), dialogue });
    expect(valid.notes.some((item) => item.code.startsWith('performance-consent-'))).toBe(false);
    expect(valid.productionBlocked).toBe(false);

    const missing = DialogueDocument.parse({
      ...dialogue,
      consents: [],
      recordedTakes: [{ ...take, capture: { ...take.capture, consentId: null } }],
    });
    expect(evaluateProductionPreflight({ ...input(shots), dialogue: missing }).notes)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'performance-consent-missing', blocking: true })]));

    const targetOnly = DialogueDocument.parse({
      ...dialogue,
      consents: [{ ...consent, scope: 'target-voice', referenceChecksum: 'c'.repeat(64) }],
    });
    expect(evaluateProductionPreflight({ ...input(shots), dialogue: targetOnly }).notes)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'performance-consent-scope', blocking: true })]));
  });

  it('blocks selected Scene Run slices with missing or rejected segment-level QC', () => {
    const shots = lineScene();
    const spokenText = 'This is the line.';
    const scriptTextHash = crypto.createHash('sha256').update(spokenText).digest('hex');
    const consent = {
      id: 'run-performance', subject: 'Creator', basis: 'self-owned' as const,
      scope: 'performance' as const, referenceChecksum: null,
      permits: { voiceConversion: true, distribution: true, training: false },
      createdAt: '2026-08-02T12:00:00.000Z', expiresAt: null, revokedAt: null, notes: [],
    };
    const take = {
      id: 'run-1', cueId: null, speaker: 'alice', displayText: spokenText, spokenText,
      scriptTextHash,
      audio: {
        file: 'dialogue/takes/run-1.wav', checksum: 'd'.repeat(64), byteLength: 96044,
        mediaType: 'audio/wav', sampleRate: 48000, channels: 1, sampleCount: 48000, durationMs: 1000,
      },
      quality: { verdict: 'pass' as const, peakDb: -6, rmsDb: -20, speechRatio: 0.6, flags: [] },
      capture: {
        mode: 'scene-run' as const, recordedAt: '2026-08-02T12:00:00.000Z', performerId: 'creator',
        inputDevice: null, latencyCompensationMs: 0, countInMs: 0, sourceFileName: null,
        consentId: consent.id,
      },
      provenance: {
        createdBy: 'creator', notes: [],
        sceneRunSegments: [{
          cueId: 'line-1', scriptTextHash, inMs: 0, outMs: 1000,
          speechOnsetMs: 80, speechEndMs: 920, quality: null,
        }],
      },
    };
    const build = (quality: null | { verdict: 'reject'; peakDb: number; rmsDb: number; speechRatio: number; flags: string[] }) =>
      DialogueDocument.parse({
        schemaVersion: 1, scene: shots.scene, revision: 1, fps: 24,
        scriptHash: dialogueScriptHash(shots), consents: [consent],
        recordedTakes: [{
          ...take,
          provenance: {
            ...take.provenance,
            sceneRunSegments: [{ ...take.provenance.sceneRunSegments[0]!, quality }],
          },
        }],
        voiceRenders: [],
        cues: [{
          id: 'line-1', beatIndex: 0, speaker: 'alice', displayText: spokenText, spokenText,
          selectedTakeId: take.id,
          trim: { inMs: 0, outMs: 1000, speechOnsetMs: 80, speechEndMs: 920 },
          approval: { state: 'approved', by: 'creator', at: '2026-08-02T12:05:00.000Z', notes: [] },
          locked: true, provenance: { origin: 'recorded', revision: 1 },
        }],
      });

    expect(evaluateProductionPreflight({ ...input(shots), dialogue: build(null) }).notes)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'scene-run-segment-qc-missing', blocking: true })]));
    expect(evaluateProductionPreflight({
      ...input(shots),
      dialogue: build({ verdict: 'reject', peakDb: -6, rmsDb: -40, speechRatio: 0.01, flags: ['no speech'] }),
    }).notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scene-run-segment-qc-rejected', blocking: true }),
    ]));
  });

  it('resolves estimated animation timing and blocks deterministic track conflicts', () => {
    const shots = actionScene({ stage: [{ type: 'move', actor: 'alice', to: { mark: 'SR' } }], unsupported: [] });
    const malformed = evaluateProductionPreflight({
      ...input(shots),
      animationError: 'invalid JSON at animation.json',
    });
    expect(malformed.notes.some((item) => item.code === 'animation-invalid' && item.blocking)).toBe(true);

    const animation = AnimationDocument.parse({
      schemaVersion: 1,
      scene: shots.scene,
      revision: 1,
      layers: [{ id: 'manual', name: 'Manual', ownership: 'manual' }],
      tracks: [
        {
          id: 'move-a', layerId: 'manual', actorId: 'alice', channel: 'root.position',
          keys: [{ id: 'a-1', time: { kind: 'absolute', ms: 0 }, value: [100, 600] }],
        },
        {
          id: 'move-b', layerId: 'manual', actorId: 'alice', channel: 'root.position',
          keys: [{ id: 'b-1', time: { kind: 'absolute', ms: 500 }, value: [200, 600] }],
        },
      ],
      events: [],
    });
    const result = evaluateProductionPreflight({ ...input(shots), animation });

    expect(result.notes.find((item) => item.code === 'animation-resolve-failed')?.message).toMatch(/animation conflict/i);
    expect(result.productionBlocked).toBe(true);

    const outsideScene = AnimationDocument.parse({
      schemaVersion: 1,
      scene: shots.scene,
      revision: 1,
      layers: [{ id: 'manual', name: 'Manual', ownership: 'manual' }],
      tracks: [{
        id: 'late-move', layerId: 'manual', actorId: 'alice', channel: 'root.position',
        keys: [{ id: 'late-1', time: { kind: 'absolute', ms: 5_000 }, value: [200, 600] }],
      }],
      events: [],
    });
    const outside = evaluateProductionPreflight({ ...input(shots), animation: outsideScene });
    expect(outside.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'animation-resolve-failed', blocking: true }),
    ]));
    expect(outside.notes.some((item) => item.code === 'animation-timing-deferred')).toBe(false);
  });

  // Re-directing onto a new cast leaves motion authored for the departed one.
  // The compiler throws on it, so anything short of a named blocker here shows
  // up as an opaque 500 from the preview with nothing to act on.
  it('blocks motion segments left pointing at an actor no longer in the cast', () => {
    const shots = lineScene();
    const orphaned = AnimationDocument.parse({
      schemaVersion: 1,
      scene: shots.scene,
      revision: 1,
      layers: [{ id: 'manual', name: 'Manual', ownership: 'manual' }],
      tracks: [],
      segments: [{
        id: 'manual:bob:root.position:1',
        layerId: 'manual',
        actorId: 'bob',
        channel: 'root.position',
        blend: 'override',
        easing: 'linear',
        path: { shape: 'linear', curvature: 0 },
        assist: { anticipation: 0, overshoot: 0, hold: 0, recovery: 0.15 },
        source: 'drag',
        from: { id: 'from-1', time: { kind: 'absolute', ms: 0 }, value: [0, 0] },
        to: { id: 'to-1', time: { kind: 'absolute', ms: 500 }, value: [100, 0] },
        waypoints: [],
      }],
      events: [],
    });

    const result = evaluateProductionPreflight({ ...input(shots), animation: orphaned });
    const note = result.notes.find((item) => item.code === 'animation-target-invalid');
    expect(note?.message).toMatch(/motion segment .* references unknown actor "bob"/);
    expect(note?.blocking).toBe(true);
  });

  it('uses selected-asset editorial scheduling for animation anchors without decoding audio', () => {
    const shots = ShotList.parse({
      scene: 'preflight-editorial-clock', cards: false, fps: 24, characterFps: 12,
      cast: [
        { id: 'alice', rig: 'alice', mark: 'SL' },
        { id: 'bob', rig: 'bob', mark: 'SR' },
      ],
      beats: [
        { kind: 'line', id: 'line-a', speaker: 'alice', text: 'Alpha beta', expression: 'NEUTRAL', gesture: 'TALK' },
        { kind: 'line', id: 'line-b', speaker: 'bob', text: 'Gamma delta', expression: 'NEUTRAL', gesture: 'TALK' },
      ],
    });
    const audio = (id: string) => ({
      file: `dialogue/takes/${id}.wav`, checksum: id === 'take-a' ? 'a'.repeat(64) : 'b'.repeat(64),
      byteLength: 96_044, mediaType: 'audio/wav' as const, sampleRate: 48_000, channels: 1,
      sampleCount: 48_000, durationMs: 1_000,
    });
    const take = (id: string, cueId: string, speaker: string, text: string) => ({
      id, cueId, speaker, displayText: text, spokenText: text,
      scriptTextHash: crypto.createHash('sha256').update(text).digest('hex'),
      audio: audio(id),
      capture: {
        mode: 'line-booth' as const, recordedAt: '2026-08-02T12:00:00.000Z', performerId: null,
        inputDevice: null, latencyCompensationMs: 0, countInMs: 0, sourceFileName: null, consentId: null,
      },
    });
    const dialogue = DialogueDocument.parse({
      schemaVersion: 1, scene: shots.scene, revision: 1, fps: 24,
      scriptHash: dialogueScriptHash(shots),
      recordedTakes: [
        take('take-a', 'line-a', 'alice', 'Alpha beta'),
        take('take-b', 'line-b', 'bob', 'Gamma delta'),
      ],
      voiceRenders: [],
      cues: [
        {
          id: 'line-a', beatIndex: 0, speaker: 'alice', displayText: 'Alpha beta', spokenText: 'Alpha beta',
          selectedTakeId: 'take-a', trim: { inMs: 100, outMs: 900, speechOnsetMs: 200, speechEndMs: 800 },
          startFrame: 12,
          durationPolicy: { mode: 'fit-locked-window', targetFrames: 24 },
          approval: { state: 'candidate' }, provenance: { origin: 'recorded', revision: 1 },
        },
        {
          id: 'line-b', beatIndex: 1, speaker: 'bob', displayText: 'Gamma delta', spokenText: 'Gamma delta',
          selectedTakeId: 'take-b', trim: { inMs: 0, outMs: 1000, speechOnsetMs: 100, speechEndMs: 900 },
          pauseAfterMs: 250,
          overlap: { withCueId: 'line-a', mode: 'interruption', ms: 200, interruptAtMs: 600 },
          approval: { state: 'candidate' }, provenance: { origin: 'recorded', revision: 1 },
        },
      ],
    });

    const timeline = estimatedAnimationTimeline(shots, dialogue);
    const first = timeline.beats.find((beat) => beat.id === 'line-a')!;
    const second = timeline.beats.find((beat) => beat.id === 'line-b')!;
    expect(first.startMs).toBe(500);
    expect(first.endMs).toBe(1_100);
    expect(second.startMs).toBe(1_000);
    expect(second.endMs).toBe(2_250);
    expect(timeline.durationMs).toBe(2_250);
    expect(first.speech?.words.map((word) => word.id)).toEqual(expect.arrayContaining([
      'word-0', 'w000-alpha', 'word-1', 'w001-beta',
    ]));

    const anchored = (wordId: string) => AnimationDocument.parse({
      schemaVersion: 1, scene: shots.scene, revision: 1,
      layers: [{ id: 'manual', name: 'Manual', ownership: 'manual' }],
      tracks: [{
        id: 'word-move', layerId: 'manual', actorId: 'alice', channel: 'root.position',
        keys: [{
          id: 'word-key', time: { kind: 'word', beatId: 'line-a', wordId, edge: 'start' },
          value: [300, 600],
        }],
      }],
      events: [],
    });
    const base = {
      ...input(shots),
      rigs: new Map([['alice', rig('alice')], ['bob', rig('bob')]]),
      dialogue,
    };
    const stableAlias = evaluateProductionPreflight({ ...base, animation: anchored('w000-alpha') });
    expect(stableAlias.notes.some((item) => (
      item.code === 'animation-resolve-failed' || item.code === 'animation-timing-deferred'
    ))).toBe(false);
    const missingAlias = evaluateProductionPreflight({ ...base, animation: anchored('alignment-token-that-does-not-exist') });
    expect(missingAlias.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'animation-resolve-failed', blocking: true }),
    ]));
    expect(missingAlias.notes.some((item) => item.code === 'animation-timing-deferred')).toBe(false);

    const impossible = DialogueDocument.parse({
      ...dialogue,
      cues: dialogue.cues.map((cue) => cue.id === 'line-b' ? {
        ...cue,
        overlap: { ...cue.overlap!, interruptAtMs: 1_000 },
      } : cue),
    });
    const invalid = evaluateProductionPreflight({
      ...base,
      dialogue: impossible,
      animation: null,
    });
    expect(invalid.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'dialogue-timing-invalid', blocking: true }),
    ]));
  });

  it('blocks stale soundtrack and preserves the missing-set check', () => {
    const shots = ShotList.parse({ ...actionScene({ stage: [{ type: 'move', actor: 'alice', to: { mark: 'SR' } }], unsupported: [] }), set: 'missing-set' });
    const result = evaluateProductionPreflight({ ...input(shots), soundtrack: 'stale' });

    expect(result.notes.some((item) => item.code === 'soundtrack-stale' && item.blocking)).toBe(true);
    expect(result.notes.some((item) => item.code === 'set-missing' && item.blocking)).toBe(true);
  });

  it('blocks production export when the soundtrack has not been built', () => {
    const shots = actionScene({ stage: [{ type: 'move', actor: 'alice', to: { mark: 'SR' } }], unsupported: [] });
    const result = evaluateProductionPreflight({ ...input(shots), soundtrack: 'missing' });

    expect(result.notes.some((item) => item.code === 'soundtrack-missing' && item.blocking)).toBe(true);
    expect(result.productionBlocked).toBe(true);
  });

  it('gates a current master on integrated loudness and inter-sample true peak', () => {
    const shots = actionScene({
      stage: [{ type: 'move', actor: 'alice', to: { mark: 'SR' } }],
      unsupported: [],
    });
    const result = evaluateProductionPreflight({
      ...input(shots),
      soundtrackQuality: {
        standard: 'ITU-R-BS.1770-style',
        targetIntegratedLufs: -16,
        loudnessToleranceLu: 1.5,
        truePeakCeilingDbtp: -1,
        metrics: { integratedLufs: -20, truePeakDbtp: -0.2, samplePeakDbfs: -1 },
        loudnessPassed: false,
        truePeakPassed: false,
        intentionalSilence: false,
        passed: false,
      },
    });
    expect(result.notes.some((item) => item.code === 'soundtrack-loudness-failed' && item.blocking)).toBe(true);
    expect(result.notes.some((item) => item.code === 'soundtrack-true-peak-failed' && item.blocking)).toBe(true);
    expect(result.productionBlocked).toBe(true);
  });

  it('blocks captions and portrait compositions outside release-safe areas', () => {
    const shots = actionScene({
      stage: [{ type: 'move', actor: 'alice', to: { mark: 'SR' } }],
      unsupported: [],
    });
    const captions = evaluatePublishingSafety([{
      id: 'line-long', speaker: 'alice',
      text: Array.from({ length: 19 }, () => 'word').join(' '),
      startMs: 0, endMs: 1_000,
    }]);
    const result = evaluateProductionPreflight({
      ...input(shots),
      publishingSafety: {
        ...captions,
        ok: false,
        portrait: {
          status: 'fail', actionSafeInset: 0.08, checkedFrames: 12,
          violations: [{
            frame: 8, actor: 'alice', reason: 'subject-outside-action-safe', xFraction: 0.97,
          }],
        },
      },
    });
    expect(result.notes.some((item) => item.code === 'caption-safe-area-failed' && item.blocking)).toBe(true);
    expect(result.notes.some((item) => item.code === 'portrait-safe-area-failed' && item.blocking)).toBe(true);
  });
});
