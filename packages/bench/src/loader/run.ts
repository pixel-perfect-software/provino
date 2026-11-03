// Runs the Spike A fixture through Provino's loader in this process. Until `provino/node` exists,
// this drives `createLoader` directly: DECISIONS S4 allows a bundle's temporary entry.
import { createLoader } from '@provino/loader'
import { neutralPolicy } from '@provino/policy'
import { createResolver } from '@provino/resolver'
import { createPipeline } from '@provino/transform'
import type { Loader } from '@provino/types'
import { VIOLATION } from './fixture.ts'

/** The loader tiers B06 implements. */
export type LoaderTier = 'none' | 'registry'

/** What one pass over the fixture found. */
export interface FixtureResult {
  readonly passed: number
  readonly failed: number
  readonly violations: number
  /** The first few failures, as `file › test: message`. */
  readonly failures: readonly string[]
  readonly elapsedMs: number
}

export function createFixtureLoader(root: string): Loader {
  return createLoader({
    root,
    engine: 'runner',
    resolver: createResolver({
      root,
      mappers: [],
      extensions: ['.ts', '.js', '.mjs', '.cjs', '.json'],
      tsconfig: false,
    }),
    transformer: createPipeline({
      root,
      typescript: 'oxc',
      tsconfig: false,
      hoist: null,
      cache: false,
    }),
    policy: neutralPolicy.module,
  })
}

interface TestModule {
  readonly tests: ReadonlyArray<readonly [string, () => unknown]>
}

/** Imports every file in its own registry (or the shared one) and runs its tests in order. */
export async function runFixture(
  loader: Loader,
  files: readonly string[],
  tier: LoaderTier,
): Promise<FixtureResult> {
  let passed = 0
  let failed = 0
  let violations = 0
  const failures: string[] = []
  const start = process.hrtime.bigint()
  for (const file of files) {
    const registry = loader.createFileRegistry(file, { tier })
    try {
      const { tests } = await registry.import<TestModule>(file)
      for (const [name, fn] of tests) {
        try {
          await fn()
          passed++
        } catch (error) {
          failed++
          const message = error instanceof Error ? error.message : String(error)
          if (message.startsWith(VIOLATION)) violations++
          if (failures.length < 10) failures.push(`${file} › ${name}: ${message}`)
        }
      }
    } finally {
      registry.dispose()
    }
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
  return { passed, failed, violations, failures, elapsedMs }
}
