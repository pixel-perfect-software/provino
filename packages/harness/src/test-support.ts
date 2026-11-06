// Builders shared by the unit tests. Not a test file: the test glob is `src/**/*.test.ts`.
import type {
  NormalizedFile,
  NormalizedRun,
  NormalizedTest,
  RunEnvironment,
  TestStatus,
} from '@provino/types'
import type { ConvertOptions } from './convert-options.ts'
import type { Fixture, FixtureProfile } from './fixture.ts'
import { SCHEMA_VERSION } from './schema.ts'

/** A fixture recorded under one of its profiles, named as the recorder names it in its errors. */
export function pairLabel(fixture: Fixture, profile: FixtureProfile): string {
  return `${fixture.id} (${profile})`
}

export const ROOT = '/work/fixture'

export const ENV: RunEnvironment = {
  os: 'linux',
  osRelease: '6.1.0',
  arch: 'x64',
  cpuModel: 'Test CPU',
  cpuCount: 4,
  memoryMb: 8192,
  node: 'v24.0.0',
  runners: {},
  ci: true,
}

export function convertOptions(overrides: Partial<ConvertOptions> = {}): ConvertOptions {
  return {
    rootDir: ROOT,
    suite: 'unit/suite',
    runnerVersion: '1.2.3',
    startedAt: '2026-01-01T00:00:00.000Z',
    env: ENV,
    ...overrides,
  }
}

/** The snapshot totals both runners report, all zero. */
export function snapshotSummary(): {
  added: number
  didUpdate: boolean
  failure: boolean
  filesAdded: number
  filesRemoved: number
  filesRemovedList: string[]
  filesUnmatched: number
  filesUpdated: number
  matched: number
  total: number
  unchecked: number
  uncheckedKeysByFile: []
  unmatched: number
  updated: number
} {
  return {
    added: 0,
    didUpdate: false,
    failure: false,
    filesAdded: 0,
    filesRemoved: 0,
    filesRemovedList: [],
    filesUnmatched: 0,
    filesUpdated: 0,
    matched: 0,
    total: 0,
    unchecked: 0,
    uncheckedKeysByFile: [],
    unmatched: 0,
    updated: 0,
  }
}

interface TestSpec {
  readonly status?: TestStatus
  readonly errors?: NormalizedTest['errors']
  readonly passingAssertions?: number
  readonly console?: NormalizedTest['console']
  readonly dupIndex?: number
}

/** A test `path` in `file`, passing unless the spec says otherwise. */
export function makeTest(
  file: string,
  path: readonly string[],
  spec: TestSpec = {},
): NormalizedTest {
  return {
    id: { file, path, dupIndex: spec.dupIndex ?? 0 },
    status: spec.status ?? 'passed',
    errors: spec.errors ?? [],
    ...(spec.passingAssertions === undefined ? {} : { passingAssertions: spec.passingAssertions }),
    ...(spec.console === undefined ? {} : { console: spec.console }),
  }
}

export function makeFile(
  file: string,
  tests: readonly NormalizedTest[],
  status: NormalizedFile['status'] = tests.some((t) => t.status === 'failed') ? 'failed' : 'passed',
): NormalizedFile {
  return { file, status, tests }
}

export function makeRun(
  files: readonly NormalizedFile[],
  overrides: Partial<NormalizedRun> = {},
): NormalizedRun {
  return {
    schemaVersion: SCHEMA_VERSION,
    runner: 'jest',
    runnerVersion: '30.5.2',
    suite: 'unit/suite',
    startedAt: '2026-01-01T00:00:00.000Z',
    env: ENV,
    files,
    runErrors: [],
    success: true,
    ...overrides,
  }
}
