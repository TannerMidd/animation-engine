import { z } from 'zod';
import { IdentityStamp } from './identity.ts';

/**
 * Dialogue editorial document v1.
 *
 * Raw performances, derived audio, and editorial timing are deliberately
 * separate records:
 *
 *   RecordedTake (immutable evidence) -> VoiceRender (derived asset)
 *                                      -> DialogueCue (editable decision)
 *
 * A creator can therefore replace a conversion, move a pickup, or revert to
 * the original recording without rewriting or deleting the source take.
 */

export const DIALOGUE_SCHEMA_VERSION = 1 as const;

const Id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be a stable ID');
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/i, 'must be a SHA-256 checksum');
const IsoDate = z.string().datetime({ offset: true });
const Ms = z.number().int().nonnegative();

/** Decoded audio facts. Checksums always identify the immutable file bytes. */
export const AudioAsset = z
  .object({
    file: z.string().min(1),
    checksum: Sha256,
    byteLength: z.number().int().positive(),
    mediaType: z.string().min(1).default('audio/wav'),
    sampleRate: z.number().int().positive(),
    channels: z.number().int().min(1).max(8),
    sampleCount: z.number().int().positive(),
    durationMs: z.number().int().positive(),
  })
  .strict()
  .superRefine((asset, ctx) => {
    const decodedMs = (asset.sampleCount / asset.sampleRate) * 1000;
    if (Math.abs(decodedMs - asset.durationMs) > 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationMs'],
        message: `durationMs disagrees with sampleCount/sampleRate (${decodedMs.toFixed(2)} ms)`,
      });
    }
  });
export type AudioAsset = z.infer<typeof AudioAsset>;

export const CaptureMode = z.enum(['line-booth', 'scene-run', 'imported']);
export type CaptureMode = z.infer<typeof CaptureMode>;

export const CaptureQuality = z.object({
  verdict: z.enum(['pass', 'warn', 'reject']),
  peakDb: z.number().nullable(),
  rmsDb: z.number().nullable(),
  speechRatio: z.number().min(0).max(1),
  flags: z.array(z.string()).default([]),
}).strict();
export type CaptureQuality = z.infer<typeof CaptureQuality>;

/** Immutable cue mapping inside one continuous Scene Run recording. */
export const SceneRunSegment = z
  .object({
    cueId: Id,
    scriptTextHash: Sha256,
    inMs: Ms,
    outMs: Ms,
    speechOnsetMs: Ms,
    speechEndMs: Ms,
    /** QC for this exact slice, independent of the enclosing continuous take. */
    quality: CaptureQuality.nullable().default(null),
  })
  .strict()
  .superRefine((segment, ctx) => {
    if (segment.outMs <= segment.inMs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outMs'], message: 'must be after inMs' });
    }
    if (segment.speechOnsetMs < segment.inMs || segment.speechOnsetMs > segment.outMs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['speechOnsetMs'], message: 'must be inside the segment' });
    }
    if (segment.speechEndMs < segment.speechOnsetMs || segment.speechEndMs > segment.outMs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['speechEndMs'], message: 'must follow speechOnsetMs inside the segment' });
    }
  });
export type SceneRunSegment = z.infer<typeof SceneRunSegment>;

/**
 * Metadata for an original recording or imported performance.
 *
 * Persistence treats every field under an existing ID as append-only. A
 * cleanup, segment, conversion, or retime is a VoiceRender, never a mutation
 * of this record or its audio file.
 */
