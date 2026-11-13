// The reporter host over a played run: a recording reporter class (written to $TMPDIR as text, as
// a user's module would be) is loaded, constructed and called as jest-core's `ReporterDispatcher`
// calls it: the aliases (`onTestStart`, `onTestResult`), the order, the arguments, `getLastError`,
// the console buffer freed after the file result, one file at a time when serial, and Jest's
// message for a module that doesn't load.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createJestResults, type ProjectConfigLike } from '@provino/dialect-jest/results'
import type {
  FileInfo,
  FileResult,
  FileTask,
  Reporter,
  RunSummary,
  TaskId,
  TestTask,
} from '@provino/types'
import { createJestReporterHost } from './host.ts'
import { loadJestReporters } from './load.ts'
import type { JestReporterPlan } from './plan.ts'

const id = (name: string): TaskId => name as TaskId

const config: ProjectConfigLike = {
  rootDir: '/proj',
  testMatch: ['**/*.test.ts'],
  testLocationInResults: false,
  displayName: undefined,
}

const made: string[] = []
after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true })
})

/** A reporter module in a fresh directory: what it logs goes to the global `calls` array. */
async function reporterModule(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'provino-host-'))
  made.push(dir)
  const path = join(dir, 'reporter.cjs')
  await writeFile(path, body)
  return path
}

const RECORDING = `
const calls = (globalThis.__calls ??= [])
module.exports = class Recording {
  constructor(globalConfig, options, context) {
    calls.push(['constructor', options, context.firstRun])
  }
  onRunStart(results, options) { calls.push(['onRunStart', results.numTotalTestSuites, options.showStatus]) }
  onTestFileStart(test) { calls.push(['onTestFileStart', test.path]) }
  onTestCaseStart(test, info) { calls.push(['onTestCaseStart', info.fullName, info.mode]) }
  onTestCaseResult(test, result) { calls.push(['onTestCaseResult', result.fullName, result.status, result.invocations]) }
  onTestFileResult(test, result, results) {
    calls.push(['onTestFileResult', test.path, result.numFailingTests, result.console?.length ?? 0, results.numFailedTests])
  }
  onRunComplete(contexts, results) { calls.push(['onRunComplete', contexts.size, results.numTotalTests]) }
  getLastError() { return globalThis.__lastError }
}
`

const ALIASES = `
const calls = (globalThis.__calls ??= [])
module.exports = class Aliases {
  onTestStart(test) { calls.push(['onTestStart', test.path]) }
  onTestResult(test, result) { calls.push(['onTestResult', test.path, result.testFilePath]) }
}
`

function fileOf(path: string): FileInfo {
  return { fileId: id(path), path, project: '', projectIndex: 0 }
}

function testIn(file: string, name: string): TestTask {
  return {
    type: 'test',
    id: id(`${file}:${name}`),
    parentId: id(file),
    fileId: id(file),
    name,
    mode: 'run',
    location: null,
    tags: [],
    meta: {},
    fullName: [name],
    dupIndex: 0,
    each: false,
    concurrent: false,
    expectFail: false,
    timeoutMs: 5000,
    retry: 0,
    repeats: 0,
  }
}

function treeOf(info: FileInfo, tests: readonly TestTask[]): FileTask[] {
  const root = {
    type: 'file',
    id: info.fileId,
    parentId: null,
    fileId: info.fileId,
    name: info.path,
    mode: 'run',
    location: null,
    tags: [],
    meta: {},
    path: info.path,
    projectName: '',
    children: tests.map((test) => test.id),
  }
  return [root, ...tests] as unknown as FileTask[]
}

const resultOf = (state: 'pass' | 'fail') =>
  ({
    state,
    durationMs: 1,
    startTime: 0,
    errors: state === 'fail' ? [{ name: 'Error', message: 'no', stack: 'Error: no' }] : [],
    retryErrors: [],
    attempts: 1,
    repeatIndex: 0,
    assertions: 1,
    passingAssertions: state === 'pass' ? 1 : 0,
  }) as const

async function send<K extends keyof Reporter & string>(
  reporters: readonly Reporter[],
  event: K,
  ...args: unknown[]
): Promise<void> {
  for (const reporter of reporters) {
    const handler = reporter[event as keyof Reporter] as ((...a: unknown[]) => unknown) | undefined
    await handler?.(...args)
  }
}

