import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HarnessError, type HarnessErrorCode } from './errors.ts'
import {
  findFixtures,
  parseFixtureManifest,
  readFixture,
  resolveFixtureDirs,
  runnerOfProfile,
  runnersForTestFile,
  testFilesFor,
} from './fixture.ts'

function rejects(code: HarnessErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof HarnessError && error.code === code
}

const VALID = { description: 'what it shows', runners: ['jest', 'vitest'] }

test('a valid manifest parses, with and without env', () => {
  assert.deepEqual(parseFixtureManifest(JSON.stringify(VALID)), VALID)
  assert.deepEqual(
    parseFixtureManifest(JSON.stringify({ ...VALID, runners: ['jest'], env: { TZ: 'UTC' } })),
    {
      description: 'what it shows',
      runners: ['jest'],
      env: { TZ: 'UTC' },
    },
  )
})

test('text that is not JSON, or not an object, is HARNESS_FIXTURE_BAD_JSON', () => {
  assert.throws(() => parseFixtureManifest('{ nope'), rejects('HARNESS_FIXTURE_BAD_JSON'))
  assert.throws(() => parseFixtureManifest('[]'), rejects('HARNESS_FIXTURE_BAD_JSON'))
  assert.throws(() => parseFixtureManifest('null'), rejects('HARNESS_FIXTURE_BAD_JSON'))
})

test('an unknown key is HARNESS_FIXTURE_UNKNOWN_KEY and names the key', () => {
  assert.throws(
    () => parseFixtureManifest(JSON.stringify({ ...VALID, config: {} }), 'f/fixture.json'),
    (error: unknown) =>
      rejects('HARNESS_FIXTURE_UNKNOWN_KEY')(error) &&
      error instanceof Error &&
      error.message.includes('"config"') &&
      error.message.includes('f/fixture.json'),
  )
})

test('description must be a non-empty string', () => {
  for (const description of [undefined, '', '  ', 3]) {
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, description })),
      rejects('HARNESS_FIXTURE_BAD_DESCRIPTION'),
    )
  }
})

test('runners must be a non-empty, duplicate-free list of jest, vitest and vitest-list', () => {
  for (const runners of [
    undefined,
    [],
    'jest',
    ['mocha'],
    ['jest', 'jest'],
    [1],
    ['vitest-list', 'vitest-list'],
    ['vitest-lists'],
  ]) {
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, runners })),
      rejects('HARNESS_FIXTURE_BAD_RUNNERS'),
    )
  }
})

test('vitest-list is a runner entry of its own, next to vitest', () => {
  const runners = ['jest', 'vitest', 'vitest-list']
  assert.deepEqual(parseFixtureManifest(JSON.stringify({ ...VALID, runners })).runners, runners)
  assert.deepEqual(
    parseFixtureManifest(JSON.stringify({ ...VALID, runners: ['vitest-list'] })).runners,
    ['vitest-list'],
  )
})

test('expectCrash is an optional, non-empty, duplicate-free subset of runners', () => {
  const runners = ['jest', 'vitest', 'vitest-list']
  assert.deepEqual(
    parseFixtureManifest(
      JSON.stringify({ ...VALID, runners, expectCrash: ['vitest-list', 'jest'] }),
    ),
    { description: 'what it shows', runners, expectCrash: ['vitest-list', 'jest'] },
  )
  assert.equal('expectCrash' in parseFixtureManifest(JSON.stringify(VALID)), false)
})

test('a bad expectCrash is HARNESS_FIXTURE_BAD_EXPECT_CRASH and says what is wrong', () => {
  const cases: [unknown, string][] = [
    [[], 'non-empty'],
    ['jest', 'non-empty'],
    [{ jest: true }, 'non-empty'],
    [['mocha'], 'non-empty'],
    [[1], 'non-empty'],
    [['vitest-list'], '"vitest-list", which "runners" does not'],
    [['jest', 'jest'], '"jest" twice'],
  ]
  for (const [expectCrash, mention] of cases) {
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, expectCrash }), 'f/fixture.json'),
      (error: unknown) =>
        rejects('HARNESS_FIXTURE_BAD_EXPECT_CRASH')(error) &&
        error instanceof Error &&
        error.message.includes('"expectCrash"') &&
        error.message.includes(mention),
      JSON.stringify(expectCrash),
    )
  }
})

