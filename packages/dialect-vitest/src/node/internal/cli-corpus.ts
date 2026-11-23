// The command lines `cli.test.ts` holds `parseVitestArgv` to Vitest 5.0.5's own `parseCLI` and bin
// checks on (T11.16), and the real side's answer for one line. The real side costs two `createCLI()`
// calls a line (`parseCLI` makes its own), so the whole corpus is recorded once into
// `__goldens__/cli-corpus.json` by `pnpm --filter @provino/dialect-vitest record:cli`
// (`cli-record.ts`), keyed by Vitest's version and a hash of the corpus; the test fails on either
// changing, and still asks the real `parseCLI` live for every hand-written line.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { VITEST_CLI_OPTIONS, VITEST_LIST_OPTIONS } from '../cli-table.ts'

/** @internal */
export interface CacLike {
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

/** The two functions of `vitest/node` the oracle calls. @internal */
export interface VitestNode {
  parseCLI(argv: string[]): { filter: unknown[]; options: Record<string, unknown> }
  createCLI(): CacLike
}

/** `vitest/node`, the devDependency's. @internal */
export async function loadVitestNode(): Promise<VitestNode> {
  return (await import('vitest/node')) as unknown as VitestNode
}

/** The installed Vitest's version, from its own `package.json`. @internal */
export function installedVitestVersion(): string {
  const require = createRequire(fileURLToPath(import.meta.resolve('vitest')))
  const manifest: unknown = require('vitest/package.json')
  const version =
    typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'version') : undefined
  if (typeof version !== 'string') throw new TypeError('vitest/package.json has no version')
  return version
}

/** A value as text both sides can be compared on (a RegExp, NaN and undefined kept). @internal */
export function encode(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof RegExp) return `RegExp(${String(v)})`
    if (typeof v === 'number' && Number.isNaN(v)) return 'NaN'
    if (v === undefined) return 'undefined'
    return v
  })
}

/** One line's answer: the parse, encoded, or the error's `<name>: <message>`. @internal */
export type Outcome = { readonly ok: string } | { readonly error: string }

/** What real Vitest does with `vitest <args>`: `parseCLI`, then the bin's checks. @internal */
export function realOutcome(vitestNode: VitestNode, args: readonly string[]): Outcome {
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

/** @internal */
export const HAND: readonly (readonly string[])[] = [
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

/** Every line: the hand-written ones, every option in its forms and 800 seeded. @internal */
export function cliCorpus(): readonly (readonly string[])[] {
  return [...HAND, ...forms(), ...seeded(800)]
}

/** The sha256 of the corpus's lines, so a recording of another corpus is refused. @internal */
export function corpusHash(corpus: readonly (readonly string[])[]): string {
  return createHash('sha256').update(JSON.stringify(corpus)).digest('hex')
}

/** The recording: real Vitest's answer to every line, in corpus order. @internal */
export interface CliGolden {
  readonly vitest: string
  readonly corpus: string
  readonly outcomes: readonly Outcome[]
}

/** Where the recording is. @internal */
export const CLI_GOLDEN_PATH: string = fileURLToPath(
  new URL('../__goldens__/cli-corpus.json', import.meta.url),
)

/** The recording as committed: one outcome a line, so a re-recording's diff names the lines. @internal */
export function serializeCliGolden(golden: CliGolden): string {
  const lines = golden.outcomes.map((outcome) => `    ${JSON.stringify(outcome)}`)
  return `{\n  "vitest": ${JSON.stringify(golden.vitest)},\n  "corpus": ${JSON.stringify(golden.corpus)},\n  "outcomes": [\n${lines.join(',\n')}\n  ]\n}\n`
}

/** Reads the recording, checking its shape. @internal */
export function readCliGolden(path: string = CLI_GOLDEN_PATH): CliGolden {
  const json: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const field = (key: string): unknown =>
    typeof json === 'object' && json !== null ? Reflect.get(json, key) : undefined
  const vitest = field('vitest')
  const corpus = field('corpus')
  const outcomes = field('outcomes')
  const isOutcome = (value: unknown): value is Outcome =>
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    (typeof Reflect.get(value, 'ok') === 'string' ||
      typeof Reflect.get(value, 'error') === 'string')
  if (
    typeof vitest !== 'string' ||
    typeof corpus !== 'string' ||
    !Array.isArray(outcomes) ||
    !outcomes.every(isOutcome)
  ) {
    throw new TypeError(`${path} is not a CLI corpus recording`)
  }
  return { vitest, corpus, outcomes }
}
