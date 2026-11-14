// T9.7 through the bin: `provino jest` against the text real Jest 30.5.2 printed for the same
// project (`cli/report-default`, `report-verbose`, `report-silent`: the lines each recording kept,
// its `keepLines`), then what the environment and the flags change: an agent, GitHub Actions,
// colour, and the reporters `provino run` names.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

  it('gets colour and the live block of the running files, erased before the results', async () => {
    const project = await makeProject(ok)
    const stderr = new Terminal()
    const ran = await run({ config: project.config, stdout: new Collect(), stderr, env: {} })
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

  it('NO_COLOR turns the colour off and keeps the live block; TERM=dumb has neither', async () => {
    const project = await makeProject(ok)
    const plain = new Terminal()
    await run({
      config: project.config,
      stdout: new Collect(),
      stderr: plain,
      env: { NO_COLOR: '1' },
    })
    assert.match(plain.text, /RUNS tests\/[ab]\.test\.js/)
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

  it('provino jest --colors colours a pipe, --no-colors silences FORCE_COLOR', async () => {
    const project = await makeProject({ 'tests/ok.test.js': passing('ok') })
    const config = `--config=${jestConfigJson(project.dir)}`
    const coloured = await spawnCli(['jest', config, '--colors'], { cwd: project.dir })
    assert.match(coloured.stderr, new RegExp(`${ESC}\\[32m PASS `))
    const off = await spawnCli(['jest', config, '--no-colors'], {
      cwd: project.dir,
      env: { FORCE_COLOR: '1' },
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