export const RecordedTake = z
  .object({
    id: Id,
    /** Null for an unsegmented Scene Run; line takes name their destination cue. */
    cueId: Id.nullable().default(null),
    speaker: Id,
    displayText: z.string(),
    spokenText: z.string(),
    scriptTextHash: Sha256,
    audio: AudioAsset,
    quality: CaptureQuality.nullable().default(null),
    capture: z
      .object({
        mode: CaptureMode,
        recordedAt: IsoDate,
        performerId: Id.nullable().default(null),
        inputDevice: z.string().nullable().default(null),
        /** Measured correction already applied to preserve the real pickup. */
        latencyCompensationMs: z.number().int().default(0),
        countInMs: Ms.default(0),
        sourceFileName: z.string().nullable().default(null),
        consentId: Id.nullable().default(null),
      })
      .strict(),
    provenance: z
      .object({
        createdBy: z.string().nullable().default(null),
        notes: z.array(z.string()).default([]),
        /** Exact nondestructive cue slices for a continuous Scene Run. */
        sceneRunSegments: z.array(SceneRunSegment).default([]),
      })
      .strict()
      .default({}),
    /**
     * One-way withdrawal. The row stays as audit evidence — bytes, checksums
     * and provenance untouched — but a revoked take leaves every working
     * surface: selections referencing it are cleared by the revocation
     * operation and the UI stops listing it.
     */
    revokedAt: IsoDate.nullable().default(null),
  })
  .strict();
export type RecordedTake = Readonly<z.infer<typeof RecordedTake>>;

export const RegisterPolicy = z.enum(['preserve-performer', 'adapt-to-character']);
export type RegisterPolicy = z.infer<typeof RegisterPolicy>;

/** Rights record for a performer or target voice used in a production scene. */
export const VoiceConsentRecord = z
  .object({
    id: Id,
    subject: z.string().min(1),
    basis: z.enum(['self-owned', 'written-license', 'performer-contract', 'synthetic-owned']),
    scope: z.enum(['target-voice', 'performance', 'both']).default('target-voice'),
    /** Exact target-reference bytes covered by this record. */
    referenceChecksum: Sha256.nullable().default(null),
    permits: z.object({
      voiceConversion: z.boolean().default(true),
      distribution: z.boolean().default(true),
      training: z.boolean().default(false),
    }).strict().default({}),
    createdAt: IsoDate,
    expiresAt: IsoDate.nullable().default(null),
    revokedAt: IsoDate.nullable().default(null),
    notes: z.array(z.string()).default([]),
  })
  .strict();
export type VoiceConsentRecord = Readonly<z.infer<typeof VoiceConsentRecord>>;

export const DurationPolicyMode = z.enum([
  'follow-performance',
  'fit-locked-window',
  'rerecord-to-picture',
]);
export type DurationPolicyMode = z.infer<typeof DurationPolicyMode>;

export const DownstreamRetime = z.enum([
  'ripple',
  'retime-attached-motion',
  'preserve-absolute',
]);
export type DownstreamRetime = z.infer<typeof DownstreamRetime>;

/** Explicit policy; an engine may never silently squeeze a take to fit. */
export const DurationPolicy = z
  .object({
    mode: DurationPolicyMode.default('follow-performance'),
    targetFrames: z.number().int().positive().nullable().default(null),
    warnVoicedStretchRatio: z.number().min(0).max(0.25).default(0.03),
    maxVoicedStretchRatio: z.number().min(0).max(0.25).default(0.05),
    downstream: DownstreamRetime.default('ripple'),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.maxVoicedStretchRatio < policy.warnVoicedStretchRatio) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxVoicedStretchRatio'],
        message: 'maximum stretch must be at least the warning threshold',
      });
    }
    if (policy.mode !== 'follow-performance' && policy.targetFrames === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetFrames'],
        message: `${policy.mode} requires an exact target frame count`,
      });
    }
  });
export type DurationPolicy = z.infer<typeof DurationPolicy>;

const DraftTtsSource = z
  .object({
    kind: z.literal('draft-tts'),
    seed: z.number().int(),
    voiceId: Id.nullable().default(null),
    referenceChecksum: Sha256.nullable().default(null),
  })
  .strict();

const CleanupSource = z
  .object({
    kind: z.literal('cleanup'),
    takeId: Id,
  })
  .strict();

