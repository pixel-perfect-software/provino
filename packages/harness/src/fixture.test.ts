import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HarnessError, type HarnessErrorCode } from './errors.ts'
import {
  checkedOnNode,
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
    () => parseFixtureManifest(JSON.stringify({ ...VALID, settings: {} }), 'f/fixture.json'),
    (error: unknown) =>
      rejects('HARNESS_FIXTURE_UNKNOWN_KEY')(error) &&
      error instanceof Error &&
      error.message.includes('"settings"') &&
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

test('nodeMajors names runners of the fixture and positive integer majors, and limits where a golden is checked', () => {
  const manifest = parseFixtureManifest(
    JSON.stringify({ ...VALID, runners: ['jest', 'vitest'], nodeMajors: { jest: [24] } }),
  )
  assert.deepEqual(manifest.nodeMajors, { jest: [24] })
  assert.equal(checkedOnNode(manifest, 'jest', 24), true)
  assert.equal(checkedOnNode(manifest, 'jest', 22), false)
  assert.equal(checkedOnNode(manifest, 'jest', 26), false)
  // A profile with no entry is checked on every major, and a profile the fixture lacks on none.
  assert.equal(checkedOnNode(manifest, 'vitest', 22), true)
  assert.equal(checkedOnNode({ ...manifest, runners: ['vitest'] }, 'jest', 24), false)
  assert.equal(parseFixtureManifest(JSON.stringify(VALID)).nodeMajors, undefined)
  for (const nodeMajors of [
    [],
    {},
    { jest: [] },
    { jest: ['24'] },
    { jest: [24.5] },
    { jest: [0] },
    { vitest: [24] },
    { 'vitest-list': [24] },
    { bun: [24] },
  ]) {
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, runners: ['jest'], nodeMajors })),
      rejects('HARNESS_FIXTURE_BAD_NODE_MAJORS'),
      JSON.stringify(nodeMajors),
    )
  }
})

test('nodeFlags is a non-empty array of node flags, and is kept', () => {
  const kept = parseFixtureManifest(
    JSON.stringify({ ...VALID, nodeFlags: ['--harmony-temporal', '--stack-trace-limit=50'] }),
  )
  assert.deepEqual(kept.nodeFlags, ['--harmony-temporal', '--stack-trace-limit=50'])
  assert.equal(parseFixtureManifest(JSON.stringify(VALID)).nodeFlags, undefined)
  for (const nodeFlags of [
    '--harmony-temporal',
    [],
    ['harmony-temporal'],
    ['--require=./x.js'],
    ['--import', 'x'],
    ['--eval=1'],
    ['-e'],
    [1],
  ]) {
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, nodeFlags })),
      rejects('HARNESS_FIXTURE_BAD_NODE_FLAGS'),
      JSON.stringify(nodeFlags),
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

test('jestEsm is optional, true only, and needs a fixture that runs Jest', () => {
  assert.deepEqual(parseFixtureManifest(JSON.stringify({ ...VALID, jestEsm: true })), {
    ...VALID,
    jestEsm: true,
  })
  assert.equal('jestEsm' in parseFixtureManifest(JSON.stringify(VALID)), false)
  for (const jestEsm of [false, 'true', 1, null]) {
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, jestEsm })),
      rejects('HARNESS_FIXTURE_BAD_JEST_ESM'),
    )
  }
  assert.throws(
    () => parseFixtureManifest(JSON.stringify({ ...VALID, runners: ['vitest'], jestEsm: true })),
    rejects('HARNESS_FIXTURE_BAD_JEST_ESM'),
  )
})

test('packages keeps plain and scoped packages with their files', () => {
  const packages = {
    left: { 'package.json': '{"main":"index.js"}', 'index.js': 'module.exports = 1' },
    '@scope/right': { 'package.json': '{}', 'lib/index.js': 'module.exports = 2' },
  }
  assert.deepEqual(parseFixtureManifest(JSON.stringify({ ...VALID, packages })), {
    ...VALID,
    packages,
  })
  assert.equal('packages' in parseFixtureManifest(JSON.stringify(VALID)), false)
})

test('packages refuses a bad shape, a name or a file that escapes its directory', () => {
  const bad = (packages: unknown): void =>
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, packages })),
      rejects('HARNESS_FIXTURE_BAD_PACKAGES'),
    )
  bad({})
  bad([])
  bad({ a: {} })
  bad({ a: 'index.js' })
  bad({ a: { 'index.js': 1 } })
  bad({ '../a': { 'index.js': '' } })
  bad({ '/abs': { 'index.js': '' } })
  bad({ 'a/b': { 'index.js': '' } })
  bad({ '@scope': { 'index.js': '' } })
  bad({ A: { 'index.js': '' } })
  // Each file is refused for itself: the package has its package.json.
  const badFile = (file: string): void => bad({ a: { 'package.json': '{}', [file]: '' } })
  badFile('../index.js')
  badFile('x/../../index.js')
  badFile('/etc/passwd')
  badFile('x\\..\\y.js')
  badFile('')
  badFile('.')
  badFile('lib/')
  badFile('./lib/')
})

