// File arguments on a native project (B28): `provino run <pattern>…` and the bare `provino <pattern>`
// run the files whose path any pattern matches (Jest's `testPathPatterns`: case-insensitive regular
// expressions over the path), through the source bin.
import assert from 'node:assert/strict'
import { describe, test } from 'provino'
import { nativeProject, spawnCli } from './support.ts'

function passingTest(name: string): string {
  return `import { expect, test } from 'provino'\ntest('${name}', () => { expect(1).toBe(1) })\n`
}

function failingTest(name: string): string {
  return `import { expect, test } from 'provino'\ntest('${name}', () => { expect(1).toBe(2) })\n`
}

const FILES: Readonly<Record<string, string>> = {
  'tests/alpha.test.ts': passingTest('alpha'),
  'tests/beta.test.ts': passingTest('beta'),
  'tests/__tests__/a/b.test.ts': passingTest('nested'),
  // Only reached by a pattern that selects it: a run of anything else never fails.
  'tests/gamma.test.ts': failingTest('gamma'),
}

const RUN = ['run', '--config', 'provino.config.mjs', '--maxWorkers', '1', '--reporter', 'verbose']

/** The test files a run named, in sorted order. */
function filesRun(stderr: string): readonly string[] {
  return [
    ...new Set([...stderr.matchAll(/(?:PASS|FAIL) (tests\/\S+\.test\.ts)/g)].map((m) => m[1])),
  ]
    .filter((name): name is string => name !== undefined)
    .sort()
}

describe('file arguments', () => {
  test('one pattern runs the one file it matches', async () => {
    const dir = await nativeProject(FILES)
    const ran = await spawnCli([...RUN, 'alpha'], { cwd: dir })
    assert.equal(ran.code, 0, ran.stderr)
    assert.deepEqual(filesRun(ran.stderr), ['tests/alpha.test.ts'])
  })

  test('two patterns run their union, and a pattern is a case-insensitive regular expression', async () => {
    const dir = await nativeProject(FILES)
    const ran = await spawnCli([...RUN, 'ALPHA', 'be.a\\.test'], { cwd: dir })
    assert.equal(ran.code, 0, ran.stderr)
    assert.deepEqual(filesRun(ran.stderr), ['tests/alpha.test.ts', 'tests/beta.test.ts'])
  })

  test('a path with a directory in it matches as a regular expression', async () => {
    const dir = await nativeProject(FILES)
    const ran = await spawnCli([...RUN, '__tests__/a/b.test.ts'], { cwd: dir })
    assert.equal(ran.code, 0, ran.stderr)
    assert.deepEqual(filesRun(ran.stderr), ['tests/__tests__/a/b.test.ts'])
  })

  test('the bare form takes the same patterns, and a flag may come after one', async () => {
    const dir = await nativeProject(FILES)
    const ran = await spawnCli(['beta', '--maxWorkers', '1', '--reporter', 'verbose'], { cwd: dir })
    assert.equal(ran.code, 0, ran.stderr)
    assert.deepEqual(filesRun(ran.stderr), ['tests/beta.test.ts'])
  })

  test('no match is the no-tests outcome, named, and --passWithNoTests passes it', async () => {
    const dir = await nativeProject(FILES)
    const none = await spawnCli([...RUN, 'nothing-like-this'], { cwd: dir })
    assert.equal(none.code, 1, none.stderr)
    assert.match(none.stderr, /no test file matches the pattern "nothing-like-this"/)

    const passed = await spawnCli([...RUN, 'nothing-like-this', '--passWithNoTests'], { cwd: dir })
    assert.equal(passed.code, 0, passed.stderr)
    assert.match(passed.stderr, /no test file matches the pattern "nothing-like-this"/)
  })

  test('a shard that got no file is not a pattern that matched nothing', async () => {
    const dir = await nativeProject({
      'tests/alpha.test.ts': passingTest('alpha'),
      'tests/beta.test.ts': passingTest('beta'),
    })
    // One shard holds the file the pattern selects and the other none: neither names the pattern.
    for (const shard of ['--shard=1/2', '--shard=2/2']) {
      const ran = await spawnCli([...RUN, shard, 'alpha'], { cwd: dir })
      assert.doesNotMatch(ran.stderr, /no test file matches/, shard)
    }
  })

  test('after -- every argument is a pattern: --bail and --dialect are not flags there', async () => {
    const dir = await nativeProject(FILES)
    const bailed = await spawnCli([...RUN, '--', '--bail', '3'], { cwd: dir })
    assert.equal(bailed.code, 1, bailed.stderr)
    assert.match(bailed.stderr, /no test file matches any of the patterns "--bail", "3"/)
    const bare = await spawnCli(['--maxWorkers', '1', '--', '--dialect', 'jest'], { cwd: dir })
    assert.equal(bare.code, 1, bare.stderr)
    assert.match(bare.stderr, /no test file matches any of the patterns "--dialect", "jest"/)
  })

  test('an invalid regular expression is a usage error, exit 2', async () => {
    const dir = await nativeProject(FILES)
    const ran = await spawnCli([...RUN, '('], { cwd: dir })
    assert.equal(ran.code, 2, ran.stderr)
    assert.match(ran.stderr, /test path pattern "\(" is not a valid regular expression/)
  })

  test('without a pattern every file runs', async () => {
    const dir = await nativeProject(FILES)
    const ran = await spawnCli(RUN, { cwd: dir })
    assert.equal(ran.code, 1, ran.stderr)
    assert.deepEqual(filesRun(ran.stderr), [
      'tests/__tests__/a/b.test.ts',
      'tests/alpha.test.ts',
      'tests/beta.test.ts',
      'tests/gamma.test.ts',
    ])
  })
})