test('env must be an object of strings', () => {
  for (const env of ['TZ=UTC', null, { TZ: 1 }, ['a']]) {
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, env })),
      rejects('HARNESS_FIXTURE_BAD_ENV'),
    )
  }
})

test('test files: *.test.ts runs everywhere, *.jest.test.ts and *.vitest.test.ts under one runner', () => {
  assert.deepEqual(runnersForTestFile('a.test.ts'), ['jest', 'vitest'])
  assert.deepEqual(runnersForTestFile('sub/a.jest.test.ts'), ['jest'])
  assert.deepEqual(runnersForTestFile('a.vitest.test.ts'), ['vitest'])
  assert.equal(runnersForTestFile('helper.ts'), undefined)
  assert.equal(runnersForTestFile('a.test.js'), undefined)
  const files = ['a.test.ts', 'b.jest.test.ts', 'c.vitest.test.ts', 'helper.ts']
  assert.deepEqual(testFilesFor(files, 'jest'), ['a.test.ts', 'b.jest.test.ts'])
  assert.deepEqual(testFilesFor(files, 'vitest'), ['a.test.ts', 'c.vitest.test.ts'])
})

test('vitest-list runs the files vitest runs, and its runner is vitest', () => {
  const files = ['a.test.ts', 'b.jest.test.ts', 'c.vitest.test.ts', 'helper.ts']
  assert.deepEqual(testFilesFor(files, 'vitest-list'), testFilesFor(files, 'vitest'))
  assert.equal(runnerOfProfile('vitest-list'), 'vitest')
  assert.equal(runnerOfProfile('vitest'), 'vitest')
  assert.equal(runnerOfProfile('jest'), 'jest')
})

async function withTempDir(use: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'harness-fixture-'))
  try {
    await use(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function put(root: string, file: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), text)
}

test('readFixture lists the files, without the manifest or goldens, and builds the id', async () => {
  await withTempDir(async (root) => {
    await put(root, 'area/thing/fixture.json', JSON.stringify(VALID))
    await put(root, 'area/thing/a.test.ts', '')
    await put(root, 'area/thing/helper.ts', '')
    await put(root, 'area/thing/__goldens__/jest.json', '{}')
    const fixture = await readFixture(path.join(root, 'area/thing'), root)
    assert.equal(fixture.id, 'area/thing')
    assert.deepEqual(fixture.files, ['a.test.ts', 'helper.ts'])
    assert.deepEqual(fixture.manifest, VALID)
  })
})

test('readFixture: a missing manifest, or a runner with no test file, is a coded error', async () => {
  await withTempDir(async (root) => {
    await put(root, 'none/a.test.ts', '')
    await assert.rejects(
      readFixture(path.join(root, 'none'), root),
      rejects('HARNESS_FIXTURE_NOT_FOUND'),
    )

    await put(root, 'jest-only/fixture.json', JSON.stringify(VALID))
    await put(root, 'jest-only/a.jest.test.ts', '')
    await assert.rejects(
      readFixture(path.join(root, 'jest-only'), root),
      (error: unknown) =>
        rejects('HARNESS_FIXTURE_NO_TESTS')(error) &&
        error instanceof Error &&
        error.message.includes('"vitest"'),
    )
  })
})

