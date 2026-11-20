// T11.16: the Vitest command line held to Vitest 5.0.5's own: `parseCLI` from `vitest/node`, in
// process, and the checks its bin makes before a command runs (`runMatchedCommand`'s
// `checkUnknownOptions`, `checkOptionValue`, `checkRequiredArgs`), over hand-written lines, every
// option in its forms and a seeded set. And the table against `createCLI()`'s options, the
// classification, the diagnostics and the run request.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseVitestArgv,
  parseVitestCli,
  VITEST_CLI_OPTIONS,
  VITEST_LIST_OPTIONS,
  VitestCliError,
  vitestArgvToRunRequest,
  vitestFlags,
} from './cli.ts'
import { cacOption } from './internal/cac-parse.ts'

interface CacLike {
  readonly options: Record<string, unknown>
  readonly matchedCommand?: {
    readonly name: string
    checkUnknownOptions(): void
    checkOptionValue(): void
    checkRequiredArgs(): void
  }
  readonly matchedCommandName?: string
  readonly globalCommand: { readonly options: readonly { readonly rawName: string }[] }
  readonly commands: readonly {
    readonly name: string
    readonly options: readonly { readonly rawName: string }[]
  }[]
  parse(argv: string[], options: { run: boolean }): unknown
}
interface VitestNode {
  parseCLI(argv: string[]): { filter: unknown[]; options: Record<string, unknown> }
  createCLI(): CacLike
}

const vitestNode = (await import('vitest/node')) as unknown as VitestNode

/** A value as text both sides can be compared on (a RegExp, NaN and undefined kept). */
function encode(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof RegExp) return `RegExp(${String(v)})`
    if (typeof v === 'number' && Number.isNaN(v)) return 'NaN'
    if (v === undefined) return 'undefined'
    return v
  })
}

type Outcome = { readonly ok: string } | { readonly error: string }

function real(args: readonly string[]): Outcome {
  try {
    const { filter, options } = vitestNode.parseCLI(['vitest', ...args])
    const cli = vitestNode.createCLI()
    cli.parse(['node', '/index.js', ...args], { run: false })
    const command = cli.matchedCommand
    command?.checkUnknownOptions()
    command?.checkOptionValue()
    command?.checkRequiredArgs()
    return { ok: encode({ command: command?.name ?? '', filter, options }) }
  } catch (error) {
    const e = error as Error
    return { error: `${e.name}: ${e.message}` }
  }
}

function ours(args: readonly string[]): Outcome {
  try {
    const argv = parseVitestArgv(args)
    return { ok: encode({ command: argv.command, filter: argv.filters, options: argv.options }) }
  } catch (error) {
    if (!(error instanceof VitestCliError) || error.code !== 'VITEST_CLI_INVALID') throw error
    return { error: `${error.upstreamName}: ${error.message}` }
  }
}

