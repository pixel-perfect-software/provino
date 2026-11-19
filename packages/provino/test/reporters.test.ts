// T9.7 through the bin: `provino jest` against the text real Jest 30.5.2 printed for the same
// project (`cli/report-default`, `report-verbose`, `report-silent`: the lines each recording kept,
// its `keepLines`), then what the environment and the flags change: an agent, GitHub Actions,
// colour, and the reporters `provino run` names.
import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Writable } from 'node:stream'
import { describe, it } from 'node:test'
import { run } from 'provino/node'
import { runJest } from './live-jest.ts'
import { loadFixture, materialize } from './recorded.ts'
import {
  Collect,
  ESC,
  failing,
  jestConfigJson,
  passing,
  spawnCli,
  trackedProjects,
  withoutCiEnvironment,
  withoutNodeNoise,
} from './support.ts'

const makeProject = trackedProjects()

/** Our stderr as the recording sees Jest's: the lines it kept, with each timing taken out. */
function kept(stderr: string, keepLines: string): string[] {
  const keep = new RegExp(keepLines)
  return stderr
    .split('\n')
    .filter((line) => keep.test(line))
    .map((line) => line.replace(/ \((?:<dur>|\d+(?:\.\d+)? ms)\)$/, ''))
}

/** Provino on the fixture's project, with the flags the recording ran Jest with. */
async function provinoOn(id: string): Promise<{
  readonly code: number | null
  readonly lines: string[]
  readonly expected: string[]
  readonly expectedCode: number | null | undefined
  readonly stderr: string
}> {
  const fixture = await loadFixture(id)
  const project = await materialize(fixture)
  try {
    const keepLines = fixture.manifest.run?.keepLines
    assert.ok(keepLines !== undefined, `${id} keeps lines`)
    const argv = fixture.manifest.run?.argv?.jest ?? []
    const cwd = fixture.manifest.run?.cwd
    const ended = await spawnCli(
      ['jest', `--config=${join(project.root, 'jest.config.json')}`, '--ci', ...argv],
      { cwd: cwd === undefined ? project.root : join(project.root, cwd) },
    )
    const golden = fixture.golden.observed
    return {
      code: ended.code,
      lines: kept(ended.stderr, keepLines),
      expected: kept(golden?.stderr ?? '', keepLines),
      expectedCode: golden?.exitCode,
      stderr: ended.stderr,
    }
  } finally {
    await project.dispose()
  }
}

describe('provino jest prints what Jest 30.5.2 printed (the lines each recording kept)', () => {
  for (const [id, what] of [
    ['cli/report-default', 'the default reporter: headers, the console block, the totals'],
    [
      'cli/report-verbose',
      '--verbose: each test under its describe titles, console before the header',
    ],
    [
      'cli/report-console-helper',
      'a console.error from a helper: code frame and every frame outside Jest; warn likewise, log its first frame',
    ],
    [
      'cli/report-console-helper-nostack',
      '--noStackTrace keeps the first frame of a warn or error entry and prints no code frame',
    ],
    [
      'cli/report-console-helper-verbose',
      '--verbose: the title at 2 spaces, the frames still at 6',
    ],
    ['cli/report-silent', '--silent: the same headers and totals, and no console output'],
    [
      'cli/report-single-file',
      'a single test file lists its tests with no --verbose, console first (runJest turns it on)',
    ],
    [
      'cli/report-single-file-silent',
      'a single test file under --silent is not verbose: header, totals, no console',
    ],
    [
      'cli/report-single-file-verbose-false',
      'a single test file under verbose: false is not verbose: the console block under the header',
    ],
    ['cli/show-seed', '--showSeed: `Seed:` before the totals, with the order kept (B23d A4)'],
    [
      'cli/randomize-shows-seed',
      '--randomize turns showSeed on: the seed line with no --showSeed (B23d A4)',
    ],
    ['cli/report-ran-pattern', 'a file pattern: `Ran all test suites matching snap.`'],
    [
      'cli/report-from-subdir',
      'run from below rootDir: each header is relative to the working directory, not the root',
    ],
    ['cli/report-ran-name', '-t: `Ran all test suites with tests matching "inner".`'],
    ['cli/report-ran-by-path', '--runTestsByPath: `within paths "a.test.ts"`'],
    [
      'cli/report-snapshot-summary',
      'the per-file snapshot lines and the Snapshot Summary (written, failed, obsolete)',
    ],
  ] as const) {
    it(`${what} (${id})`, async () => {
      const run = await provinoOn(id)
      assert.equal(run.code, run.expectedCode, run.stderr)
      assert.ok(run.expected.length >= 3, 'the recording kept lines')
      assert.deepEqual(run.lines, run.expected, run.stderr)
    })
  }

  it('--logHeapUsage: each header ends ` (<n> MB heap size)` (cli/log-heap-usage, B23d A4)', async () => {
    const fixture = await loadFixture('cli/log-heap-usage')
    const project = await materialize(fixture)
    try {
      const keepLines = fixture.manifest.run?.keepLines
      assert.ok(keepLines !== undefined)
      const mask = (text: string): string[] =>
        kept(text, keepLines)
          .map((line) => line.replace(/\d+(?= MB heap size)/, '<masked>'))
          .sort()
      const ended = await spawnCli(
        [
          'jest',
          `--config=${join(project.root, 'jest.config.json')}`,
          '--ci',
          ...(fixture.manifest.run?.argv?.jest ?? []),
        ],
        { cwd: project.root },
      )
      assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
      assert.deepEqual(
        mask(ended.stderr),
        mask(fixture.golden.observed?.stderr ?? ''),
        ended.stderr,
      )
      assert.ok(mask(ended.stderr).some((line) => line.includes('<masked> MB heap size')))
    } finally {
      await project.dispose()
    }
  })

  it('two projects: the display name before each file, `Ran all test suites in 2 projects.` (cli/report-ran-projects)', async () => {
    const fixture = await loadFixture('cli/report-ran-projects')
    const project = await materialize(fixture)
    try {
      // The recorder reserves `projects`, so the recording named them on the command line; here
      // they are a config key (`provino jest` refuses the flag).
      const config = join(project.root, 'jest.config.json')
      await writeFile(
        config,
        JSON.stringify({
          rootDir: project.root,
          maxWorkers: 1,
          projects: ['<rootDir>/p1', '<rootDir>/p2'],
        }),
      )
      const ended = await spawnCli(['jest', `--config=${config}`, '--ci'], { cwd: project.root })
      const keepLines = fixture.manifest.run?.keepLines ?? ''
      assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
      assert.deepEqual(
        kept(ended.stderr, keepLines),
        kept(fixture.golden.observed?.stderr ?? '', keepLines),
        ended.stderr,
      )
    } finally {
      await project.dispose()
    }
  })

  it('a file of only todo tests, or skipped and todo, is a PASS line and a passed suite; one whose every test is skipped has no line (cli/report-todo-only, DV50)', async () => {
    const run = await provinoOn('cli/report-todo-only')
    assert.equal(run.code, run.expectedCode, run.stderr)
    // Which of the small files runs first depends on the sequencer's tie-break, so the lines are compared as a set.
    assert.deepEqual(run.lines.toSorted(), run.expected.toSorted(), run.stderr)
    assert.ok(run.expected.some((line) => line === 'PASS ./todo-only.test.ts'))
    assert.ok(!run.lines.some((line) => /all-skipped/.test(line)))
    assert.ok(run.lines.includes('Test Suites: 1 skipped, 3 passed, 3 of 4 total'))
  })

  it('--silent hides the console output the default run prints (cli/report-default against report-silent)', async () => {
    const loud = await provinoOn('cli/report-default')
    const quiet = await provinoOn('cli/report-silent')
    assert.ok(loud.lines.some((line) => line === '  ● Console'))
    assert.ok(loud.lines.some((line) => line.trim() === 'from the test'))
    assert.ok(!quiet.lines.some((line) => /Console|from the test|a warning/.test(line)))
    assert.doesNotMatch(quiet.stderr, /from the test|a warning/)
  })

  it('--verbose lists each test (cli/report-verbose)', async () => {
    const run = await provinoOn('cli/report-verbose')
    for (const line of [
      '  ✓ stands alone',
      '  math',
      '    ✓ adds',
      '      ✓ subtracts',
      '    ✕ fails',
      '  ○ skipped is skipped',
      '  ✎ todo is planned',
    ]) {
      assert.ok(run.lines.includes(line), `lists "${line}":\n${run.lines.join('\n')}`)
    }
  })
})

