// An inline worker inside another worker's process (`src/worker/internal/runtime/process-globals.ts`);
// what the process lacks under another runner is planted first, so no check passes on an empty one.
import assert from 'node:assert/strict'
import process from 'node:process'
import { connectWorker, transportFor } from '@provino/orchestrator'
import { createConsoleCapture, PROCESS_SLOTS } from '@provino/orchestrator/worker'
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

const EVENTS = ['uncaughtException', 'unhandledRejection', 'rejectionHandled'] as const

type Listener = (...args: unknown[]) => void
/** What the generated test files read and write on the global the workers share. */
type Shared = typeof globalThis & {
  __keys?: readonly symbol[]
  __above?: readonly unknown[]
  __outer?: Outer
  __seen?: unknown[]
  __runInner?: () => Promise<string[][]>
  __held?: PromiseWithResolvers<void>
  __release?: PromiseWithResolvers<void>
}
const shared = globalThis as Shared

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
  const planted = PROCESS_SLOTS.filter((key) => !Object.hasOwn(globalThis, key))
  for (const key of planted) {
    Object.defineProperty(globalThis, key, {
      value: { standIn: key.description },
      configurable: true,
    })
  }
  const heard: unknown[] = []
  const listen: Listener = (error) => void heard.push(error)
  process.on('uncaughtException', listen)
  process.on('unhandledRejection', listen)
  // A capture like the outer worker's, over whatever console the process has now.
  const beneath = globalThis.console
  const capture = createConsoleCapture({ emit: () => {}, currentTaskId: () => null })
  const sink = { write: () => true }
  const installed = capture.install({ stdout: sink, stderr: sink }, globalThis)
  const outer: Outer = {
    slots: PROCESS_SLOTS.map((key) => Reflect.getOwnPropertyDescriptor(globalThis, key)),
    listeners: EVENTS.map((event) => process.rawListeners(event) as Listener[]),
    console: globalThis.console,
    beneath,
    heard,
  }
  shared.__keys = PROCESS_SLOTS
  shared.__above = outer.slots.map((descriptor) => descriptor?.value)
  shared.__outer = outer
  shared.__seen = []
  try {
    await body(outer)
  } finally {
    installed.restore()
    process.removeListener('uncaughtException', listen)
    process.removeListener('unhandledRejection', listen)
    for (const key of planted) Reflect.deleteProperty(globalThis, key)
    for (const key of [
      '__keys',
      '__above',
      '__outer',
      '__seen',
      '__runInner',
      '__held',
      '__release',
    ])
      Reflect.deleteProperty(shared, key)
  }
}