test('packages requires a package.json in every package', () => {
  assert.throws(
    () => parseFixtureManifest(JSON.stringify({ ...VALID, packages: { a: { 'index.js': '' } } })),
    (error) =>
      rejects('HARNESS_FIXTURE_BAD_PACKAGES')(error) && /package\.json/.test(String(error)),
  )
  // `./package.json` is the same file.
  assert.deepEqual(
    parseFixtureManifest(
      JSON.stringify({ ...VALID, packages: { a: { './package.json': '{}', 'index.js': '' } } }),
    ).packages,
    { a: { 'package.json': '{}', 'index.js': '' } },
  )
})

test('packages refuses two spellings of one file, and keeps a name that only starts with ..', () => {
  assert.throws(
    () =>
      parseFixtureManifest(
        JSON.stringify({
          ...VALID,
          packages: { a: { 'package.json': '{}', './x.js': '1', 'x.js': '2', 'y/../x.js': '3' } },
        }),
      ),
    rejects('HARNESS_FIXTURE_BAD_PACKAGES'),
  )
  assert.deepEqual(
    parseFixtureManifest(
      JSON.stringify({ ...VALID, packages: { a: { 'package.json': '{}', '..foo.js': '1' } } }),
    ).packages,
    { a: { 'package.json': '{}', '..foo.js': '1' } },
  )
})

test('jestConfig keeps roots and unmocked patterns, for a fixture that runs Jest', () => {
  const jestConfig = { roots: ['one', 'a/two'], unmockedModulePathPatterns: ['keep', 'x\\.ts$'] }
  assert.deepEqual(
    parseFixtureManifest(JSON.stringify({ ...VALID, runners: ['jest'], jestConfig })).jestConfig,
    jestConfig,
  )
  assert.equal('jestConfig' in parseFixtureManifest(JSON.stringify(VALID)), false)
})

test('jestConfig refuses a bad shape, a root that leaves the fixture and a bad pattern', () => {
  const bad = (jestConfig: unknown, runners: string[] = ['jest']): void =>
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, runners, jestConfig })),
      rejects('HARNESS_FIXTURE_BAD_JEST_CONFIG'),
    )
  bad({})
  bad([])
  bad({ other: ['x'] })
  bad({ roots: [] })
  bad({ roots: [1] })
  bad({ roots: ['../up'] })
  bad({ roots: ['/abs'] })
  bad({ roots: ['one', './one'] })
  bad({ unmockedModulePathPatterns: [''] })
  bad({ unmockedModulePathPatterns: ['('] })
  bad({ roots: ['one'] }, ['vitest'])
})

test('config keeps a JSON overlay per runner the fixture lists', () => {
  const config = { jest: { testTimeout: 50 }, vitest: { test: { globals: false } } }
  assert.deepEqual(parseFixtureManifest(JSON.stringify({ ...VALID, config })).config, config)
  assert.equal('config' in parseFixtureManifest(JSON.stringify(VALID)), false)
})

test('config refuses a bad shape, an unlisted runner and a key someone else sets', () => {
  const bad = (manifest: Record<string, unknown>): void =>
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, ...manifest })),
      rejects('HARNESS_FIXTURE_BAD_CONFIG'),
    )
  bad({ config: {} })
  bad({ config: [] })
  bad({ config: { mocha: { a: 1 } } })
  bad({ config: { jest: {} } })
  bad({ config: { jest: 1 } })
  bad({ runners: ['vitest'], config: { jest: { a: 1 } } })
  // The recorder's own keys.
  bad({ config: { jest: { rootDir: '/x' } } })
  bad({ config: { jest: { testMatch: ['**/*.ts'] } } })
  bad({ config: { vitest: { root: '/x' } } })
  bad({ config: { vitest: { test: { include: ['x'] } } } })
  // Projects bring configs the recorder doesn't write, and a `test` that isn't an object hides keys.
  bad({ config: { jest: { projects: ['a'] } } })
  bad({ config: { vitest: { projects: ['a'] } } })
  bad({ config: { vitest: { test: { projects: ['a'] } } } })
  bad({ config: { vitest: { test: 'x' } } })
  bad({ config: { vitest: { test: ['x'] } } })
  // A key `mockCleanup` or `jestConfig` sets.
  bad({ mockCleanup: { clear: true }, config: { jest: { clearMocks: false } } })
  bad({ mockCleanup: { clear: true }, config: { vitest: { test: { clearMocks: false } } } })
  bad({ runners: ['jest'], jestConfig: { roots: ['a'] }, config: { jest: { roots: ['b'] } } })
  // The `vitest-list` profile's own key.
  bad({ runners: ['vitest-list'], config: { vitest: { test: { sequence: { hooks: 'stack' } } } } })
  // Without the other source, the same key is the fixture's.
  assert.deepEqual(
    parseFixtureManifest(JSON.stringify({ ...VALID, config: { jest: { clearMocks: true } } }))
      .config,
    { jest: { clearMocks: true } },
  )
})

