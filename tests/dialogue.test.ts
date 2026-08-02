import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DIALOGUE_SCHEMA_VERSION,
  DialogueDocument,
  DurationPolicy,
} from '../src/schema/dialogue.ts';
import {
  assessSceneRunSegment,
  createDialogueDocument,
  dialoguePath,
  readDialogueDocument,
  revokeVoiceConsent,
  updateDialogueDocument,
  writeDialogueDocument,
} from '../src/pipeline/dialogue.ts';
import { tempDir } from './helpers.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function audio(file: string, checksum: string) {
  return {
    file,
    checksum,
    byteLength: 48_044,
    mediaType: 'audio/wav',
    sampleRate: 24_000,
    channels: 1,
    sampleCount: 24_000,
    durationMs: 1_000,
  };
}

function completeDocument() {
  return DialogueDocument.parse({
    schemaVersion: DIALOGUE_SCHEMA_VERSION,
    scene: 'test-scene',
    revision: 1,
    fps: 24,
    scriptHash: HASH_C,
    recordedTakes: [
      {
        id: 'take-001',
        cueId: 'cue-001',
        speaker: 'paul',
        displayText: 'For what.',
        spokenText: 'For what?',
        scriptTextHash: HASH_C,
        audio: audio('takes/take-001.wav', HASH_A),
        capture: {
          mode: 'line-booth',
          recordedAt: '2026-08-02T18:00:00.000Z',
          performerId: 'performer-1',
          inputDevice: 'interface-1',
          latencyCompensationMs: -37,
          countInMs: 1_000,
          consentId: 'consent-1',
        },
      },
    ],
    voiceRenders: [
      {
        id: 'render-001',
        source: {
          kind: 'voice-conversion',
          takeId: 'take-001',
          targetVoiceId: 'paul-production',
          targetReferenceChecksum: HASH_B,
          consentId: 'consent-1',
          registerPolicy: 'adapt-to-character',
        },
        state: 'ready',
        audio: audio('renders/render-001.wav', HASH_B),
        model: {
          engine: 'chatterbox-vc',
          model: 'chatterbox',
          revision: '0.1.7',
          settings: { exaggeration: 0.4 },
          generatedAt: '2026-08-02T18:01:00.000Z',
        },
        durationPolicy: { mode: 'follow-performance' },
        alignment: {
          sourceToOutput: [
            { sourceMs: 0, outputMs: 0 },
            { sourceMs: 1_000, outputMs: 1_000 },
          ],
          words: [{ text: 'For', startMs: 100, endMs: 400, confidence: 0.99 }],
        },
        quality: { verdict: 'pass', transcriptMatch: 1, stretchRatio: 1 },
      },
    ],
    cues: [
      {
        id: 'cue-001',
        beatIndex: 4,
        speaker: 'paul',
        displayText: 'For what.',
        spokenText: 'For what?',
        selectedTakeId: 'take-001',
        selectedRenderId: 'render-001',
        seed: 7004,
        delivery: {
          expression: 'CONFUSED',
          intent: 'a real question, finally',
          emphasis: [{ startChar: 4, endChar: 8, level: 'light' }],
          pronunciations: [],
        },
        trim: { inMs: 60, outMs: 960, speechOnsetMs: 100, speechEndMs: 900 },
        startFrame: 48,
        durationFrames: 22,
        pickupMs: 80,
        turnGapMs: 140,
        pauseAfterMs: 300,
        durationPolicy: {
          mode: 'follow-performance',
          downstream: 'ripple',
        },
        approval: {
          state: 'approved',
          by: 'creator',
          at: '2026-08-02T18:02:00.000Z',
        },
        locked: true,
        provenance: { origin: 'recorded', revision: 1 },
      },
    ],
  });
}

