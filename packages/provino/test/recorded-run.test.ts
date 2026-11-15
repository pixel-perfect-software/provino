// The shared replay helper (`recorded-run.ts`): it must run `provino jest` under the environment
// the recorder gave Jest, refuse what it can't build, read each capture through the recorder's own
// steps, and never let a missing file pass for an equal one.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { Json } from './mask.ts'
import type { RecordedFixture, RecordedManifest } from './recorded.ts'
import {
  assertMatchesGolden,
  RESULTS,
  type RecordedRun,
  recordedFile,
  recordedStream,
  replayCommand,
  replayEnv,
  runFixture,
} from './recorded-run.ts'

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A fixture with one test file, `body` being its test's body. */
async function fixtureOf(
  manifest: Partial<RecordedManifest> & Pick<RecordedManifest, 'run'>,
  body: string,
  extraFiles: Readonly<Record<string, string>> = {},
): Promise<RecordedFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'recorded-run-'))
  made.push(dir)
  await writeFile(join(dir, 'a.test.ts'), `it('probe', () => {\n${body}\n})\n`)
  for (const [file, text] of Object.entries(extraFiles)) {
    await mkdir(dirname(join(dir, file)), { recursive: true })
    await writeFile(join(dir, file), text)
  }
  return {
    id: 'inline/probe',
    dir,
    manifest: { description: 'a probe', ...manifest },
    golden: { files: [] },
  }
}

const EXACT = { exact: true, argv: { jest: ['--ci=false'] }, capture: ['exitCode'] } as const

describe('provinoOn runs under the environment the recorder gave Jest', () => {
  it('a null in env removes an inherited variable from the child', async () => {
    process.env.B23E_REPLAY_PROBE = 'inherited'
    try {
      const control = await fixtureOf(
        { run: EXACT },
        "expect(process.env.B23E_REPLAY_PROBE).toBe('inherited')",
      )
      assert.equal(
        (await runFixture(control)).code,
        0,
        'the variable is inherited without the null',
      )
      const removed = await fixtureOf(
        { run: EXACT, env: { B23E_REPLAY_PROBE: null, NO_COLOR: null } },
        'expect(process.env.B23E_REPLAY_PROBE).toBeUndefined()\nexpect(process.env.NO_COLOR).toBeUndefined()',
      )
      assert.equal((await runFixture(removed)).code, 0)
    } finally {
      delete process.env.B23E_REPLAY_PROBE
    }
  })

  it('git in the replay can never find the checkout’s repository', async () => {
    const fixture = await fixtureOf(
      { run: EXACT },
      `const { execFileSync } = require('node:child_process')
let found = ''
try {
  found = String(execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'pipe' }))
} catch {}
expect(found).toBe('')`,
    )
    // The default parent is inside this checkout, whose repository `git` would otherwise find.
    assert.equal((await runFixture(fixture)).code, 0)
  })

  it('replayEnv: the recorder’s base, hermetic git, the fixture’s env, then every null removed', () => {
    process.env.GIT_DIR = '/elsewhere'
    process.env.LC_TIME = 'xx'
    process.env.B23E_NULLED = '1'
    try {
      const env = replayEnv(
        { description: 'x', env: { B23E_NULLED: null, CI: 'false', EXTRA: 'e' } },
        '/work/parent/project',
      )
      assert.equal(env.GIT_DIR, undefined)
      assert.equal(env.LC_TIME, undefined)
      assert.equal(env.GIT_CEILING_DIRECTORIES, '/work/parent')
      assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null')
      assert.equal(env.B23E_NULLED, undefined)
      assert.equal(env.CI, 'false')
      assert.equal(env.EXTRA, 'e')
      assert.equal(env.NO_COLOR, '1')
      assert.equal(env.TZ, 'UTC')
    } finally {
      delete process.env.GIT_DIR
      delete process.env.LC_TIME
      delete process.env.B23E_NULLED
    }
  })
})

