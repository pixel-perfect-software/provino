import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Reporter, SerializedError } from '@provino/types'
import { createReporterBus } from './bus.ts'
import { defineReporter } from './define.ts'
import { error, fileInfo, recorder } from './internal/test-support.ts'

const FILE = fileInfo('a.test.ts')

/** Lets every already-queued microtask run, without a timer. */
async function turns(count = 5): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve()
}

describe('defineReporter', () => {
  test('returns the reporter it was given, name kept', () => {
    const reporter = { name: 'mine', 'run:start': () => {} }
    assert.equal(defineReporter(reporter), reporter)
  })
})

describe('createReporterBus: delivery', () => {
  test('sends an event to the reporters in the order they were added', async () => {
    const log: string[] = []
    const bus = createReporterBus([recorder('a', log), recorder('b', log)])
    bus.add(recorder('c', log))
    await bus.emit('file:queued', FILE)
    assert.deepEqual(log, ['a:file:queued', 'b:file:queued', 'c:file:queued'])
  })

  test('awaits each handler before calling the next', async () => {
    const log: string[] = []
    const slow = (name: string): Reporter => ({
      name,
      async 'file:queued'() {
        log.push(`${name}:start`)
        await turns()
        log.push(`${name}:end`)
      },
    })
    const bus = createReporterBus([slow('a'), slow('b')])
    await bus.emit('file:queued', FILE)
    assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'b:end'])
  })

  test('passes the event’s arguments through, and calls a handler as a method', async () => {
    const seen: unknown[] = []
    const reporter = {
      name: 'method',
      label: 'mine',
      'file:start'(this: { readonly label: string }, file: unknown, workerId: number) {
        seen.push(this.label, file, workerId)
      },
    }
    await createReporterBus([reporter]).emit('file:start', FILE, 3)
    assert.deepEqual(seen, ['mine', FILE, 3])
  })

  test('skips a reporter with no handler for the event', async () => {
    const log: string[] = []
    const bus = createReporterBus([{ name: 'silent' }, recorder('loud', log)])
    await bus.emit('run:end', { reason: 'passed', files: [], unhandled: [], durationMs: 0 })
    assert.deepEqual(log, ['loud:run:end'])
  })

  test('resolves with no reporters', async () => {
    await createReporterBus().emit('file:queued', FILE)
  })

  test('is not affected by later changes to the array it was made from', async () => {
    const log: string[] = []
    const reporters = [recorder('a', log)]
    const bus = createReporterBus(reporters)
    reporters.push(recorder('b', log))
    await bus.emit('file:queued', FILE)
    assert.deepEqual(log, ['a:file:queued'])
  })

  test('a reporter added during an emit first sees the next event', async () => {
    const log: string[] = []
    const bus = createReporterBus()
    const late = recorder('late', log)
    bus.add({
      name: 'adder',
      'file:queued'() {
        bus.add(late)
      },
    })
    await bus.emit('file:queued', FILE)
    assert.deepEqual(log, [])
    await bus.emit('file:queued', FILE)
    assert.deepEqual(log, ['late:file:queued'])
  })

  test('delivers events one at a time, in the order emit was called', async () => {
    const log: string[] = []
    const first = fileInfo('first.test.ts')
    const second = fileInfo('second.test.ts')
    const bus = createReporterBus([
      {
        name: 'slow',
        async 'file:queued'(file) {
          log.push(`start ${file.path}`)
          await turns(10)
          log.push(`end ${file.path}`)
        },
      },
    ])
    await Promise.all([bus.emit('file:queued', first), bus.emit('file:queued', second)])
    assert.deepEqual(log, [
      'start first.test.ts',
      'end first.test.ts',
      'start second.test.ts',
      'end second.test.ts',
    ])
  })
})