describe('dialogue document schema', () => {
  it('keeps immutable source, derived render, and editable cue distinct', () => {
    const doc = completeDocument();
    expect(doc.recordedTakes[0]!.audio.file).toBe('takes/take-001.wav');
    expect(doc.voiceRenders[0]!.source).toMatchObject({
      kind: 'voice-conversion',
      takeId: 'take-001',
    });
    expect(doc.cues[0]!.selectedTakeId).toBe('take-001');
    expect(doc.cues[0]!.selectedRenderId).toBe('render-001');
    expect(doc.cues[0]!.displayText).toBe('For what.');
    expect(doc.cues[0]!.spokenText).toBe('For what?');
  });

  it('requires an exact window for picture-locked timing policies', () => {
    expect(() => DurationPolicy.parse({ mode: 'fit-locked-window' }))
      .toThrow(/exact target frame count/);
    expect(DurationPolicy.parse({ mode: 'fit-locked-window', targetFrames: 24 }).targetFrames)
      .toBe(24);
  });

  it('rejects approval without a selected, reviewed asset', () => {
    const doc = completeDocument();
    expect(() => DialogueDocument.parse({
      ...doc,
      cues: [{
        ...doc.cues[0]!,
        selectedTakeId: null,
        selectedRenderId: null,
        trim: null,
      }],
    })).toThrow(/approved cue needs/);
  });

  it('rejects trim handles outside the selected asset', () => {
    const doc = completeDocument();
    expect(() => DialogueDocument.parse({
      ...doc,
      cues: [{
        ...doc.cues[0]!,
        trim: { inMs: 60, outMs: 1_100, speechOnsetMs: 100, speechEndMs: 1_000 },
      }],
    })).toThrow(/trim exceeds selected asset duration/);
  });

  it('keeps draft or quality-rejected synthesis out of production approval', () => {
    const doc = completeDocument();
    const draftRender = {
      ...doc.voiceRenders[0]!,
      source: {
        kind: 'draft-tts' as const,
        seed: 4,
        voiceId: 'paul-draft',
        referenceChecksum: null,
      },
    };
    expect(() => DialogueDocument.parse({
      ...doc,
      recordedTakes: [],
      voiceRenders: [draftRender],
      cues: [{ ...doc.cues[0]!, selectedTakeId: null }],
    })).toThrow(/draft TTS.*cannot be approved/);

    expect(() => DialogueDocument.parse({
      ...doc,
      voiceRenders: [{
        ...doc.voiceRenders[0]!,
        quality: { ...doc.voiceRenders[0]!.quality, verdict: 'reject' },
      }],
    })).toThrow(/quality-rejected render cannot be approved/);
  });
});