const ConversionSourceTrim = z
  .object({
    inMs: Ms,
    outMs: Ms,
    speechOnsetMs: Ms,
    speechEndMs: Ms,
  })
  .strict()
  .superRefine((trim, ctx) => {
    if (trim.outMs <= trim.inMs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outMs'], message: 'must be after inMs' });
    }
    if (trim.speechOnsetMs < trim.inMs || trim.speechEndMs < trim.speechOnsetMs || trim.speechEndMs > trim.outMs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['speechOnsetMs'], message: 'speech bounds must be inside the source trim' });
    }
  });

const ConversionSource = z
  .object({
    kind: z.literal('voice-conversion'),
    takeId: Id,
    targetVoiceId: Id,
    targetReferenceChecksum: Sha256,
    /** A production conversion must point to the permission record it relied on. */
    consentId: Id,
    registerPolicy: RegisterPolicy.default('adapt-to-character'),
    /** Immutable raw-take slice used for this candidate, independent of UI selection. */
    sourceCueId: Id.nullable().default(null),
    sourceAudioChecksum: Sha256.nullable().default(null),
    sourceTrim: ConversionSourceTrim.nullable().default(null),
  })
  .strict();

export const VoiceRenderSource = z.discriminatedUnion('kind', [
  DraftTtsSource,
  CleanupSource,
  ConversionSource,
]);
export type VoiceRenderSource = z.infer<typeof VoiceRenderSource>;

export const ModelProvenance = z
  .object({
    engine: z.string().min(1),
    model: z.string().min(1),
    revision: z.string().min(1),
    settings: z.record(z.string(), z.unknown()).default({}),
    generatedAt: IsoDate,
  })
  .strict();
export type ModelProvenance = z.infer<typeof ModelProvenance>;

export const TimeMapPoint = z
  .object({ sourceMs: Ms, outputMs: Ms })
  .strict();
export type TimeMapPoint = z.infer<typeof TimeMapPoint>;

export const AlignmentToken = z
  .object({
    text: z.string().min(1),
    startMs: Ms,
    endMs: Ms,
    confidence: z.number().min(0).max(1).nullable().default(null),
  })
  .strict()
  .refine((token) => token.endMs >= token.startMs, {
    path: ['endMs'],
    message: 'must not precede startMs',
  });
export type AlignmentToken = z.infer<typeof AlignmentToken>;

const Alignment = z
  .object({
    sourceToOutput: z.array(TimeMapPoint).default([]),
    words: z.array(AlignmentToken).default([]),
    phonemes: z.array(AlignmentToken).default([]),
  })
  .strict()
  .superRefine((alignment, ctx) => {
    for (let i = 1; i < alignment.sourceToOutput.length; i++) {
      const before = alignment.sourceToOutput[i - 1]!;
      const point = alignment.sourceToOutput[i]!;
      if (point.sourceMs < before.sourceMs || point.outputMs < before.outputMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sourceToOutput', i],
          message: 'time map must be monotonic in source and output time',
        });
      }
    }
  });

export const VoiceQualityReport = z
  .object({
    verdict: z.enum(['pass', 'warn', 'reject']).default('warn'),
    transcriptMatch: z.number().min(0).max(1).nullable().default(null),
    speechRatio: z.number().min(0).max(1).nullable().default(null),
    clippedSampleRatio: z.number().min(0).max(1).nullable().default(null),
    stretchRatio: z.number().positive().nullable().default(null),
    speakerSimilarity: z.number().min(0).max(1).nullable().default(null),
    /** Normalized source/output energy-envelope similarity; cadence proxy, not ASR. */
    cadenceSimilarity: z.number().min(0).max(1).nullable().default(null),
    /**
     * Output voiced-frame share over the source's. Near 1 means the conversion
     * is still speech; well under 1 means it collapsed into noise that a
     * loudness check cannot distinguish from a voice.
     */
    voicedRetention: z.number().min(0).nullable().default(null),
    /** How far the result landed from the target voice's register, in semitones. */
    pitchErrorSemitones: z.number().nullable().default(null),
    flags: z.array(z.string()).default([]),
  })
  .strict()
  .default({});
