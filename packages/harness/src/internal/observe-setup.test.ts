import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'
import { OBSERVE_SETUP_PATH, TRACE_ENV, traceSetupSource } from './runner-config.ts'

type Observe = (id: string, run: () => unknown) => Promise<void>
const target = globalThis as { trace?: unknown; observe?: Observe }

/** Installs both setups the way a runner does, runs `body`, and returns the traced lines parsed. */
async function withSetups(body: (observe: Observe) => Promise<void>): Promise<unknown[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'harness-observe-setup-'))
  const saved = process.env[TRACE_ENV]
  try {
    const traceFile = path.join(dir, 'trace.txt')
    const traceSetup = path.join(dir, 'trace-setup.ts')
    await writeFile(traceSetup, traceSetupSource())
    process.env[TRACE_ENV] = traceFile
    await import(traceSetup)
    await import(`${OBSERVE_SETUP_PATH}?${Math.random()}`)
    assert.equal(typeof target.observe, 'function')
    await body(target.observe as Observe)
    const text = await readFile(traceFile, 'utf8').catch(() => '')
    return text === ''
      ? []
      : text
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line))
  } finally {
    delete target.trace
    delete target.observe
    if (saved === undefined) delete process.env[TRACE_ENV]
    else process.env[TRACE_ENV] = saved
    await rm(dir, { recursive: true, force: true })
  }
}

const observe1 = async (run: () => unknown): Promise<unknown> => {
  const [line] = await withSetups((observe) => observe('c', run))
  return line
}

test('the observe setup has no import, require or export, so Jest can run it as CommonJS', async () => {
  const source = await readFile(OBSERVE_SETUP_PATH, 'utf8')
  assert.doesNotMatch(source, /^\s*(import|export)\b|\brequire\(|\bimport\(/m)
})

test('a case traces exactly one JSON line with its id and its value', async () => {
  const lines = await withSetups(async (observe) => {
    await observe('first', () => ({ a: [1, 'two', null, true] }))
    await observe('second', () => 'text with\nnewline')
  })
  assert.deepEqual(lines, [
    { id: 'first', value: { a: [1, 'two', null, true] } },
    { id: 'second', value: 'text with\nnewline' },
  ])
})

test('an async case is awaited, and a throw or a rejection is the observation', async () => {
  assert.deepEqual(await observe1(async () => 5), { id: 'c', value: 5 })
  assert.deepEqual(
    await observe1(() => {
      throw new RangeError('too far')
    }),
    { id: 'c', threw: { $: 'error', name: 'RangeError', message: 'too far' } },
  )
  assert.deepEqual(await observe1(() => Promise.reject(new TypeError('no'))), {
    id: 'c',
    threw: { $: 'error', name: 'TypeError', message: 'no' },
  })
  assert.deepEqual(
    await observe1(() => {
      throw 'a string'
    }),
    { id: 'c', threw: 'a string' },
  )
})

test('values with no JSON form are reduced by name', async () => {
  const value = (await observe1(() => ({
    undef: undefined,
    nan: Number.NaN,
    inf: Number.POSITIVE_INFINITY,
    negInf: Number.NEGATIVE_INFINITY,
    negZero: -0,
    big: 12n,
    sym: Symbol('tag'),
    fn: function named() {},
    promise: Promise.resolve(1),
    map: new Map([['k', 1]]),
    set: new Set([1, 2]),
    date: new Date(0),
    badDate: new Date(Number.NaN),
    regexp: /a+/g,
  }))) as { value: unknown }
  assert.deepEqual(value.value, {
    undef: { $: 'undefined' },
    nan: { $: 'number', value: 'NaN' },
    inf: { $: 'number', value: 'Infinity' },
    negInf: { $: 'number', value: '-Infinity' },
    negZero: { $: 'number', value: '-0' },
    big: { $: 'bigint', value: '12' },
    sym: { $: 'symbol', value: 'tag' },
    fn: { $: 'function', name: 'named' },
    promise: { $: 'promise' },
    map: { $: 'map', entries: [['k', 1]] },
    set: { $: 'set', values: [1, 2] },
    date: { $: 'date', value: '1970-01-01T00:00:00.000Z' },
    badDate: { $: 'date', value: 'Invalid Date' },
    regexp: { $: 'regexp', value: '/a+/g' },
  })
})

test('an error is its name and message, with no stack and no path', async () => {
  const line = JSON.stringify(await observe1(() => ({ error: new Error('boom') })))
  assert.equal(line, '{"id":"c","value":{"error":{"$":"error","name":"Error","message":"boom"}}}')
})

test('values from another realm reduce the same as local ones', async () => {
  const foreign = vm.runInNewContext(
    '({ error: new Error("foreign"), list: [1, 2], promise: Promise.resolve(1), map: new Map(), when: new Date(0) })',
  )
  assert.equal(foreign.error instanceof Error, false, 'the error is not an Error of this realm')
  assert.deepEqual(await observe1(() => foreign), {
    id: 'c',
    value: {
      error: { $: 'error', name: 'Error', message: 'foreign' },
      list: [1, 2],
      promise: { $: 'promise' },
      map: { $: 'map', entries: [] },
      when: { $: 'date', value: '1970-01-01T00:00:00.000Z' },
    },
  })
})

test('object keys keep their order, symbol keys are dropped, and a throwing getter is shown', async () => {
  const input = {
    z: 1,
    a: 2,
    [Symbol('hidden')]: 3,
    get bad(): number {
      throw new Error('getter failed')
    },
  }
  const line = JSON.stringify(await observe1(() => input))
  assert.equal(
    line,
    '{"id":"c","value":{"z":1,"a":2,"bad":{"$":"threw","error":{"$":"error","name":"Error","message":"getter failed"}}}}',
  )
})

test('a cycle and a value nested too deep are marked, not followed', async () => {
  const cyclic: { self?: unknown; list: unknown[] } = { list: [] }
  cyclic.self = cyclic
  cyclic.list.push(cyclic)
  assert.deepEqual(await observe1(() => cyclic), {
    id: 'c',
    value: { list: [{ $: 'circular' }], self: { $: 'circular' } },
  })
  let deep: unknown = 'bottom'
  for (let i = 0; i < 12; i++) deep = [deep]
  const line = JSON.stringify(await observe1(() => deep))
  assert.match(line, /\{"\$":"deep"\}/)
  assert.doesNotMatch(line, /bottom/)
})

test('a shared reference that is not a cycle is shown each time', async () => {
  const shared = { n: 1 }
  assert.deepEqual(await observe1(() => [shared, shared]), { id: 'c', value: [{ n: 1 }, { n: 1 }] })
})

test('observe without the trace setup, or without an id, throws instead of tracing nothing', async () => {
  await withSetups(async (observe) => {
    await assert.rejects(
      observe('', () => 1),
      /non-empty id/,
    )
    delete target.trace
    await assert.rejects(
      observe('x', () => 1),
      /trace setup/,
    )
  })
})
