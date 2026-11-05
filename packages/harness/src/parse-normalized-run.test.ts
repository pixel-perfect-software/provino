import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { FormattedTestResults } from '@jest/test-result'
import type { NormalizedRun } from '@provino/types'
import { convertJest } from './convert-jest.ts'
import { HarnessError } from './errors.ts'
import { parseNormalizedRun } from './parse-normalized-run.ts'
import { SCHEMA_VERSION } from './schema.ts'
import {
  convertOptions,
  ENV,
  makeFile,
  makeRun,
  makeTest,
  ROOT,
  snapshotSummary,
} from './test-support.ts'

const SOURCE = 'check/provino.json'

/** Every field of the model, optional ones included, in every place it can appear. */
const rich: NormalizedRun = makeRun(
  [
    {
      file: 'src/a.test.ts',
      status: 'failed',
      fileError: { message: 'afterAll blew up', raw: 'Error: afterAll blew up\n    at x' },
      tests: [
        {
          id: { file: 'src/a.test.ts', path: ['math', 'adds'], dupIndex: 1 },
          status: 'failed',
          errors: [
            {
              name: 'AssertionError',
              message: 'expected 4',
              matcher: 'toBe',
              userFrame: '<root>/src/a.test.ts:7:23',
              raw: 'AssertionError: expected 4',
            },
          ],
          passingAssertions: 2,
          retries: 1,
          durationMs: 12.5,
          location: { line: 3, column: 5 },
          console: [{ stream: 'stderr', level: 'warn', text: 'careful' }],
          expectedToFail: true,
        },
        {
          id: { file: 'src/a.test.ts', path: ['math', 'later'], dupIndex: 0 },
          status: 'skipped',
          skipReason: 'only-filter',
          errors: [],
        },
        makeTest('src/a.test.ts', ['todo'], { status: 'todo' }),
        makeTest('src/a.test.ts', ['queued'], { status: 'notRun' }),
      ],
      console: [{ stream: 'stdout', text: 'hello' }],
      trace: [
        { kind: 'hook:beforeAll', owner: ['math'], label: '0', outcome: 'ok' },
        { kind: 'test:start', owner: ['math', 'adds'] },
        { kind: 'mark', owner: [], label: 'here' },
      ],
      durationMs: 40,
    },
    { file: 'src/b.test.ts', status: 'crashed', tests: [], fileError: { message: 'x', raw: 'x' } },
    makeFile('src/c.test.ts', [], 'skipped'),
  ],
  {
    env: { ...ENV, runners: { jest: '30.5.2', provino: '0.0.0' } },
    snapshots: {
      counters: {
        added: 1,
        matched: 2,
        unmatched: 3,
        updated: 4,
        unchecked: 5,
        total: 6,
        filesAdded: 7,
        filesRemoved: 8,
        filesUnmatched: 9,
        filesUpdated: 10,
      },
      files: [{ file: 'src/__snapshots__/a.test.ts.snap', sha256: 'ab'.repeat(32) }],
    },
    runErrors: [{ name: 'Error', message: 'worker crashed', raw: 'Error: worker crashed' }],
    success: false,
  },
)

const minimal: NormalizedRun = makeRun([])

function invalid(error: unknown): error is HarnessError {
  return error instanceof HarnessError && error.code === 'HARNESS_RESULT_INVALID'
}

/** Whether a value, at any depth, is `undefined` (which a JSON-built value never is). */
function hasUndefined(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null) return false
  return Object.values(value).some(hasUndefined)
}