describe('provinoOn refuses what it does not build', () => {
  it('a fixture with scm', async () => {
    const fixture = await fixtureOf({ run: EXACT, scm: { steps: [{ commit: 'c' }] } }, '')
    await assert.rejects(runFixture(fixture), /"scm"/)
  })

  it('an exact fixture with a Jest config of its own', async () => {
    for (const [file, text] of [
      ['jest.config.js', 'module.exports = {}'],
      ['package.json', '{ "jest": {} }'],
    ] as const) {
      const fixture = await fixtureOf({ run: EXACT }, '', { [file]: text })
      await assert.rejects(runFixture(fixture), new RegExp(file.replace('.', '\\.')))
    }
  })
})

describe('the command', () => {
  it('passes nodeFlags before the bin, and exactly the fixture’s argv under exact', async () => {
    const fixture = await fixtureOf(
      {
        run: { ...EXACT, argv: { jest: ['--ci=false', '--json'] } },
        nodeFlags: ['--stack-size=900'],
      },
      '',
    )
    assert.deepEqual(replayCommand(fixture, '/root', ['--json']), {
      args: ['jest', '--json'],
      nodeArgs: ['--stack-size=900'],
    })
    const inexact = await fixtureOf({ run: { capture: ['exitCode'] } }, '')
    const { args, nodeArgs } = replayCommand(inexact, '/root', ['-t', 'x'])
    assert.deepEqual(args, [
      'jest',
      '--config=/root/jest.config.json',
      '--ci',
      '-t',
      'x',
      '--json',
      `--outputFile=${RESULTS}`,
    ])
    assert.deepEqual(nodeArgs, [])
  })
})

describe('rawJson', () => {
  it('throws for a file that was never read, so a missing results file can’t pass as equal', async () => {
    const fixture = await fixtureOf({ run: EXACT }, '')
    const run = await runFixture(fixture)
    assert.throws(() => run.rawJson(RESULTS), /under run\.exact/)
    // Outside `exact` the recorder's own results file is read.
    const inexact = await runFixture(await fixtureOf({ run: { capture: ['exitCode'] } }, ''))
    assert.ok(inexact.rawJson(RESULTS) !== null)
  })
})

describe('an uncaptured stream', () => {
  it('throws when read, naming the fixture, and a captured one still reads', async () => {
    const run = await runFixture(
      await fixtureOf({ run: { ...EXACT, capture: ['exitCode', 'stderr'] } }, ''),
    )
    assert.throws(() => run.stdout, /inline\/probe: stdout was not captured: capture it/)
    assert.equal(typeof run.stderr, 'string')
    const none = await runFixture(await fixtureOf({ run: EXACT }, ''))
    assert.throws(() => none.stderr, /stderr was not captured: capture it/)
  })
})

describe('captures are read as the recorder reads them', () => {
  it('sortStdout: the roots become <root> before the lines are sorted', () => {
    // Sorted first, '/r/c' < '5 a'; as `<root>/c` it sorts after it: the recorder's order wins.
    const text = '5 a\n/r/c'
    assert.equal(recordedStream(text, { capture: [], sortStdout: true }, ['/r']), '5 a\n<root>/c')
  })

  it('sortStdout "json" applies to a file and the roots come first; true leaves a file alone', () => {
    const list = JSON.stringify(['5 a', '/r/c'])
    assert.equal(recordedFile(list, { capture: [], sortStdout: 'json' }, ['/r']), '5 a\n<root>/c')
    assert.equal(recordedFile('b\na', { capture: [], sortStdout: true }, []), 'b\na')
    // As the recorder, a text file under "json" is refused.
    assert.throws(() => recordedFile('b\na', { capture: [], sortStdout: 'json' }, []), /JSON array/)
  })
})

describe('assertMatchesGolden compares as recorded', () => {
  const run = (testResults: readonly Json[], golden: readonly Json[]): RecordedRun => {
    const fixture: RecordedFixture = {
      id: 'inline/order',
      dir: '/none',
      manifest: { description: 'x', run: { capture: ['json:out.json'] } },
      golden: { files: [], observed: { json: { 'out.json': { testResults: golden } } } },
    }
    return {
      fixture,
      code: 0,
      stdout: '',
      stderr: '',
      files: {},
      json: { 'out.json': { testResults } },
      rawJson: () => null,
    }
  }

  it('does not reorder either side', () => {
    const a = { name: 'a' }
    const b = { name: 'b' }
    assertMatchesGolden('inline/order', run([a, b], [a, b]))
    assert.throws(() => assertMatchesGolden('inline/order', run([b, a], [a, b])))
  })
})
