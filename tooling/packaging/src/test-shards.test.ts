import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'provino'
import { CANARY } from './dogfood.ts'
import { nodeTestArgs } from './node-test.ts'
import {
  bootstrapProblems,
  nodeTestImportProblems,
  SHARD_COUNT,
  SHARD_ONE,
  SPLIT_PACKAGES,
  shardInvocation,
  shardProblems,
} from './test-shards.ts'
import { scratchDir } from './test-support.ts'

const shardOne = [...SPLIT_PACKAGES, ...SHARD_ONE]
const packages = [...shardOne, '@provino/core']

/**
 * Seconds each package's `node --test` summary reported on Node 22.15.0 in one CI run (44796424257,
 * 2026-11-20, the run that put `provino`'s halves in both shards). Packages run side by side, so
 * a duration is contended; a shard's sum is what its job took, at about 2.3 summed seconds per
 * second of wall time in both jobs (1840 s in 814 s, 1121 s in 474 s). A split package lists what
 * each half took, in shard order: Node deals files out by position, so the halves differ. A
 * package not listed weighs nothing here; add it when it is measured.
 */
const WEIGHTS: Readonly<Record<string, number | readonly number[]>> = {
  provino: [801, 366],
  '@provino/harness': 447,
  '@provino/orchestrator': 437,
  '@provino/bench': 133,
  '@provino/dialect-jest': 129,
  '@provino/transform': 124,
  '@provino/reporters': 103,
  'provino-boundaries': 74,
  'provino-packaging': 71,
  '@provino/loader': 58,
  '@provino/lazy': 47,
  '@provino/core': 28,
  '@provino/coverage': 19,
  '@provino/env-shared': 18,
  '@provino/dialect-vitest': 18,
  '@provino/env-jsdom': 16,
  '@provino/mock': 15,
  '@provino/timers': 12,
  '@provino/expect': 11,
  '@provino/config': 8,
  '@provino/snapshot': 8,
  '@provino/policy': 5,
  '@provino/env-node': 5,
  '@provino/resolver': 4,
  '@provino/rpc': 2,
  '@provino/types': 2,
}

/** What each shard should cost in the weights' unit: the packages it runs, its half of a split one. */
function expectedShardCosts(): readonly number[] {
  const weight = (name: string, shard: number): number => {
    const value = WEIGHTS[name] ?? 0
    return typeof value === 'number' ? value : (value[shard] ?? 0)
  }
  return Array.from({ length: SHARD_COUNT }, (_, shard) => {
    const names =
      shard === 0 ? shardOne : Object.keys(WEIGHTS).filter((name) => !SHARD_ONE.includes(name))
    return names.reduce((total, name) => total + weight(name, shard), 0)
  })
}

const NODE_TEST = fileURLToPath(new URL('./node-test.ts', import.meta.url))

/** A directory of seven one-test files, `f1` to `f7`, and the files a run of them reports. */
function probe(): { dir: string; ran: (args: readonly string[], shard?: string) => string[] } {
  const dir = scratchDir('probe')
  for (let index = 1; index <= 7; index += 1) {
    writeFileSync(
      join(dir, `f${index}.test.ts`),
      `import { test } from 'node:test'\ntest('f${index}', () => {})\n`,
    )
  }
  const ran = (args: readonly string[], shard?: string): string[] => {
    // A child inside a test run would report to this run, not to its stdout.
    const { NODE_TEST_CONTEXT: _context, ...rest } = process.env
    const env = { ...rest, PROVINO_TEST_SHARD: shard ?? '' }
    const result = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', env })
    assert.equal(result.status, 0, result.stderr)
    return [...result.stdout.matchAll(/^ok \d+ - (f\d)\b/gm)].map((m) => m[1] ?? '').sort()
  }
  return { dir, ran }
}