test('a black-box run may set the options that decide which files it finds; other fixtures may not', () => {
  const discovery = {
    jest: { testMatch: ['**/*.spec.ts'], testPathIgnorePatterns: ['/skip/'] },
    vitest: { test: { include: ['src/**'], exclude: ['**/skip/**'] } },
  }
  const run = { capture: ['exitCode'] }
  assert.deepEqual(
    parseFixtureManifest(JSON.stringify({ ...VALID, config: discovery, run })).config,
    discovery,
  )
  const refused = (config: unknown): void =>
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, config })),
      rejects('HARNESS_FIXTURE_BAD_CONFIG'),
    )
  refused({ jest: { testMatch: ['**/*.spec.ts'] } })
  refused({ jest: { testPathIgnorePatterns: ['/skip/'] } })
  refused({ vitest: { test: { include: ['src/**'] } } })
  refused({ vitest: { test: { exclude: ['x'] } } })
  // The rest of what the recorder owns stays its own, run or not.
  assert.throws(
    () =>
      parseFixtureManifest(JSON.stringify({ ...VALID, config: { jest: { rootDir: '/x' } }, run })),
    rejects('HARNESS_FIXTURE_BAD_CONFIG'),
  )
})

test('run.sortStdout is true or "json"', () => {
  const run = { capture: ['stdout'], sortStdout: 'json' }
  assert.deepEqual(parseFixtureManifest(JSON.stringify({ ...VALID, run })).run, run)
  assert.throws(
    () => parseFixtureManifest(JSON.stringify({ ...VALID, run: { ...run, sortStdout: 'lines' } })),
    rejects('HARNESS_FIXTURE_BAD_RUN'),
  )
})

test('files keeps a tree per runner, under its normalized paths', () => {
  const files = { jest: { './__snapshots__/a.test.ts.snap': 'x' }, vitest: { 'b.txt': '' } }
  assert.deepEqual(parseFixtureManifest(JSON.stringify({ ...VALID, files })).files, {
    jest: { '__snapshots__/a.test.ts.snap': 'x' },
    vitest: { 'b.txt': '' },
  })
})

test('files refuses a bad shape, an unlisted runner and a path that leaves the work directory', () => {
  const bad = (files: unknown, runners: string[] = ['jest', 'vitest']): void =>
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, runners, files })),
      rejects('HARNESS_FIXTURE_BAD_FILES'),
    )
  bad({})
  bad({ jest: {} })
  bad({ jest: { 'a.txt': 1 } })
  bad({ jest: { '../a.txt': '' } })
  bad({ jest: { '/a.txt': '' } })
  bad({ jest: { 'a.txt': '', './a.txt': '' } })
  bad({ mocha: { 'a.txt': '' } })
  bad({ jest: { 'a.txt': '' } }, ['vitest'])
})

test('run keeps what a black-box run captures', () => {
  const run = {
    argv: { jest: ['--passWithNoTests'] },
    capture: ['exitCode', 'stderr', 'file:__snapshots__/a.test.ts.snap'],
    keepLines: '^Snapshots:',
    sortStdout: true,
  }
  assert.deepEqual(parseFixtureManifest(JSON.stringify({ ...VALID, run })).run, run)
  assert.deepEqual(
    parseFixtureManifest(JSON.stringify({ ...VALID, run: { capture: ['exitCode'] } })).run,
    { capture: ['exitCode'] },
  )
})

