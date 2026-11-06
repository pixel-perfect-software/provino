import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HarnessError, type HarnessErrorCode } from './errors.ts'
import {
  FIXTURE_PROFILES,
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

test('the profiles the messages spell out are FIXTURE_PROFILES', () => {
  assert.deepEqual(FIXTURE_PROFILES, ['jest', 'vitest', 'vitest-list'])
  const source = 'f/fixture.json'
  assert.throws(
    () => parseFixtureManifest(JSON.stringify({ ...VALID, runners: ['mocha'] }), source),
    {
      message: `${source}: "runners" must be a non-empty array of "jest" | "vitest" | "vitest-list"`,
    },
  )
  assert.throws(
    () => parseFixtureManifest(JSON.stringify({ ...VALID, expectCrash: { mocha: 'x' } }), source),
    {
      message: `${source}: "expectCrash" names "mocha", which is not "jest" | "vitest" | "vitest-list"`,
    },
  )
})

test('vitest-list is a runner entry of its own, next to vitest', () => {
  const runners = ['jest', 'vitest', 'vitest-list']
  assert.deepEqual(parseFixtureManifest(JSON.stringify({ ...VALID, runners })).runners, runners)
  assert.deepEqual(
    parseFixtureManifest(JSON.stringify({ ...VALID, runners: ['vitest-list'] })).runners,
    ['vitest-list'],
  )
})

test('expectCrash is an optional, non-empty object from runners to the text their crash shows', () => {
  const runners = ['jest', 'vitest', 'vitest-list']
  const expectCrash = { 'vitest-list': 'Missing second argument', jest: 'Todo must be called' }
  assert.deepEqual(parseFixtureManifest(JSON.stringify({ ...VALID, runners, expectCrash })), {
    description: 'what it shows',
    runners,
    expectCrash,
  })
  assert.equal('expectCrash' in parseFixtureManifest(JSON.stringify(VALID)), false)
})

test('mockCleanup is optional and keeps the neutral names it was given', () => {
  const mockCleanup = { clear: false, reset: true, restore: true }
  assert.deepEqual(parseFixtureManifest(JSON.stringify({ ...VALID, mockCleanup })), {
    ...VALID,
    mockCleanup,
  })
  assert.equal('mockCleanup' in parseFixtureManifest(JSON.stringify(VALID)), false)
})

test('unstubEnvs and unstubGlobals are accepted when only Vitest runs the fixture', () => {
  const mockCleanup = { unstubEnvs: true, unstubGlobals: false }
  for (const runners of [['vitest'], ['vitest', 'vitest-list']]) {
    assert.deepEqual(
      parseFixtureManifest(JSON.stringify({ ...VALID, runners, mockCleanup })).mockCleanup,
      mockCleanup,
    )
  }
})

test('an unstub key with jest in runners is HARNESS_FIXTURE_BAD_MOCK_CLEANUP and names the key', () => {
  for (const key of ['unstubEnvs', 'unstubGlobals']) {
    assert.throws(
      () =>
        parseFixtureManifest(
          JSON.stringify({ ...VALID, mockCleanup: { [key]: true } }),
          'f/fixture.json',
        ),
      (error: unknown) =>
        rejects('HARNESS_FIXTURE_BAD_MOCK_CLEANUP')(error) &&
        error instanceof Error &&
        error.message.includes(`"${key}"`) &&
        error.message.includes('"jest"') &&
        error.message.includes('f/fixture.json'),
    )
  }
})

test('a bad mockCleanup is HARNESS_FIXTURE_BAD_MOCK_CLEANUP', () => {
  const cases: [unknown, string][] = [
    [{}, 'non-empty object'],
    [null, 'non-empty object'],
    [['clear'], 'non-empty object'],
    ['clear', 'non-empty object'],
    [{ clean: true }, 'unknown key "clean"'],
    [{ clear: 'yes' }, 'must give "clear" true or false'],
    [{ reset: 1 }, 'must give "reset" true or false'],
    [{ restore: null }, 'must give "restore" true or false'],
  ]
  for (const [mockCleanup, mention] of cases) {
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, mockCleanup }), 'f/fixture.json'),
      (error: unknown) =>
        rejects('HARNESS_FIXTURE_BAD_MOCK_CLEANUP')(error) &&
        error instanceof Error &&
        error.message.includes('"mockCleanup"') &&
        error.message.includes(mention),
      JSON.stringify(mockCleanup),
    )
  }
})