/** Plays `files` (each one test, the second failing) through the collector and the host. */
async function play(
  paths: readonly string[],
  files: readonly string[],
  options: { serial?: boolean; showStatus?: boolean; interleave?: boolean } = {},
): Promise<{ calls: unknown[][]; reporters: readonly Reporter[] }> {
  const globals = globalThis as { __calls?: unknown[][]; __lastError?: Error }
  globals.__calls = []
  delete globals.__lastError
  const results = createJestResults({
    globalConfig: { noStackTrace: false },
    projectConfigs: [config],
  })
  const plan: JestReporterPlan = {
    steps: paths.map((path) => ({ kind: 'custom' as const, path, options: { tag: path.length } })),
    summary: undefined,
  }
  const entries = await loadJestReporters(plan)
  const host = createJestReporterHost({
    results,
    globalConfig: { rootDir: '/proj' },
    entries,
    showStatus: options.showStatus ?? true,
    ...(options.serial === undefined ? {} : { serial: options.serial }),
  })
  const reporters = [results.reporter, ...host]
  const infos = files.map(fileOf)
  await send(
    reporters,
    'run:start',
    { root: '/proj', projects: [''], startTime: 0, watch: false },
    infos,
  )
  const trees = infos.map((info, index) => {
    const test = testIn(info.path, `t${index}`)
    return { info, test, tree: treeOf(info, [test]) }
  })
  const finish = async ({ info, test, tree }: (typeof trees)[number], index: number) => {
    await send(reporters, 'file:collected', info, {
      type: 'file-collect-end',
      fileId: info.fileId,
      tasks: tree,
      errors: [],
      t: 0,
    })
    await send(reporters, 'test:attempt-start', test, { type: 'test-attempt-start', id: test.id })
    await send(reporters, 'task:start', test, { type: 'test-start', id: test.id, t: 0 })
    await send(reporters, 'console', info, {
      type: 'console',
      taskId: test.id,
      stream: 'stdout',
      level: 'log',
      text: 'hello\n',
      origin: 'at Object.log (a.test.ts:1:1)',
      t: 0,
    })
    const result = resultOf(index === 1 ? 'fail' : 'pass')
    await send(reporters, 'task:end', test, { type: 'test-end', id: test.id, result, t: 1 })
    const fileResult: FileResult = {
      file: info,
      state: result.state,
      durationMs: 1,
      errors: [],
    } as unknown as FileResult
    await send(reporters, 'file:end', fileResult)
  }
  if (options.interleave === true) {
    // The pool hands the second file out before the first has ended.
    await send(reporters, 'file:start', trees[0]?.info, 1)
    await send(reporters, 'file:start', trees[1]?.info, 2)
    if (trees[0] !== undefined) await finish(trees[0], 0)
    if (trees[1] !== undefined) await finish(trees[1], 1)
  } else {
    for (const [index, entry] of trees.entries()) {
      await send(reporters, 'file:start', entry.info, 1)
      await finish(entry, index)
    }
  }
  const summary: RunSummary = { reason: 'failed', files: [], unhandled: [], durationMs: 1 }
  await send(reporters, 'run:end', summary)
  return { calls: globals.__calls, reporters }
}

