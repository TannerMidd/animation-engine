import fs from 'node:fs/promises';
import { atomicWriteFile } from '../audio/files.ts';
import type { ProductionPreflightNote, ProductionPreflightReport } from './preflight.ts';

/**
 * The draft-render policy, shared by the CLI and the server.
 *
 * A draft is an explicit distribution-status choice, not merely a console
 * flag: the production gate is bypassed for diagnostics only, and the bundle
 * is labeled so downstream tooling cannot mistake it for approved output.
 */

export function blockingPreflightNotes(report: ProductionPreflightReport): ProductionPreflightNote[] {
  return report.notes.filter((note) => note.blocking);
}

/** Both surfaces follow the same production policy: blocked unless explicitly drafting. */
export function productionRenderBlocked(report: ProductionPreflightReport, draft: boolean): boolean {
  return report.renderEndpointBlocked && !draft;
}

/**
 * Preserve the canonical publishing manifest and add a conspicuous
 * machine-readable label so downstream tooling cannot mistake this bundle for
 * an approved production render.
 */
export async function markExportManifestDraft(
  manifestFile: string,
  report: ProductionPreflightReport,
): Promise<void> {
  const parsed = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`cannot label non-object export manifest ${manifestFile} as draft`);
  }
  const blockers = blockingPreflightNotes(report);
  const warnings = report.notes.filter((note) => note.level === 'warn');
  const manifest = {
    ...parsed,
    productionStatus: {
      state: 'draft',
      productionReady: false,
      draftOverride: true,
      preflightPolicy: report.policy.id,
      preflightPassed: !report.renderEndpointBlocked,
      blockers: blockers.map(({ code, message }) => ({ code, message })),
      warnings: warnings.map(({ code, message }) => ({ code, message })),
      note: 'Created by an explicit draft render. This bundle is not approved for production distribution.',
    },
  };
  await atomicWriteFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}
