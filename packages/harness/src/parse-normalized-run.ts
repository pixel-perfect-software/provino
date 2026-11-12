import type {
  ConsoleEntry,
  FileStatus,
  NormalizedError,
  NormalizedFile,
  NormalizedRun,
  NormalizedTest,
  RunEnvironment,
  SkipReason,
  SnapshotCounters,
  SnapshotFileState,
  TestIdentity,
  TestStatus,
  TraceEntry,
} from '@provino/types'
import { HarnessError } from './errors.ts'
import { isRecord } from './internal/guards.ts'
import { SCHEMA_VERSION } from './schema.ts'

// A hand-written structural check of `NormalizedRun` (Track 12's result model), the schema that
// Provino's `normalized-json` reporter and the harness's converters both write to. It builds the
// value as it checks it, so nothing is cast: a field is read, checked and then typed. An optional
// field is present in the result only when the JSON has it, so none is ever `undefined`
// (`exactOptionalPropertyTypes`), and a `null` is a wrong type like any other. Keys the model does
// not define are ignored and not returned, so a newer writer's extra field does not fail an older
// reader.

/** The first thing wrong with the JSON: where it is and what was expected there. */
class Mismatch extends Error {
  readonly location: string

  constructor(at: Loc, expected: string, value: unknown) {
    const location = render(at)
    super(
      `${location === '' ? 'the run' : location} must be ${expected} (got ${describeValue(value)})`,
    )
    this.location = location
  }
}

/**
 * Where a value sits: its parent and one key or array index, `undefined` for the run itself. The
 * text (`files[3].tests[0].status`) is only built by `render`, when something is wrong, so a
 * successful parse builds no strings for its locations.
 */
type Loc = { readonly parent: Loc; readonly segment: string | number } | undefined

/** A parser: the value and where it is, for a message. */
type Parse<T> = (value: unknown, at: Loc) => T

/** `files[3].tests[0].status`: a key after a parent is `.key`, an index is `[n]`. */
function render(at: Loc): string {
  const segments: (string | number)[] = []
  for (let node = at; node !== undefined; node = node.parent) segments.unshift(node.segment)
  let text = ''
  for (const segment of segments) {
    if (typeof segment === 'number') text += `[${segment}]`
    else text += text === '' ? segment : `.${segment}`
  }
  return text
}

/** A short description of a value for a message: its kind, and a short string in quotes. */
function describeValue(value: unknown): string {
  if (value === undefined) return 'nothing, the key is missing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)
  }
  if (typeof value === 'object') return 'an object'
  return `${typeof value} ${String(value)}`
}

const TEST_STATUSES: readonly TestStatus[] = ['passed', 'failed', 'skipped', 'todo', 'notRun']
const FILE_STATUSES: readonly FileStatus[] = ['passed', 'failed', 'crashed', 'skipped']
const SKIP_REASONS: readonly SkipReason[] = [
  'modifier',
  'only-filter',
  'name-filter',
  'condition',
  'dynamic',
  'unknown',
]
const STREAMS: readonly ConsoleEntry['stream'][] = ['stdout', 'stderr']
const TRACE_KINDS: readonly TraceEntry['kind'][] = [
  'hook:beforeAll',
  'hook:afterAll',
  'hook:beforeEach',
  'hook:afterEach',
  'test:start',
  'test:end',
  'mark',
]
const TRACE_OUTCOMES: readonly NonNullable<TraceEntry['outcome']>[] = ['ok', 'error']
const SHA256 = /^[0-9a-f]{64}$/i

function object(value: unknown, at: Loc): Record<string, unknown> {
  if (!isRecord(value)) throw new Mismatch(at, 'an object', value)
  return value
}

/** One own property of `record`, or `undefined` when it has none (never an inherited one). */
function field(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function string(value: unknown, at: Loc): string {
  if (typeof value !== 'string') throw new Mismatch(at, 'a string', value)
  return value
}

function boolean(value: unknown, at: Loc): boolean {
  if (typeof value !== 'boolean') throw new Mismatch(at, 'a boolean', value)
  return value
}

/** A number that is not `NaN` or infinite and is not below zero (a duration, a size). */
function quantity(value: unknown, at: Loc): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Mismatch(at, 'a number that is not negative', value)
  }
  return value
}

/** A whole number, `minimum` or more (a count, an index, a line). */
function integer(minimum: number): Parse<number> {
  const expected =
    minimum === 0 ? 'a whole number, 0 or more' : `a whole number, ${minimum} or more`
  return (value, at) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
      throw new Mismatch(at, expected, value)
    }
    return value
  }
}