test('run refuses a bad capture, argv, keepLines or sortStdout', () => {
  const bad = (run: unknown): void =>
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, run })),
      rejects('HARNESS_FIXTURE_BAD_RUN'),
    )
  bad([])
  bad({})
  bad({ capture: [] })
  bad({ capture: ['exit'] })
  bad({ capture: ['file:../x'] })
  bad({ capture: ['exitCode', 'exitCode'] })
  bad({ capture: ['exitCode'], other: 1 })
  bad({ capture: ['exitCode'], argv: {} })
  bad({ capture: ['exitCode'], argv: { mocha: [] } })
  bad({ capture: ['exitCode'], argv: { jest: [1] } })
  bad({ capture: ['exitCode'], keepLines: '' })
  bad({ capture: ['exitCode'], keepLines: '(' })
  bad({ capture: ['exitCode'], sortStdout: false })
  // `emptyStreams` lists captured streams once each, and only beside `keepLines`.
  bad({ capture: ['stdout'], emptyStreams: ['stdout'] })
  bad({ capture: ['stdout'], keepLines: 'x', emptyStreams: [] })
  bad({ capture: ['stdout'], keepLines: 'x', emptyStreams: ['stderr'] })
  bad({ capture: ['stdout'], keepLines: 'x', emptyStreams: ['stdout', 'stdout'] })
  // `missingJson` lists `json:` entries that `capture` lists, once each.
  bad({ capture: ['json:a.json'], missingJson: [] })
  bad({ capture: ['json:a.json'], missingJson: ['json:b.json'] })
  bad({ capture: ['file:a.json'], missingJson: ['file:a.json'] })
  bad({ capture: ['json:a.json'], missingJson: ['json:a.json', 'json:a.json'] })
})

test('run.argv refuses an option the recorder or mockCleanup sets, in any spelling', () => {
  const bad = (args: readonly string[]): void =>
    assert.throws(
      () =>
        parseFixtureManifest(
          JSON.stringify({
            ...VALID,
            run: { capture: ['stdout'], argv: { jest: args, vitest: [] } },
          }),
        ),
      rejects('HARNESS_FIXTURE_BAD_RUN'),
    )
  for (const arg of [
    '--config=other.json',
    '-c',
    '--outputFile=x.json',
    '--output-file',
    '--outputFile.json=x.json',
    '--json',
    '--no-json',
    '--root=/x',
    '--rootDir',
    '--root-dir=/x',
    '--reporter',
    '--reporter=json',
    '--reporters=default',
    '--clearMocks',
    '--no-restore-mocks',
    '--mockReset',
    '--unstubGlobals',
  ]) {
    bad([arg])
  }
  // A text reporter beside the recorder's JSON one, and options it doesn't own, are the fixture's.
  const args = ['--reporter=default', '--ci=false', '--passWithNoTests', 'some.test.ts']
  const run = { capture: ['stdout'], argv: { jest: args } }
  assert.deepEqual(parseFixtureManifest(JSON.stringify({ ...VALID, run })).run, run)
})

test('run keeps json: captures with timeKeys and mask', () => {
  const run = {
    capture: ['json:.harness-out/jest.json', 'stderr'],
    timeKeys: ['startTime', 'duration'],
    mask: ['pid \\d+'],
  }
  assert.deepEqual(parseFixtureManifest(JSON.stringify({ ...VALID, run })).run, run)
})

test('run refuses timeKeys without a json: capture, and a bad timeKeys or mask', () => {
  const bad = (run: unknown): void =>
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, run })),
      rejects('HARNESS_FIXTURE_BAD_RUN'),
    )
  bad({ capture: ['stderr'], timeKeys: ['a'] })
  bad({ capture: ['json:a.json'], timeKeys: [] })
  bad({ capture: ['json:a.json'], timeKeys: ['a', 'a'] })
  bad({ capture: ['json:../a.json'] })
  bad({ capture: ['stderr'], mask: [] })
  bad({ capture: ['stderr'], mask: ['('] })
  bad({ capture: ['stderr'], mask: [''] })
})

test('run keeps maskKeys beside a json: capture and a cwd inside the fixture, and refuses bad ones', () => {
  const run = { capture: ['json:coverage/coverage-final.json'], maskKeys: ['hash'], cwd: 'sub' }
  assert.deepEqual(parseFixtureManifest(JSON.stringify({ ...VALID, run })).run, run)
  const bad = (spec: unknown): void =>
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, run: spec })),
      rejects('HARNESS_FIXTURE_BAD_RUN'),
    )
  bad({ capture: ['stdout'], maskKeys: ['hash'] })
  bad({ capture: ['json:a.json'], maskKeys: [] })
  bad({ capture: ['json:a.json'], maskKeys: ['hash', 'hash'] })
  bad({ capture: ['stdout'], cwd: '' })
  bad({ capture: ['stdout'], cwd: '../up' })
  bad({ capture: ['stdout'], cwd: '/abs' })
})
