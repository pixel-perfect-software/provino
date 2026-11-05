// `run()` from `provino/node`, end to end: small Jest-style projects written to $TMPDIR, the real
// Jest dialect and Node environment, real forked workers (the default pool).
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { type RunOptions, type RunResult, run } from 'provino/node'
import {
  Collect,
  failing,
  isRunning,
  notedPids,
  noting,
  type Project,
  passing,
  trackedProjects,
  viewOfNormalized,
} from './support.ts'

const makeProject = trackedProjects()

interface Ran extends RunResult {
  readonly stdout: string
  readonly stderr: string
}

/** `run()` on a project's config with collected output. */
async function runProject(project: Project, options: Partial<RunOptions> = {}): Promise<Ran> {
  const stdout = new Collect()
  const stderr = new Collect()
  const result = await run({ config: project.config, stdout, stderr, ...options })
  return { ...result, stdout: stdout.text, stderr: stderr.text }
}

describe('run()', () => {
  it('passes a passing project: exit 0, and every file passed', async () => {
    const project = await makeProject({
      'tests/a.test.js': passing('a'),
      'tests/b.test.js': passing('b'),
      'tests/c.test.js': passing('c'),
    })
    const ran = await runProject(project)

    assert.equal(ran.exitCode, 0, ran.stderr)
    assert.equal(ran.summary?.reason, 'passed')
    assert.deepEqual(ran.summary?.files.map((file) => [file.file.path, file.state]).sort(), [
      ['tests/a.test.js', 'pass'],
      ['tests/b.test.js', 'pass'],
      ['tests/c.test.js', 'pass'],
    ])
    // The default reporter writes to stderr, and the policy's default is the default reporter.
    assert.match(ran.stderr, /PASS tests\/a\.test\.js/)
    assert.match(ran.stderr, /Test Suites: 3 passed, 3 total/)
    assert.equal(ran.stdout, '')
  })

  it('fails a failing test: exit 1, and the default reporter names it under FAIL', async () => {
    const project = await makeProject({
      'tests/good.test.js': passing('good'),
      'tests/bad.test.js': failing('the bad one'),
    })
    const ran = await runProject(project)

    assert.equal(ran.exitCode, 1)
    assert.equal(ran.summary?.reason, 'failed')
    assert.match(ran.stderr, /PASS tests\/good\.test\.js/)
    assert.match(ran.stderr, /FAIL tests\/bad\.test\.js/)
    assert.match(ran.stderr, /the bad one/)
    assert.match(ran.stderr, /Test Suites: 1 failed, 1 passed, 2 total/)
  })

  it('resolves the config and an outputFile against cwd', async () => {
    const project = await makeProject({ 'tests/a.test.js': passing('a') })
    const stderr = new Collect()
    const result = await run({
      config: 'provino.config.mjs',
      cwd: project.dir,
      reporters: [['normalized-json', { outputFile: 'out/run.json' }]],
      stderr,
    })

    assert.equal(result.exitCode, 0, stderr.text)
    assert.ok(existsSync(project.path('out/run.json')))
  })

  describe('bad input is exit code 2, the message on stderr and no summary', () => {
    it('a config file that is not there', async () => {
      const project = await makeProject({})
      const ran = await runProject(project, { config: project.path('nope.config.mjs') })

      assert.equal(ran.exitCode, 2)
      assert.equal(ran.summary, null)
      assert.match(ran.stderr, /can't load the config file/)
      assert.match(ran.stderr, /nope\.config\.mjs/)
    })

    it('a dialect name nobody knows', async () => {
      const project = await makeProject(
        {},
        "export default { dialect: 'mocha', include: ['tests/**/*.test.js'] }\n",
      )
      const ran = await runProject(project)

      assert.equal(ran.exitCode, 2)
      assert.equal(ran.summary, null)
      assert.match(ran.stderr, /mocha/)
      assert.match(ran.stderr, /jest/, 'it lists the dialects it knows')
    })

    it('a config that does not load', async () => {
      const project = await makeProject({}, "throw new Error('config boom')\n")
      const ran = await runProject(project)

      assert.equal(ran.exitCode, 2)
      assert.equal(ran.summary, null)
      assert.match(ran.stderr, /config boom/, 'the cause is in the message')
    })

    it('a test name pattern that is not a regular expression', async () => {
      const project = await makeProject({ 'tests/a.test.js': passing('a') })
      const ran = await runProject(project, { testNamePattern: '(' })

      assert.equal(ran.exitCode, 2)
      assert.equal(ran.summary, null)
      assert.match(ran.stderr, /not a valid regular expression/)
      assert.doesNotMatch(ran.stderr, /PASS|FAIL/, 'no file ran')
    })

    it('a maxWorkers that is not a positive whole number', async () => {
      const project = await makeProject({ 'tests/a.test.js': passing('a') })
      for (const maxWorkers of [0, -1, 1.5, Number.NaN]) {
        const ran = await runProject(project, { maxWorkers })
        assert.equal(ran.exitCode, 2, String(maxWorkers))
        assert.equal(ran.summary, null)
        assert.match(ran.stderr, /maxWorkers/)
      }
    })

    it('a reporter that is not a built-in or a reporter', async () => {
      const project = await makeProject({ 'tests/a.test.js': passing('a') })
      // @ts-expect-error "verbose" is not a reporter name
      const ran = await runProject(project, { reporters: ['verbose'] })

      assert.equal(ran.exitCode, 2)
      assert.equal(ran.summary, null)
      assert.match(ran.stderr, /unknown reporter "verbose"/)
    })

    it('reporter options that make no sense', async () => {
      const project = await makeProject({ 'tests/a.test.js': passing('a') })
      const bad = [
        // @ts-expect-error outputFile is a string
        await runProject(project, { reporters: [['normalized-json', { outputFile: 1 }]] }),
        // @ts-expect-error the reporters are an array
        await runProject(project, { reporters: 'default' }),
        // @ts-expect-error a reporter object has a name
        await runProject(project, { reporters: [{}] }),
      ]

      for (const ran of bad) {
        assert.equal(ran.exitCode, 2)
        assert.equal(ran.summary, null)
        assert.match(ran.stderr, /^Provino: /m)
      }
    })

    it('no config path', async () => {
      // @ts-expect-error config is required
      const result = await run({ stderr: new Collect() })
      assert.equal(result.exitCode, 2)
      assert.equal(result.summary, null)
    })
  })

  it('no test files: the dialect’s no-tests exit code, unless passWithNoTests', async () => {
    const project = await makeProject({})
    const none = await runProject(project)
    // The Jest dialect's `exitCodes.noTests`.
    assert.equal(none.exitCode, 1)
    assert.deepEqual(none.summary?.files, [])

    const allowed = await runProject(project, { passWithNoTests: true })
    assert.equal(allowed.exitCode, 0)
    assert.deepEqual(allowed.summary?.files, [])
  })

  it('runs only the tests whose name matches -t', async () => {
    const project = await makeProject({
      'tests/a.test.js': [
        "test('keeps this', () => { expect(1).toBe(1) })",
        "test('skips that', () => { expect(1).toBe(2) })",
        '',
      ].join('\n'),
    })
    const ran = await runProject(project, {
      testNamePattern: 'keeps',
      reporters: [['normalized-json', { outputFile: project.path('out.json') }]],
    })

    assert.equal(ran.exitCode, 0, ran.stderr)
    const file = viewOfNormalized(await readFile(project.path('out.json'), 'utf8')).files.get(
      'tests/a.test.js',
    )
    assert.equal(file?.tests.get('keeps this'), 'passed')
    assert.notEqual(file?.tests.get('skips that'), 'passed')
    assert.notEqual(file?.tests.get('skips that'), 'failed')
  })

  describe('normalized-json', () => {
    const files = {
      'tests/math.test.js': [
        "describe('math', () => {",
        "  test('adds', () => { expect(1 + 1).toBe(2) })",
        "  test('is wrong', () => { expect(1 + 1).toBe(3) })",
        "  test.skip('is skipped', () => {})",
        '})',
        '',
      ].join('\n'),
      'tests/ok.test.js': passing('fine'),
    }

    it('writes a NormalizedRun to the outputFile, next to the default reporter', async () => {
      const project = await makeProject(files)
      const outputFile = project.path('results/run.json')
      const ran = await runProject(project, {
        reporters: ['default', ['normalized-json', { outputFile, suite: 'my-suite' }]],
      })

      assert.equal(ran.exitCode, 1)
      assert.match(ran.stderr, /FAIL tests\/math\.test\.js/)
      assert.equal(ran.stdout, '', 'the JSON went to the file')

      const view = viewOfNormalized(await readFile(outputFile, 'utf8'))
      assert.equal(view.schemaVersion, 1)
      assert.equal(view.runner, 'provino:jest')
      assert.equal(view.suite, 'my-suite')
      assert.equal(view.success, false)
      assert.deepEqual([...view.files.keys()], ['tests/math.test.js', 'tests/ok.test.js'])
      const math = view.files.get('tests/math.test.js')
      assert.equal(math?.status, 'failed')
      assert.deepEqual(
        [...(math?.tests ?? [])],
        [
          ['math > adds', 'passed'],
          ['math > is wrong', 'failed'],
          ['math > is skipped', 'skipped'],
        ],
      )
      const ok = view.files.get('tests/ok.test.js')
      assert.equal(ok?.status, 'passed')
      assert.deepEqual([...(ok?.tests ?? [])], [['fine', 'passed']])
    })

    it('writes to stdout without an outputFile, and the suite is the root directory’s name', async () => {
      const project = await makeProject(files)
      const ran = await runProject(project, { reporters: ['normalized-json'] })

      assert.equal(ran.exitCode, 1)
      assert.doesNotMatch(ran.stderr, /PASS|Test Suites/, 'no default reporter')
      const view = viewOfNormalized(ran.stdout)
      assert.equal(view.schemaVersion, 1)
      assert.equal(view.suite, project.dir.split('/').pop())
      assert.equal(view.files.size, 2)
    })
  })

  describe('env.ci in the normalized run is the ci the run resolved', () => {
    /** Runs a passing project with `CI` set to `value` (unset when `undefined`) and reads `env.ci`. */
    async function ciOf(value: string | undefined, options: Partial<RunOptions> = {}) {
      const project = await makeProject({ 'tests/a.test.js': passing('a') })
      const before = process.env.CI
      try {
        if (value === undefined) delete process.env.CI
        else process.env.CI = value
        const ran = await runProject(project, {
          pool: 'inline',
          reporters: ['normalized-json'],
          ...options,
        })
        assert.equal(ran.exitCode, 0, ran.stderr)
        return viewOfNormalized(ran.stdout).ci
      } finally {
        if (before === undefined) delete process.env.CI
        else process.env.CI = before
      }
    }

    it('reads CI the way isCi does: case and spaces do not make false a CI', async () => {
      assert.equal(await ciOf(undefined), false)
      for (const value of ['', '0', 'false', 'FALSE', ' false ']) {
        assert.equal(await ciOf(value), false, JSON.stringify(value))
      }
      for (const value of ['true', '1', ' TRUE ']) {
        assert.equal(await ciOf(value), true, JSON.stringify(value))
      }
    })

    it('is the ci option when it is given, whatever CI says', async () => {
      assert.equal(await ciOf(undefined, { ci: true }), true)
      assert.equal(await ciOf('true', { ci: false }), false)
    })
  })

  it('runs a reporter object, and several reporters see every event in order', async () => {
    const project = await makeProject({ 'tests/a.test.js': passing('a') })
    const seen: string[] = []
    const ran = await runProject(project, {
      reporters: [
        { name: 'first', 'run:start': () => void seen.push('first run:start') },
        {
          name: 'second',
          'run:start': () => void seen.push('second run:start'),
          'file:end': (result) => void seen.push(`file:end ${result.file.path}`),
          'run:end': (summary) => void seen.push(`run:end ${summary.reason}`),
        },
      ],
    })

    assert.equal(ran.exitCode, 0, ran.stderr)
    assert.deepEqual(seen, [
      'first run:start',
      'second run:start',
      'file:end tests/a.test.js',
      'run:end passed',
    ])
    assert.doesNotMatch(ran.stderr, /PASS|Test Suites/, 'only the reporters given run')
  })

  it('a reporter that throws fails the run and is said on stderr', async () => {
    const project = await makeProject({ 'tests/a.test.js': passing('a') })
    const ran = await runProject(project, {
      reporters: [
        {
          name: 'broken',
          'run:end': () => {
            throw new Error('reporter broke')
          },
        },
      ],
    })

    assert.equal(ran.exitCode, 1)
    assert.equal(ran.summary?.reason, 'passed', 'the tests themselves passed')
    assert.match(ran.stderr, /a reporter failed: reporter broke/)
  })

  describe('the results cache', () => {
    it('is written by default, in the project’s node_modules/.cache/provino', async () => {
      const project = await makeProject({ 'tests/a.test.js': passing('a') })
      const ran = await runProject(project)

      assert.equal(ran.exitCode, 0, ran.stderr)
      assert.ok(existsSync(project.path('node_modules/.cache/provino/results.json')))
    })

    it('is neither read nor written with cache: false', async () => {
      const project = await makeProject({ 'tests/a.test.js': passing('a') })
      const ran = await runProject(project, { cache: false })

      assert.equal(ran.exitCode, 0, ran.stderr)
      assert.equal(existsSync(project.path('node_modules/.cache/provino')), false)
    })
  })

  describe('the pool', () => {
    it('forks by default, and an inline pool runs in this process', async () => {
      const pidFile = (dir: string) => join(dir, 'worker.pid')
      const forked = await makeProject((dir) => ({ 'tests/a.test.js': noting('a', pidFile(dir)) }))
      const inline = await makeProject((dir) => ({ 'tests/a.test.js': noting('a', pidFile(dir)) }))

      assert.equal((await runProject(forked)).exitCode, 0)
      assert.equal((await runProject(inline, { pool: 'inline' })).exitCode, 0)

      const [forkedPid] = await notedPids(pidFile(forked.dir))
      const [inlinePid] = await notedPids(pidFile(inline.dir))
      assert.ok(forkedPid !== undefined && forkedPid !== process.pid, 'a fork has its own pid')
      assert.equal(inlinePid, process.pid)
      assert.equal(isRunning(forkedPid), false, 'and it has exited')
    })

    it('runs on threads', async () => {
      const project = await makeProject({
        'tests/a.test.js': passing('a'),
        'tests/b.test.js': passing('b'),
      })
      const ran = await runProject(project, { pool: 'threads', maxWorkers: 2 })

      assert.equal(ran.exitCode, 0, ran.stderr)
      assert.equal(ran.summary?.files.length, 2)
    })

    it('never has more workers than maxWorkers, and every one has exited afterwards', async () => {
      const many = await makeProject((dir) =>
        Object.fromEntries(
          ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => [
            `tests/${name}.test.js`,
            noting(name, join(dir, 'workers.pids')),
          ]),
        ),
      )
      const ran = await runProject(many, { maxWorkers: 2 })

      assert.equal(ran.exitCode, 0, ran.stderr)
      const pids = await notedPids(many.path('workers.pids'))
      assert.equal(pids.length, 6, 'every file ran')
      assert.ok(new Set(pids).size <= 2, `at most two workers (saw ${new Set(pids).size})`)
      assert.ok(
        pids.every((pid) => !isRunning(pid)),
        'no worker outlived the run',
      )
    })
  })

  describe('being called more than once', () => {
    it('works twice in a row, on the same project and on another', async () => {
      const a = await makeProject({ 'tests/a.test.js': passing('a') })
      const b = await makeProject({ 'tests/b.test.js': failing('b') })

      const first = await runProject(a)
      const second = await runProject(a)
      const third = await runProject(b)

      assert.equal(first.exitCode, 0, first.stderr)
      assert.equal(second.exitCode, 0, second.stderr)
      assert.equal(third.exitCode, 1)
      assert.deepEqual(
        second.summary?.files.map((file) => file.state),
        ['pass'],
      )
    })

    it('works concurrently on different projects, each with its own pool and output', async () => {
      const passes = await makeProject({
        'tests/p1.test.js': passing('p1'),
        'tests/p2.test.js': passing('p2'),
      })
      const fails = await makeProject({
        'tests/f1.test.js': failing('f1'),
        'tests/f2.test.js': passing('f2'),
      })
      const [good, bad] = await Promise.all([
        runProject(passes, { maxWorkers: 2 }),
        runProject(fails, { maxWorkers: 2 }),
      ])

      assert.equal(good.exitCode, 0, good.stderr)
      assert.equal(bad.exitCode, 1)
      assert.match(good.stderr, /Test Suites: 2 passed, 2 total/)
      assert.doesNotMatch(good.stderr, /f1\.test\.js/, 'the other run’s output stayed out')
      assert.match(bad.stderr, /FAIL tests\/f1\.test\.js/)
      assert.doesNotMatch(bad.stderr, /p1\.test\.js/)
    })
  })

  it('stops with exit code 130 and no files reported when the signal has aborted', async () => {
    const project = await makeProject({
      'tests/a.test.js': passing('a'),
      'tests/b.test.js': passing('b'),
    })
    const ran = await runProject(project, { signal: AbortSignal.abort() })

    assert.equal(ran.exitCode, 130)
    assert.equal(ran.summary?.reason, 'interrupted')
    assert.deepEqual(ran.summary?.files, [])
  })
})