const count = integer(0)

/** A value that is one of `allowed`, which is returned as itself, so it keeps its literal type. */
function oneOf<T extends string>(allowed: readonly T[]): Parse<T> {
  const expected = `one of ${allowed.map((item) => `"${item}"`).join(', ')}`
  return (value, at) => {
    const found = allowed.find((item) => item === value)
    if (found === undefined) throw new Mismatch(at, expected, value)
    return found
  }
}

/** An array, each item parsed by `item` at `at[index]`. */
function list<T>(item: Parse<T>, options: { readonly minimum?: number } = {}): Parse<T[]> {
  const minimum = options.minimum ?? 0
  return (value, at) => {
    if (!Array.isArray(value)) throw new Mismatch(at, 'an array', value)
    if (value.length < minimum) {
      throw new Mismatch(at, `an array of at least ${minimum} item`, value)
    }
    return value.map((entry: unknown, index) => item(entry, { parent: at, segment: index }))
  }
}

/** The required `key` of `record`, parsed. */
function required<T>(record: Record<string, unknown>, key: string, at: Loc, parse: Parse<T>): T {
  return parse(field(record, key), { parent: at, segment: key })
}

/**
 * The optional fields of `record` named by `parsers`, each parsed: only the keys `record` has,
 * so no value is ever `undefined`. The one cast is safe because each key's value comes from its
 * own parser.
 */
function optionalFields<P extends Record<string, Parse<unknown>>>(
  record: Record<string, unknown>,
  at: Loc,
  parsers: P,
): { [K in keyof P]?: ReturnType<P[K]> } {
  const found: Record<string, unknown> = {}
  for (const [key, parse] of Object.entries(parsers)) {
    if (Object.hasOwn(record, key)) found[key] = parse(record[key], { parent: at, segment: key })
  }
  return found as { [K in keyof P]?: ReturnType<P[K]> }
}

function testIdentity(value: unknown, at: Loc): TestIdentity {
  const id = object(value, at)
  return {
    file: required(id, 'file', at, string),
    path: required(id, 'path', at, list(string, { minimum: 1 })),
    dupIndex: required(id, 'dupIndex', at, count),
  }
}

function normalizedError(value: unknown, at: Loc): NormalizedError {
  const error = object(value, at)
  return {
    message: required(error, 'message', at, string),
    raw: required(error, 'raw', at, string),
    ...optionalFields(error, at, {
      name: string,
      matcher: string,
      userFrame: string,
    }),
  }
}

function consoleEntry(value: unknown, at: Loc): ConsoleEntry {
  const entry = object(value, at)
  return {
    stream: required(entry, 'stream', at, oneOf(STREAMS)),
    text: required(entry, 'text', at, string),
    ...optionalFields(entry, at, { level: string }),
  }
}

function traceEntry(value: unknown, at: Loc): TraceEntry {
  const entry = object(value, at)
  return {
    kind: required(entry, 'kind', at, oneOf(TRACE_KINDS)),
    owner: required(entry, 'owner', at, list(string)),
    ...optionalFields(entry, at, { label: string, outcome: oneOf(TRACE_OUTCOMES) }),
  }
}

function sourceLocation(
  value: unknown,
  at: Loc,
): { readonly line: number; readonly column: number } {
  const position = object(value, at)
  return {
    line: required(position, 'line', at, integer(1)),
    column: required(position, 'column', at, integer(1)),
  }
}

function normalizedTest(value: unknown, at: Loc): NormalizedTest {
  const test = object(value, at)
  return {
    id: required(test, 'id', at, testIdentity),
    status: required(test, 'status', at, oneOf(TEST_STATUSES)),
    errors: required(test, 'errors', at, list(normalizedError)),
    ...optionalFields(test, at, {
      skipReason: oneOf(SKIP_REASONS),
      passingAssertions: count,
      retries: count,
      durationMs: quantity,
      location: sourceLocation,
      console: list(consoleEntry),
      expectedToFail: boolean,
    }),
  }
}

function normalizedFile(value: unknown, at: Loc): NormalizedFile {
  const file = object(value, at)
  return {
    file: required(file, 'file', at, string),
    status: required(file, 'status', at, oneOf(FILE_STATUSES)),
    tests: required(file, 'tests', at, list(normalizedTest)),
    ...optionalFields(file, at, {
      fileError: normalizedError,
      console: list(consoleEntry),
      trace: list(traceEntry),
      durationMs: quantity,
    }),
  }
}