const HAND: readonly (readonly string[])[] = [
  [],
  ['run'],
  ['run', 'a', 'b'],
  ['a.test.ts:12'],
  ['run', 'src/a.test.ts:3', 'b.test.ts'],
  ['-t', 'adds'],
  ['run', '-t', 'adds two'],
  ['-t', 'a', '-t', 'b'],
  ['-t'],
  ['-t', '12'],
  ['--testNamePattern=x'],
  ['--test-name-pattern', 'x'],
  ['--sequence.shuffle'],
  ['--sequence.shuffle', '--sequence.seed', '3'],
  ['--sequence.seed=12', '--sequence.shuffle.files'],
  ['--sequence.shuffle.tests=false'],
  ['--no-sequence.shuffle'],
  ['--shard', '1/3'],
  ['--shard=2/2'],
  ['--project', 'a', '--project', 'b'],
  ['--project=a'],
  ['--exclude', 'x', '--exclude', 'y'],
  ['--reporter', 'json', '--reporter', 'default'],
  ['--reporter=json', '--outputFile', 'out.json'],
  ['--outputFile.json', 'a.json', '--outputFile.junit', 'b.xml'],
  ['--silent'],
  ['--silent=passed-only'],
  ['--silent=bogus'],
  ['--silent', 'false'],
  ['--no-silent'],
  ['-u'],
  ['-u', 'new'],
  ['--update=all'],
  ['--update', 'none'],
  ['--passWithNoTests'],
  ['--pass-with-no-tests'],
  ['--bail', '1'],
  ['--bail=3'],
  ['--bail'],
  ['--pool', 'threads'],
  ['--pool=vmThreads'],
  ['--maxWorkers', '2'],
  ['--maxWorkers=50%'],
  ['-w'],
  ['-w', '2'],
  ['--watch'],
  ['watch'],
  ['dev', 'x'],
  ['run', '--watch'],
  ['related', 'src/a.ts', 'src/b.ts'],
  ['related', 'a.ts', '--passWithNoTests=false'],
  ['list'],
  ['list', '--json'],
  ['list', '--json=out.json'],
  ['list', '--filesOnly', 'a'],
  ['list', '--json', 'a', '--json', 'b'],
  ['run', '--json', 'a', '--json', 'b'],
  ['list', '--changed', 'main'],
  ['--changed'],
  ['--changed', 'HEAD~1'],
  ['bench'],
  ['init'],
  ['init', 'browser'],
  ['doctor'],
  ['--environment', 'jsdom'],
  ['--environment=happy-dom'],
  ['--globals'],
  ['--no-globals'],
  ['--coverage'],
  ['--no-coverage'],
  ['--coverage.enabled', '--coverage.provider', 'istanbul'],
  ['--coverage.reporter', 'text', '--coverage.reporter', 'html'],
  ['--coverage.thresholds.lines', '80'],
  ['--coverage.thresholds.100'],
  ['--coverage.watermarks.lines', '50,80'],
  ['--coverage.thresholds.autoUpdate', 'yes'],
  ['--coverage.changed=no'],
  ['--browser'],
  ['--browser', 'chrome'],
  ['--browser=false'],
  ['--browser.enabled'],
  ['--browser.name=firefox', '--browser.headless'],
  ['--browser.trace', 'on'],
  ['--typecheck'],
  ['--typecheck.only'],
  ['--api', '3000'],
  ['--api.port', '3000'],
  ['--api'],
  ['--inspect'],
  ['--inspect=0'],
  ['--inspect', '127.0.0.1:9230'],
  ['--inspectBrk=yes'],
  ['--retry', '2'],
  ['--retry.count', '2', '--retry.condition', 'flaky'],
  ['--retry.condition=('],
  ['--expect', '1'],
  ['--expect.requireAssertions'],
  ['--expect.poll.timeout', '100'],
  ['--expect.poll', '3'],
  ['--mergeReports'],
  ['--mergeReports', 'dir'],
  ['--root', 'a'],
  ['--root', 'a', '--root', 'b'],
  ['-r', './a/../b/'],
  ['--dir', 'src\\\\x'],
  ['--config', './vitest.config.ts'],
  ['-c', 'x.ts'],
  ['--config'],
  ['--mode', 'staging'],
  ['--color'],
  ['--no-color'],
  ['--bogus'],
  ['-x'],
  ['--bogus.deep=1'],
  ['--', '--bogus', 'x'],
  ['run', '--', 'a'],
  ['--testTimeout', '100', '--hookTimeout=200'],
  ['--isolate=false'],
  ['--no-isolate'],
  ['--fileParallelism', 'false'],
  ['--diff.expand', '--diff.contextLines', '2'],
  ['--experimental.importDurations'],
  ['--experimental.importDurations.print', 'on-warn'],
  ['--execArgv', '--x', '--execArgv=--y'],
  ['--logHeapUsage'],
  ['--dom'],
  ['--clearCache'],
  ['--listTags'],
  ['--listTags=json'],
  ['--tagsFilter', 'a', '--tagsFilter', 'b'],
  ['--includeTaskLocation'],
  ['--"quoted"'],
  ['-t', '"quoted"'],
  ['-t', "'single'"],
  ['--exclude', '"a"', '--exclude', "'b'"],
  ['---x'],
  ['-tu', 'x'],
  ['-ut', 'x'],
  ['--=x'],
  ['-'],
  [''],
  ['run', ''],
  ['x', 'run'],
  ['complete'],
  ['--standalone'],
  ['--ui'],
  ['--open=false'],
  ['--vmMemoryLimit', '1G'],
  ['--attachmentsDir', 'x'],
  ['--maxConcurrency', '3'],
  ['--allowOnly'],
  ['--repeats', '2'],
  ['--slowTestThreshold=10'],
  ['--detectAsyncLeaks'],
  ['--printConsoleTrace'],
  ['--configLoader', 'runner'],
  ['--clearScreen=false'],
  ['--strictTags'],
  ['--hideSkippedTests'],
  ['--injectCjsGlobals=false'],
  ['--fsModuleCache'],
  ['--cache=false'],
  ['--teardownTimeout', '5'],
  ['--disableConsoleIntercept'],
  ['--dangerouslyIgnoreUnhandledErrors'],
  ['--expandSnapshotDiff'],
  ['--sharedViteServer'],
]

