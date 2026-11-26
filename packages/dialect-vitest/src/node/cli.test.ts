// T11.16: the Vitest command line held to Vitest 5.0.5's own: `parseCLI` from `vitest/node`, in
// process, and the checks its bin makes before a command runs (`runMatchedCommand`'s
// `checkUnknownOptions`, `checkOptionValue`, `checkRequiredArgs`), over hand-written lines, every
// option in its forms and a seeded set. And the table against `createCLI()`'s options, the
// classification, the diagnostics and the run request.
import assert from 'node:assert/strict'
import { describe, it } from 'provino'
import {
  parseVitestArgv,
  parseVitestCli,
  VITEST_CLI_OPTIONS,
  VITEST_LIST_OPTIONS,
  VitestCliError,
  vitestArgvToRunRequest,
  vitestArgvToTestConfig,
  vitestFlags,
} from './cli.ts'
import { cacOption } from './internal/cac-parse.ts'
import {
  cliCorpus,
  corpusHash,
  encode,
  HAND,
  installedVitestVersion,
  loadVitestNode,
  type Outcome,
  readCliGolden,
  realOutcome,
} from './internal/cli-corpus.ts'
import { VITEST_APPLIED_TEST_KEYS } from './to-neutral.ts'

const vitestNode = await loadVitestNode()

function ours(args: readonly string[]): Outcome {
  try {
    const argv = parseVitestArgv(args)
    return { ok: encode({ command: argv.command, filter: argv.filters, options: argv.options }) }
  } catch (error) {
    if (!(error instanceof VitestCliError) || error.code !== 'VITEST_CLI_INVALID') throw error
    return { error: `${error.upstreamName}: ${error.message}` }
  }
}

const RECORD = 'pnpm --filter @provino/dialect-vitest record:cli'

/** The corpus and its recording, once the recording is known to be of this Vitest and this corpus. */
function checkedGolden() {
  const corpus = cliCorpus()
  const golden = readCliGolden()
  assert.equal(golden.vitest, installedVitestVersion(), `Vitest moved: run \`${RECORD}\``)
  assert.equal(golden.corpus, corpusHash(corpus), `the corpus changed: run \`${RECORD}\``)
  assert.equal(golden.outcomes.length, corpus.length)
  return { corpus, golden }
}

describe('vitestCli against vitest/node 5.0.5', () => {
  it('registers the options createCLI registers, in its order', () => {
    const cli = vitestNode.createCLI()
    assert.deepEqual(
      VITEST_CLI_OPTIONS.map((row) => row.flag),
      cli.globalCommand.options.map((option) => option.rawName),
    )
    const list = cli.commands.find((command) => command.name === 'list')
    const listFlags = list?.options.map((option) => option.rawName) ?? []
    assert.deepEqual(
      VITEST_LIST_OPTIONS.map((row) => row.flag),
      listFlags.filter((flag, index) => index >= 171 || flag.startsWith('--changed ')),
    )
  })

  // The real side over the whole corpus is the recording (`internal/cli-corpus.ts`): two
  // `createCLI()` calls a line made this test the slowest in the package.
  it('the recording is of this Vitest and this corpus, and the hand-written lines get it live', () => {
    const { golden } = checkedGolden()
    HAND.forEach((args, index) => {
      assert.deepEqual(
        golden.outcomes[index],
        realOutcome(vitestNode, args),
        `${JSON.stringify(args)}: the recording is not what parseCLI says: run \`${RECORD}\``,
      )
    })
  })

  it('parses as parseCLI and checks as the bin, on every line of the corpus', () => {
    const { corpus, golden } = checkedGolden()
    assert.ok(corpus.length > 2000, `corpus of ${corpus.length}`)
    const failures: string[] = []
    corpus.forEach((args, index) => {
      const expected = golden.outcomes[index]
      const actual = ours(args)
      if (encode(expected) !== encode(actual)) {
        failures.push(
          `${JSON.stringify(args)}\n  vitest:  ${encode(expected)}\n  provino: ${encode(actual)}`,
        )
      }
    })
    assert.equal(failures.length, 0, failures.slice(0, 10).join('\n'))
  })
})