describe('a run of one test file is verbose under provino jest, as Jest has it (runJest)', () => {
  const config = (dir: string): string => jestConfigJson(dir)

  it('lists the test with no flag, for one file; two files list none', async () => {
    const one = await makeProject({ 'tests/a.test.js': passing('only one') })
    const alone = await spawnCli(['jest', '--config', config(one.dir)], { cwd: one.dir })
    assert.equal(alone.code, 0, alone.stderr)
    assert.match(alone.stderr, /^ {2}✓ only one( \(\d+ ms\))?$/m)
    const two = await makeProject({
      'tests/a.test.js': passing('first'),
      'tests/b.test.js': passing('second'),
    })
    const both = await spawnCli(['jest', '--config', config(two.dir)], { cwd: two.dir })
    assert.equal(both.code, 0, both.stderr)
    assert.doesNotMatch(both.stderr, /✓/)
  })

  it('counts the files the filters leave: a path pattern that picks one of two', async () => {
    const two = await makeProject({
      'tests/a.test.js': passing('first'),
      'tests/b.test.js': passing('second'),
    })
    // `tests/a.test`, not `a.test`: a pattern is a regular expression tried on the absolute path,
    // and a temp dir that ends in `a` (1 in 62) would match `a/test` for `b.test.js` too.
    const ran = await spawnCli(['jest', '--config', config(two.dir), 'tests/a.test'], {
      cwd: two.dir,
    })
    assert.match(ran.stderr, /^ {2}✓ first( \(\d+ ms\))?$/m)
    assert.doesNotMatch(ran.stderr, /second/)
  })

  it('--no-verbose and --verbose=false keep it off, as real Jest does (live)', async () => {
    const project = await makeProject({ 'tests/a.test.js': passing('only one') })
    for (const flag of ['--no-verbose', '--verbose=false']) {
      const args = ['--config', config(project.dir), flag]
      const live = await runJest(project.dir, ['--watchman=false', '--ci', ...args])
      const ours = await spawnCli(['jest', '--ci', ...args], { cwd: project.dir })
      assert.doesNotMatch(live.stderr, /✓/, `Jest ${flag}`)
      assert.doesNotMatch(ours.stderr, /✓/, `Provino ${flag}`)
      assert.match(ours.stderr, /^PASS tests\/a\.test\.js$/m)
    }
  })

  it('--silent keeps it off, with the file’s console output too (live)', async () => {
    const project = await makeProject({ 'tests/a.test.js': passing('only one') })
    const args = ['--config', config(project.dir), '--silent']
    const live = await runJest(project.dir, ['--watchman=false', '--ci', ...args])
    const ours = await spawnCli(['jest', '--ci', ...args], { cwd: project.dir })
    assert.doesNotMatch(live.stderr, /✓/)
    assert.doesNotMatch(ours.stderr, /✓/)
  })

  it('is the dialect’s: provino run lists the test of one file under a Jest config (report.listTestsForSingleFile)', async () => {
    const project = await makeProject({ 'tests/a.test.js': passing('only one') })
    const ran = await spawnCli(['run', '--config', project.config], { cwd: project.dir })
    assert.equal(ran.code, 0, ran.stderr)
    assert.match(ran.stderr, /^PASS tests\/a\.test\.js\n {2}✓ only one( \(\d+ ms\))?\n\n/m)
  })
})

const AGENT = { CLAUDECODE: '1' }

describe('the environment picks the reporters when none are named', () => {
  it('an agent gets the agent reporter: the failures and the totals, no PASS line', async () => {
    const project = await makeProject({
      'tests/ok.test.js': passing('ok'),
      'tests/bad.test.js': failing('bad'),
    })
    const ran = await spawnCli(['run', '--config', project.config], {
      cwd: project.dir,
      env: AGENT,
    })
    assert.equal(ran.code, 1, ran.stderr)
    assert.match(ran.stderr, /^FAIL tests\/bad\.test\.js$/m)
    assert.doesNotMatch(ran.stderr, /ok\.test\.js/)
    assert.match(ran.stderr, /Test Suites: 1 failed, 1 passed, 2 total/)
  })

  it('every variable the list names, and AI_AGENT, make it the agent reporter', async () => {
    const project = await makeProject({ 'tests/ok.test.js': passing('ok') })
    for (const env of [{ AI_AGENT: 'my-agent' }, { CURSOR_AGENT: '1' }, { GEMINI_CLI: '1' }]) {
      const ran = await spawnCli(['run', '--config', project.config], { cwd: project.dir, env })
      assert.equal(ran.code, 0, ran.stderr)
      assert.doesNotMatch(ran.stderr, /PASS/, JSON.stringify(env))
      assert.match(ran.stderr, /Test Suites: 1 passed, 1 total/)
    }
  })

  it('a reporter named on the command line is never replaced, under an agent too', async () => {
    const project = await makeProject({ 'tests/ok.test.js': passing('ok') })
    const ran = await spawnCli(['run', '--config', project.config, '--reporter', 'default'], {
      cwd: project.dir,
      env: AGENT,
    })
    assert.match(ran.stderr, /^PASS tests\/ok\.test\.js$/m)
  })

  it('provino jest gets the agent reporter under an agent, with --verbose too (Jest’s detectAgent comes first)', async () => {
    const project = await makeProject({ 'tests/ok.test.js': passing('ok') })
    const ran = await spawnCli(['jest', '--config', jestConfigJson(project.dir), '--verbose'], {
      cwd: project.dir,
      env: AGENT,
    })
    assert.equal(ran.code, 0, ran.stderr)
    assert.doesNotMatch(ran.stderr, /PASS|✓/)
  })

  it('GitHub Actions adds the github-actions reporter beside the default one', async () => {
    const project = await makeProject({ 'tests/bad.test.js': failing('bad') })
    const ran = await spawnCli(['run', '--config', project.config], {
      cwd: project.dir,
      env: { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: project.dir },
    })
    assert.equal(ran.code, 1, ran.stderr)
    assert.match(ran.stderr, /^FAIL tests\/bad\.test\.js$/m)
    assert.match(ran.stderr, /^::error file=tests\/bad\.test\.js,line=\d+,col=\d+,title=bad::/m)
  })

  it('and an agent on GitHub Actions gets both the agent reporter and the annotations', async () => {
    const project = await makeProject({ 'tests/bad.test.js': failing('bad') })
    const ran = await spawnCli(['run', '--config', project.config], {
      cwd: project.dir,
      env: { ...AGENT, GITHUB_ACTIONS: 'true' },
    })
    assert.match(ran.stderr, /^::error file=/m)
    assert.match(ran.stderr, /^FAIL tests\/bad\.test\.js$/m)
  })
})

/** A stderr that says it is a terminal of this width, as a `tty.WriteStream` does. */
class Terminal extends Collect {
  readonly isTTY = true
  readonly columns = 60
}