describe('dialogue scene persistence', () => {
  it('round-trips beside scene outputs and advances revisions through updates', async () => {
    const outDir = await tempDir('dialogue-store');
    const complete = completeDocument();
    const doc = DialogueDocument.parse({
      ...complete,
      cues: [{ ...complete.cues[0]!, locked: false }],
    });
    const file = await writeDialogueDocument(doc.scene, doc, outDir);

    expect(file).toBe(dialoguePath('test-scene', outDir));
    expect(JSON.parse(await fs.readFile(file, 'utf8')).schemaVersion).toBe(1);
    expect(await readDialogueDocument('test-scene', outDir)).toEqual(doc);

    const updated = await updateDialogueDocument('test-scene', (current) => ({
      ...current,
      cues: [{ ...current.cues[0]!, pauseAfterMs: 450 }],
    }), outDir);
    expect(updated.revision).toBe(2);
    expect(updated.cues[0]!.pauseAfterMs).toBe(450);
  });

  it('creates an empty, versioned document for a new scene', () => {
    expect(createDialogueDocument('new-scene', 30)).toMatchObject({
      schemaVersion: 1,
      scene: 'new-scene',
      revision: 1,
      fps: 30,
      recordedTakes: [],
      voiceRenders: [],
      cues: [],
    });
  });

  it('refuses to mutate or remove an existing raw take', async () => {
    const outDir = await tempDir('dialogue-immutable');
    const doc = completeDocument();
    await writeDialogueDocument(doc.scene, doc, outDir);

    const changed = DialogueDocument.parse({
      ...doc,
      revision: 2,
      recordedTakes: [{
        ...doc.recordedTakes[0]!,
        provenance: { ...doc.recordedTakes[0]!.provenance, notes: ['rewritten after capture'] },
      }],
    });
    await expect(writeDialogueDocument(doc.scene, changed, outDir))
      .rejects.toThrow(/immutable recorded take "take-001" cannot be changed/);

    const removed = DialogueDocument.parse({
      ...doc,
      revision: 2,
      recordedTakes: [],
      voiceRenders: [],
      cues: [],
    });
    await expect(writeDialogueDocument(doc.scene, removed, outDir))
      .rejects.toThrow(/immutable recorded take "take-001" cannot be removed/);
  });

  it('keeps consent and derived render audit records append-only', async () => {
    const outDir = await tempDir('dialogue-audit-immutable');
    const base = completeDocument();
    const consent = {
      id: 'consent-1',
      subject: 'Performer One',
      basis: 'performer-contract' as const,
      scope: 'both' as const,
      referenceChecksum: HASH_B,
      permits: { voiceConversion: true, distribution: true, training: false },
      createdAt: '2026-08-02T18:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
      notes: ['signed release on file'],
    };
    const doc = DialogueDocument.parse({ ...base, consents: [consent] });
    await writeDialogueDocument(doc.scene, doc, outDir);

    await expect(writeDialogueDocument(doc.scene, DialogueDocument.parse({
      ...doc,
      revision: 2,
      consents: [{ ...consent, subject: 'Rewritten subject' }],
    }), outDir)).rejects.toThrow(/immutable consent record "consent-1" cannot be changed/);

    await expect(writeDialogueDocument(doc.scene, DialogueDocument.parse({
      ...doc,
      revision: 2,
      consents: [{ ...consent, revokedAt: '2026-08-02T19:00:00.000Z' }],
    }), outDir)).rejects.toThrow(/dedicated revocation operation/);

    await expect(writeDialogueDocument(doc.scene, DialogueDocument.parse({
      ...doc,
      revision: 2,
      consents: [],
    }), outDir)).rejects.toThrow(/immutable consent record "consent-1" cannot be removed/);

    await expect(writeDialogueDocument(doc.scene, DialogueDocument.parse({
      ...doc,
      revision: 2,
      voiceRenders: [{
        ...doc.voiceRenders[0]!,
        model: { ...doc.voiceRenders[0]!.model, revision: 'silently-replaced' },
      }],
    }), outDir)).rejects.toThrow(/immutable voice render "render-001" cannot be changed/);

    await expect(writeDialogueDocument(doc.scene, DialogueDocument.parse({
      ...doc,
      revision: 2,
      voiceRenders: [],
      cues: [{ ...doc.cues[0]!, selectedRenderId: null }],
    }), outDir)).rejects.toThrow(/immutable voice render "render-001" cannot be removed/);
  });

  it('revokes consent once through the dedicated operation without rewriting history', async () => {
    const outDir = await tempDir('dialogue-consent-revoke');
    const consent = {
      id: 'consent-1',
      subject: 'Performer One',
      basis: 'performer-contract' as const,
      scope: 'both' as const,
      referenceChecksum: HASH_B,
      permits: { voiceConversion: true, distribution: true, training: false },
      createdAt: '2026-08-02T18:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
      notes: [],
    };
    const doc = DialogueDocument.parse({ ...completeDocument(), consents: [consent] });
    await writeDialogueDocument(doc.scene, doc, outDir);

    const revokedAt = '2026-08-02T19:00:00.000Z';
    const revoked = await revokeVoiceConsent(doc.scene, consent.id, revokedAt, outDir);
    expect(revoked.revision).toBe(2);
    expect(revoked.consents[0]!.revokedAt).toBe(revokedAt);

    const repeated = await revokeVoiceConsent(
      doc.scene,
      consent.id,
      '2026-08-02T20:00:00.000Z',
      outDir,
    );
    expect(repeated.revision).toBe(2);
    expect(repeated.consents[0]!.revokedAt).toBe(revokedAt);

    await expect(writeDialogueDocument(doc.scene, DialogueDocument.parse({
      ...revoked,
      revision: 3,
      consents: [{ ...revoked.consents[0]!, revokedAt: null }],
    }), outDir)).rejects.toThrow(/immutable consent record/);
  });

  it('rejects a document stored under the wrong scene', async () => {
    const outDir = await tempDir('dialogue-scene');
    const doc = completeDocument();
    await fs.mkdir(path.dirname(dialoguePath('other-scene', outDir)), { recursive: true });
    await fs.writeFile(dialoguePath('other-scene', outDir), `${JSON.stringify(doc)}\n`, 'utf8');
    await expect(readDialogueDocument('other-scene', outDir)).rejects.toThrow(/belongs to scene/);
  });
});

describe('Scene Run segment capture quality', () => {
  it('measures the exact slice and rejects silent or unusably short segments', () => {
    const sampleRate = 1_000;
    const samples = new Int16Array(1_000);
    samples.fill(5_000, 200, 700);

    const performed = assessSceneRunSegment(samples, sampleRate, 1, 150, 750);
    expect(performed.verdict).toBe('pass');
    expect(performed.speechRatio).toBeCloseTo(5 / 6, 3);
    expect(performed.peakDb).toBeLessThan(-10);

    const silent = assessSceneRunSegment(samples, sampleRate, 1, 750, 1_000);
    expect(silent.verdict).toBe('reject');
    expect(silent.flags.join(' ')).toMatch(/no reliable detected speech/i);

    const tooShort = assessSceneRunSegment(samples, sampleRate, 1, 200, 300);
    expect(tooShort.verdict).toBe('reject');
    expect(tooShort.flags.join(' ')).toMatch(/too short/i);
  });
});