describe('createReporterBus: a reporter that throws', () => {
  test('is recorded, and does not stop the others or fail emit', async () => {
    const log: string[] = []
    const bus = createReporterBus([
      recorder('a', log),
      recorder('bad', log, { throwOn: 'file:queued' }),
      recorder('c', log),
    ])
    await bus.emit('file:queued', FILE)
    assert.deepEqual(
      log.filter((line) => line.endsWith(':file:queued')),
      ['a:file:queued', 'bad:file:queued', 'c:file:queued'],
    )
    const [failure, ...rest] = bus.failures()
    assert.deepEqual(rest, [])
    assert.equal(failure?.name, 'Error')
    assert.equal(failure?.message, 'bad threw on file:queued')
    assert.match(failure?.stack ?? '', /bus\.test|test-support/)
  })

  test('is announced to the other reporters as error(…, "reporter"), never back to itself', async () => {
    const log: string[] = []
    const origins: string[] = []
    const bus = createReporterBus([
      recorder('a', log),
      recorder('bad', log, { throwOn: 'file:end' }),
      {
        name: 'c',
        error(_error, origin) {
          origins.push(origin)
          log.push('c:error')
        },
      },
    ])
    await bus.emit('file:end', { file: FILE, state: 'pass', durationMs: 1, errors: [] })
    assert.deepEqual(log, [
      'a:file:end',
      'bad:file:end',
      'a:error bad threw on file:end',
      'c:error',
    ])
    assert.deepEqual(origins, ['reporter'])
  })

  test('rejects the same way as it throws', async () => {
    const log: string[] = []
    const bus = createReporterBus([
      {
        name: 'async-bad',
        async 'run:start'() {
          await turns(2)
          throw new TypeError('late failure')
        },
      },
      recorder('b', log),
    ])
    await bus.emit('run:start', { root: '/', projects: [], startTime: 0, watch: false }, [])
    assert.deepEqual(log, ['b:run:start', 'b:error late failure'])
    assert.equal(bus.failures()[0]?.name, 'TypeError')
  })

  test('is announced once: a reporter that throws on the announcement is recorded, not announced', async () => {
    const log: string[] = []
    const bus = createReporterBus([
      recorder('first', log, { throwOn: 'file:queued' }),
      recorder('second', log, { throwOn: 'error' }),
      recorder('third', log),
    ])
    await bus.emit('file:queued', FILE)
    assert.deepEqual(
      log.filter((line) => line.includes(':error')),
      ['second:error first threw on file:queued', 'third:error first threw on file:queued'],
    )
    assert.deepEqual(
      bus.failures().map((failure) => failure.message),
      ['first threw on file:queued', 'second threw on error'],
    )
  })

  test('failing on a coordinator error is announced to the others like any failure', async () => {
    const log: string[] = []
    const bus = createReporterBus([recorder('a', log, { throwOn: 'error' }), recorder('b', log)])
    await bus.emit('error', error('the run broke'), 'coordinator')
    assert.deepEqual(log, [
      'a:error the run broke',
      'b:error the run broke',
      'b:error a threw on error',
    ])
  })

  test('is recorded with its cause chain, a string code, and a non-Error value in text', async () => {
    const withCause = new Error('outer', { cause: new RangeError('inner') })
    Object.assign(withCause, { code: 'E_BOOM' })
    const bus = createReporterBus([
      {
        name: 'throws-errors',
        'file:queued'() {
          throw withCause
        },
        'file:start'() {
          throw 'just a string'
        },
        'file:end'() {
          throw null
        },
      },
    ])
    await bus.emit('file:queued', FILE)
    await bus.emit('file:start', FILE, 0)
    await bus.emit('file:end', { file: FILE, state: 'pass', durationMs: 1, errors: [] })
    const [first, second, third] = bus.failures()
    assert.equal(first?.message, 'outer')
    assert.equal(first?.code, 'E_BOOM')
    assert.equal(first?.cause?.name, 'RangeError')
    assert.equal(first?.cause?.message, 'inner')
    assert.deepEqual(second, { name: 'Error', message: 'just a string' })
    assert.deepEqual(third, { name: 'Error', message: 'null' })
  })

  test('survives an error whose fields throw when read', async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('no reading')
        },
      },
    )
    const bus = createReporterBus([
      {
        name: 'hostile',
        'file:queued'() {
          throw hostile
        },
      },
    ])
    await bus.emit('file:queued', FILE)
    assert.deepEqual(bus.failures(), [{ name: 'Error', message: 'undefined' }])
  })
})

describe('createReporterBus: failures()', () => {
  test('is empty when every reporter is well', async () => {
    const log: string[] = []
    const bus = createReporterBus([recorder('a', log)])
    await bus.emit('file:queued', FILE)
    assert.deepEqual(bus.failures(), [])
  })

  test('adds each reporter’s lastError() as of the call, after the thrown errors', async () => {
    let last: SerializedError | undefined
    const bus = createReporterBus([
      { name: 'keeps-an-error', lastError: () => last },
      recorder('bad', [], { throwOn: 'file:queued' }),
    ])
    await bus.emit('file:queued', FILE)
    assert.deepEqual(
      bus.failures().map((failure) => failure.message),
      ['bad threw on file:queued'],
    )
    last = error('could not write the report')
    assert.deepEqual(
      bus.failures().map((failure) => failure.message),
      ['bad threw on file:queued', 'could not write the report'],
    )
    last = undefined
    assert.equal(bus.failures().length, 1)
  })

  test('counts a lastError() that throws as a failure', () => {
    const bus = createReporterBus([
      {
        name: 'broken-last-error',
        lastError() {
          throw new Error('lastError broke')
        },
      },
    ])
    assert.deepEqual(
      bus.failures().map((failure) => failure.message),
      ['lastError broke'],
    )
  })

  test('returns a copy: callers can’t change what the bus recorded', async () => {
    const bus = createReporterBus([recorder('bad', [], { throwOn: 'file:queued' })])
    await bus.emit('file:queued', FILE)
    const first = bus.failures()
    assert.notEqual(first, bus.failures())
    assert.deepEqual(first, bus.failures())
  })
})