describe('a terminal (through run(), where a stderr can say it is one)', () => {
  const ok = { 'tests/a.test.js': passing('a'), 'tests/b.test.js': passing('b') }

  // D135: with no reporter named, an interactive terminal gets `provino`; `default`'s own live
  // block is held here by naming it.
  it('default gets colour and the live block of the running files, erased before the results', async () => {
    const project = await makeProject(ok)
    const stderr = new Terminal()
    const ran = await run({
      config: project.config,
      stdout: new Collect(),
      stderr,
      env: {},
      reporters: ['default'],
    })
    assert.equal(ran.exitCode, 0, stderr.text)
    assert.match(stderr.text, new RegExp(`${ESC}\\[33m RUNS ${ESC}`))
    assert.match(stderr.text, new RegExp(`${ESC}\\[1F${ESC}\\[0J`))
    assert.match(stderr.text, new RegExp(`${ESC}\\[32m PASS ${ESC}\\[39m`))
    assert.match(stderr.text, /Test Suites:/)
    // The block is gone by the totals: the last RUNS is followed by an erase.
    const last = stderr.text.lastIndexOf('RUNS')
    assert.match(stderr.text.slice(last), new RegExp(`${ESC}\\[1F${ESC}\\[0J`))
  })

  it('gets no live block in CI, and still has colour', async () => {
    const project = await makeProject(ok)
    const stderr = new Terminal()
    await run({ config: project.config, stdout: new Collect(), stderr, env: { CI: 'true' } })
    assert.doesNotMatch(stderr.text, /RUNS/)
    assert.match(stderr.text, new RegExp(`${ESC}\\[32m PASS `))
  })

  it('gets no live block or colour under an agent: the agent reporter', async () => {
    const project = await makeProject({ 'tests/bad.test.js': failing('bad') })
    const stderr = new Terminal()
    await run({ config: project.config, stdout: new Collect(), stderr, env: { CLAUDECODE: '1' } })
    assert.doesNotMatch(stderr.text, /RUNS/)
    assert.match(stderr.text, /FAIL tests\/bad\.test\.js/)
  })

  it('NO_COLOR turns the colour off and keeps default’s live block; TERM=dumb has neither', async () => {
    const project = await makeProject(ok)
    const plain = new Terminal()
    // Named (D135: a terminal that names none gets `provino`).
    await run({
      config: project.config,
      stdout: new Collect(),
      stderr: plain,
      env: { NO_COLOR: '1' },
      reporters: ['default'],
    })
    // Jest pads RUNS whatever the colour (`Status.ts` L23-L24).
    assert.match(plain.text, / RUNS {2}tests\/[ab]\.test\.js/)
    assert.doesNotMatch(plain.text, new RegExp(`${ESC}\\[3\\dm`))
    const dumb = new Terminal()
    await run({
      config: project.config,
      stdout: new Collect(),
      stderr: dumb,
      env: { TERM: 'dumb' },
    })
    assert.doesNotMatch(dumb.text, /RUNS/)
    assert.doesNotMatch(dumb.text, new RegExp(ESC))
  })

  it('a stderr that is not a terminal gets neither, whatever FORCE_COLOR says about the live block', async () => {
    const project = await makeProject(ok)
    const stderr = new Collect()
    await run({ config: project.config, stdout: new Collect(), stderr, env: { FORCE_COLOR: '1' } })
    assert.doesNotMatch(stderr.text, /RUNS/)
    assert.match(stderr.text, new RegExp(`${ESC}\\[32m PASS `))
  })
})

/**
 * `runJestCommand`, loaded by URL: the type-test project includes this directory but not the
 * package's source. In this process, so its stderr can say it is a terminal.
 */
const { runJestCommand } = (await import(
  new URL('../src/internal/jest-command.ts', import.meta.url).href
)) as {
  runJestCommand(
    args: readonly string[],
    io: {
      stdout: Writable
      stderr: Writable
      cwd: string
      env: Readonly<Record<string, string | undefined>>
    },
  ): Promise<number>
}

/** The harness's terminal model, loaded by path: `provino` may not import `@provino/harness`. */
const { renderTranscript } = (await import(
  new URL('../../harness/src/internal/watch-transcript.ts', import.meta.url).href
)) as { renderTranscript(output: string): string }