describe('Provino on top of the parse', () => {
  it('classifies every option, and gives a refusal or a warning an owner', () => {
    for (const row of [...VITEST_CLI_OPTIONS, ...VITEST_LIST_OPTIONS]) {
      assert.ok(['request', 'config', 'refuse', 'warn'].includes(row.support), row.path)
      if (row.support === 'refuse' || row.support === 'warn') assert.ok(row.owner, row.path)
      else assert.equal(row.owner, undefined, row.path)
    }
    assert.equal(cacOption('-t, --testNamePattern <pattern>').name, 'testNamePattern')
  })

  it('refuses watch, the commands it has no backend for and the refused flags, by name', () => {
    const codes = (args: string[]): string[] =>
      parseVitestCli(args).diagnostics.map((d) => `${d.level}:${d.key ?? ''}`)
    assert.deepEqual(codes(['run']), [])
    assert.deepEqual(codes(['watch']), ['error:watch'])
    assert.deepEqual(codes(['-w']), ['error:--watch'])
    assert.deepEqual(codes(['--no-watch']), [])
    assert.deepEqual(codes(['--browser']), ['error:--browser'])
    assert.deepEqual(codes(['--browser=false']), [])
    assert.deepEqual(codes(['--typecheck']), ['error:--typecheck'])
    assert.deepEqual(codes(['--coverage']), ['error:--coverage'])
    assert.deepEqual(codes(['--no-coverage']), [])
    assert.deepEqual(codes(['bench']), ['error:bench'])
    assert.deepEqual(codes(['list']), ['error:list'])
    // A key no row registers falls back to its parent's row (D183: never dropped).
    assert.deepEqual(codes(['--expect.soft']), ['error:--expect.soft'])
    assert.deepEqual(codes(['--retry.foo', '1']), ['error:--retry.foo'])
    assert.deepEqual(codes(['--sequence.foo', '1']), [])
    assert.deepEqual(vitestArgvToTestConfig(parseVitestArgv(['--sequence.foo', '1'])), {
      sequence: { foo: 1 },
    })
    assert.deepEqual(codes(['--configLoader', 'runner']), ['warning:--configLoader'])
    assert.deepEqual(codes(['--pool=vmThreads', '--environment', 'node']), [])
    const [watch] = parseVitestCli(['watch']).diagnostics
    assert.match(watch?.message ?? '', /provino vitest runs once/)
  })

  it('consumes every row it neither refuses nor warns about (nothing is dropped)', () => {
    // Each `request` row, with what reads it: `provino vitest` or `vitestArgvToRunRequest`.
    const requestRows = [
      'root', // readVitestConfig's root
      'config', // RunRequest.configPath
      'update', // RunRequest.update
      'testNamePattern', // RunRequest.namePattern
      'silent', // the command's display
      'reporters', // the command's reporter plan
      'outputFile', // the json report's path
      'mode', // readVitestConfig's mode
      'passWithNoTests', // RunRequest.passWithNoTests
      'shard', // the command's shard
      'project', // the command's project choice
      'includeTaskLocation', // the json report's locations
      'run', // provino vitest runs once
      'color', // RunRequest.colour
    ]
    // Each `config` row goes to the reader as `test`, which applies its top-level key.
    const configRows = [
      'dir',
      'isolate',
      'globals',
      'pool',
      'fileParallelism',
      'maxWorkers',
      'environment',
      'dom', // `environment: 'happy-dom'` (normalize.ts)
      'logHeapUsage',
      'allowOnly',
      'sequence',
      'sequence.shuffle',
      'sequence.shuffle.tests',
      'sequence.seed',
      'sequence.hooks',
      'testTimeout',
      'hookTimeout',
      'bail',
      'exclude',
      'slowTestThreshold',
      'teardownTimeout',
      'maxConcurrency',
    ]
    const rows = [...VITEST_CLI_OPTIONS, ...VITEST_LIST_OPTIONS]
    const paths = (support: string): string[] =>
      rows.filter((row) => row.support === support).map((row) => row.path)
    assert.deepEqual(paths('request').sort(), [...requestRows].sort())
    assert.deepEqual(paths('config').sort(), [...configRows].sort())
    for (const path of configRows) {
      assert.ok(VITEST_APPLIED_TEST_KEYS.has(path.split('.')[0] ?? ''), path)
    }
    for (const path of ['repeats', 'diff.expand', 'expect.poll', 'retry', 'json']) {
      assert.match(rows.find((row) => row.path === path)?.owner ?? '', /^not built yet$/, path)
    }
  })

  it('refuses help, version and prototype names as unsupported, not as invalid', () => {
    for (const args of [
      ['--help'],
      ['-h'],
      ['--version'],
      ['-v'],
      ['--constructor'],
      ['--no-__proto__'],
    ]) {
      assert.throws(
        () => parseVitestArgv(args),
        (error: unknown) => error instanceof VitestCliError && error.code !== 'VITEST_CLI_INVALID',
        args.join(' '),
      )
    }
  })

  it('turns the argv into a RunRequest', () => {
    const request = (args: string[]) => vitestArgvToRunRequest(parseVitestArgv(args))
    assert.deepEqual(
      request([
        'run',
        'src/a',
        'b.test.ts:12',
        '-t',
        'adds',
        '--passWithNoTests',
        '-c',
        'v.config.ts',
      ]),
      {
        mode: 'run',
        json: false,
        fileFilters: [
          { kind: 'substring', value: 'src/a', ignoreCase: true },
          { kind: 'pathLine', value: 'b.test.ts', line: 12 },
        ],
        namePattern: 'adds',
        inBand: false,
        passWithNoTests: true,
        configPath: 'v.config.ts',
      },
    )
    assert.equal(request(['-t', '12']).namePattern, '12')
    assert.equal(request(['-u']).update, true)
    assert.equal(request(['-u', 'all']).update, true)
    assert.equal(request(['-u', 'none']).update, false)
    assert.equal(request(['-u', 'new']).update, undefined)
    // resolveConfig.ts L661-L672: any other truthy value updates all, a falsy one says nothing.
    assert.equal(request(['-u', 'yes']).update, true)
    assert.equal(request(['-u', '1']).update, true)
    // No transform: `false` is a string, so truthy; `--no-update` is the falsy one.
    assert.equal(request(['-u', 'false']).update, true)
    assert.equal(request(['--no-update']).update, undefined)
    assert.equal(request(['-u', '']).update, undefined)
    assert.equal(request(['--maxWorkers', '2']).maxWorkers, 2)
    assert.equal(request(['--maxWorkers=50%']).maxWorkers, '50%')
    assert.equal(request([]).colour, undefined)
    assert.equal(request(['--no-color']).colour, false)
    assert.deepEqual(request(['list', '--json']).mode, 'list-files')
    assert.equal(request(['list', '--json']).json, true)
    assert.equal(request(['related', 'a.ts']).passWithNoTests, true)
    assert.deepEqual(request(['a/../b/c.test.ts']).fileFilters, [
      { kind: 'substring', value: 'b/c.test.ts', ignoreCase: true },
    ])
    assert.throws(
      () => request(['a.test.ts:1-3']),
      (error: unknown) =>
        error instanceof VitestCliError && /range location filters/.test(error.message),
    )
  })

  it('lists every flag once with its dashes', () => {
    const names = vitestFlags.map((flag) => flag.name)
    assert.equal(new Set(names).size, names.length)
    assert.deepEqual(
      vitestFlags.find((flag) => flag.name === '--testNamePattern'),
      {
        name: '--testNamePattern',
        short: '-t',
        takesValue: true,
        description: VITEST_CLI_OPTIONS.find((r) => r.path === 'testNamePattern')?.description,
      },
    )
  })
})
