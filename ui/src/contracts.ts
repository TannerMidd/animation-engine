import { z } from 'zod';
import { AnimationDocument } from '../../src/schema/animation.ts';
import { DialogueDocument } from '../../src/schema/dialogue.ts';
import { ShotList } from '../../src/schema/script.ts';
import { SetDescriptor } from '../../src/sets/schema.ts';

/** Minimal interface accepted by the API client without coupling it to Zod. */
export interface RuntimeContract<T> {
  parse(value: unknown): T;
}

const SceneSummary = z.object({
  estimateMs: z.number().finite().nonnegative(),
  beatCounts: z.object({
    line: z.number().int().nonnegative(),
    pause: z.number().int().nonnegative(),
    action: z.number().int().nonnegative(),
  }),
});

/** Documents crossing the HTTP boundary are parsed, not merely type asserted. */
export const SceneDetailContract = z.object({
  name: z.string().min(1),
  source: z.string(),
  shots: ShotList.nullable(),
  summary: SceneSummary.nullable(),
  hasAudio: z.boolean(),
  hasVideo: z.boolean(),
  hasVertical: z.boolean().optional(),
  hasExport: z.boolean().optional(),
});

export const DirectProposalContract = z.object({
  proposed: ShotList,
  diff: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      kind: z.string(),
      change: z.string(),
      summary: z.string(),
    }),
  ),
  keptLocked: z.number().int().nonnegative(),
  droppedLocked: z.number().int().nonnegative(),
  errors: z.array(z.string()),
  newCharacters: z.array(z.string()),
});

export const DialogueDocumentContract = DialogueDocument;
export const AnimationDocumentContract = AnimationDocument;
export const SetDescriptorContract = SetDescriptor;