const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`

/** Whether a run's stderr is the `provino` reporter's live output: the cursor hidden and shown again, its end card, none of Jest's totals. */
function assertProvinoLive(text: string): void {
  assert.ok(text.includes(HIDE_CURSOR), text)
  assert.ok(text.lastIndexOf(SHOW_CURSOR) > text.indexOf(HIDE_CURSOR), text)
  assert.match(text, /2 tests passed in 2 files/)
  assert.doesNotMatch(text, /Test Suites:|Ran all test suites| RUNS /)
  // The footer is gone from the screen the bytes leave: the end card is what is left.
  const screen = renderTranscript(text)
  assert.doesNotMatch(screen, / of \d+ files? |starting \d+ workers?/, screen)
  assert.match(screen, /2 tests passed in 2 files/)
}

/** Whether it is Jest's text and no `provino` output. */
function assertJestText(text: string): void {
  assert.match(text, /Test Suites:|Tests:/)
  assert.ok(!text.includes(HIDE_CURSOR), text)
  assert.doesNotMatch(text, /tests passed in \d+ files/)
}

describe('D135: an interactive terminal with no reporter named gets provino', () => {
  const ok = { 'tests/a.test.js': passing('a'), 'tests/b.test.js': passing('b') }

  it('under provino run (run(), a stderr that is a terminal, not CI, no agent)', async () => {
    const project = await makeProject(ok)
    const stderr = new Terminal()
    const ran = await run({ config: project.config, stdout: new Collect(), stderr, env: {} })
    assert.equal(ran.exitCode, 0, stderr.text)
    assertProvinoLive(stderr.text)
  })

  it('under provino jest: no summary, no closing line, no RUNS block', async () => {
    const project = await makeProject(ok)
    const stderr = new Terminal()
    // An interactive terminal: none of a CI runner's variables reach the Jest reader.
    const code = await withoutCiEnvironment(() =>
      runJestCommand([`--config=${jestConfigJson(project.dir)}`], {
        stdout: new Collect(),
        stderr,
        cwd: project.dir,
        env: {},
      }),
    )
    assert.equal(code, 0, stderr.text)
    assertProvinoLive(stderr.text)
  })

  it('not in CI, under an agent, with TERM=dumb, or with --verbose: Jest’s text stays', async () => {
    const project = await makeProject(ok)
    // The Jest reader in this process takes CI from the process, not from `io.env`, so the Jest
    // side of the CI case is `--ci` (the bin reads both from one environment).
    for (const [env, flags] of [
      [{ CI: '1' }, ['--ci']],
      [{ CLAUDECODE: '1' }, []],
      [{ TERM: 'dumb' }, []],
    ] as const) {
      const viaRun = new Terminal()
      await run({ config: project.config, stdout: new Collect(), stderr: viaRun, env })
      assertJestText(viaRun.text)
      const viaJest = new Terminal()
      await runJestCommand([`--config=${jestConfigJson(project.dir)}`, ...flags], {
        stdout: new Collect(),
        stderr: viaJest,
        cwd: project.dir,
        env,
      })
      assertJestText(viaJest.text)
    }
    // D143: `--verbose`, or `verbose` in the config, keeps Jest's verbose reporter.
    for (const args of [
      [`--config=${jestConfigJson(project.dir)}`, '--verbose'],
      [`--config=${jestConfigJson(project.dir, { verbose: true })}`],
    ]) {
      const stderr = new Terminal()
      await runJestCommand(args, { stdout: new Collect(), stderr, cwd: project.dir, env: {} })
      assertJestText(stderr.text)
      // Jest's verbose list, coloured on the terminal.
      assert.match(stderr.text.replaceAll(new RegExp(`${ESC}\\[\\d+m`, 'g'), ''), /✓ a/)
    }
  })

  it('not when a reporter is named: --reporters, the reporters key, run()’s reporters', async () => {
    const project = await makeProject(ok)
    const named = new Terminal()
    await run({
      config: project.config,
      stdout: new Collect(),
      stderr: named,
      env: {},
      reporters: ['default'],
    })
    assertJestText(named.text)
    for (const args of [
      [`--config=${jestConfigJson(project.dir)}`, '--reporters', 'default'],
      [`--config=${jestConfigJson(project.dir, { reporters: ['default'] })}`],
    ]) {
      const stderr = new Terminal()
      await runJestCommand(args, { stdout: new Collect(), stderr, cwd: project.dir, env: {} })
      assertJestText(stderr.text)
    }
  })

  it('not without a terminal: a pipe gets Jest’s text under both commands', async () => {
    const project = await makeProject(ok)
    const viaRun = await spawnCli(['run', '--config', project.config], { cwd: project.dir })
    assertJestText(viaRun.stderr)
    const viaJest = await spawnCli(['jest', `--config=${jestConfigJson(project.dir)}`], {
      cwd: project.dir,
    })
    assertJestText(viaJest.stderr)
  })
})

describe('the provino reporter by name (D141)', () => {
  const ok = { 'tests/a.test.js': passing('a'), 'tests/b.test.js': passing('b') }

  it('on a pipe prints plain lines: no cursor moves, no escape at all', async () => {
    const project = await makeProject(ok)
    const runs = [
      await spawnCli(['run', '--config', project.config, '--reporter', 'provino'], {
        cwd: project.dir,
      }),
      await spawnCli(
        ['jest', `--config=${jestConfigJson(project.dir)}`, '--reporters', 'provino'],
        { cwd: project.dir },
      ),
      await spawnCli(
        ['jest', `--config=${jestConfigJson(project.dir, { reporters: ['provino'] })}`],
        { cwd: project.dir },
      ),
    ]
    for (const ran of runs) {
      assert.equal(ran.code, 0, ran.stderr)
      assert.ok(!ran.stderr.includes(ESC), ran.stderr)
      assert.match(ran.stderr, /^✅ tests\/a\.test\.js · 1 test · /m)
      assert.match(ran.stderr, /^🎉 2 tests passed in 2 files · /m)
      assert.doesNotMatch(ran.stderr, /Test Suites:/)
    }
  })

  it('--no-emoji gives the plain symbols, under provino run and provino jest', async () => {
    const project = await makeProject(ok)
    const runs = [
      await spawnCli(['run', '--config', project.config, '--reporter', 'provino', '--no-emoji'], {
        cwd: project.dir,
      }),
      await spawnCli(
        ['jest', `--config=${jestConfigJson(project.dir)}`, '--no-emoji', '--reporters', 'provino'],
        { cwd: project.dir },
      ),
    ]
    for (const ran of runs) {
      assert.equal(ran.code, 0, ran.stderr)
      assert.match(ran.stderr, /^✓ tests\/a\.test\.js · 1 test · /m)
      assert.doesNotMatch(ran.stderr, /✅|🎉/)
    }
    // PROVINO_EMOJI=0 is the same, and Jest's parser never saw the flag.
    const env = await spawnCli(['run', '--config', project.config, '--reporter', 'provino'], {
      cwd: project.dir,
      env: { PROVINO_EMOJI: '0' },
    })
    assert.match(env.stderr, /^✓ tests\/a\.test\.js/m)
  })

  it('a path named ./provino is still a module, resolved as Jest resolves a custom reporter', async () => {
    const project = await makeProject(ok)
    const ran = await spawnCli(
      ['jest', `--config=${jestConfigJson(project.dir, { reporters: ['./provino'] })}`],
      { cwd: project.dir },
    )
    assert.equal(ran.code, 1, ran.stderr)
    assert.match(
      ran.stderr,
      /Could not resolve a module for a custom reporter\.\n {2}Module name: \.\/provino/,
    )
  })

  it('./html is a module too, resolved as Jest resolves a custom reporter', async () => {
    const project = await makeProject(ok)
    const ran = await spawnCli(
      ['jest', `--config=${jestConfigJson(project.dir, { reporters: ['./html'] })}`],
      { cwd: project.dir },
    )
    assert.equal(ran.code, 1, ran.stderr)
    assert.match(
      ran.stderr,
      /Could not resolve a module for a custom reporter\.\n {2}Module name: \.\/html/,
    )
  })
})

/** What the page carries: its data script, parsed. */
function pageData(html: string): {
  readonly strings: readonly string[]
  readonly files: readonly (readonly number[])[]
  readonly tests: readonly unknown[]
  readonly failures: readonly unknown[]
  readonly title: string
  readonly seed?: number
  readonly sample?: true
} {
  const found = /<script type="application\/json" id="provino-data">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(found?.[1] !== undefined, 'the page has no data script')
  return JSON.parse(found[1])
}

describe('the html reporter (B26 Phase 5, D146)', () => {
  const mixed = { 'tests/ok.test.js': passing('works'), 'tests/bad.test.js': failing('breaks') }

  it('writes one self-contained page to --outputFile, and nothing to stdout', async () => {
    const project = await makeProject(mixed)
    const file = join(project.dir, 'reports', 'run.html')
    const ran = await spawnCli(
      ['run', '--config', project.config, '--reporter', 'html', '--outputFile', file],
      { cwd: project.dir },
    )
    assert.equal(ran.code, 1, ran.stderr)
    assert.equal(ran.stdout, '')
    const html = await readFile(file, 'utf8')
    assert.match(html, /^<!doctype html>/)
    assert.match(html, /default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-/)
    const data = pageData(html)
    assert.deepEqual(data.files.map((row) => data.strings[row[0] ?? 0]).sort(), [
      'tests/bad.test.js',
      'tests/ok.test.js',
    ])
    assert.equal(data.tests.length, 2)
    assert.equal(data.failures.length, 1)
    // The root's directory name stands for the run's root, which is written nowhere in the page, and
    // there is no seed or sample label on a real run.
    assert.equal(data.title, basename(project.dir))
    assert.equal(html.includes(project.dir), false, 'the run’s path is in the page')
    assert.equal(data.seed, undefined)
    assert.equal(data.sample, undefined)
  })

  it('carries the seed of a run that shows one (--showSeed) into the page', async () => {
    const project = await makeProject(mixed)
    const ran = await spawnCli(
      [
        'jest',
        `--config=${jestConfigJson(project.dir)}`,
        '--reporters',
        'html',
        '--showSeed',
        '--seed=7',
      ],
      { cwd: project.dir },
    )
    assert.equal(ran.code, 1, ran.stderr)
    const data = pageData(await readFile(join(project.dir, 'provino-report.html'), 'utf8'))
    assert.equal(data.seed, 7)
  })

  it('writes provino-report.html in the project root when it has no file, never to stdout', async () => {
    const project = await makeProject(mixed)
    const viaRun = await spawnCli(['run', '--config', project.config, '--reporter', 'html'], {
      cwd: project.dir,
    })
    assert.equal(viaRun.code, 1, viaRun.stderr)
    assert.equal(viaRun.stdout, '')
    const file = join(project.dir, 'provino-report.html')
    assert.equal(pageData(await readFile(file, 'utf8')).tests.length, 2)
    // Under provino jest: the name, and the config's own form.
    await rm(file)
    const viaJest = await spawnCli(
      ['jest', `--config=${jestConfigJson(project.dir)}`, '--reporters', 'html'],
      { cwd: project.dir },
    )
    assert.equal(viaJest.code, 1, viaJest.stderr)
    assert.equal(viaJest.stdout, '')
    assert.equal(pageData(await readFile(file, 'utf8')).tests.length, 2)
    const configured = join(project.dir, 'out', 'jest.html')
    const viaConfig = await spawnCli(
      [
        'jest',
        `--config=${jestConfigJson(project.dir, { reporters: [['html', { outputFile: 'out/jest.html' }]] })}`,
      ],
      { cwd: project.dir },
    )
    assert.equal(viaConfig.code, 1, viaConfig.stderr)
    assert.equal(pageData(await readFile(configured, 'utf8')).tests.length, 2)
  })

  it('under provino jest, html beside the default reporter adds the page to Jest’s text, and alone prints no test result', async () => {
    const project = await makeProject(mixed)
    // Beside `default`: Jest's own text on stderr, and the page.
    const both = join(project.dir, 'both.html')
    const beside = await spawnCli(
      [
        'jest',
        `--config=${jestConfigJson(project.dir, { reporters: ['default', ['html', { outputFile: both }]] })}`,
      ],
      { cwd: project.dir },
    )
    assert.equal(beside.code, 1, beside.stderr)
    assert.match(beside.stderr, /FAIL .*tests\/bad\.test\.js/)
    assert.match(beside.stderr, /PASS .*tests\/ok\.test\.js/)
    assert.match(beside.stderr, /Tests: +1 failed, 1 passed, 2 total/)
    assert.equal(beside.stdout, '')
    assert.equal(pageData(await readFile(both, 'utf8')).tests.length, 2)
    // Alone: the page is the only output of the run, which still fails it (html is not a terminal reporter).
    const only = join(project.dir, 'only.html')
    const alone = await spawnCli(
      [
        'jest',
        `--config=${jestConfigJson(project.dir, { reporters: [['html', { outputFile: only }]] })}`,
      ],
      { cwd: project.dir },
    )
    assert.equal(alone.code, 1, alone.stderr)
    assert.doesNotMatch(alone.stderr, /PASS|FAIL|Tests:|Test Suites:|Snapshots:|Time:/)
    assert.equal(alone.stdout, '')
    assert.equal(pageData(await readFile(only, 'utf8')).tests.length, 2)
  })

  it('beside json, --outputFile is json’s and html writes provino-report.html', async () => {
    const project = await makeProject(mixed)
    const json = join(project.dir, 'run.json')
    const ran = await spawnCli(
      [
        'run',
        '--config',
        project.config,
        '--reporter',
        'html',
        '--reporter',
        'json',
        '--outputFile',
        json,
      ],
      { cwd: project.dir },
    )
    assert.equal(ran.code, 1, ran.stderr)
    assert.equal((JSON.parse(await readFile(json, 'utf8')) as { success: boolean }).success, false)
    assert.equal(
      pageData(await readFile(join(project.dir, 'provino-report.html'), 'utf8')).tests.length,
      2,
    )
    // With json on stdout, html still goes to its file and stdout is json's alone.
    const toStdout = await spawnCli(
      ['run', '--config', project.config, '--reporter', 'json', '--reporter', 'html'],
      { cwd: project.dir },
    )
    assert.equal((JSON.parse(toStdout.stdout) as { success: boolean }).success, false)
  })

  it('takes { outputFile } through run(), and refuses an option it does not have', async () => {
    const project = await makeProject(mixed)
    const stderr = new Collect()
    const ran = await run({
      config: project.config,
      cwd: project.dir,
      stdout: new Collect(),
      stderr,
      env: {},
      reporters: [['html', { outputFile: 'configured/report.html' }]],
    })
    assert.equal(ran.exitCode, 1, stderr.text)
    const page = await readFile(join(project.dir, 'configured', 'report.html'), 'utf8')
    assert.equal(pageData(page).failures.length, 1)
    const refused = new Collect()
    const bad = await run({
      config: project.config,
      cwd: project.dir,
      stdout: new Collect(),
      stderr: refused,
      env: {},
      reporters: [['html', { stream: 'stdout' } as never]],
    })
    assert.equal(bad.exitCode, 2)
    assert.match(refused.text, /the html reporter has no "stream" option \(it takes outputFile\)/)
  })

  it('--outputFile with no document reporter is refused, and names html among them', async () => {
    const project = await makeProject(mixed)
    const ran = await spawnCli(
      ['run', '--config', project.config, '--reporter', 'agent', '--outputFile', 'x.html'],
      { cwd: project.dir },
    )
    assert.equal(ran.code, 2)
    assert.match(ran.stderr, /--outputFile needs --reporter json, normalized-json, junit or html/)
  })
})

/** The text with its colour codes taken out. */
function plain(text: string): string {
  return text.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')
}

/**
 * `provino jest` in this process on a fake terminal, no reporter named: D135's live path. The CI
 * and agent variables are taken out of `process.env` for the call, as an interactive terminal has
 * none (the Jest reader reads `CI` there, and CI's runners set it).
 */
async function liveJest(dir: string, args: readonly string[]): Promise<string> {
  const stderr = new Terminal()
  await withoutCiEnvironment(() =>
    runJestCommand(args, { stdout: new Collect(), stderr, cwd: dir, env: {} }),
  )
  return stderr.text
}

describe('B26 Phase 3 review: what the flags ask for under D135’s live path', () => {
  it('--showSeed (and --randomize) put the seed in the end card', async () => {
    const project = await makeProject({
      'tests/a.test.js': passing('a'),
      'tests/b.test.js': passing('b'),
    })
    const config = `--config=${jestConfigJson(project.dir)}`
    const shown = plain(await liveJest(project.dir, [config, '--showSeed', '--seed=7']))
    assert.ok(shown.includes(HIDE_CURSOR), 'the provino reporter drew')
    assert.match(shown, /^seed: 7$/m)
    const randomized = plain(await liveJest(project.dir, [config, '--randomize', '--seed=8']))
    assert.match(randomized, /^seed: 8$/m)
    const none = plain(await liveJest(project.dir, [config]))
    assert.doesNotMatch(none, /^seed:/m)
  })

  it('--logHeapUsage puts each file’s heap after its time', async () => {
    const project = await makeProject({
      'tests/a.test.js': passing('a'),
      'tests/b.test.js': passing('b'),
    })
    const text = plain(
      await liveJest(project.dir, [`--config=${jestConfigJson(project.dir)}`, '--logHeapUsage']),
    )
    assert.match(text, /tests\/a\.test\.js · 1 test · \S+ · \d+ MB heap/)
  })

  it('obsolete snapshots: the file’s line, the end card’s count, and Jest’s update command', async () => {
    const project = await makeProject({
      'tests/s.test.js': "test('s', () => { expect(1).toMatchSnapshot() })\n",
      'tests/b.test.js': passing('b'),
      'tests/__snapshots__/s.test.js.snap': [
        '// Jest Snapshot v1, https://jestjs.io/docs/snapshot-testing',
        '',
        'exports[`gone 1`] = `2`;',
        '',
        'exports[`s 1`] = `1`;',
        '',
      ].join('\n'),
    })
    const text = plain(await liveJest(project.dir, [`--config=${jestConfigJson(project.dir)}`]))
    assert.match(text, /^ {3}snapshots: 1 obsolete$/m)
    assert.match(text, /^snapshots: 1 obsolete · 1 passed$/m)
    assert.match(text, /^ {2}re-run jest with `-u` to update them$/m)
  })

  it('a global setup that throws is printed on a terminal the footer has left', async () => {
    const project = await makeProject({
      'tests/a.test.js': passing('a'),
      'tests/b.test.js': passing('b'),
      'setup.js': "module.exports = async () => { throw new Error('setup broke') }\n",
    })
    const text = await liveJest(project.dir, [
      `--config=${jestConfigJson(project.dir, { globalSetup: '<rootDir>/setup.js' })}`,
    ])
    const at = text.indexOf('setup broke')
    assert.ok(at !== -1, text)
    // Whatever was drawn before it is gone, and the cursor is shown, before the failure is printed.
    assert.ok(
      text.lastIndexOf(HIDE_CURSOR) < text.lastIndexOf(SHOW_CURSOR) || !text.includes(HIDE_CURSOR),
    )
    assert.ok(!text.slice(at).includes(HIDE_CURSOR))
    assert.doesNotMatch(renderTranscript(text), / of \d+ files? /)
  })
})

describe('B26 Phase 3 review: one rule chooses provino under both commands', () => {
  it('a run of one file lists its tests (Jest’s single-file rule) under provino run and provino jest alike', async () => {
    const one = await makeProject({ 'tests/a.test.js': passing('a') })
    const viaRun = new Terminal()
    await run({ config: one.config, stdout: new Collect(), stderr: viaRun, env: {} })
    const viaJest = await liveJest(one.dir, [`--config=${jestConfigJson(one.dir)}`])
    for (const text of [viaRun.text, viaJest]) {
      assert.ok(!text.includes(HIDE_CURSOR), 'no live footer for one file')
      assert.match(plain(text), /✓ a/)
    }
    // --silent turns the rule off: then both get provino.
    const silentJest = await liveJest(one.dir, [`--config=${jestConfigJson(one.dir)}`, '--silent'])
    assert.ok(silentJest.includes(HIDE_CURSOR))
  })

  it('two files: provino under both; a verbose config keeps Jest’s verbose under both', async () => {
    const two = await makeProject({
      'tests/a.test.js': passing('a'),
      'tests/b.test.js': passing('b'),
    })
    const viaRun = new Terminal()
    await run({ config: two.config, stdout: new Collect(), stderr: viaRun, env: {} })
    const viaJest = await liveJest(two.dir, [`--config=${jestConfigJson(two.dir)}`])
    for (const text of [viaRun.text, viaJest]) assert.ok(text.includes(HIDE_CURSOR))
    const verbose = await liveJest(two.dir, [
      `--config=${jestConfigJson(two.dir, { verbose: true })}`,
    ])
    assert.ok(!verbose.includes(HIDE_CURSOR))
  })
})

describe('B26 Phase 3 review: this process’s own writes go above the footer', () => {
  it('a test’s direct process.stdout.write and an inline worker’s console, then the streams as they were', async () => {
    const project = await makeProject({
      'tests/a.test.js': [
        "test('writes', () => {",
        "  process.stdout.write('a direct write\\n')",
        "  console.log('an inline console line')",
        '})',
        '',
      ].join('\n'),
      'tests/b.test.js': passing('b'),
    })
    const stdout = process.stdout
    const wasTTY = Object.getOwnPropertyDescriptor(stdout, 'isTTY')
    const hadOwnWrite = Object.hasOwn(stdout, 'write')
    const write = stdout.write
    // This process's stdout is node:test's pipe: say it is the terminal, as a bin's is.
    Object.defineProperty(stdout, 'isTTY', { value: true, configurable: true, writable: true })
    const stderr = new Terminal()
    try {
      const ran = await run({
        config: project.config,
        stdout: new Collect(),
        stderr,
        env: {},
        pool: 'inline',
      })
      assert.equal(ran.exitCode, 0, stderr.text)
    } finally {
      if (wasTTY === undefined) Reflect.deleteProperty(stdout, 'isTTY')
      else Object.defineProperty(stdout, 'isTTY', wasTTY)
    }
    assert.match(stderr.text, /a direct write\n/)
    assert.match(stderr.text, /an inline console line/)
    // Above the footer: printed by a frame, before the end card.
    assert.ok(stderr.text.indexOf('a direct write') < stderr.text.indexOf('2 tests passed'))
    assert.equal(Object.hasOwn(stdout, 'write'), hadOwnWrite, 'stdout.write is its own again')
    assert.equal(stdout.write, write)
  })
})

describe('colour', () => {
  it('is off for a pipe, on under FORCE_COLOR, off under NO_COLOR, and --colors and --no-colors win', async () => {
    const project = await makeProject({ 'tests/ok.test.js': passing('ok') })
    const run = (env: Record<string, string>, extra: readonly string[] = []) =>
      spawnCli(['run', '--config', project.config, ...extra], { cwd: project.dir, env })
    assert.doesNotMatch((await run({})).stderr, new RegExp(ESC))
    assert.match((await run({ FORCE_COLOR: '1' })).stderr, new RegExp(`${ESC}\\[32m PASS `))
    assert.doesNotMatch((await run({ NO_COLOR: '1' })).stderr, new RegExp(ESC))
    assert.doesNotMatch((await run({ FORCE_COLOR: '0' })).stderr, new RegExp(ESC))
  })

  it('provino jest --colors colours a pipe; a FORCE_COLOR in the environment outranks the flags, as Jest’s chalk has it', async () => {
    const project = await makeProject({ 'tests/ok.test.js': passing('ok') })
    const config = `--config=${jestConfigJson(project.dir)}`
    const coloured = await spawnCli(['jest', config, '--colors'], { cwd: project.dir })
    assert.match(coloured.stderr, new RegExp(`${ESC}\\[32m PASS `))
    // Live Jest 30.5.2 gives the same answers: supports-color reads FORCE_COLOR after the flags.
    const stays = await spawnCli(['jest', config, '--no-colors'], {
      cwd: project.dir,
      env: { FORCE_COLOR: '1' },
    })
    assert.match(stays.stderr, new RegExp(`${ESC}\\[32m PASS `))
    const off = await spawnCli(['jest', config, '--colors'], {
      cwd: project.dir,
      env: { FORCE_COLOR: '0' },
    })
    assert.doesNotMatch(off.stderr, new RegExp(ESC))
  })

  it('a terminal-less pipe never gets the live block', async () => {
    const project = await makeProject({ 'tests/ok.test.js': passing('ok') })
    const ran = await spawnCli(['run', '--config', project.config], {
      cwd: project.dir,
      env: { FORCE_COLOR: '1' },
    })
    assert.doesNotMatch(ran.stderr, /RUNS/)
    assert.doesNotMatch(ran.stderr, new RegExp(`${ESC}\\[\\d+F`))
  })
})

describe('the reporters provino run names', () => {
  it('verbose lists the tests, dot prints characters, agent only the failures', async () => {
    const project = await makeProject({
      'tests/ok.test.js': passing('works'),
      'tests/bad.test.js': failing('breaks'),
    })
    const run = (name: string) =>
      spawnCli(['run', '--config', project.config, '--reporter', name], { cwd: project.dir })
    const verbose = await run('verbose')
    assert.match(verbose.stderr, /PASS tests\/ok\.test\.js\n {2}✓ works/)
    assert.match(verbose.stderr, /FAIL tests\/bad\.test\.js\n {2}✕ breaks/)
    const dot = await run('dot')
    // The text starts after what Node (a type-stripping warning on 22.15) and some sandboxes print.
    assert.match(withoutNodeNoise(dot.stderr), /^[.F]{2}\n\nFAIL tests\/bad\.test\.js/)
    const agent = await run('agent')
    assert.doesNotMatch(agent.stderr, /ok\.test\.js/)
    assert.match(agent.stderr, /^FAIL tests\/bad\.test\.js/m)
  })

  it('json is the NormalizedRun, as normalized-json is', async () => {
    const project = await makeProject({ 'tests/ok.test.js': passing('ok') })
    const out = join(project.dir, 'out')
    for (const name of ['json', 'normalized-json']) {
      const file = join(out, `${name}.json`)
      const ran = await spawnCli(
        ['run', '--config', project.config, '--reporter', name, '--outputFile', file],
        { cwd: project.dir },
      )
      assert.equal(ran.code, 0, ran.stderr)
      const run = JSON.parse(await readFile(file, 'utf8')) as { success: boolean; runner: string }
      assert.equal(run.success, true)
      assert.equal(run.runner, 'provino:jest')
    }
    const stdout = await spawnCli(['run', '--config', project.config, '--reporter', 'json'], {
      cwd: project.dir,
    })
    assert.equal((JSON.parse(stdout.stdout) as { success: boolean }).success, true)
  })

  it('junit writes the XML to the file, and a failure is a failure element', async () => {
    const project = await makeProject({
      'tests/ok.test.js': passing('works'),
      'tests/bad.test.js': failing('breaks'),
    })
    const file = join(project.dir, 'reports', 'junit.xml')
    const ran = await spawnCli(
      ['run', '--config', project.config, '--reporter', 'junit', '--outputFile', file],
      { cwd: project.dir },
    )
    assert.equal(ran.code, 1, ran.stderr)
    const xml = await readFile(file, 'utf8')
    assert.match(
      xml,
      /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<testsuites name="provino" tests="2" failures="1" errors="0" time="/,
    )
    assert.match(
      xml,
      /<testcase name="breaks" classname="tests\/bad\.test\.js" time="[\d.]+">\n\s+<failure message=/,
    )
    assert.match(xml, /<testcase name="works" classname="tests\/ok\.test\.js" time="[\d.]+"\/>/)
    // Nothing went to stdout: the document is in the file.
    assert.equal(ran.stdout, '')
  })

  it('junit and json each write to stdout when they have no file, and two of them may not', async () => {
    const project = await makeProject({ 'tests/ok.test.js': passing('ok') })
    const junit = await spawnCli(['run', '--config', project.config, '--reporter', 'junit'], {
      cwd: project.dir,
    })
    assert.match(junit.stdout, /^<\?xml /)
    const both = await spawnCli(
      ['run', '--config', project.config, '--reporter', 'junit', '--reporter', 'json'],
      { cwd: project.dir },
    )
    assert.equal(both.code, 2)
    assert.match(both.stderr, /both write to stdout/)
  })

  it('--outputFile with two document reporters is one path for two documents: refused', async () => {
    const project = await makeProject({ 'tests/ok.test.js': passing('ok') })
    const ran = await spawnCli(
      [
        'run',
        '--config',
        project.config,
        '--reporter',
        'json',
        '--reporter',
        'junit',
        '--outputFile',
        'x',
      ],
      { cwd: project.dir },
    )
    assert.equal(ran.code, 2)
    assert.match(ran.stderr, /--outputFile is one path/)
  })

  it('github-actions prints annotations only', async () => {
    const project = await makeProject({ 'tests/bad.test.js': failing('breaks') })
    const ran = await spawnCli(
      ['run', '--config', project.config, '--reporter', 'github-actions'],
      { cwd: project.dir, env: { GITHUB_WORKSPACE: project.dir } },
    )
    assert.equal(ran.code, 1)
    const lines = ran.stderr.split('\n').filter((line) => line.startsWith('::error'))
    assert.equal(lines.length, 1, ran.stderr)
    assert.match(
      lines[0] ?? '',
      /^::error file=tests\/bad\.test\.js,line=\d+,col=\d+,title=breaks::/,
    )
    assert.doesNotMatch(ran.stderr, /Test Suites/)
  })
})

describe('B26 Phase 4: --tree and --map', () => {
  const files = {
    'tests/a.test.js': passing('a'),
    'tests/ui/b.test.js': passing('b'),
    'tests/ui/c.test.js': failing('c'),
  }

  /** The run's stderr under both commands, with the flags after each command's own. */
  async function both(
    dir: string,
    config: string,
    runFlags: readonly string[],
    jestFlags: readonly string[],
  ): Promise<
    readonly { readonly command: string; readonly code: number | null; readonly text: string }[]
  > {
    const viaRun = await spawnCli(['run', '--config', config, ...runFlags], { cwd: dir })
    const viaJest = await spawnCli(['jest', `--config=${jestConfigJson(dir)}`, ...jestFlags], {
      cwd: dir,
    })
    return [
      { command: 'run', code: viaRun.code, text: viaRun.stderr },
      { command: 'jest', code: viaJest.code, text: viaJest.stderr },
    ]
  }

  it('--tree with no reporter named chooses provino even without a terminal: the tree comes before the end card', async () => {
    const project = await makeProject(files)
    for (const ran of await both(project.dir, project.config, ['--tree'], ['--tree'])) {
      assert.equal(ran.code, 1, `${ran.command}: ${ran.text}`)
      assert.ok(!ran.text.includes(ESC), `${ran.command}: plain lines on a pipe`)
      assert.doesNotMatch(ran.text, /Test Suites:|Ran all test suites/)
      const at = (pattern: RegExp): number => ran.text.search(pattern)
      assert.ok(at(/^❌ tests\/ui\/ · 2 files · 2 tests · 1 failed +\d+ms$/m) !== -1, ran.text)
      assert.match(ran.text, /^├─ ✅ b\.test\.js · 1 test +\d+ms$/m)
      assert.match(ran.text, /^└─ ❌ c\.test\.js · 1 of 1 failed +\d+ms$/m)
      assert.match(ran.text, /^ {3}└─ ❌ c +\d+ms$/m)
      assert.match(ran.text, /^ {9}expect\(received\)\.toBe\(expected\)/m)
      assert.ok(at(/^✅ tests\/ · 1 file · 1 test +\d+ms$/m) !== -1, ran.text)
      assert.ok(at(/^💥 /m) > at(/^❌ tests\/ui\/ · /m), 'the tree is before the end card')
      assert.ok(!/🟩|🟥/.test(ran.text), 'no map unless asked')
    }
  })

  it('--map prints one cell per file after the end card, a row per folder', async () => {
    const project = await makeProject(files)
    for (const ran of await both(project.dir, project.config, ['--map'], ['--map'])) {
      assert.equal(ran.code, 1, `${ran.command}: ${ran.text}`)
      assert.match(ran.text, /^🟩 pass {2}🟥 fail {2}🟨 skip {2}⬜ todo$/m)
      assert.match(ran.text, /^tests\/ +🟩$/m)
      assert.match(ran.text, /^tests\/ui\/ +🟩🟥$/m)
      assert.ok(
        ran.text.search(/^🟩 pass/m) > ran.text.search(/^💥 /m),
        'the map is after the end card',
      )
      assert.ok(!ran.text.includes('├─') && !ran.text.includes('└─'), 'no tree unless asked')
    }
  })

  it('both flags, with --no-emoji: the box tree with plain marks, and the lettered map', async () => {
    const project = await makeProject(files)
    const flags = ['--tree', '--map', '--no-emoji']
    for (const ran of await both(project.dir, project.config, flags, flags)) {
      assert.equal(ran.code, 1, `${ran.command}: ${ran.text}`)
      assert.match(ran.text, /^└─ ✕ c\.test\.js · 1 of 1 failed +\d+ms$/m)
      assert.match(ran.text, /^\. pass {2}X fail {2}s skip {2}t todo$/m)
      assert.match(ran.text, /^tests\/ui\/ +\.X$/m)
      assert.doesNotMatch(ran.text, /[🟩🟥✅❌]/u)
    }
  })

  it('they ride on a named provino reporter: --reporter provino and --reporters provino', async () => {
    const project = await makeProject(files)
    const ran = await both(
      project.dir,
      project.config,
      ['--reporter', 'provino', '--tree'],
      ['--reporters', 'provino', '--tree'],
    )
    for (const each of ran) {
      assert.match(each.text, /^└─ ❌ c\.test\.js · 1 of 1 failed +\d+ms$/m, each.command)
    }
    // `provino` named beside another reporter takes them too.
    const beside = await spawnCli(
      ['run', '--config', project.config, '--reporter', 'agent', '--reporter', 'provino', '--map'],
      { cwd: project.dir },
    )
    assert.match(beside.stderr, /^tests\/ui\/ +🟩🟥$/m)
    // And the config's `reporters` key naming it, with the flag adding the view to its options.
    const keyed = await spawnCli(
      ['jest', `--config=${jestConfigJson(project.dir, { reporters: ['provino'] })}`, '--tree'],
      { cwd: project.dir },
    )
    assert.match(keyed.stderr, /^└─ ❌ c\.test\.js · 1 of 1 failed +\d+ms$/m)
  })

  it('beside reporters that are not provino they are a usage error: 2 under provino run, 1 under provino jest', async () => {
    const project = await makeProject(files)
    const message = '--tree needs the provino reporter'
    const viaRun = await spawnCli(
      ['run', '--config', project.config, '--reporter', 'agent', '--tree'],
      { cwd: project.dir },
    )
    assert.equal(viaRun.code, 2, viaRun.stderr)
    assert.ok(viaRun.stderr.includes(message), viaRun.stderr)
    // Named by `--reporters` or by the config's `reporters` key, and refused before any run starts.
    for (const args of [
      [`--config=${jestConfigJson(project.dir)}`, '--reporters', 'default'],
      [`--config=${jestConfigJson(project.dir, { reporters: ['default'] })}`],
    ]) {
      const viaJest = await spawnCli(['jest', ...args, '--tree'], { cwd: project.dir })
      assert.equal(viaJest.code, 1, viaJest.stderr)
      assert.ok(viaJest.stderr.includes(message), viaJest.stderr)
      assert.doesNotMatch(viaJest.stderr, /Test Suites:|tests passed/)
    }
  })

  it('provino run --tree on GitHub Actions keeps the github-actions reporter beside provino', async () => {
    const project = await makeProject({ 'tests/bad.test.js': failing('bad') })
    const ran = await spawnCli(['run', '--config', project.config, '--tree'], {
      cwd: project.dir,
      env: { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: project.dir },
    })
    assert.equal(ran.code, 1, ran.stderr)
    assert.match(ran.stderr, /^::error file=tests\/bad\.test\.js,line=\d+,col=\d+,title=bad::/m)
    assert.match(ran.stderr, /^└─ ❌ bad\.test\.js · 1 of 1 failed +\d+ms$/m)
    assert.match(ran.stderr, /^💥 1 failed · /m)
    assert.doesNotMatch(ran.stderr, /^FAIL /m, 'provino, not default')
  })

  it('a retried test is one test-end through the real stack: the tree’s counts agree with the file’s row (jest.retryTimes)', async () => {
    const flaky = [
      'jest.retryTimes(2)',
      'let calls = 0',
      "test('passes at the third attempt', () => { calls++; if (calls < 3) throw new Error('not yet') })",
      "test('never passes', () => { throw new Error('boom') })",
      "test('steady', () => {})",
      '',
    ].join('\n')
    const project = await makeProject({ 'tests/flaky.test.js': flaky })
    const ran = await spawnCli(
      ['jest', `--config=${jestConfigJson(project.dir)}`, '--reporters', 'provino', '--tree'],
      { cwd: project.dir },
    )
    assert.equal(ran.code, 1, ran.stderr)
    // Three tests, whatever the attempts: the file's line, the folder's heading and the end card.
    assert.match(ran.stderr, /^❌ tests\/flaky\.test\.js · 1 of 3 failed · /m)
    assert.match(ran.stderr, /^❌ tests\/ · 1 file · 3 tests · 1 failed +\d+ms$/m)
    assert.match(ran.stderr, /^└─ ❌ flaky\.test\.js · 1 of 3 failed +\d+ms$/m)
    assert.match(ran.stderr, /^💥 1 failed · 2 passed · 1 file/m)
    // One row for the test that never passed, not one per attempt; the other two are not listed.
    assert.equal(ran.stderr.match(/^ {3}├─ ❌ never passes +\d+ms$/gm)?.length, 1, ran.stderr)
    assert.match(ran.stderr, /^ {3}└─ ✅ 2 more tests +\d+ms$/m)
  })

  it('on a terminal they are part of the run’s last lines, and the footer is gone', async () => {
    const project = await makeProject(files)
    const viaJest = await liveJest(project.dir, [
      `--config=${jestConfigJson(project.dir)}`,
      '--tree',
      '--map',
    ])
    assert.ok(viaJest.includes(HIDE_CURSOR), 'the provino reporter drew')
    const screen = renderTranscript(viaJest)
    assert.match(screen, /^└─ ❌ c\.test\.js · 1 of 1 failed +\d+ms$/m, screen)
    assert.match(screen, /^tests\/ui\/ +🟩🟥$/m, screen)
    assert.doesNotMatch(screen, / of \d+ files? |starting \d+ workers?/, screen)
    const viaRun = new Terminal()
    await run({
      config: project.config,
      stdout: new Collect(),
      stderr: viaRun,
      env: {},
      reporters: [['provino', { tree: true, map: true }]],
    })
    assert.match(plain(viaRun.text), /└─ ❌ c\.test\.js · 1 of 1 failed/)
  })

  it('an explicit ask beats the terminal rules: under CI, an agent and --verbose the views still choose provino', async () => {
    const project = await makeProject(files)
    const verbose = await liveJest(project.dir, [
      `--config=${jestConfigJson(project.dir, { verbose: true })}`,
      '--tree',
    ])
    assert.ok(verbose.includes(HIDE_CURSOR))
    assert.match(plain(verbose), /c\.test\.js · 1 of 1 failed/)
    for (const env of [{ CI: '1' }, { CLAUDECODE: '1' }]) {
      const stderr = new Terminal()
      await run({
        config: project.config,
        stdout: new Collect(),
        stderr,
        env,
        views: { tree: true },
      })
      assert.match(plain(stderr.text), /└─ ❌ c\.test\.js · 1 of 1 failed/, JSON.stringify(env))
    }
  })

  it('run() takes the views as options, beside or among its reporters, and a bad one is a usage error', async () => {
    const project = await makeProject(files)
    const outcome = async (options: Partial<Parameters<typeof run>[0]>) => {
      const stderr = new Collect()
      const ran = await run({
        config: project.config,
        stdout: new Collect(),
        stderr,
        env: {},
        ...options,
      })
      return { exitCode: ran.exitCode, text: stderr.text }
    }
    // The choice's own options, `views`, or both merged into the one `provino` choice.
    for (const options of [
      { reporters: [['provino', { map: true }]] as const },
      { views: { map: true as const } },
      { reporters: ['provino'] as const, views: { map: true as const } },
    ]) {
      const ran = await outcome(options)
      assert.equal(ran.exitCode, 1)
      assert.match(ran.text, /^tests\/ui\/ +🟩🟥$/m)
    }
    const merged = await outcome({
      reporters: [['provino', { tree: true }]],
      views: { map: true },
    })
    assert.match(merged.text, /^└─ ❌ c\.test\.js · /m)
    assert.match(merged.text, /^tests\/ui\/ +🟩🟥$/m)
    // Views with reporters named and no `provino` among them, and options that are not views.
    assert.equal((await outcome({ reporters: ['agent'], views: { tree: true } })).exitCode, 2)
    for (const options of [{ tree: false }, { timeline: true }]) {
      const refused = await outcome({ reporters: [['provino', options as never]] })
      assert.equal(refused.exitCode, 2, refused.text)
    }
  })
})