export type VoiceQualityReport = z.infer<typeof VoiceQualityReport>;

/** A reproducible derivative. Failed attempts remain explicit and unselectable. */
export const VoiceRender = z
  .object({
    id: Id,
    source: VoiceRenderSource,
    state: z.enum(['ready', 'failed', 'stale', 'rejected']),
    audio: AudioAsset.nullable().default(null),
    model: ModelProvenance,
    durationPolicy: DurationPolicy.default({}),
    alignment: Alignment.default({}),
    quality: VoiceQualityReport,
    failure: z.string().nullable().default(null),
  })
  .strict()
  .superRefine((render, ctx) => {
    if (render.state === 'ready' && render.audio === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['audio'], message: 'a ready render needs audio' });
    }
    if (render.state === 'failed' && !render.failure) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['failure'], message: 'a failed render needs a reason' });
    }
  });
export type VoiceRender = z.infer<typeof VoiceRender>;

export const CueTrim = z
  .object({
    /** All values are coordinates in the selected playback asset. */
    inMs: Ms,
    outMs: Ms,
    speechOnsetMs: Ms,
    speechEndMs: Ms,
  })
  .strict()
  .superRefine((trim, ctx) => {
    if (trim.outMs <= trim.inMs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outMs'], message: 'must be after inMs' });
    }
    if (trim.speechOnsetMs < trim.inMs || trim.speechOnsetMs > trim.outMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['speechOnsetMs'],
        message: 'must fall inside the trim handles',
      });
    }
    if (trim.speechEndMs < trim.speechOnsetMs || trim.speechEndMs > trim.outMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['speechEndMs'],
        message: 'must follow speechOnsetMs and fall inside the trim handles',
      });
    }
  });
export type CueTrim = z.infer<typeof CueTrim>;

export const CueOverlap = z
  .object({
    withCueId: Id,
    mode: z.enum(['pickup', 'overlap', 'interruption']),
    ms: z.number().int().positive(),
    /** For interruption, where the interrupted cue is cut; null means it continues underneath. */
    interruptAtMs: Ms.nullable().default(null),
  })
  .strict();
export type CueOverlap = z.infer<typeof CueOverlap>;

const Emphasis = z
  .object({
    startChar: z.number().int().nonnegative(),
    endChar: z.number().int().positive(),
    level: z.enum(['light', 'strong']).default('strong'),
  })
  .strict()
  .refine((item) => item.endChar > item.startChar, {
    path: ['endChar'],
    message: 'must be after startChar',
  });

const Pronunciation = z
  .object({ written: z.string().min(1), spoken: z.string().min(1) })
  .strict();

export const CueDelivery = z
  .object({
    expression: z.string().default('NEUTRAL'),
    intent: z.string().default(''),
    energy: z.number().min(0.1).max(2).default(1),
    pace: z.number().min(0.5).max(2).default(1),
    notes: z.array(z.string()).default([]),
    emphasis: z.array(Emphasis).default([]),
    pronunciations: z.array(Pronunciation).default([]),
  })
  .strict()
  .default({});
export type CueDelivery = z.infer<typeof CueDelivery>;

export const CueApproval = z
  .object({
    state: z.enum(['draft', 'candidate', 'approved', 'rejected', 'stale', 'unresolved']).default('draft'),
    by: z.string().nullable().default(null),
    at: IsoDate.nullable().default(null),
    notes: z.array(z.string()).default([]),
  })
  .strict()
  .default({});
export type CueApproval = z.infer<typeof CueApproval>;

export const CueProvenance = z
  .object({
    origin: z.enum(['generated', 'recorded', 'imported', 'edited', 'migrated']).default('generated'),
    revision: z.number().int().positive().default(1),
    createdBy: z.string().nullable().default(null),
    createdAt: IsoDate.nullable().default(null),
    derivedFromRevision: z.number().int().positive().nullable().default(null),
  })
  .strict()
  .default({});
