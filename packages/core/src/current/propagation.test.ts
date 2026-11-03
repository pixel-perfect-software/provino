// T5.5: the 23 propagation cases of Track 5 Spikes B, rebuilt from its table (the spike's
// `propagation.mjs` is gone). Each case runs two tests, A and B, under `currentTest.run`, and
// checks which one `currentTest.get()` sees. The two process-listener cases run in a child
// process, because `node:test` installs its own `uncaughtException`/`unhandledRejection` handlers.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter, EventEmitterAsyncResource } from 'node:events'
import { test } from 'node:test'
import { promisify } from 'node:util'
import vm from 'node:vm'
import type { Frame, TaskId } from '@provino/types'
import FakeTimers from '@sinonjs/fake-timers'
import { JSDOM } from 'jsdom'
import { currentTest } from './current-test.ts'

const A = frame('A')
const B = frame('B')

function frame(name: string): Frame {
  return { test: null, hook: null, fileId: name as TaskId, attempt: 0, repeat: 0 }
}

/** Which test the lookup sees: `'A'`, `'B'` or `'-'` for none. */
function seen(): string {
  return currentTest.get()?.fileId ?? '-'
}

/** One macrotask turn: the timer under test, not a wait for time to pass. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Registers a callback inside A, then runs B until the callback has fired (B awaits the callback's
 * own signal, so no case waits on wall time).
 */
async function registeredInA(register: (record: () => void) => void): Promise<string> {
  let observed = 'not called'
  const { promise: fired, resolve } = Promise.withResolvers<void>()
  currentTest.run(A, () =>
    register(() => {
      observed = seen()
      resolve()
    }),
  )
  await currentTest.run(B, () => fired)
  return observed
}

test('1. setTimeout registered in A, firing during B, sees A', async () => {
  assert.equal(await registeredInA((record) => setTimeout(record, 5)), 'A')
})

test('2. setImmediate registered in A, firing during B, sees A', async () => {
  assert.equal(await registeredInA((record) => setImmediate(record)), 'A')
})

test('3. setInterval registered in A, firing during B, sees A', async () => {
  const observed = await registeredInA((record) => {
    const id = setInterval(() => {
      clearInterval(id)
      record()
    }, 5)
  })
  assert.equal(observed, 'A')
})

test('4. process.nextTick registered in A, firing during B, sees A', async () => {
  assert.equal(await registeredInA((record) => process.nextTick(record)), 'A')
})

test('5. queueMicrotask registered in A, firing during B, sees A', async () => {
  assert.equal(await registeredInA((record) => queueMicrotask(record)), 'A')
})

test('6. promise.then registered in A, resolved from B, sees A', async () => {
  let resolve: () => void = () => undefined
  const pending = new Promise<void>((done) => {
    resolve = done
  })
  const observed = currentTest.run(A, () => pending.then(seen))
  currentTest.run(B, () => resolve())
  assert.equal(await observed, 'A')
})

test('7. awaiting a promise created in A, inside B, sees B', async () => {
  const created = currentTest.run(A, () => tick())
  const observed = await currentTest.run(B, async () => {
    await created
    return seen()
  })
  assert.equal(observed, 'B')
})

async function* lookups(count: number): AsyncGenerator<string> {
  for (let index = 0; index < count; index++) {
    await tick()
    yield seen()
  }
}

test('8. an async generator created and consumed in A sees A, A, A', async () => {
  const observed = await currentTest.run(A, async () => {
    const values: string[] = []
    for await (const value of lookups(3)) values.push(value)
    return values
  })
  assert.deepEqual(observed, ['A', 'A', 'A'])
})

test('9. an async generator created in A and consumed in B sees B, B', async () => {
  const generator = currentTest.run(A, () => lookups(2))
  const observed = await currentTest.run(B, async () => {
    const values: string[] = []
    for await (const value of generator) values.push(value)
    return values
  })
  assert.deepEqual(observed, ['B', 'B'])
})

test('10. an EventEmitter listener added in A, emitted in B, sees B', () => {
  const emitter = new EventEmitter()
  let observed = 'not called'
  currentTest.run(A, () =>
    emitter.on('event', () => {
      observed = seen()
    }),
  )
  currentTest.run(B, () => emitter.emit('event'))
  assert.equal(observed, 'B')
})

test('11. an EventEmitterAsyncResource created in A, emitted in B, sees A', () => {
  const emitter = currentTest.run(A, () => new EventEmitterAsyncResource({ name: 'propagation' }))
  let observed = 'not called'
  emitter.on('event', () => {
    observed = seen()
  })
  currentTest.run(B, () => emitter.emit('event'))
  emitter.emitDestroy()
  assert.equal(observed, 'A')
})