describe('test shards', () => {
  test('shard 1 selects its packages, shard 2 the rest, and each gets its half of the split ones', () => {
    assert.deepEqual(shardInvocation(1), {
      filters: shardOne.map((name) => `--filter=${name}`),
      env: { PROVINO_TEST_SHARD: '1/2' },
    })
    assert.deepEqual(shardInvocation(2), {
      filters: SHARD_ONE.map((name) => `--filter=!${name}`),
      env: { PROVINO_TEST_SHARD: '2/2' },
    })
    assert.throws(() => shardInvocation(0), RangeError)
    assert.throws(() => shardInvocation(3), RangeError)
  })

  test('every package in exactly one shard, and a split one in both, is no problem', () => {
    assert.deepEqual(shardProblems(packages, [shardOne, ['provino', '@provino/core']]), [])
  })

  test('a package in no shard, in both, unknown or a split one in one is named', () => {
    assert.deepEqual(shardProblems(packages, [shardOne, ['provino']]), [
      '@provino/core has tests and is in no shard',
    ])
    assert.deepEqual(
      shardProblems(packages, [
        [...shardOne, '@provino/core'],
        ['provino', '@provino/core'],
      ]),
      ['@provino/core is in shards 1 and 2'],
    )
    assert.deepEqual(shardProblems(packages, [shardOne, ['provino', '@provino/core', 'ghost']]), [
      'shard 2 ran ghost, which is not a package with a test script',
    ])
    assert.deepEqual(shardProblems(packages, [shardOne, ['@provino/core']]), [
      'provino is split and must be in every shard; it is in 1',
    ])
  })

  test('a name this file lists that is not a package with tests is named', () => {
    const problems = shardProblems(['@provino/core', ...SHARD_ONE], [[], ['@provino/core']])
    assert.ok(
      problems.includes('test-shards.ts names provino, which is not a package with a test script'),
    )
  })

  test('the measured weights put the two shards within 15% of each other', () => {
    const [one = 0, two = 0] = expectedShardCosts()
    assert.ok(Math.abs(one - two) / Math.max(one, two) < 0.15, `${one} against ${two}`)
  })
})

describe('the file split of a package', () => {
  test('Node ignores --test-shard after the first test pattern, which is why the flag goes first', () => {
    const { ran } = probe()
    assert.equal(ran(['--test', '--test-reporter=tap', '*.test.ts', '--test-shard=1/2']).length, 7)
    assert.equal(ran(['--test', '--test-shard=1/2', '--test-reporter=tap', '*.test.ts']).length, 4)
  })

  test('nodeTestArgs puts the shard before the patterns, and a bad one is refused', () => {
    assert.deepEqual(nodeTestArgs('2/2', ['--conditions=x', 'a']), [
      '--test',
      '--test-shard=2/2',
      '--conditions=x',
      'a',
    ])
    assert.deepEqual(nodeTestArgs(undefined, ['a']), ['--test', 'a'])
    assert.deepEqual(nodeTestArgs('', ['a']), ['--test', 'a'])
    assert.throws(() => nodeTestArgs('1', ['a']), RangeError)
    assert.throws(() => nodeTestArgs('0/2', ['a']), RangeError)
  })

  test('the shards of node-test.ts run disjoint halves that add up to every file', () => {
    const { ran } = probe()
    const args = [NODE_TEST, '--test-reporter=tap', '*.test.ts']
    const all = ran(args)
    const halves = Array.from({ length: SHARD_COUNT }, (_, index) =>
      ran(args, `${index + 1}/${SHARD_COUNT}`),
    )
    assert.equal(all.length, 7)
    assert.deepEqual(halves.flat().sort(), all)
    assert.ok(halves.every((half) => half.length > 0 && half.length < all.length))
  })
})

