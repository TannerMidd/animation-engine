import crypto from 'node:crypto';
import {
  canonicalJson,
  type IdentityStamp,
  type ShowIdentity,
} from '../schema/identity.ts';

/** Stable short hash used to bind authored artifacts to a show identity. */
export function identityHash(identity: ShowIdentity): string {
  return crypto.createHash('sha1').update(canonicalJson(identity)).digest('hex').slice(0, 12);
}

export function stampOf(identity: ShowIdentity): IdentityStamp {
  return { id: identity.id, version: identity.version, hash: identityHash(identity) };
}
