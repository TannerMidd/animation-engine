import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { markExportManifestDraft, productionRenderBlocked } from '../src/cli/index.ts';
import {
  PRODUCTION_PREFLIGHT_POLICY,
  type ProductionPreflightReport,
} from '../src/pipeline/preflight.ts';
import { tempDir } from './helpers.ts';

function report(blocked: boolean): ProductionPreflightReport {
  return {
    ok: !blocked,
    productionBlocked: blocked,
    renderEndpointBlocked: blocked,
    policy: PRODUCTION_PREFLIGHT_POLICY,
    notes: blocked
      ? [{
          code: 'dialogue-unapproved',
          level: 'error',
          blocking: true,
          message: 'one cue is not approved',
        }]
      : [{
          code: 'identity-drift',
          level: 'warn',
          blocking: false,
          message: 'review the active identity',
        }],
  };
}

describe('CLI production render gate', () => {
  it('blocks production renders but permits an explicit draft override', () => {
    const blocked = report(true);
    expect(productionRenderBlocked(blocked, false)).toBe(true);
    expect(productionRenderBlocked(blocked, true)).toBe(false);
    expect(productionRenderBlocked(report(false), false)).toBe(false);
  });

  it('marks the export manifest as non-production and retains preflight findings', async () => {
    const dir = await tempDir('cli-draft-manifest');
    try {
      const file = path.join(dir, 'scene.export.json');
      await fs.writeFile(file, JSON.stringify({ schemaVersion: 2, scene: 'scene', approvals: {} }));

      await markExportManifestDraft(file, report(true));

      const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as {
        scene: string;
        productionStatus: {
          state: string;
          productionReady: boolean;
          draftOverride: boolean;
          preflightPassed: boolean;
          blockers: Array<{ code: string; message: string }>;
        };
      };
      expect(manifest.scene).toBe('scene');
      expect(manifest.productionStatus).toMatchObject({
        state: 'draft',
        productionReady: false,
        draftOverride: true,
        preflightPassed: false,
      });
      expect(manifest.productionStatus.blockers).toEqual([{
        code: 'dialogue-unapproved',
        message: 'one cue is not approved',
      }]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