test('a bad expectCrash is HARNESS_FIXTURE_BAD_EXPECT_CRASH and says what is wrong', () => {
  const nonEmptyObject = 'non-empty object'
  const cases: [unknown, string][] = [
    [{}, nonEmptyObject],
    [null, nonEmptyObject],
    ['jest', nonEmptyObject],
    // The list of profiles was the old form, and is not accepted any more.
    [['jest'], nonEmptyObject],
    [[], nonEmptyObject],
    [{ mocha: 'x' }, 'names "mocha"'],
    [{ 'vitest-list': 'x' }, '"vitest-list", which "runners" does not list'],
    [{ jest: '' }, 'must give "jest" a non-empty string'],
    [{ jest: '  ' }, 'must give "jest" a non-empty string'],
    [{ jest: true }, 'must give "jest" a non-empty string'],
    [{ jest: ['Missing second argument'] }, 'must give "jest" a non-empty string'],
    [{ jest: 'x', vitest: null }, 'must give "vitest" a non-empty string'],
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

async function putFixture(root: string, dir: string): Promise<void> {
  await put(root, `${dir}/fixture.json`, JSON.stringify(VALID))
  await put(root, `${dir}/a.test.ts`, '')
}

test('the id does not depend on how the fixture dir and the root are spelled', async () => {
  await withTempDir(async (tmp) => {
    const real = path.join(tmp, 'real')
    await putFixture(real, 'area/thing')
    // `link` is another name for `real`; `thing` is another name for `real/area/thing`.
    const link = path.join(tmp, 'link')
    await symlink(real, link)
    const thing = path.join(tmp, 'thing')
    await symlink(path.join(real, 'area/thing'), thing)

    const id = async (dir: string, root: string): Promise<string> =>
      (await readFixture(dir, root)).id
    assert.equal(await id(path.join(real, 'area/thing'), real), 'area/thing')
    assert.equal(await id(path.join(link, 'area/thing'), real), 'area/thing', 'dir via a symlink')
    assert.equal(await id(path.join(real, 'area/thing'), link), 'area/thing', 'root via a symlink')
    assert.equal(await id(path.join(link, 'area/thing'), link), 'area/thing', 'both via a symlink')
    assert.equal(await id(thing, real), 'area/thing', 'the fixture dir itself a symlink')
    // The fixture keeps the directory it was given, so its goldens are written where it was found.
    assert.equal((await readFixture(thing, real)).dir, thing)
  })
})

test('the id is the real relative path when the case of the dir or the root differs', async (t) => {
  await withTempDir(async (tmp) => {
    await putFixture(tmp, 'Area/Thing')
    const swapped = path.join(tmp, 'aREA', 'tHING')
    // Only a case-insensitive filesystem (macOS, Windows) finds the fixture under that spelling.
    const insensitive = await realpath(swapped).then(
      () => true,
      () => false,
    )
    if (!insensitive) return t.skip('this filesystem is case-sensitive')
    assert.equal((await readFixture(swapped, tmp)).id, 'Area/Thing')
    assert.equal(
      (await readFixture(path.join(tmp, 'Area/Thing'), tmp.toUpperCase())).id,
      'Area/Thing',
    )
  })
})

test('a fixture outside the root, or a root that does not exist, gets its directory name as id', async () => {
  await withTempDir(async (tmp) => {
    await putFixture(tmp, 'elsewhere/thing')
    await mkdir(path.join(tmp, 'root'))
    const dir = path.join(tmp, 'elsewhere/thing')
    assert.equal((await readFixture(dir, path.join(tmp, 'root'))).id, 'thing')
    assert.equal((await readFixture(dir, path.join(tmp, 'no-such-root'))).id, 'thing')
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