test('readFixture: vitest-list needs a Vitest test file, and the error names the profile', async () => {
  await withTempDir(async (root) => {
    await put(
      root,
      'jest-only/fixture.json',
      JSON.stringify({ ...VALID, runners: ['jest', 'vitest-list'] }),
    )
    await put(root, 'jest-only/a.jest.test.ts', '')
    await assert.rejects(
      readFixture(path.join(root, 'jest-only'), root),
      (error: unknown) =>
        rejects('HARNESS_FIXTURE_NO_TESTS')(error) &&
        error instanceof Error &&
        error.message.includes('"vitest-list"') &&
        error.message.includes('*.vitest.test.ts'),
    )
    await put(root, 'ok/fixture.json', JSON.stringify({ ...VALID, runners: ['vitest-list'] }))
    await put(root, 'ok/a.vitest.test.ts', '')
    assert.deepEqual((await readFixture(path.join(root, 'ok'), root)).manifest.runners, [
      'vitest-list',
    ])
  })
})

test('resolveFixtureDirs: a fixture or a directory of fixtures, in argument order, once each', async () => {
  await withTempDir(async (root) => {
    await put(root, 'area/b/fixture.json', '{}')
    await put(root, 'area/a/fixture.json', '{}')
    await put(root, 'other/c/fixture.json', '{}')
    const relative = async (...args: string[]): Promise<string[]> =>
      (await resolveFixtureDirs(args.map((arg) => path.join(root, arg)))).map((dir) =>
        path.relative(root, dir),
      )
    assert.deepEqual(await relative('area'), ['area/a', 'area/b'])
    assert.deepEqual(await relative('other/c', 'area'), ['other/c', 'area/a', 'area/b'])
    assert.deepEqual(await relative('area/b', 'area'), ['area/b', 'area/a'])
  })
})

test('resolveFixtureDirs: a directory with no fixture in it, or none at all, is HARNESS_FIXTURE_NOT_FOUND', async () => {
  await withTempDir(async (root) => {
    await put(root, 'empty/readme.txt', '')
    await put(root, 'area/a/fixture.json', '{}')
    await assert.rejects(
      resolveFixtureDirs([path.join(root, 'empty')]),
      rejects('HARNESS_FIXTURE_NOT_FOUND'),
    )
    await assert.rejects(
      resolveFixtureDirs([path.join(root, 'area'), path.join(root, 'missing')]),
      (error: unknown) =>
        rejects('HARNESS_FIXTURE_NOT_FOUND')(error) &&
        error instanceof Error &&
        error.message.includes('missing'),
    )
  })
})

test('findFixtures returns every directory with a fixture.json, sorted, and does not descend into one', async () => {
  await withTempDir(async (root) => {
    await put(root, 'b/two/fixture.json', '{}')
    await put(root, 'a/one/fixture.json', '{}')
    await put(root, 'a/one/nested/fixture.json', '{}')
    await put(root, 'a/other/readme.txt', '')
    const found = await findFixtures(root)
    assert.deepEqual(
      found.map((dir) => path.relative(root, dir)),
      ['a/one', 'b/two'],
    )
  })
})

test('findFixtures: a root that is itself a fixture is the only one, and node_modules is not searched', async () => {
  await withTempDir(async (root) => {
    await put(root, 'fixture.json', '{}')
    await put(root, 'inner/fixture.json', '{}')
    assert.deepEqual(await findFixtures(root), [root])
  })
  await withTempDir(async (root) => {
    await put(root, 'node_modules/pkg/fixture.json', '{}')
    await put(root, 'a/fixture.json', '{}')
    assert.deepEqual(
      (await findFixtures(root)).map((dir) => path.relative(root, dir)),
      ['a'],
    )
  })
})

test('readFixture does not list files in node_modules or nested goldens directories', async () => {
  await withTempDir(async (root) => {
    await put(root, 'area/thing/fixture.json', JSON.stringify(VALID))
    await put(root, 'area/thing/a.test.ts', '')
    await put(root, 'area/thing/sub/node_modules/x.ts', '')
    await put(root, 'area/thing/sub/__goldens__/jest.json', '{}')
    await put(root, 'area/thing/sub/b.ts', '')
    const fixture = await readFixture(path.join(root, 'area/thing'), root)
    assert.deepEqual(fixture.files, ['a.test.ts', 'sub/b.ts'])
  })
})