describe('a valid run', () => {
  test('a minimal run parses to the same run', () => {
    assert.deepEqual(parseNormalizedRun(JSON.stringify(minimal), SOURCE), minimal)
  })

  test('a run with every optional field in every place parses to the same run', () => {
    const parsed = parseNormalizedRun(JSON.stringify(rich), SOURCE)
    assert.deepEqual(parsed, rich)
    assert.equal(parsed.schemaVersion, SCHEMA_VERSION)
  })

  test('what convertJest returns parses to the same run', () => {
    const file = `${ROOT}/a.test.ts`
    const results: FormattedTestResults = {
      numFailedTestSuites: 0,
      numFailedTests: 1,
      numPassedTestSuites: 0,
      numPassedTests: 1,
      numPendingTestSuites: 0,
      numPendingTests: 1,
      numRuntimeErrorTestSuites: 0,
      numTotalTestSuites: 1,
      numTotalTests: 3,
      snapshot: snapshotSummary(),
      startTime: Date.UTC(2026, 0, 2),
      success: false,
      testResults: [
        {
          coverage: {},
          assertionResults: [
            {
              ancestorTitles: ['math'],
              fullName: 'math passes',
              status: 'passed',
              title: 'passes',
              failureMessages: [],
              location: { line: 3, column: 3 },
              duration: 1,
            },
            {
              ancestorTitles: ['math'],
              fullName: 'math fails',
              status: 'failed',
              title: 'fails',
              failureMessages: [
                `Error: expect(received).toBe(expected)\n    at Object.toBe (${file}:7:23)`,
              ],
              location: { line: 5, column: 3 },
              duration: 2,
            },
            {
              ancestorTitles: ['math'],
              fullName: 'math skipped',
              status: 'pending',
              title: 'skipped',
              failureMessages: [],
              location: null,
              duration: null,
            },
          ],
          endTime: 1_010,
          message: '',
          name: file,
          startTime: 1_000,
          status: 'failed',
          summary: '',
        },
      ],
      wasInterrupted: false,
    }
    const run = convertJest(results, convertOptions())
    assert.equal(run.files[0]?.tests.length, 3)
    assert.deepEqual(parseNormalizedRun(JSON.stringify(run), SOURCE), run)
  })

  test('an optional field the JSON lacks is absent from the result, never undefined', () => {
    const parsed = parseNormalizedRun(JSON.stringify(minimal), SOURCE)
    assert.equal('snapshots' in parsed, false)
    const [file] = parseNormalizedRun(
      JSON.stringify(makeRun([makeFile('a.test.ts', [makeTest('a.test.ts', ['t'])])])),
      SOURCE,
    ).files
    assert.ok(file !== undefined)
    for (const key of ['fileError', 'console', 'trace', 'durationMs']) {
      assert.equal(key in file, false, key)
    }
    for (const key of ['skipReason', 'passingAssertions', 'retries', 'durationMs', 'location']) {
      assert.equal(key in (file.tests[0] ?? {}), false, key)
    }
    assert.equal(hasUndefined(parseNormalizedRun(JSON.stringify(rich), SOURCE)), false)
  })

  test('a key the model does not define is ignored and left out', () => {
    const text = JSON.stringify({
      ...rich,
      extra: 1,
      files: rich.files.map((file) => ({ ...file, workerId: 3 })),
    })
    assert.deepEqual(parseNormalizedRun(text, SOURCE), rich)
  })

  test('a runner name that looks like a prototype key stays data', () => {
    const text = JSON.stringify(minimal).replace('"runners":{}', '"runners":{"__proto__":"1.0"}')
    assert.ok(text.includes('"__proto__"'))
    const { runners } = parseNormalizedRun(text, SOURCE).env
    assert.equal(Object.hasOwn(runners, '__proto__'), true)
    assert.equal(Object.getPrototypeOf(runners), Object.prototype)
  })
})

describe('text that is not a run', () => {
  test('is refused with HARNESS_RESULT_INVALID naming the source', () => {
    for (const text of ['', '{ nope', 'undefined']) {
      assert.throws(
        () => parseNormalizedRun(text, SOURCE),
        (error: unknown) =>
          invalid(error) &&
          error.message === `${SOURCE} is not valid JSON` &&
          error.path === SOURCE &&
          error.cause instanceof SyntaxError,
        text,
      )
    }
  })

  test('is refused when the JSON is not an object', () => {
    for (const text of ['[]', 'null', '3', '"run"', 'true']) {
      assert.throws(
        () => parseNormalizedRun(text, SOURCE),
        (error: unknown) => invalid(error) && /the run must be an object/.test(error.message),
        text,
      )
    }
  })
})

/** The mark for a key to delete. */
const MISSING = Symbol('missing')

/** `rich` as JSON text, with the value at `path` replaced (or the key deleted). */
function altered(path: readonly (string | number)[], value: unknown): string {
  const root: unknown = JSON.parse(JSON.stringify(rich))
  let target = root
  for (const key of path.slice(0, -1)) {
    assert.ok(typeof target === 'object' && target !== null, `no ${String(key)}`)
    target = Reflect.get(target, key)
  }
  const last = path.at(-1)
  assert.ok(typeof target === 'object' && target !== null && last !== undefined)
  if (value === MISSING) Reflect.deleteProperty(target, last)
  else Reflect.set(target, last, value)
  return JSON.stringify(root)
}

/** `files[0].tests[0].status`: a path as the message writes it. */
function written(path: readonly (string | number)[]): string {
  return path
    .map((key) => (typeof key === 'number' ? `[${key}]` : `.${key}`))
    .join('')
    .slice(1)
}

const TEST = ['files', 0, 'tests', 0] as const
const FILE = ['files', 0] as const

