// The `provino` bin as a black box: a child process per case, with a deadline, so a process that
// does not end by itself fails the test instead of hanging the suite.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { failing, passing, spawnCli, trackedProjects, viewOfNormalized } from './support.ts'

const makeProject = trackedProjects()

describe('provino run', () => {
  it('passes a passing project: exit 0, and the process ends by itself', async () => {
    const project = await makeProject({
      'tests/a.test.js': passing('a'),
      'tests/b.test.js': passing('b'),
    })
    const ended = await spawnCli(['run', '--config', project.config], { cwd: project.dir })

    assert.equal(ended.signal, null, 'it exited, it was not killed')
    assert.equal(ended.code, 0, ended.stderr)
    assert.match(ended.stderr, /PASS tests\/a\.test\.js/)
    assert.match(ended.stderr, /Test Suites: 2 passed, 2 total/)
    assert.equal(ended.stdout, '', 'the default reporter writes to stderr')
  })

  it('exits 1 for a failing test, and names it', async () => {
    const project = await makeProject({
      'tests/ok.test.js': passing('ok'),
      'tests/bad.test.js': failing('the bad one'),
    })
    const ended = await spawnCli(['run', '--config', project.config], { cwd: project.dir })

    assert.equal(ended.signal, null)
    assert.equal(ended.code, 1)
    assert.match(ended.stderr, /FAIL tests\/bad\.test\.js/)
    assert.match(ended.stderr, /the bad one/)
  })

  it('takes a relative config path from the working directory, and -c', async () => {
    const project = await makeProject({ 'tests/a.test.js': passing('a') })
    const long = await spawnCli(['run', '--config', 'provino.config.mjs'], { cwd: project.dir })
    const short = await spawnCli(['run', '-c', 'provino.config.mjs'], { cwd: project.dir })

    assert.equal(long.code, 0, long.stderr)
    assert.equal(short.code, 0, short.stderr)
  })

  it('writes normalized-json to --outputFile, and to stdout without one', async () => {
    const project = await makeProject({
      'tests/a.test.js': passing('a'),
      'tests/b.test.js': failing('b'),
    })
    const toFile = await spawnCli(
      [
        'run',
        '--config',
        project.config,
        '--reporter',
        'normalized-json',
        '--outputFile',
        'out.json',
      ],
      { cwd: project.dir },
    )
    assert.equal(toFile.code, 1)
    assert.equal(toFile.stdout, '')
    const fromFile = viewOfNormalized(await readFile(project.path('out.json'), 'utf8'))
    assert.equal(fromFile.runner, 'provino:jest')
    assert.equal(fromFile.files.get('tests/a.test.js')?.status, 'passed')
    assert.equal(fromFile.files.get('tests/b.test.js')?.status, 'failed')

    const toStdout = await spawnCli(
      ['run', '--config', project.config, '--reporter', 'normalized-json'],
      { cwd: project.dir },
    )
    assert.equal(toStdout.code, 1)
    assert.equal(viewOfNormalized(toStdout.stdout).files.size, 2)
  })

  it('applies --maxWorkers, --pool, -t, --ci, --passWithNoTests and --no-cache', async () => {
    const project = await makeProject({
      'tests/a.test.js': [
        "test('keeps this', () => { expect(1).toBe(1) })",
        "test('drops that', () => { expect(1).toBe(2) })",
        '',
      ].join('\n'),
    })
    const filtered = await spawnCli(
      [
        'run',
        '--config',
        project.config,
        '--maxWorkers',
        '1',
        '--pool',
        'threads',
        '-t',
        'keeps',
        '--ci',
        '--no-cache',
      ],
      { cwd: project.dir },
    )
    assert.equal(filtered.code, 0, filtered.stderr)
    assert.equal(existsSync(project.path('node_modules/.cache/provino')), false, '--no-cache')

    const empty = await makeProject({})
    const none = await spawnCli(['run', '--config', empty.config], { cwd: empty.dir })
    const allowed = await spawnCli(['run', '--config', empty.config, '--passWithNoTests'], {
      cwd: empty.dir,
    })
    assert.equal(none.code, 1)
    assert.equal(allowed.code, 0, allowed.stderr)
  })

  it('reads -t=<pattern> and -c=<file> without the =', async () => {
    const project = await makeProject({
      'tests/a.test.js': [
        "test('keeps this', () => { expect(1).toBe(1) })",
        "test('drops that', () => { expect(1).toBe(2) })",
        '',
      ].join('\n'),
    })
    // Before the fix the pattern was "=drops", nothing matched, and the run passed with no tests.
    const ended = await spawnCli(
      ['run', `-c=${project.config}`, '-t=drops', '--reporter', 'normalized-json'],
      { cwd: project.dir },
    )
    assert.equal(ended.code, 1, ended.stderr)
    const view = viewOfNormalized(ended.stdout)
    assert.equal(view.files.get('tests/a.test.js')?.tests.get('drops that'), 'failed')
  })

  it('exits 2 for an --outputFile that is empty or a directory, before running any test', async () => {
    const project = await makeProject({ 'tests/a.test.js': passing('a') })
    for (const outputFile of ['', '.']) {
      const ended = await spawnCli(
        [
          'run',
          '--config',
          project.config,
          '--reporter',
          'normalized-json',
          '--outputFile',
          outputFile,
        ],
        { cwd: project.dir },
      )
      assert.equal(ended.code, 2, `${JSON.stringify(outputFile)}: ${ended.stderr}`)
      assert.match(ended.stderr, /outputFile/)
      assert.doesNotMatch(ended.stderr, /PASS|FAIL/, 'no file ran')
    }
  })

  it('exits 2 for a repeated --reporter', async () => {
    const ended = await spawnCli([
      'run',
      '--config',
      'x.mjs',
      '--reporter',
      'normalized-json',
      '--reporter',
      'normalized-json',
    ])
    assert.equal(ended.code, 2)
    assert.equal(ended.stdout, '')
    assert.match(ended.stderr, /given more than once/)
  })

  it('exits 2 for a pattern that is not a regular expression, and starts nothing', async () => {
    const project = await makeProject({ 'tests/a.test.js': passing('a') })
    const ended = await spawnCli(['run', '--config', project.config, '--testNamePattern', '('], {
      cwd: project.dir,
    })

    assert.equal(ended.code, 2)
    assert.match(ended.stderr, /not a valid regular expression/)
    assert.doesNotMatch(ended.stderr, /PASS/)
  })

  it('exits 2 with the message for a config file that is not there', async () => {
    const ended = await spawnCli(['run', '--config', 'nope.config.mjs'])

    assert.equal(ended.code, 2)
    assert.match(ended.stderr, /can't load the config file/)
    assert.match(ended.stderr, /nope\.config\.mjs/)
  })
})

describe('usage errors: the message and the usage text on stderr, exit 2', () => {
  const cases: readonly (readonly [string, readonly string[], RegExp])[] = [
    ['no command', [], /a command is required/],
    ['an unknown command', ['walk'], /unknown command "walk"/],
    ['an unknown flag', ['run', '--config', 'x.mjs', '--turbo'], /--turbo/],
    ['a missing --config', ['run'], /--config <file> is required/],
    ['a --config with no value', ['run', '--config'], /--config/],
    ['a stray argument', ['run', '--config', 'x.mjs', 'tests/a.test.js'], /tests\/a\.test\.js/],
    ['a bad --pool', ['run', '--config', 'x.mjs', '--pool', 'cluster'], /--pool must be one of/],
    ['a --maxWorkers of 0', ['run', '--config', 'x.mjs', '--maxWorkers', '0'], /--maxWorkers/],
    ['a --maxWorkers of 1.5', ['run', '--config', 'x.mjs', '--maxWorkers', '1.5'], /--maxWorkers/],
    ['a --maxWorkers of abc', ['run', '--config', 'x.mjs', '--maxWorkers', 'abc'], /--maxWorkers/],
    [
      'an unknown --reporter',
      ['run', '--config', 'x.mjs', '--reporter', 'verbose'],
      /unknown reporter "verbose"/,
    ],
    [
      '--outputFile without normalized-json',
      ['run', '--config', 'x.mjs', '--outputFile', 'out.json'],
      /--outputFile needs --reporter normalized-json/,
    ],
  ]
  for (const [name, args, message] of cases) {
    it(name, async () => {
      const ended = await spawnCli(args)

      assert.equal(ended.signal, null)
      assert.equal(ended.code, 2, ended.stderr)
      assert.match(ended.stderr, message)
      assert.match(ended.stderr, /Usage: provino <command>/)
      assert.equal(ended.stdout, '')
    })
  }
})

describe('provino --help', () => {
  it('prints the usage text to stdout and exits 0, also after run', async () => {
    for (const args of [['--help'], ['-h'], ['run', '--help']]) {
      const ended = await spawnCli(args)
      assert.equal(ended.code, 0, ended.stderr)
      assert.match(ended.stdout, /Usage: provino <command>/)
      assert.match(ended.stdout, /--maxWorkers/)
    }
  })
})