describe('bootstrapProblems (B27g2)', () => {
  const exists = (): boolean => true
  const pkg = (script: string, expectedScript: string, dir = 'packages/p') => ({
    name: 'p',
    dir,
    script,
    expectedScript,
  })
  const problems = (
    bootstrap: readonly string[],
    packages: readonly ReturnType<typeof pkg>[],
    dirs: readonly string[] = packages.map((one) => one.dir),
    present: (file: string) => boolean = exists,
  ): string => bootstrapProblems(bootstrap, packages, present, dirs).join('\n')

  test('a script that is the expected one is fine', () => {
    assert.equal(problems([CANARY], [pkg('run', 'run')]), '')
  })

  test('a script that differs runs a bootstrap file on both runners or on neither', () => {
    assert.match(
      problems([CANARY], [pkg('run', 'run && node --test a.test.ts')]),
      /test script is "run", expected "run && node --test a\.test\.ts"/,
    )
  })

  test('an entry in an unmigrated package, or one no include glob matches, fails', () => {
    const found = problems(
      [CANARY, 'packages/other/src/a.test.ts', 'packages/p/docs/a.test.ts'],
      [pkg('run', 'run')],
    )
    assert.match(found, /packages\/other\/src\/a\.test\.ts is not in a migrated package/)
    assert.match(found, /packages\/p\/docs\/a\.test\.ts is matched by none of p's include globs/)
    assert.equal(problems([CANARY, 'packages/p/src/a.test.ts'], [pkg('run', 'run')]), '')
  })

  test('the canary is required, and an entry must exist', () => {
    assert.match(
      problems([], [pkg('run', 'run')]),
      /must hold packages\/provino\/test\/bootstrap\/canary\.test\.ts/,
    )
    assert.match(
      problems([CANARY, 'gone.test.ts'], [pkg('run', 'run')], undefined, (file) => file === CANARY),
      /gone\.test\.ts does not exist/,
    )
  })

  test('no migrated package at all fails, and so does a config dir that is not a package', () => {
    assert.match(problems([CANARY], [], []), /no migrated package/)
    assert.match(
      problems([CANARY], [pkg('run', 'run')], ['packages/p', 'packages/broken']),
      /packages\/broken has a provino\.config\.ts but is not a readable workspace package/,
    )
  })

  test('the canary is held to the include globs once its package migrates', () => {
    assert.equal(problems([CANARY], [pkg('run', 'run', 'packages/provino')]), '')
    assert.match(
      problems([CANARY], [pkg('run', 'run && node --test x', 'packages/provino')]),
      /expected "run && node --test x"/,
    )
  })
})

describe('nodeTestImportProblems (B27h3)', () => {
  const TEST = 'packages/p/src/a.test.ts'
  /** The problems for `files` (path to text) when `tests` are the test files Provino runs. */
  const problems = (files: Readonly<Record<string, string>>, tests: readonly string[] = [TEST]) =>
    nodeTestImportProblems(
      tests,
      (file) => files[file],
      (file) => file.startsWith('packages/p/src/'),
    ).join('\n')

  test('a helper that imports node:test and a Provino test that imports the helper fail, by name', () => {
    const found = problems({
      [TEST]: "import { tempDir } from './helper.ts'\n",
      'packages/p/src/helper.ts': "import { after } from 'node:test'\nafter(() => {})\n",
    })
    assert.match(
      found,
      /packages\/p\/src\/helper\.ts imports node:test, and packages\/p\/src\/a\.test\.ts/,
    )
    assert.match(found, /never run in a Provino worker/)
  })

  test('every value form counts: default, namespace, side effect, a named value beside a type, a re-export, import()', () => {
    for (const line of [
      "import test from 'node:test'",
      "import * as nodeTest from 'node:test'",
      "import 'node:test'",
      "import { type TestContext, after } from 'node:test'",
      "export { after } from 'node:test'",
      "export * from 'node:test'",
      "const nodeTest = await import('node:test')",
    ]) {
      const found = problems({
        [TEST]: "import './helper.ts'\n",
        'packages/p/src/helper.ts': `${line}\n`,
      })
      assert.match(found, /helper\.ts imports node:test/, line)
    }
  })

  test('a type import is erased: it loads nothing', () => {
    for (const line of [
      "import type { TestContext } from 'node:test'",
      "import { type TestContext } from 'node:test'",
      "export type { TestContext } from 'node:test'",
    ]) {
      const files = {
        [TEST]: "import './helper.ts'\n",
        'packages/p/src/helper.ts': `${line}\n`,
      }
      assert.equal(problems(files), '', line)
    }
  })

  test('a file only the bootstrap set imports may use node:test', () => {
    // The helper is reached by no Provino test: the bootstrap test that imports it is not in `tests`.
    assert.equal(
      problems({
        [TEST]: "import './other.ts'\n",
        'packages/p/src/other.ts': '',
        'packages/p/src/boot.test.ts': "import './helper.ts'\n",
        'packages/p/src/helper.ts': "import { after } from 'node:test'\n",
      }),
      '',
    )
  })

  test('the file is found through other files, and through a re-export', () => {
    const found = problems({
      [TEST]: "import { b } from './a.ts'\n",
      'packages/p/src/a.ts': "export { b } from './deep/b.ts'\n",
      'packages/p/src/deep/b.ts': "import { describe } from 'node:test'\n",
    })
    assert.match(
      found,
      /packages\/p\/src\/deep\/b\.ts imports node:test, and packages\/p\/src\/a\.test\.ts/,
    )
  })

  test('a Provino test that imports node:test itself fails, and an import cycle ends', () => {
    assert.match(
      problems({ [TEST]: "import { test } from 'node:test'\n" }),
      /packages\/p\/src\/a\.test\.ts is a test file Provino runs and imports node:test/,
    )
    assert.equal(
      problems({
        [TEST]: "import './x.ts'\n",
        'packages/p/src/x.ts': "import './y.ts'\n",
        'packages/p/src/y.ts': "import './x.ts'\n",
      }),
      '',
    )
  })

  test('a string that holds an import is no import, and a file outside the roots is not followed', () => {
    assert.equal(
      problems({
        [TEST]:
          "const text = \"import { test } from 'node:test'\"\nimport '../../q/src/outside.ts'\n",
        'packages/q/src/outside.ts': "import { after } from 'node:test'\n",
      }),
      '',
    )
  })

  test('each file is named once however many tests reach it', () => {
    const found = problems(
      {
        'packages/p/src/a.test.ts': "import './helper.ts'\n",
        'packages/p/src/b.test.ts': "import './helper.ts'\n",
        'packages/p/src/helper.ts': "import { after } from 'node:test'\n",
      },
      ['packages/p/src/a.test.ts', 'packages/p/src/b.test.ts'],
    )
    assert.match(found, /helper\.ts imports node:test/)
    assert.equal(found.split('\n').length, 1)
  })
})