describe('createJestReporterHost', () => {
  it('calls the hooks in jest-core’s order with its arguments', async () => {
    const path = await reporterModule(RECORDING)
    const { calls } = await play([path], ['a.test.ts', 'b.test.ts'])
    assert.deepEqual(calls, [
      ['constructor', { tag: path.length }, true],
      ['onRunStart', 2, true],
      ['onTestFileStart', '/proj/a.test.ts'],
      ['onTestCaseStart', 't0', undefined],
      ['onTestCaseResult', 't0', 'passed', 1],
      // The console buffer is there for every reporter, and freed afterwards.
      ['onTestFileResult', '/proj/a.test.ts', 0, 1, 0],
      ['onTestFileStart', '/proj/b.test.ts'],
      ['onTestCaseStart', 't1', undefined],
      ['onTestCaseResult', 't1', 'failed', 1],
      ['onTestFileResult', '/proj/b.test.ts', 1, 1, 1],
      ['onRunComplete', 1, 2],
    ])
  })

  it('calls onTestStart and onTestResult for a reporter that has no file hooks', async () => {
    const path = await reporterModule(ALIASES)
    const { calls } = await play([path], ['a.test.ts'])
    assert.deepEqual(calls, [
      ['onTestStart', '/proj/a.test.ts'],
      ['onTestResult', '/proj/a.test.ts', '/proj/a.test.ts'],
    ])
  })

  it('reports getLastError as the reporter’s lastError, and nothing when it has none', async () => {
    const path = await reporterModule(RECORDING)
    const { reporters } = await play([path], ['a.test.ts'])
    const host = reporters.find((reporter) => reporter.name.startsWith('jest-reporter:'))
    assert.equal(host?.lastError?.(), undefined)
    ;(globalThis as { __lastError?: Error }).__lastError = new Error('deliberate')
    assert.equal(host?.lastError?.()?.message, 'deliberate')
  })

  it('fails the run for any truthy getLastError, as Jest keeps it (a string, not only an Error)', async () => {
    const path = await reporterModule(RECORDING)
    const { reporters } = await play([path], ['a.test.ts'])
    const host = reporters.find((reporter) => reporter.name.startsWith('jest-reporter:'))
    const globals = globalThis as { __lastError?: unknown }
    globals.__lastError = 'plain text'
    assert.equal(host?.lastError?.()?.message, 'plain text')
    globals.__lastError = 0
    assert.equal(host?.lastError?.(), undefined)
    delete globals.__lastError
  })

  it('frees the console buffer once every reporter has seen the file', async () => {
    const path = await reporterModule(RECORDING)
    const { reporters } = await play([path], ['a.test.ts'])
    const release = reporters.at(-1)
    assert.equal(release?.name, 'jest-reporter-release')
  })

  it('holds a file that starts early until the one before has had its result, when serial', async () => {
    const path = await reporterModule(RECORDING)
    const loose = await play([path], ['a.test.ts', 'b.test.ts'], {
      interleave: true,
      serial: false,
    })
    assert.deepEqual(loose.calls.map((call) => call[0]).slice(2, 5), [
      'onTestFileStart',
      'onTestFileStart',
      'onTestCaseStart',
    ])
    const serial = await play([path], ['a.test.ts', 'b.test.ts'], {
      interleave: true,
      serial: true,
    })
    assert.deepEqual(
      serial.calls.map((call) => call[0]),
      [
        'constructor',
        'onRunStart',
        'onTestFileStart',
        'onTestCaseStart',
        'onTestCaseResult',
        'onTestFileResult',
        'onTestFileStart',
        'onTestCaseStart',
        'onTestCaseResult',
        'onTestFileResult',
        'onRunComplete',
      ],
    )
  })

  it('wraps a constructor that throws in Jest’s message', async () => {
    const path = await reporterModule(
      "module.exports = class { constructor() { throw new Error('nope') } }\n",
    )
    await assert.rejects(play([path], ['a.test.ts']), (error: Error) => {
      assert.match(
        error.message,
        /An error occurred while adding the reporter at path ".*reporter\.cjs"\.\nnope/,
      )
      return true
    })
  })
})

describe('loadJestReporters', () => {
  it('refuses the github-actions option silent: false by name, and accepts silent: true', async () => {
    const plan = (silent: boolean): JestReporterPlan => ({
      steps: [{ kind: 'builtin', name: 'github-actions', options: { silent } }],
      summary: undefined,
    })
    await assert.rejects(loadJestReporters(plan(false)), /option 'silent: false' is not supported/)
    assert.equal((await loadJestReporters(plan(true))).length, 1)
  })

  it('loads each custom reporter of a plan, in order, and skips the built-ins', async () => {
    const a = await reporterModule(RECORDING)
    const b = await reporterModule(ALIASES)
    const entries = await loadJestReporters({
      steps: [
        { kind: 'custom', path: a, options: { x: 1 } },
        { kind: 'builtin', name: 'default', options: {} },
        { kind: 'custom', path: b, options: {} },
      ],
      summary: { options: {} },
    })
    assert.deepEqual(
      entries.map((entry) => [entry.path, entry.options]),
      [
        [a, { x: 1 }],
        [b, {}],
      ],
    )
  })

  it('says Jest’s message, with the module’s own error, when a module does not load', async () => {
    const path = await reporterModule("throw new Error('cannot load it')\n")
    await assert.rejects(
      loadJestReporters({
        steps: [{ kind: 'custom', path, options: {} }],
        summary: undefined,
      }),
      (error: Error) => {
        assert.ok(
          error.message.startsWith(
            `An error occurred while adding the reporter at path "${path}".\n`,
          ),
        )
        assert.match(error.message, /cannot load it/)
        return true
      },
    )
  })
})
