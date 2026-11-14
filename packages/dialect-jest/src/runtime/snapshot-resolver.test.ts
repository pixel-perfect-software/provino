// `jestSnapshotResolver` (B23d B1): jest-snapshot 30.5.2's custom resolver checks, held to what
// `buildSnapshotResolver` itself returns and throws for the same modules (real jest-snapshot,
// reached through jest-config's install, as the other oracles here are).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { createBehaviourLoader, resolvePolicy } from '@provino/policy'
import { jestPolicy } from '../dialect.ts'
import { jestSnapshotResolver } from './snapshot-resolver.ts'

const fromJestConfig = createRequire(createRequire(import.meta.url).resolve('jest-config'))
const jestSnapshot = createRequire(fromJestConfig.resolve('jest-circus'))('jest-snapshot') as {
  buildSnapshotResolver(
    config: { rootDir: string; snapshotResolver: string },
    localRequire: (path: string) => unknown,
  ): Promise<{
    resolveSnapshotPath(path: string): string
    resolveTestPath(path: string): string
    testPathForConsistencyCheck: string
  }>
}

const inverse = {
  resolveSnapshotPath: (path: string, ext: string) => `${path}${ext}.x`,
  resolveTestPath: (path: string, ext: string) => path.slice(0, -`${ext}.x`.length),
  testPathForConsistencyCheck: 'a/b.test.js',
}

/** What Jest makes of `module`, under a root of its own so its cache never answers. */
let roots = 0
async function jest(module: unknown): Promise<unknown> {
  try {
    const resolver = await jestSnapshot.buildSnapshotResolver(
      { rootDir: join('/jest-oracle', String(roots++)), snapshotResolver: '/resolver.js' },
      () => module,
    )
    return {
      path: resolver.resolveSnapshotPath('t.test.js'),
      test: resolver.testPathForConsistencyCheck,
    }
  } catch (error) {
    return {
      error: `${(error as Error).name}: ${(error as Error).message.replaceAll(/\u001b\[\d+m/g, '')}`,
    }
  }
}

/** What we make of it: the worker hands over what `import()` of a CommonJS module gives. */
function ours(module: unknown): unknown {
  try {
    const resolver = jestSnapshotResolver({ default: module }, '.snap')
    return {
      path: resolver.resolveSnapshotPath('t.test.js'),
      test: resolver.testPathForConsistencyCheck,
    }
  } catch (error) {
    return { error: `${(error as Error).name}: ${(error as Error).message}` }
  }
}

describe('jestSnapshotResolver against jest-snapshot 30.5.2', () => {
  const cases: Record<string, unknown> = {
    'a consistent resolver': inverse,
    'the same as a default export': { default: inverse },
    'Babel`s ESM output': { __esModule: true, default: inverse },
    'one whose functions do not invert': { ...inverse, resolveTestPath: (path: string) => path },
    'one without resolveSnapshotPath': { ...inverse, resolveSnapshotPath: undefined },
    'one without resolveTestPath': { ...inverse, resolveTestPath: 'no' },
    'one without testPathForConsistencyCheck': { ...inverse, testPathForConsistencyCheck: 1 },
    'a module that exports nothing': {},
  }
  for (const [name, module] of Object.entries(cases)) {
    test(name, async () => {
      assert.deepEqual(ours(module), await jest(module))
    })
  }

  test('the policy`s ref loads it', async () => {
    const ref = resolvePolicy(jestPolicy).snapshot.resolverFactory
    assert.ok(ref !== null && typeof ref !== 'function')
    assert.equal(await createBehaviourLoader().load(ref), jestSnapshotResolver)
  })
})