/** Each rule: the path in `rich` that is changed, and a value that breaks it. */
const broken: ReadonlyArray<readonly [what: string, path: (string | number)[], value: unknown]> = [
  ['a schema version of 2', ['schemaVersion'], 2],
  ['a schema version as text', ['schemaVersion'], '1'],
  ['a missing schema version', ['schemaVersion'], MISSING],
  ['a runner that is not text', ['runner'], 7],
  ['a missing runner', ['runner'], MISSING],
  ['a null runnerVersion', ['runnerVersion'], null],
  ['a missing suite', ['suite'], MISSING],
  ['a startedAt that is a number', ['startedAt'], 1_700_000_000],
  ['a missing startedAt', ['startedAt'], MISSING],
  ['an env that is an array', ['env'], []],
  ['a missing env', ['env'], MISSING],
  ['an os that is not text', ['env', 'os'], 1],
  ['a missing osRelease', ['env', 'osRelease'], MISSING],
  ['an arch that is null', ['env', 'arch'], null],
  ['a missing cpuModel', ['env', 'cpuModel'], MISSING],
  ['a cpuCount with a fraction', ['env', 'cpuCount'], 2.5],
  ['a negative memoryMb', ['env', 'memoryMb'], -1],
  ['a node that is not text', ['env', 'node'], 24],
  ['runners that are an array', ['env', 'runners'], ['jest']],
  ['a runner version that is not text', ['env', 'runners', 'jest'], 30],
  ['a ci that is text', ['env', 'ci'], 'true'],
  ['files that are an object', ['files'], {}],
  ['a missing files', ['files'], MISSING],
  ['a file that is null', [...FILE], null],
  ['a file path that is not text', [...FILE, 'file'], 3],
  ['a missing file path', [...FILE, 'file'], MISSING],
  ['an unknown file status', [...FILE, 'status'], 'pending'],
  ['a test status used for a file', [...FILE, 'status'], 'todo'],
  ['a missing file status', [...FILE, 'status'], MISSING],
  ['a fileError that is null', [...FILE, 'fileError'], null],
  ['a fileError with no message', [...FILE, 'fileError', 'message'], MISSING],
  ['a fileError with no raw', [...FILE, 'fileError', 'raw'], MISSING],
  ['a fileError name that is a number', [...FILE, 'fileError', 'name'], 1],
  ['a missing tests', [...FILE, 'tests'], MISSING],
  ['tests that are null', [...FILE, 'tests'], null],
  ['a file console entry with an unknown stream', [...FILE, 'console', 0, 'stream'], 'stdin'],
  ['a file console entry with no text', [...FILE, 'console', 0, 'text'], MISSING],
  ['a file console that is an object', [...FILE, 'console'], {}],
  ['an unknown trace kind', [...FILE, 'trace', 0, 'kind'], 'hook:around'],
  ['a trace owner that is text', [...FILE, 'trace', 0, 'owner'], 'math'],
  ['a trace owner with a number in it', [...FILE, 'trace', 0, 'owner', 0], 1],
  ['an unknown trace outcome', [...FILE, 'trace', 0, 'outcome'], 'fail'],
  ['a trace label that is a number', [...FILE, 'trace', 0, 'label'], 0],
  ['a file duration that is null', [...FILE, 'durationMs'], null],
  ['a file duration that is negative', [...FILE, 'durationMs'], -5],
  ['a test that is a string', [...TEST], 'passes'],
  ['a missing test id', [...TEST, 'id'], MISSING],
  ['a test id file that is a number', [...TEST, 'id', 'file'], 1],
  ['a test id path that is text', [...TEST, 'id', 'path'], 'math adds'],
  ['an empty test id path', [...TEST, 'id', 'path'], []],
  ['a test id path with a number in it', [...TEST, 'id', 'path', 1], 2],
  ['a missing dupIndex', [...TEST, 'id', 'dupIndex'], MISSING],
  ['a negative dupIndex', [...TEST, 'id', 'dupIndex'], -1],
  ['a dupIndex with a fraction', [...TEST, 'id', 'dupIndex'], 0.5],
  ['an unknown test status', [...TEST, 'status'], 'pending'],
  ['a file status used for a test', [...TEST, 'status'], 'crashed'],
  ['a missing test status', [...TEST, 'status'], MISSING],
  ['an unknown skipReason', [...TEST, 'skipReason'], 'because'],
  ['a null skipReason', [...TEST, 'skipReason'], null],
  ['missing errors', [...TEST, 'errors'], MISSING],
  ['errors that are an object', [...TEST, 'errors'], {}],
  ['an error with no message', [...TEST, 'errors', 0, 'message'], MISSING],
  ['an error message that is null', [...TEST, 'errors', 0, 'message'], null],
  ['an error with no raw', [...TEST, 'errors', 0, 'raw'], MISSING],
  ['an error matcher that is a number', [...TEST, 'errors', 0, 'matcher'], 1],
  ['an error userFrame that is null', [...TEST, 'errors', 0, 'userFrame'], null],
  ['a null passingAssertions', [...TEST, 'passingAssertions'], null],
  ['a negative passingAssertions', [...TEST, 'passingAssertions'], -1],
  ['a passingAssertions that is text', [...TEST, 'passingAssertions'], '2'],
  ['a retries with a fraction', [...TEST, 'retries'], 1.5],
  ['a test duration that is text', [...TEST, 'durationMs'], '12'],
  ['a location that is null', [...TEST, 'location'], null],
  ['a location with no column', [...TEST, 'location', 'column'], MISSING],
  ['a location line of 0', [...TEST, 'location', 'line'], 0],
  ['a test console entry with no stream', [...TEST, 'console', 0, 'stream'], MISSING],
  ['a console level that is a number', [...TEST, 'console', 0, 'level'], 1],
  ['an expectedToFail that is a number', [...TEST, 'expectedToFail'], 1],
  ['a null expectedToFail', [...TEST, 'expectedToFail'], null],
  ['snapshots that are null', ['snapshots'], null],
  ['snapshot counters that are missing', ['snapshots', 'counters'], MISSING],
  ['a missing snapshot counter', ['snapshots', 'counters', 'filesUpdated'], MISSING],
  ['a snapshot counter that is text', ['snapshots', 'counters', 'total'], '6'],
  ['a snapshot counter that is negative', ['snapshots', 'counters', 'added'], -1],
  ['snapshot files that are missing', ['snapshots', 'files'], MISSING],
  ['a snapshot file with no path', ['snapshots', 'files', 0, 'file'], MISSING],
  ['a snapshot sha256 that is too short', ['snapshots', 'files', 0, 'sha256'], 'abc'],
  ['a snapshot sha256 that is not hex', ['snapshots', 'files', 0, 'sha256'], 'z'.repeat(64)],
  ['runErrors that are missing', ['runErrors'], MISSING],
  ['a runError with no message', ['runErrors', 0, 'message'], MISSING],
  ['a runError that is a string', ['runErrors', 0], 'worker crashed'],
  ['a success that is text', ['success'], 'false'],
  ['a missing success', ['success'], MISSING],
]

