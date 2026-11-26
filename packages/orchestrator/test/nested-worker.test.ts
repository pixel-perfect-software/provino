// An inline worker started inside another worker's process: a test that runs Provino in band
// while Provino runs it (`run()` on an inline pool, `provino jest -i`). The outer worker holds its
// slots, its process error listeners and its console capture; the inner one sets each aside as it
// starts and puts it back, exactly as it found it, when it stops, after a start that throws half-way
// and a kill without a stop too (`src/worker/internal/runtime/process-globals.ts`). Under Provino
// the outer worker's own are there; a slot, a listener or a capture the process lacks (another
// runner) is planted first, so the check never passes on an empty process.
import assert from 'node:assert/strict'
import process from 'node:process'
import { connectWorker, transportFor } from '@provino/orchestrator'
import { createConsoleCapture } from '@provino/orchestrator/worker'
import { moduleRef } from '@provino/policy'
import type {
  FileJob,
  GlobalsFactory,
  RuntimeEventOf,
  SerializedProjectConfig,
  WorkerEvent,
  WorkerExit,
} from '@provino/types'
import { afterAll, describe, it } from 'provino'
import {
  Collect,
  eventsOf,
  fixture,
  initFor,
  methods,
  RUNTIME_ENTRY,
  runtimeConfig,
  runtimeJob,
  trackedProjects,
} from './support.ts'

const project = trackedProjects(afterAll)

/** The process-global slots a worker's boot installs: the matchers, the lazy runtime, the native API. */
const SLOTS = [
  Symbol.for('$$jest-matchers-object'),
  Symbol.for('provino.lazy.runtime'),
  Symbol.for('provino.api'),
] as const
const EVENTS = ['uncaughtException', 'unhandledRejection', 'rejectionHandled'] as const

type Listener = (...args: unknown[]) => void
type Shared = typeof globalThis & { __outer?: Outer; __seen?: unknown[] }

/** What the process held when the inner worker started: what it must find again after it. */
interface Outer {
  readonly slots: readonly (PropertyDescriptor | undefined)[]
  readonly listeners: readonly (readonly Listener[])[]
  readonly console: Console
  /** The console the outer capture replaced: the one the inner worker's files must see. */
  readonly beneath: Console
  /** What the planted error listener heard (nothing while the inner worker lives). */
  readonly heard: unknown[]
}

/**
 * Plants what the process lacks (a stand-in slot, an error listener, a console capture over the
 * current console), runs `body` with what the process then holds, and takes the plants away.
 */
async function withOuter(body: (outer: Outer) => Promise<void>): Promise<void> {
  const planted = SLOTS.filter((key) => !Object.hasOwn(globalThis, key))
  for (const key of planted) {
    Object.defineProperty(globalThis, key, {
      value: { standIn: key.description },
      configurable: true,
    })
  }
  const heard: unknown[] = []
  const listen: Listener = (error) => void heard.push(error)
  process.on('uncaughtException', listen)
  // A capture like the outer worker's, over whatever console the process has now.
  const beneath = globalThis.console
  const capture = createConsoleCapture({ emit: () => {}, currentTaskId: () => null })
  const sink = { write: () => true }
  const installed = capture.install({ stdout: sink, stderr: sink }, globalThis)
  const outer: Outer = {
    slots: SLOTS.map((key) => Reflect.getOwnPropertyDescriptor(globalThis, key)),
    listeners: EVENTS.map((event) => process.rawListeners(event) as Listener[]),
    console: globalThis.console,
    beneath,
    heard,
  }
  const shared = globalThis as Shared
  shared.__outer = outer
  shared.__seen = []
  try {
    await body(outer)
  } finally {
    installed.restore()
    process.removeListener('uncaughtException', listen)
    for (const key of planted) Reflect.deleteProperty(globalThis, key)
    Reflect.deleteProperty(shared, '__outer')
    Reflect.deleteProperty(shared, '__seen')
  }
}

/** Every slot, error listener and the console are exactly what `outer` recorded. */
function assertAsFound(outer: Outer, when: string): void {
  SLOTS.forEach((key, index) => {
    const now = Reflect.getOwnPropertyDescriptor(globalThis, key)
    const found = outer.slots[index]
    // Booleans: a failed assertion on a slot's value would print the whole runtime.
    assert.equal(now?.value === found?.value, true, `${when}: ${key.description} is another value`)
    assert.equal(now?.configurable, found?.configurable, `${when}: ${key.description}`)
  })
  EVENTS.forEach((event, index) => {
    const now = process.rawListeners(event) as Listener[]
    const found = outer.listeners[index] ?? []
    assert.equal(now.length, found.length, `${when}: the ${event} listeners`)
    assert.equal(
      now.every((listener, at) => listener === found[at]),
      true,
      `${when}: the ${event} listeners are others, or in another order`,
    )
  })
  assert.equal(globalThis.console === outer.console, true, `${when}: the console`)
  assert.deepEqual(outer.heard, [], `${when}: the outer listener heard the inner worker's error`)
}