/** Every slot, error listener and the console are exactly what `outer` recorded. */
function assertAsFound(outer: Outer, when: string): void {
  PROCESS_SLOTS.forEach((key, index) => {
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

/** An inline worker over the real entry, connected: its events as they come. */
async function startInline(
  config: SerializedProjectConfig,
  options: { readonly captureConsole?: boolean; readonly teardownTimeoutMs?: number } = {},
) {
  const events: WorkerEvent[] = []
  const transport = await transportFor('inline', {
    entry: RUNTIME_ENTRY,
    stderr: new Collect(),
    ...(options.teardownTimeoutMs === undefined
      ? {}
      : { teardownTimeoutMs: options.teardownTimeoutMs }),
  }).create({
    ...initFor('inline'),
    config,
    ...(options.captureConsole === true ? { captureConsole: true } : {}),
  })
  const connection = connectWorker(transport, {
    methods,
    onEvents: (batch) => void events.push(...batch),
  })
  return { events, transport, connection }
}

/** One inline worker over the real entry: its events and how it ended. */
async function runInline(
  config: SerializedProjectConfig,
  jobs: readonly FileJob[],
  options: { readonly end?: 'stop' | 'kill'; readonly captureConsole?: boolean } = {},
): Promise<{ events: WorkerEvent[]; exit: WorkerExit }> {
  const { events, transport, connection } = await startInline(config, options)
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

/** The codes of the worker's unhandled errors. */
function unhandledCodes(events: readonly WorkerEvent[]): unknown[] {
  return eventsOf(events, 'unhandled-error').map((event) => event.error.code)
}

/**
 * A test file that notes what each slot holds (`own`: a value, and not the one the worker above
 * holds; `above`; `none`) and which console it has, then leaves an exception and a rejection
 * behind after its body.
 */
const NOTING = [
  "test('sees its own worker', () => {",
  '  const above = globalThis.__above',
  '  globalThis.__seen.push({',
  "    slots: globalThis.__keys.map((key, at) => globalThis[key] === undefined ? 'none' : globalThis[key] === above[at] ? 'above' : 'own'),",
  '    beneath: console === globalThis.__outer.beneath,',
  '    outerConsole: console === globalThis.__outer.console,',
  '  })',
  '})',
  'const turn = () => new Promise((resolve) => setImmediate(resolve))',
  "test('throws after its body', async () => {",
  "  setImmediate(() => { throw new Error('late, from the inner worker') })",
  '  await turn()',
  '  await turn()',
  '})',
  "test('rejects after its body', async () => {",
  "  Promise.reject(new Error('rejected, in the inner worker'))",
  '  await turn()',
  '  await turn()',
  '})',
  "test('passes', () => {})",
].join('\n')

const NOTED_STATES = [
  ['sees its own worker', 'pass'],
  ['throws after its body', 'fail'],
  ['rejects after its body', 'fail'],
  ['passes', 'pass'],
]

/** The matcher slot and the lazy runtime are the inner worker's own; the fixtures install no API. */
const OWN_SLOTS = ['own', 'own', 'none']

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
        // It booted (no EXPECT_SLOT_TAKEN), and its file's late exception and rejection are its own.
        assert.deepEqual(states(run.events), NOTED_STATES)
        // Out of band the file has the console the outer capture replaced; in band, its own capture's.
        assert.deepEqual(shared.__seen, [
          { slots: OWN_SLOTS, beneath: !captureConsole, outerConsole: false },
        ])
        assertAsFound(outer, 'after a stop')
      })
    })
  }

  it('two levels: an in-band worker inside the outer one, and an inline worker inside that', async () => {
    const p = await project({
      'middle.test.js': [
        "test('runs an inner worker', async () => {",
        '  const mine = globalThis.__keys.map((key) => globalThis[key])',
        '  const above = globalThis.__above',
        '  globalThis.__above = mine',
        '  try {',
        '    globalThis.__seen.push({ inner: await globalThis.__runInner() })',
        '  } finally {',
        '    globalThis.__above = above',
        '  }',
        '  globalThis.__seen.push({ middleBack: globalThis.__keys.map((key, at) => globalThis[key] === mine[at]) })',
        '})',
      ].join('\n'),
      'inner.test.js': NOTING,
    })
    const config = runtimeConfig(p.dir)
    await withOuter(async (outer) => {
      shared.__runInner = async () =>
        states((await runInline(config, [runtimeJob(config, p.path('inner.test.js'))])).events)
      const middle = await runInline(config, [runtimeJob(config, p.path('middle.test.js'))], {
        captureConsole: true,
      })
      assert.deepEqual(unhandledCodes(middle.events), [])
      assert.deepEqual(states(middle.events), [['runs an inner worker', 'pass']])
      assert.deepEqual(shared.__seen, [
        // The inner file's notes: its own slots (not the middle worker's), the console beneath both captures.
        { slots: OWN_SLOTS, beneath: true, outerConsole: false },
        { inner: NOTED_STATES },
        // The middle worker's slots are back once the inner worker has stopped.
        { middleBack: [true, true, true] },
      ])
      assertAsFound(outer, 'after both stopped')
    })
  })

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

  it('a worker killed while its file runs on is no one to adopt: the next one fails loudly, and its own stop puts the outer slots back', async () => {
    const p = await project({
      'hold.test.js': [
        "test('holds', async () => {",
        '  globalThis.__held.resolve()',
        '  await globalThis.__release.promise',
        '})',
      ].join('\n'),
      'next.test.js': "test('never runs', () => {})",
    })
    const config = runtimeConfig(p.dir)
    await withOuter(async (outer) => {
      shared.__held = Promise.withResolvers<void>()
      shared.__release = Promise.withResolvers<void>()
      // A short bound: the kill is reported while the stop still waits behind the held file.
      const first = await startInline(config, { teardownTimeoutMs: 1 })
      const holding = first.connection
        .run(runtimeJob(config, p.path('hold.test.js')))
        .catch(() => undefined)
      await shared.__held.promise
      await first.transport.terminate(true)
      await first.connection.exited
      const listenersBefore = EVENTS.map((event) => process.rawListeners(event))

      const next = await runInline(config, [runtimeJob(config, p.path('next.test.js'))])
      // It found the first worker's slots, marked stopped when its link closed, and refused them.
      assert.equal(unhandledCodes(next.events).includes('EXPECT_SLOT_TAKEN'), true)
      assert.deepEqual(states(next.events), [])
      EVENTS.forEach((event, index) => {
        const now = process.rawListeners(event)
        assert.equal(
          now.length === listenersBefore[index]?.length &&
            now.every((listener, at) => listener === listenersBefore[index]?.[at]),
          true,
          `the next worker took the ${event} listeners`,
        )
      })

      // The held file ends; the first worker's stop runs now and puts the outer slots back.
      shared.__release.resolve()
      await holding
      for (let turn = 0; turn < 1000 && !slotsAsFound(outer); turn++) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      assertAsFound(outer, "after the first worker's late stop")
    })
  })
})

/** Whether every slot holds what `outer` recorded (the late stop's end, polled by turns). */
function slotsAsFound(outer: Outer): boolean {
  return PROCESS_SLOTS.every(
    (key, index) =>
      Reflect.getOwnPropertyDescriptor(globalThis, key)?.value === outer.slots[index]?.value,
  )
}
