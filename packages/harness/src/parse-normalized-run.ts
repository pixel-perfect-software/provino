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

  constructor(location: string, expected: string, value: unknown) {
    super(
      `${location === '' ? 'the run' : location} must be ${expected} (got ${describeValue(value)})`,
    )
    this.location = location
  }
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

/** `parent.key`, or `key` at the root. */
function keyPath(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Mismatch(location, 'an object', value)
  return value
}

/** One own property of `record`, or `undefined` when it has none (never an inherited one). */
function field(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function string(value: unknown, location: string): string {
  if (typeof value !== 'string') throw new Mismatch(location, 'a string', value)
  return value
}

function boolean(value: unknown, location: string): boolean {
  if (typeof value !== 'boolean') throw new Mismatch(location, 'a boolean', value)
  return value
}

/** A number that is not `NaN` or infinite and is not below zero (a duration, a size). */
function quantity(value: unknown, location: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Mismatch(location, 'a number that is not negative', value)
  }
  return value
}

/** A whole number, `minimum` or more (a count, an index, a line). */
function integer(minimum: number): (value: unknown, location: string) => number {
  const expected =
    minimum === 0 ? 'a whole number, 0 or more' : `a whole number, ${minimum} or more`
  return (value, location) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
      throw new Mismatch(location, expected, value)
    }
    return value
  }
}

const count = integer(0)

/** A value that is one of `allowed`, which is returned as itself, so it keeps its literal type. */
function oneOf<T extends string>(allowed: readonly T[]): (value: unknown, location: string) => T {
  const expected = `one of ${allowed.map((item) => `"${item}"`).join(', ')}`
  return (value, location) => {
    const found = allowed.find((item) => item === value)
    if (found === undefined) throw new Mismatch(location, expected, value)
    return found
  }
}

/** An array, each item parsed by `item` at `location[index]`. */
function list<T>(
  item: (value: unknown, location: string) => T,
  options: { readonly minimum?: number } = {},
): (value: unknown, location: string) => T[] {
  const minimum = options.minimum ?? 0
  return (value, location) => {
    if (!Array.isArray(value)) throw new Mismatch(location, 'an array', value)
    if (value.length < minimum) {
      throw new Mismatch(location, `an array of at least ${minimum} item`, value)
    }
    return value.map((entry: unknown, index) => item(entry, `${location}[${index}]`))
  }
}

/** The required `key` of `record`, parsed. */
function required<T>(
  record: Record<string, unknown>,
  key: string,
  location: string,
  parse: (value: unknown, location: string) => T,
): T {
  return parse(field(record, key), keyPath(location, key))
}

/** The optional `key` of `record`, parsed; `undefined` when `record` does not have it. */
function optional<T>(
  record: Record<string, unknown>,
  key: string,
  location: string,
  parse: (value: unknown, location: string) => T,
): T | undefined {
  return Object.hasOwn(record, key) ? parse(record[key], keyPath(location, key)) : undefined
}

function testIdentity(value: unknown, location: string): TestIdentity {
  const id = object(value, location)
  return {
    file: required(id, 'file', location, string),
    path: required(id, 'path', location, list(string, { minimum: 1 })),
    dupIndex: required(id, 'dupIndex', location, count),
  }
}

function normalizedError(value: unknown, location: string): NormalizedError {
  const error = object(value, location)
  const name = optional(error, 'name', location, string)
  const matcher = optional(error, 'matcher', location, string)
  const userFrame = optional(error, 'userFrame', location, string)
  return {
    ...(name === undefined ? {} : { name }),
    message: required(error, 'message', location, string),
    ...(matcher === undefined ? {} : { matcher }),
    ...(userFrame === undefined ? {} : { userFrame }),
    raw: required(error, 'raw', location, string),
  }
}

function consoleEntry(value: unknown, location: string): ConsoleEntry {
  const entry = object(value, location)
  const level = optional(entry, 'level', location, string)
  return {
    stream: required(entry, 'stream', location, oneOf(STREAMS)),
    ...(level === undefined ? {} : { level }),
    text: required(entry, 'text', location, string),
  }
}

function traceEntry(value: unknown, location: string): TraceEntry {
  const entry = object(value, location)
  const label = optional(entry, 'label', location, string)
  const outcome = optional(entry, 'outcome', location, oneOf(TRACE_OUTCOMES))
  return {
    kind: required(entry, 'kind', location, oneOf(TRACE_KINDS)),
    owner: required(entry, 'owner', location, list(string)),
    ...(label === undefined ? {} : { label }),
    ...(outcome === undefined ? {} : { outcome }),
  }
}

function sourceLocation(
  value: unknown,
  location: string,
): { readonly line: number; readonly column: number } {
  const position = object(value, location)
  return {
    line: required(position, 'line', location, integer(1)),
    column: required(position, 'column', location, integer(1)),
  }
}

