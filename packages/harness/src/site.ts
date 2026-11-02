// The site data contract (Track 12 §Types): what `provino-site` reads. `./site` is a separate
// entry so the site never pulls in the converters or the recorder.
import type { RunRef } from '@provino/types'

export type {
  BenchLabel,
  BenchRecord,
  BenchResult,
  BenchSubject,
  IsolationMode,
  RunRef,
  WallStats,
} from '@provino/types'

/**
 * How well Provino supports one API row. Derived from `ApiRow.tests`, never typed by hand.
 * @public
 */
export type ApiSupport = 'supported' | 'partial' | 'missing' | 'not-planned'

/**
 * One row of the API coverage table: a Jest or Vitest API and the tests that show Provino's
 * support for it.
 * @public
 */
export interface ApiRow {
  /** `jest.fn`, `vi.mock`, `expect.toMatchSnapshot`, `config.testEnvironment`, `cli.--shard`. */
  readonly id: string
  readonly dialect: 'jest' | 'vitest'
  readonly kind:
    | 'global'
    | 'jest-object'
    | 'vi-object'
    | 'matcher'
    | 'asymmetric'
    | 'config'
    | 'cli'
    | 'type'
  /** Where the API is declared, e.g. `@jest/environment/build/index.d.ts#Jest`. */
  readonly source: string
  /** Derived from `tests`, never typed by hand. */
  readonly support: ApiSupport
  readonly tests: readonly {
    readonly file: string
    readonly name: string
    readonly status: 'passed' | 'failed'
  }[]
  readonly divergences: readonly string[]
  readonly note?: string
}

/**
 * The headline parity numbers for one suite and dialect.
 * @public
 */
export interface ParitySummary {
  readonly suite: string
  readonly dialect: 'jest' | 'vitest'
  readonly referenceVersion: string
  readonly statusParity: number
  readonly messageParity: number
  readonly snapshotByteParity: number
  readonly referenceTests: number
  readonly comparedTests: number
  readonly excluded: number
  readonly failingDiffs: number
  /** The path of the full diff report. */
  readonly diffFile: string
}

/**
 * The site's table of contents: for each commit, where its bench, parity and API files are.
 * @public
 */
export interface SiteIndex {
  readonly schemaVersion: 1
  readonly generatedAt: string
  readonly refs: readonly {
    readonly ref: RunRef
    readonly bench?: string
    readonly parity?: string
    readonly api?: string
  }[]
}
