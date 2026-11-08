// What backs a dialect's policy value (T1.7, CLAUDE.md non-negotiable 2). Every leaf of a dialect's
// resolved policy has exactly one piece of evidence, from the claim for its path or for the
// nearest group above it (`claims/<slice>.ts`). `policy-truth.test.ts` checks each against the
// committed goldens and the corpora; no runner starts.
import type { FixtureRunner } from '../fixture.ts'
import type { Golden } from '../golden.ts'

/**
 * A value read from a golden recorded from the real runner: by default the `observe` line whose id
 * is the leaf's path (or `case`), else what `read` takes from the golden (a black-box run's
 * `observed`, a test's error). The value must equal the dialect's, and every flip of it must not.
 */
export interface GoldenEvidence {
  readonly kind: 'golden'
  /** The fixture id, `policy/core-test-fn`. */
  readonly fixture: string
  /** The `observe` id, when it isn't the leaf's path. */
  readonly case?: string
  /** Takes the value from the golden, instead of an `observe` line. */
  readonly read?: (golden: Golden) => unknown
  /**
   * Whether the golden shows this candidate value, for a value no reader can take out whole (a
   * message template the golden shows filled in): the dialect's value must match, no flip may.
   */
  readonly matches?: (golden: Golden, value: unknown) => boolean
}

/** A corpus whose check runs Provino's engine against the goldens, so a wrong value fails there. */
export type CorpusName = 'runtime' | 'mock' | 'mod' | 'hoist'

/**
 * A value a corpus check holds to its goldens. `policy-truth.test.ts` flips it and runs the named
 * fixtures through the engine (runtime, mock, mod), and the flipped run must disagree with a golden
 * where the real value agrees. For `hoist`, the hoist corpus's own flips do it
 * (`hoist-corpus.test.ts` has one per key, or a reason it can't).
 */
export interface CorpusEvidence {
  readonly kind: 'corpus'
  readonly corpus: CorpusName
  /** The fixture ids whose run a flip must change; empty for `hoist`. */
  readonly fixtures: readonly string[]
}

/**
 * Provino's own key, not a Jest or Vitest value (D7 lets the dialect choose): it needs a test, not
 * ground truth. The test file must exist and name the key.
 */
export interface OwnEvidence {
  readonly kind: 'own'
  /** A test file, relative to the repo root, that pins the value. */
  readonly test: string
  /** The word the test file must contain (the key's own name). */
  readonly mentions: string
  readonly reason: string
}

/**
 * A value nothing reads under this dialect, because another key, itself backed, switches its
 * consumer off (`expect.pollFailsOnTimeout` with `expect.poll.enabled: false`). No run can show it.
 */
export interface InertEvidence {
  readonly kind: 'inert'
  /** The leaf that switches it off. */
  readonly under: string
  /** That leaf's value under this dialect. */
  readonly when: unknown
  readonly reason: string
}

/** A value whose behaviour isn't built yet, with the bundle that brings it and its evidence. */
export interface PendingEvidence {
  readonly kind: 'pending'
  /** The owner bundle (`B17a`), or the decision that keeps an unobservable value (`D47`). */
  readonly owner: string
  readonly reason: string
}

/** One piece of evidence. */
export type Evidence =
  | GoldenEvidence
  | CorpusEvidence
  | OwnEvidence
  | InertEvidence
  | PendingEvidence

/**
 * The evidence for one dialect's value: one piece, or several that each agree with the value and
 * between them reject every flip (a corpus that catches some flips and a golden for the rest).
 */
export type DialectEvidence = Evidence | readonly Evidence[]

/** The evidence for a path: shared by both dialects, or one each. */
export type Claim = DialectEvidence | Readonly<Record<FixtureRunner, DialectEvidence>>

/** The claims of one slice (or of the hoisting rules), by leaf or group path. */
export type Claims = Readonly<Record<string, Claim>>

function isPerDialect(claim: Claim): claim is Readonly<Record<FixtureRunner, DialectEvidence>> {
  return !Array.isArray(claim) && !('kind' in claim)
}

/** The evidence a claim gives one dialect, as a list. */
export function evidenceFor(claim: Claim, runner: FixtureRunner): readonly Evidence[] {
  const evidence = isPerDialect(claim) ? claim[runner] : claim
  return Array.isArray(evidence) ? evidence : [evidence as Evidence]
}

/**
 * A golden claim: the `observe` line whose id is the leaf's path, or what `read` takes from the
 * golden. A bare name is a fixture under `fixtures/policy/`; an id with a `/` names any fixture.
 */
export function golden(
  fixture: string,
  options: {
    readonly case?: string
    readonly read?: (golden: Golden) => unknown
    readonly matches?: (golden: Golden, value: unknown) => boolean
  } = {},
): GoldenEvidence {
  return {
    kind: 'golden',
    fixture: fixture.includes('/') ? fixture : `policy/${fixture}`,
    ...options,
  }
}

/** A corpus claim: flipping the value changes the run of one of these fixtures. */
export function corpus(name: CorpusName, ...fixtures: readonly string[]): CorpusEvidence {
  return { kind: 'corpus', corpus: name, fixtures }
}

/** Our own key, pinned by a test that names it. */
export function own(test: string, mentions: string, reason: string): OwnEvidence {
  return { kind: 'own', test, mentions, reason }
}

/** A value nothing reads while `under` has the value `when`. */
export function inert(under: string, when: unknown, reason: string): InertEvidence {
  return { kind: 'inert', under, when, reason }
}

/** A value whose behaviour another bundle builds. */
export function pending(owner: string, reason: string): PendingEvidence {
  return { kind: 'pending', owner, reason }
}

/** One claim for each dialect. */
export function each(
  jest: DialectEvidence,
  vitest: DialectEvidence,
): Readonly<Record<FixtureRunner, DialectEvidence>> {
  return { jest, vitest }
}