function runners(value: unknown, at: Loc): Record<string, string> {
  const versions = object(value, at)
  return Object.fromEntries(
    Object.keys(versions).map((name): [string, string] => [
      name,
      string(versions[name], { parent: at, segment: name }),
    ]),
  )
}

function runEnvironment(value: unknown, at: Loc): RunEnvironment {
  const env = object(value, at)
  return {
    os: required(env, 'os', at, string),
    osRelease: required(env, 'osRelease', at, string),
    arch: required(env, 'arch', at, string),
    cpuModel: required(env, 'cpuModel', at, string),
    cpuCount: required(env, 'cpuCount', at, count),
    memoryMb: required(env, 'memoryMb', at, quantity),
    node: required(env, 'node', at, string),
    runners: required(env, 'runners', at, runners),
    ci: required(env, 'ci', at, boolean),
  }
}

function snapshotCounters(value: unknown, at: Loc): SnapshotCounters {
  const counters = object(value, at)
  return {
    added: required(counters, 'added', at, count),
    matched: required(counters, 'matched', at, count),
    unmatched: required(counters, 'unmatched', at, count),
    updated: required(counters, 'updated', at, count),
    unchecked: required(counters, 'unchecked', at, count),
    total: required(counters, 'total', at, count),
    filesAdded: required(counters, 'filesAdded', at, count),
    filesRemoved: required(counters, 'filesRemoved', at, count),
    filesUnmatched: required(counters, 'filesUnmatched', at, count),
    filesUpdated: required(counters, 'filesUpdated', at, count),
  }
}

function sha256(value: unknown, at: Loc): string {
  const text = string(value, at)
  if (!SHA256.test(text)) throw new Mismatch(at, 'a hex SHA-256 (64 hex digits)', value)
  return text
}

function snapshotFile(value: unknown, at: Loc): SnapshotFileState {
  const state = object(value, at)
  return {
    file: required(state, 'file', at, string),
    sha256: required(state, 'sha256', at, sha256),
  }
}

function snapshots(value: unknown, at: Loc): NonNullable<NormalizedRun['snapshots']> {
  const state = object(value, at)
  return {
    counters: required(state, 'counters', at, snapshotCounters),
    files: required(state, 'files', at, list(snapshotFile)),
  }
}

function schemaVersion(value: unknown, at: Loc): typeof SCHEMA_VERSION {
  if (value !== SCHEMA_VERSION) {
    throw new Mismatch(at, `the schema version ${SCHEMA_VERSION}`, value)
  }
  return SCHEMA_VERSION
}

function normalizedRun(value: unknown): NormalizedRun {
  const run = object(value, undefined)
  return {
    schemaVersion: required(run, 'schemaVersion', undefined, schemaVersion),
    runner: required(run, 'runner', undefined, string),
    runnerVersion: required(run, 'runnerVersion', undefined, string),
    suite: required(run, 'suite', undefined, string),
    startedAt: required(run, 'startedAt', undefined, string),
    env: required(run, 'env', undefined, runEnvironment),
    files: required(run, 'files', undefined, list(normalizedFile)),
    runErrors: required(run, 'runErrors', undefined, list(normalizedError)),
    success: required(run, 'success', undefined, boolean),
    ...optionalFields(run, undefined, { snapshots }),
  }
}

/**
 * Parses the JSON text of a `NormalizedRun` (what the `normalized-json` reporter writes, and what
 * `convertJest` and `convertVitest` return): the schema version, every required field and its
 * type, every enum, and each optional field's type when it is there. Throws `HarnessError`
 * `HARNESS_RESULT_INVALID` for text that is not JSON or not a run, naming `source` and the first
 * JSON path that is wrong (`files[3].tests[0].status`). Keys the model does not define are ignored
 * and left out of the result.
 * @public
 */
export function parseNormalizedRun(text: string, source: string): NormalizedRun {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new HarnessError('HARNESS_RESULT_INVALID', `${source} is not valid JSON`, {
      path: source,
      cause,
    })
  }
  try {
    return normalizedRun(value)
  } catch (cause) {
    if (!(cause instanceof Mismatch)) throw cause
    throw new HarnessError(
      'HARNESS_RESULT_INVALID',
      `${source} is not a NormalizedRun: ${cause.message}`,
      { path: source, cause },
    )
  }
}

/**
 * How many tests a run holds, over all its files.
 * @internal
 */
export function countTests(run: NormalizedRun): number {
  return run.files.reduce((total, file) => total + file.tests.length, 0)
}
