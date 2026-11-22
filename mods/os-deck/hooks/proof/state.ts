// Agent Proof's session state as the controller uses it. The atoms are the hooks module's, which hands
// over these four calls; everything here is pure.
import type { ProofSession, ProofWork } from '../../types'
import { isObject } from './values'

export type ProofOps = {
  proof: () => Promise<ProofSession>
  setProof: (fn: (p: ProofSession) => ProofSession) => Promise<void>
  work: () => Promise<ProofWork>
  setWork: (fn: (w: ProofWork) => ProofWork) => Promise<void>
}

export const EMPTY_PROOF: ProofSession = { session: '', allowed: [], claims: [], attempts: [], reviews: [], past: [], paused: [], openClaim: null, draft: null, notSaved: false }
export const EMPTY_WORK: ProofWork = { session: '', tracking: { open: [], descriptions: [] }, seen: [], turnEnded: false }

const isList = (v: unknown, each: (x: Record<string, unknown>) => boolean) => Array.isArray(v) && v.every(x => isObject(x) && each(x))

/** Whole or empty, never repaired: a state half understood allows nothing and proves nothing. */
export const proofOf = (stored: unknown): ProofSession => {
  if (!isObject(stored) || typeof stored.session !== 'string') return EMPTY_PROOF
  const ok =
    isList(stored.allowed, a => isObject(a.grant) && Array.isArray(a.grant.checks) && Array.isArray(a.watched)) &&
    isList(stored.claims, c => Array.isArray(c.changes) && Array.isArray(c.outside)) &&
    isList(stored.attempts, a => Array.isArray(a.checks)) &&
    isList(stored.reviews, r => Array.isArray(r.revisions)) &&
    isList(stored.past, p => typeof p.root === 'string') &&
    isList(stored.paused, p => Array.isArray(p.paths))
  return ok ? (stored as unknown as ProofSession) : EMPTY_PROOF
}

export const workOf = (stored: unknown): ProofWork => {
  if (!isObject(stored) || typeof stored.session !== 'string' || !isObject(stored.tracking)) return EMPTY_WORK
  const ok = isList(stored.tracking.open, o => Array.isArray(o.start) && Array.isArray(o.editors)) && Array.isArray(stored.tracking.descriptions) && isList(stored.seen, s => Array.isArray(s.files))
  return ok ? (stored as unknown as ProofWork) : EMPTY_WORK
}
