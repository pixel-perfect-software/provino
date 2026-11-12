// T3.6, Track 3 R5: what a cached record depends on besides the file. `pipelineFingerprint` is the
// part every file shares; the pipeline adds the file's own name, role, options and content (or its
// transformer's cache key) to make an entry's key.
import { hash } from 'node:crypto'
import type { HoistPolicy } from '@provino/types'

/**
 * A stable serialization for fingerprints: object keys sorted, regexps as their source, sets
 * sorted.
 * @internal
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof RegExp) return v.toString()
    if (v instanceof Set) return [...v].map(String).sort()
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
    }
    return v
  })
}

/**
 * SHA-256 over the parts, each ended by a NUL so that `('a', 'bc')` and `('ab', 'c')` differ. The
 * one-shot `crypto.hash` is several times faster than a `Hash` object for a file-sized input.
 * @internal
 */
export function hashParts(parts: readonly string[]): string {
  return hash('sha256', `${parts.join('\0')}\0`)
}

/**
 * Everything about a pipeline besides a file that changes what it produces.
 * @internal
 */
export interface FingerprintInputs {
  /** This package's version and code identity, and the two Oxc packages' versions. */
  readonly versions: {
    readonly transform: string
    /** A hash of this package's own code (`code-identity.ts`): an edit to it misses the cache. */
    readonly code: string
    readonly oxcTransform: string
    readonly oxcParser: string
  }
  readonly typescript: 'oxc' | 'node-strip' | 'off'
  /** `process.version`. Part of the fingerprint only under `node-strip`, where Node does the work. */
  readonly nodeVersion: string
  readonly tsconfig: 'auto' | false | string
  readonly jsx: unknown
  readonly define: unknown
  readonly hoist: HoistPolicy | null
  /** The Jest host's fingerprint (rules, options, ignore patterns, config), or `null`. */
  readonly transformers: string | null
  /**
   * The version of the module-runner form (`RUNNER_FORM_VERSION`) when records carry one, else
   * `null`: a change to how the form is made, or to whether it is kept, misses every entry.
   */
  readonly runnerForm: string | null
}

/**
 * The pipeline fingerprint (R5): versions, TypeScript mode, the Node version when Node strips the
 * types, the options, the hoist policy and the transformer host's setup. Per-file inputs (the
 * resolved tsconfig's emit options, the transformer's own cache key) are the entry key's.
 * @internal
 */
export function pipelineFingerprint(inputs: FingerprintInputs): string {
  return hashParts([
    stableJson({
      transform: inputs.versions.transform,
      code: inputs.versions.code,
      oxcTransform: inputs.versions.oxcTransform,
      oxcParser: inputs.versions.oxcParser,
      typescript: inputs.typescript,
      node: inputs.typescript === 'node-strip' ? inputs.nodeVersion : null,
      tsconfig: inputs.tsconfig,
      jsx: inputs.jsx ?? null,
      define: inputs.define ?? null,
      hoist: inputs.hoist,
      transformers: inputs.transformers,
      runnerForm: inputs.runnerForm,
    }),
  ])
}