/** Every option in its forms: bare, with `=`, with a value after it, negated, twice. */
function forms(): (readonly string[])[] {
  const out: (readonly string[])[] = []
  for (const row of [...VITEST_CLI_OPTIONS, ...VITEST_LIST_OPTIONS]) {
    if (row.path === 'help' || row.path === 'version') continue
    const names = row.flag.replace(/ [<[].*$/, '').split(', ')
    for (const name of names) {
      out.push([name], [`${name}=1`], [name, 'v'], [name, 'a', name, 'b'], [`${name}=false`])
      if (name.startsWith('--')) out.push([`--no-${name.slice(2)}`])
      out.push(['list', name, 'x'])
    }
  }
  return out
}

/** A seeded set (mulberry32): random lines over the table's names, values and commands. */
function seeded(count: number): (readonly string[])[] {
  let seed = 20261120
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
  const names = VITEST_CLI_OPTIONS.filter(
    (row) => row.path !== 'help' && row.path !== 'version',
  ).flatMap((row) => row.flag.replace(/ [<[].*$/, '').split(', '))
  const values = [
    '1',
    '0',
    'true',
    'false',
    'yes',
    'no',
    'a',
    'a,b',
    '"q"',
    '50%',
    '2/3',
    '-1',
    'x.ts:3',
    '',
  ]
  const commands = ['', '', '', 'run', 'list', 'watch', 'related', 'bench']
  const out: (readonly string[])[] = []
  for (let i = 0; i < count; i++) {
    const line: string[] = []
    const command = pick(commands)
    if (command !== '') line.push(command)
    const length = 1 + Math.floor(random() * 4)
    for (let j = 0; j < length; j++) {
      const name = pick(names)
      const form = Math.floor(random() * 5)
      if (form === 0) line.push(name)
      else if (form === 1) line.push(`${name}=${pick(values)}`)
      else if (form === 2) line.push(name, pick(values))
      else if (form === 3 && name.startsWith('--')) line.push(`--no-${name.slice(2)}`)
      else line.push(pick(['a.test.ts', 'src/b.ts:4', 'c']))
    }
    out.push(line)
  }
  return out
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

  it('parses as parseCLI and checks as the bin, on every line of the corpus', () => {
    const corpus = [...HAND, ...forms(), ...seeded(800)]
    assert.ok(corpus.length > 2000, `corpus of ${corpus.length}`)
    const failures: string[] = []
    for (const args of corpus) {
      const expected = real(args)
      const actual = ours(args)
      if (encode(expected) !== encode(actual)) {
        failures.push(
          `${JSON.stringify(args)}\n  vitest:  ${encode(expected)}\n  provino: ${encode(actual)}`,
        )
      }
    }
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
    assert.deepEqual(codes(['--configLoader', 'runner']), ['warning:--configLoader'])
    assert.deepEqual(codes(['--pool=vmThreads', '--environment', 'node']), [])
    const [watch] = parseVitestCli(['watch']).diagnostics
    assert.match(watch?.message ?? '', /D175/)
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
          { kind: 'substring', value: 'src/a' },
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
    assert.equal(request(['--maxWorkers', '2']).maxWorkers, 2)
    assert.equal(request(['--maxWorkers=50%']).maxWorkers, '50%')
    assert.equal(request([]).colour, undefined)
    assert.equal(request(['--no-color']).colour, false)
    assert.deepEqual(request(['list', '--json']).mode, 'list-files')
    assert.equal(request(['list', '--json']).json, true)
    assert.equal(request(['related', 'a.ts']).passWithNoTests, true)
    assert.deepEqual(request(['a/../b/c.test.ts']).fileFilters, [
      { kind: 'substring', value: 'b/c.test.ts' },
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