export type CueProvenance = z.infer<typeof CueProvenance>;

/** The editable production decision for one screenplay line. */
export const DialogueCue = z
  .object({
    id: Id,
    beatIndex: z.number().int().nonnegative(),
    speaker: Id,
    displayText: z.string().min(1),
    /** Engine-facing punctuation/pronunciation; display text remains untouched. */
    spokenText: z.string().min(1),
    selectedTakeId: Id.nullable().default(null),
    selectedRenderId: Id.nullable().default(null),
    /**
     * The creator's voice decision for this line. 'performance' expects a
     * selected take or render; 'generated' is the explicit choice that the
     * character's own seeded synthesis carries the line — approvable and
     * lockable like any performance, so "no recording" can be a decision
     * rather than a gap.
     */
    voiceSource: z.enum(['performance', 'generated']).default('performance'),
    seed: z.number().int().nullable().default(null),
    delivery: CueDelivery,
    trim: CueTrim.nullable().default(null),
    startFrame: z.number().int().nonnegative().default(0),
    durationFrames: z.number().int().positive().nullable().default(null),
    /** Begin this much earlier than the neutral response point. */
    pickupMs: Ms.default(0),
    /** Authored silence after the previous audible speech end. */
    turnGapMs: Ms.default(0),
    pauseAfterMs: Ms.default(0),
    overlap: CueOverlap.nullable().default(null),
    durationPolicy: DurationPolicy.default({}),
    approval: CueApproval,
    /** Full lock; lockedFields supports a selective lock before final approval. */
    locked: z.boolean().default(false),
    lockedFields: z
      .array(z.enum(['selection', 'text', 'delivery', 'trim', 'timing', 'duration-policy']))
      .default([]),
    provenance: CueProvenance,
  })
  .strict()
  .superRefine((cue, ctx) => {
    for (let i = 0; i < cue.delivery.emphasis.length; i++) {
      if (cue.delivery.emphasis[i]!.endChar > cue.spokenText.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['delivery', 'emphasis', i, 'endChar'],
          message: 'falls outside spokenText',
        });
      }
    }
    if (cue.voiceSource === 'generated' && (cue.selectedTakeId !== null || cue.selectedRenderId !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['voiceSource'],
        message: 'a generated-voice cue cannot also select a performance; clear the selection or switch to performance',
      });
    }
    if (cue.approval.state === 'approved' && cue.voiceSource === 'performance') {
      if (cue.selectedTakeId === null && cue.selectedRenderId === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['approval'],
          message: 'an approved cue needs an explicitly selected take or render',
        });
      }
      if (cue.trim === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['trim'],
          message: 'an approved cue needs reviewed trim and speech boundaries',
        });
      }
    }
  });
export type DialogueCue = z.infer<typeof DialogueCue>;

function duplicateIds<T extends { id: string }>(items: T[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) duplicates.add(item.id);
    seen.add(item.id);
  }
  return [...duplicates];
}

