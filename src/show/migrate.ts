import fs from 'node:fs/promises';
import { SHOW_DIR } from '../core/paths.ts';
import { DEFAULT_IDENTITY, stampOf, type ShowIdentity } from '../schema/identity.ts';
import { listRigs, loadRig, saveRig } from '../cast/store.ts';
import { rollLook } from '../cast/look.ts';
import { listSets, loadSet, saveSet } from '../sets/index.ts';
import { listScenes, readShotList, writeShotList } from '../pipeline/scene.ts';
import { activeProfileId, saveProfile, setActiveProfileId, loadProfile } from './store.ts';

/**
 * Bring a pre-identity project under an identity profile, without changing it.
 *
 * The rule is selective backfill: anything the project already expresses —
 * a stored look, a chosen voice, tuned idle motion — is kept exactly; only
 * genuinely missing identity plumbing is added. Nothing here is a creative
 * decision, and a migrated project renders byte-for-byte like it did before.
 *
 * The one subtle choice is `charId`. New characters get random ids; migrated
 * characters get **their current name** as the id. Ids only need to be stable,
 * not pretty — and using the name freezes every seed stream at its current
 * value, so blink phases and future rerolls stay exactly where they were. From
 * that moment on the name is a label: renaming the character later changes
 * nothing, which is the whole point.
 */

export interface MigrationChange {
  kind: 'profile' | 'rig' | 'set' | 'shotlist';
  target: string;
  actions: string[];
}

export interface MigrationPlan {
  identity: ShowIdentity;
  createProfile: boolean;
  changes: MigrationChange[];
}

export async function planMigration(): Promise<MigrationPlan> {
  const activeId = await activeProfileId();
  const identity = activeId ? await loadProfile(activeId) : DEFAULT_IDENTITY;
  const stamp = stampOf(identity);
  const changes: MigrationChange[] = [];

  const createProfile = !activeId;
  if (createProfile) {
    changes.push({
      kind: 'profile',
      target: `${identity.id} v${identity.version}`,
      actions: [`write show/${identity.id}.identity.json and point show/show.json at it`],
    });
  }

  for (const name of await listRigs()) {
    const { rig } = await loadRig(name);
    const actions: string[] = [];
    if (!rig.charId) actions.push(`assign charId "${name}" (current name, so every existing seed stays put)`);
    if (!rig.look) actions.push('materialise the name-rolled look into the file');
    if (!rig.identity || rig.identity.hash !== stamp.hash) actions.push(`stamp identity ${stamp.id}@${stamp.hash}`);
    if (actions.length) changes.push({ kind: 'rig', target: name, actions });
  }

  for (const name of await listSets()) {
    const desc = await loadSet(name);
    const actions: string[] = [];
    if (!desc.setId) actions.push(`assign setId "${name}"`);
    if (!desc.identity || desc.identity.hash !== stamp.hash) actions.push(`stamp identity ${stamp.id}@${stamp.hash}`);
    if (actions.length) changes.push({ kind: 'set', target: name, actions });
  }

  for (const scene of await listScenes()) {
    const shots = await readShotList(scene).catch(() => null);
    if (!shots) continue;
    if (!shots.identity || shots.identity.hash !== stamp.hash) {
      changes.push({ kind: 'shotlist', target: scene, actions: [`stamp identity ${stamp.id}@${stamp.hash}`] });
    }
  }

  return { identity, createProfile, changes };
}

export async function applyMigration(plan: MigrationPlan): Promise<void> {
  const stamp = stampOf(plan.identity);

  if (plan.createProfile) {
    await fs.mkdir(SHOW_DIR, { recursive: true });
    await saveProfile(plan.identity);
    await setActiveProfileId(plan.identity.id);
  }

  for (const change of plan.changes) {
    if (change.kind === 'rig') {
      const { rig, svg } = await loadRig(change.target);
      rig.charId ??= change.target;
      rig.look ??= rollLook(change.target);
      rig.identity = stamp;
      await saveRig(rig, svg);
    } else if (change.kind === 'set') {
      const desc = await loadSet(change.target);
      desc.setId ??= change.target;
      desc.identity = stamp;
      await saveSet(desc);
    } else if (change.kind === 'shotlist') {
      const shots = await readShotList(change.target).catch(() => null);
      if (!shots) continue;
      shots.identity = stamp;
      await writeShotList(change.target, shots);
    }
  }
}