/** One inline worker over the real entry: its events, its `fileDone`s and how it ended. */
async function runInline(
  config: SerializedProjectConfig,
  jobs: readonly FileJob[],
  options: { readonly end?: 'stop' | 'kill'; readonly captureConsole?: boolean } = {},
): Promise<{ events: WorkerEvent[]; exit: WorkerExit }> {
  const events: WorkerEvent[] = []
  const transport = await transportFor('inline', {
    entry: RUNTIME_ENTRY,
    stderr: new Collect(),
  }).create({
    ...initFor('inline'),
    config,
    ...(options.captureConsole === true ? { captureConsole: true } : {}),
  })
  const connection = connectWorker(transport, {
    methods,
    onEvents: (batch) => void events.push(...batch),
  })
  for (const job of jobs) await connection.run(job)
  await transport.terminate(options.end === 'kill')
  return { events, exit: await connection.exited }
}

/** Each test's name and state, in the order they ended. */
function states(events: readonly WorkerEvent[]): string[][] {
  const names = new Map<string, string>()
  for (const event of eventsOf(events, 'file-collect-end')) {
    for (const task of event.tasks) names.set(task.id, task.name)
  }
  return eventsOf(events, 'test-end').map((event: RuntimeEventOf<'test-end'>) => [
    names.get(event.id) ?? event.id,
    event.result.state,
  ])
}

/** A test file that notes, for each slot, whether it is the outer one, and which console it has. */
const NOTING = [
  "test('sees its own worker', () => {",
  '  const outer = globalThis.__outer',
  '  const keys = [',
  "    Symbol.for('$$jest-matchers-object'),",
  "    Symbol.for('provino.lazy.runtime'),",
  "    Symbol.for('provino.api'),",
  '  ]',
  '  globalThis.__seen.push({',
  '    outerSlots: keys.filter((key, at) => globalThis[key] !== undefined && globalThis[key] === outer.slots[at]?.value).map(String),',
  '    beneath: console === outer.beneath,',
  '    outerConsole: console === outer.console,',
  '  })',
  '})',
  "test('throws after its body', async () => {",
  "  setTimeout(() => { throw new Error('late, from the inner worker') }, 1)",
  '  await new Promise((resolve) => setTimeout(resolve, 20))',
  '})',
  "test('passes', () => {})",
].join('\n')

describe('an inline worker inside another worker’s process', () => {
  for (const captureConsole of [false, true]) {
    it(`sets the outer slots, error listeners and console aside and puts each back as found${captureConsole ? ' (in band)' : ''}`, async () => {
      const p = await project({ 'a.test.js': NOTING })
      const config = runtimeConfig(p.dir)
      await withOuter(async (outer) => {
        const run = await runInline(config, [runtimeJob(config, p.path('a.test.js'))], {
          captureConsole,
        })
        assert.deepEqual(run.exit, { type: 'exit', code: 0 })
        // The inner worker booted (no EXPECT_SLOT_TAKEN), and its file's late error is its own.
        assert.deepEqual(states(run.events), [
          ['sees its own worker', 'pass'],
          ['throws after its body', 'fail'],
          ['passes', 'pass'],
        ])
        // Out of band the file has the console the outer capture replaced; in band, the inner capture's own.
        assert.deepEqual((globalThis as Shared).__seen, [
          { outerSlots: [], beneath: !captureConsole, outerConsole: false },
        ])
        assertAsFound(outer, 'after a stop')
      })
    })
  }

  it('puts them back after a start that throws half-way, with the slots it had installed', async () => {
    const p = await project({ 'a.test.js': "test('never runs', () => {})" })
    // The globals factory fails to load after the matcher slot, the lazy runtime and the error
    // listeners are in.
    const config = runtimeConfig(p.dir, {
      globals: moduleRef<GlobalsFactory>(fixture('runtime-globals.ts').href, 'noSuchFactory'),
    })
    await withOuter(async (outer) => {
      const run = await runInline(config, [runtimeJob(config, p.path('a.test.js'))])
      assert.deepEqual(run.exit, { type: 'exit', code: 0 })
      assert.equal(eventsOf(run.events, 'unhandled-error').length, 1)
      assert.deepEqual(states(run.events), [])
      assertAsFound(outer, 'after a failed start')
    })
  })

  it('puts them back when it is killed without a stop', async () => {
    const p = await project({ 'a.test.js': "test('passes', () => {})" })
    const config = runtimeConfig(p.dir)
    await withOuter(async (outer) => {
      const run = await runInline(config, [runtimeJob(config, p.path('a.test.js'))], {
        end: 'kill',
      })
      assert.deepEqual(states(run.events), [['passes', 'pass']])
      assertAsFound(outer, 'after a kill')
    })
  })
})