export const DialogueDocumentV1 = z
  .object({
    schemaVersion: z.literal(DIALOGUE_SCHEMA_VERSION),
    scene: z.string().min(1).regex(/^[^/\\]+$/, 'scene may not contain path separators'),
    revision: z.number().int().positive().default(1),
    fps: z.number().int().positive().default(24),
    scriptHash: Sha256.nullable().default(null),
    identity: IdentityStamp.optional(),
    consents: z.array(VoiceConsentRecord).default([]),
    recordedTakes: z.array(RecordedTake).default([]),
    voiceRenders: z.array(VoiceRender).default([]),
    cues: z.array(DialogueCue).default([]),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const checkDuplicates = (field: 'consents' | 'recordedTakes' | 'voiceRenders' | 'cues', items: Array<{ id: string }>) => {
      for (const id of duplicateIds(items)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `duplicate ID "${id}"` });
      }
    };
    checkDuplicates('consents', doc.consents);
    checkDuplicates('recordedTakes', doc.recordedTakes);
    checkDuplicates('voiceRenders', doc.voiceRenders);
    checkDuplicates('cues', doc.cues);

    const takes = new Map(doc.recordedTakes.map((take) => [take.id, take]));
    const renders = new Map(doc.voiceRenders.map((render) => [render.id, render]));
    const cues = new Map(doc.cues.map((cue) => [cue.id, cue]));

    for (let i = 0; i < doc.voiceRenders.length; i++) {
      const source = doc.voiceRenders[i]!.source;
      if (source.kind !== 'draft-tts' && !takes.has(source.takeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['voiceRenders', i, 'source', 'takeId'],
          message: `unknown recorded take "${source.takeId}"`,
        });
      }
    }

    for (let i = 0; i < doc.cues.length; i++) {
      const cue = doc.cues[i]!;
      const take = cue.selectedTakeId ? takes.get(cue.selectedTakeId) : undefined;
      const render = cue.selectedRenderId ? renders.get(cue.selectedRenderId) : undefined;

      if (cue.selectedTakeId && !take) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cues', i, 'selectedTakeId'],
          message: `unknown recorded take "${cue.selectedTakeId}"`,
        });
      }
      if (cue.selectedRenderId && !render) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cues', i, 'selectedRenderId'],
          message: `unknown voice render "${cue.selectedRenderId}"`,
        });
      }
      if (take && take.cueId !== null && take.cueId !== cue.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cues', i, 'selectedTakeId'],
          message: `take "${take.id}" belongs to cue "${take.cueId}"`,
        });
      }
      if (take && take.speaker !== cue.speaker) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cues', i, 'selectedTakeId'],
          message: `take "${take.id}" belongs to speaker "${take.speaker}"`,
        });
      }
      if (render && render.source.kind !== 'draft-tts' && cue.selectedTakeId !== render.source.takeId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cues', i, 'selectedTakeId'],
          message: `selected take must be the source of render "${render.id}"`,
        });
      }
      if (cue.approval.state === 'approved' && render && render.state !== 'ready') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cues', i, 'approval'],
          message: `cannot approve a ${render.state} render`,
        });
      }
      if (cue.approval.state === 'approved' && render?.source.kind === 'draft-tts') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cues', i, 'approval'],
          message: 'draft TTS is audition material and cannot be approved for production',
        });
      }
      if (cue.approval.state === 'approved' && render?.quality.verdict === 'reject') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cues', i, 'approval'],
          message: 'a quality-rejected render cannot be approved',
        });
      }
      if (cue.trim) {
        const asset = render?.audio ?? take?.audio;
        if (asset && cue.trim.outMs > asset.durationMs) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['cues', i, 'trim', 'outMs'],
            message: `trim exceeds selected asset duration (${asset.durationMs} ms)`,
          });
        }
      }
      if (cue.overlap) {
        if (cue.overlap.withCueId === cue.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['cues', i, 'overlap', 'withCueId'],
            message: 'a cue cannot overlap itself',
          });
        } else if (!cues.has(cue.overlap.withCueId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['cues', i, 'overlap', 'withCueId'],
            message: `unknown cue "${cue.overlap.withCueId}"`,
          });
        } else if (cues.get(cue.overlap.withCueId)!.beatIndex >= cue.beatIndex) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['cues', i, 'overlap', 'withCueId'],
            message: 'an overlap target must be an earlier dialogue cue',
          });
        }
      }
    }
  });
export type DialogueDocumentV1 = z.infer<typeof DialogueDocumentV1>;

/** Current reader. Future versions get an explicit migration before joining this union. */
export const DialogueDocument = DialogueDocumentV1;
export type DialogueDocument = z.infer<typeof DialogueDocument>;