test('12. a function bound in A, called in B, sees A', () => {
  const bound = currentTest.run(A, () => currentTest.bind(seen))
  assert.equal(
    currentTest.run(B, () => bound()),
    'A',
  )
})

test('13. a fake timer set in A and fired by clock.tick in B sees B', () => {
  const clock = FakeTimers.createClock()
  let observed = 'not called'
  currentTest.run(A, () =>
    clock.setTimeout(() => {
      observed = seen()
    }, 10),
  )
  currentTest.run(B, () => clock.tick(10))
  assert.equal(observed, 'B')
})

test('14. a fake timer set in A and fired by clock.tickAsync in B sees B', async () => {
  const clock = FakeTimers.createClock()
  let observed = 'not called'
  currentTest.run(A, () =>
    clock.setTimeout(() => {
      observed = seen()
    }, 10),
  )
  await currentTest.run(B, () => clock.tickAsync(10))
  assert.equal(observed, 'B')
})

test('15. a fake timer set and ticked in the same test sees that test', () => {
  const clock = FakeTimers.createClock()
  let observed = 'not called'
  currentTest.run(A, () => {
    clock.setTimeout(() => {
      observed = seen()
    }, 10)
    clock.tick(10)
  })
  assert.equal(observed, 'A')
})

test('16. a jsdom listener added in A, dispatched in B, sees B', () => {
  const { window } = new JSDOM('<!doctype html><p>propagation</p>')
  let observed = 'not called'
  currentTest.run(A, () =>
    window.document.addEventListener('ping', () => {
      observed = seen()
    }),
  )
  currentTest.run(B, () => window.document.dispatchEvent(new window.Event('ping')))
  window.close()
  assert.equal(observed, 'B')
})

test("17. jsdom's window.setTimeout registered in A sees A", async () => {
  const { window } = new JSDOM('<!doctype html><p>propagation</p>')
  const observed = await registeredInA((record) => window.setTimeout(record, 5))
  window.close()
  assert.equal(observed, 'A')
})

test('18. two interleaved concurrent tests with 5 awaits each see A×5 and B×5', async () => {
  const order: string[] = []
  const body = (count: number) => async (): Promise<string[]> => {
    const values: string[] = []
    for (let index = 0; index < count; index++) {
      await (index % 2 === 0 ? Promise.resolve() : tick())
      const value = seen()
      values.push(value)
      order.push(value)
    }
    return values
  }
  const [a, b] = await Promise.all([currentTest.run(A, body(5)), currentTest.run(B, body(5))])
  assert.deepEqual(a, ['A', 'A', 'A', 'A', 'A'])
  assert.deepEqual(b, ['B', 'B', 'B', 'B', 'B'])
  // They really interleaved: the reads alternate rather than running A then B.
  assert.notDeepEqual(order, [...a, ...b])
})

test('19. a custom thenable resolved through setTimeout keeps A', async () => {
  const thenable = {
    // biome-ignore lint/suspicious/noThenProperty: the case is a hand-written thenable
    then(resolve: (value: number) => void): void {
      setTimeout(() => resolve(1), 1)
    },
  }
  const observed = await currentTest.run(A, async () => {
    await thenable
    return seen()
  })
  assert.equal(observed, 'A')
})

test('20–21. process listeners see the test that caused the error (child process)', async () => {
  const child = new URL('./fixtures/process-listeners.ts', import.meta.url)
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--conditions=provino-source', child.pathname],
    { env: process.env },
  )
  assert.deepEqual(JSON.parse(stdout), {
    unhandledRejection: 'A',
    uncaughtException: 'A',
  })
})

test("22. code in a vm.Context using that realm's Promise keeps A", async () => {
  const context = vm.createContext({ seen, setTimeout })
  const observed = await currentTest.run(A, () =>
    vm.runInContext('new Promise((resolve) => setTimeout(resolve, 1)).then(() => seen())', context),
  )
  assert.equal(observed, 'A')
})

test('23. interleaved concurrent tests inside a vm.Context see A×4 and B×4', async () => {
  const context = vm.createContext({ seen, setTimeout })
  const loop = vm.runInContext(
    `(async () => {
      const values = []
      for (let index = 0; index < 4; index++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        values.push(seen())
      }
      return values
    })`,
    context,
  ) as () => Promise<string[]>
  const [a, b] = await Promise.all([currentTest.run(A, loop), currentTest.run(B, loop)])
  // Arrays from another realm fail `deepStrictEqual`'s prototype check; compare the values.
  assert.deepEqual([...a], ['A', 'A', 'A', 'A'])
  assert.deepEqual([...b], ['B', 'B', 'B', 'B'])
})

test('outside any run, the lookup sees nothing', () => {
  assert.equal(currentTest.get(), undefined)
})