function normalizedTest(value: unknown, location: string): NormalizedTest {
  const test = object(value, location)
  const skipReason = optional(test, 'skipReason', location, oneOf(SKIP_REASONS))
  const passingAssertions = optional(test, 'passingAssertions', location, count)
  const retries = optional(test, 'retries', location, count)
  const durationMs = optional(test, 'durationMs', location, quantity)
  const position = optional(test, 'location', location, sourceLocation)
  const output = optional(test, 'console', location, list(consoleEntry))
  const expectedToFail = optional(test, 'expectedToFail', location, boolean)
  return {
    id: required(test, 'id', location, testIdentity),
    status: required(test, 'status', location, oneOf(TEST_STATUSES)),
    ...(skipReason === undefined ? {} : { skipReason }),
    errors: required(test, 'errors', location, list(normalizedError)),
    ...(passingAssertions === undefined ? {} : { passingAssertions }),
    ...(retries === undefined ? {} : { retries }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(position === undefined ? {} : { location: position }),
    ...(output === undefined ? {} : { console: output }),
    ...(expectedToFail === undefined ? {} : { expectedToFail }),
  }
}

function normalizedFile(value: unknown, location: string): NormalizedFile {
  const file = object(value, location)
  const fileError = optional(file, 'fileError', location, normalizedError)
  const output = optional(file, 'console', location, list(consoleEntry))
  const trace = optional(file, 'trace', location, list(traceEntry))
  const durationMs = optional(file, 'durationMs', location, quantity)
  return {
    file: required(file, 'file', location, string),
    status: required(file, 'status', location, oneOf(FILE_STATUSES)),
    ...(fileError === undefined ? {} : { fileError }),
    tests: required(file, 'tests', location, list(normalizedTest)),
    ...(output === undefined ? {} : { console: output }),
    ...(trace === undefined ? {} : { trace }),
    ...(durationMs === undefined ? {} : { durationMs }),
  }
}

function runners(value: unknown, location: string): Record<string, string> {
  const versions = object(value, location)
  return Object.fromEntries(
    Object.keys(versions).map((name): [string, string] => [
      name,
      string(versions[name], keyPath(location, name)),
    ]),
  )
}

function runEnvironment(value: unknown, location: string): RunEnvironment {
  const env = object(value, location)
  return {
    os: required(env, 'os', location, string),
    osRelease: required(env, 'osRelease', location, string),
    arch: required(env, 'arch', location, string),
    cpuModel: required(env, 'cpuModel', location, string),
    cpuCount: required(env, 'cpuCount', location, count),
    memoryMb: required(env, 'memoryMb', location, quantity),
    node: required(env, 'node', location, string),
    runners: required(env, 'runners', location, runners),
    ci: required(env, 'ci', location, boolean),
  }
}

function snapshotCounters(value: unknown, location: string): SnapshotCounters {
  const counters = object(value, location)
  return {
    added: required(counters, 'added', location, count),
    matched: required(counters, 'matched', location, count),
    unmatched: required(counters, 'unmatched', location, count),
    updated: required(counters, 'updated', location, count),
    unchecked: required(counters, 'unchecked', location, count),
    total: required(counters, 'total', location, count),
    filesAdded: required(counters, 'filesAdded', location, count),
    filesRemoved: required(counters, 'filesRemoved', location, count),
    filesUnmatched: required(counters, 'filesUnmatched', location, count),
    filesUpdated: required(counters, 'filesUpdated', location, count),
  }
}

function sha256(value: unknown, location: string): string {
  const text = string(value, location)
  if (!SHA256.test(text)) throw new Mismatch(location, 'a hex SHA-256 (64 hex digits)', value)
  return text
}

function snapshotFile(value: unknown, location: string): SnapshotFileState {
  const state = object(value, location)
  return {
    file: required(state, 'file', location, string),
    sha256: required(state, 'sha256', location, sha256),
  }
}

function snapshots(value: unknown, location: string): NonNullable<NormalizedRun['snapshots']> {
  const state = object(value, location)
  return {
    counters: required(state, 'counters', location, snapshotCounters),
    files: required(state, 'files', location, list(snapshotFile)),
  }
}

function schemaVersion(value: unknown, location: string): typeof SCHEMA_VERSION {
  if (value !== SCHEMA_VERSION) {
    throw new Mismatch(location, `the schema version ${SCHEMA_VERSION}`, value)
  }
  return SCHEMA_VERSION
}

function normalizedRun(value: unknown): NormalizedRun {
  const run = object(value, '')
  const state = optional(run, 'snapshots', '', snapshots)
  return {
    schemaVersion: required(run, 'schemaVersion', '', schemaVersion),
    runner: required(run, 'runner', '', string),
    runnerVersion: required(run, 'runnerVersion', '', string),
    suite: required(run, 'suite', '', string),
    startedAt: required(run, 'startedAt', '', string),
    env: required(run, 'env', '', runEnvironment),
    files: required(run, 'files', '', list(normalizedFile)),
    ...(state === undefined ? {} : { snapshots: state }),
    runErrors: required(run, 'runErrors', '', list(normalizedError)),
    success: required(run, 'success', '', boolean),
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