describe('a run that breaks a rule', () => {
  for (const [what, path, value] of broken) {
    test(`${what} is refused, naming ${written(path)} and the source`, () => {
      assert.throws(
        () => parseNormalizedRun(altered(path, value), SOURCE),
        (error: unknown) =>
          invalid(error) &&
          error.message.startsWith(`${SOURCE} is not a NormalizedRun: ${written(path)} must be `) &&
          error.path === SOURCE,
      )
    })
  }

  test('the message says what was found', () => {
    const cases: ReadonlyArray<readonly [(string | number)[], unknown, string]> = [
      [['files', 0, 'status'], 'pending', '(got "pending")'],
      [['files', 0, 'tests', 0, 'status'], null, '(got null)'],
      [['files', 0, 'tests', 0, 'errors'], {}, '(got an object)'],
      [['files', 0, 'tests', 0, 'errors'], MISSING, '(got nothing, the key is missing)'],
      [['files', 0, 'tests', 0, 'id', 'dupIndex'], -2, '(got number -2)'],
    ]
    for (const [path, value, found] of cases) {
      assert.throws(
        () => parseNormalizedRun(altered(path, value), SOURCE),
        (error: unknown) => invalid(error) && error.message.endsWith(found),
        written(path),
      )
    }
  })

  test('the message lists the values an enum allows', () => {
    assert.throws(
      () => parseNormalizedRun(altered(['files', 0, 'tests', 0, 'status'], 'x'), SOURCE),
      {
        code: 'HARNESS_RESULT_INVALID',
        message: /status must be one of "passed", "failed", "skipped", "todo", "notRun"/,
      },
    )
    assert.throws(() => parseNormalizedRun(altered(['files', 0, 'status'], 'x'), SOURCE), {
      code: 'HARNESS_RESULT_INVALID',
      message: /status must be one of "passed", "failed", "crashed", "skipped"/,
    })
  })

  test('only the first problem is reported, in the order of the model’s fields', () => {
    const root: unknown = JSON.parse(JSON.stringify(rich))
    assert.ok(typeof root === 'object' && root !== null)
    Reflect.set(root, 'success', 'no')
    Reflect.set(root, 'runner', 1)
    assert.throws(() => parseNormalizedRun(JSON.stringify(root), SOURCE), {
      message: /runner must be a string/,
    })
  })

  test('a long string in the message is cut short', () => {
    assert.throws(
      () => parseNormalizedRun(altered(['files', 0, 'status'], 'x'.repeat(200)), SOURCE),
      {
        message: /\(got "x{40}…"\)$/,
      },
    )
  })
})
