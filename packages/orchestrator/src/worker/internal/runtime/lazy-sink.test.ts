import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LazyEvaluation, RuntimeEvent, TaskId, TaskResult } from '@provino/types'
import { lazyReportSink } from './lazy-sink.ts'

const id = (value: string): TaskId => value as TaskId
const lazies: readonly LazyEvaluation[] = [
  {
    key: 'a',
    site: { file: '/p/a.ts', line: 1, column: 2 },
    override: false,
    ms: 1,
    failed: false,
  },
]
const testEnd = (testId: string, state: TaskResult['state']): RuntimeEvent => ({
  type: 'test-end',
  id: id(testId),
  result: {
    state,
    durationMs: 1,
    startTime: 0,
    errors: [],
    retryErrors: [],
    attempts: 1,
    repeatIndex: 0,
    assertions: 0,
    passingAssertions: 0,
  },
  t: 0,
})

function collect(): { events: RuntimeEvent[]; sink: { emit(event: RuntimeEvent): void } } {
  const events: RuntimeEvent[] = []
  return { events, sink: { emit: (event) => void events.push(event) } }
}

describe('lazyReportSink', () => {
  it('puts the recorded values on the test-end of a failed test', () => {
    const next = collect()
    const report = lazyReportSink(next.sink)
    report.record(id('t1'), lazies)
    report.sink.emit(testEnd('t1', 'fail'))
    const [event] = next.events
    assert.equal(event?.type === 'test-end' && event.result.lazies, lazies)
  })

  it('leaves a test that passed after a failed attempt alone, and forgets what it held', () => {
    const next = collect()
    const report = lazyReportSink(next.sink)
    report.record(id('t1'), lazies)
    report.sink.emit(testEnd('t1', 'pass'))
    report.sink.emit(testEnd('t1', 'fail'))
    assert.equal(next.events.length, 2)
    for (const event of next.events) {
      assert.equal(event.type === 'test-end' && 'lazies' in event.result, false)
    }
  })

  it('passes a test with nothing recorded, and every other event, through untouched', () => {
    const next = collect()
    const report = lazyReportSink(next.sink)
    const end = testEnd('t2', 'fail')
    const start: RuntimeEvent = { type: 'test-start', id: id('t2'), t: 0 }
    report.sink.emit(start)
    report.sink.emit(end)
    assert.equal(next.events[0], start)
    assert.equal(next.events[1], end)
  })

  it('drops an earlier attempt’s values when a later failed attempt recorded none', () => {
    const next = collect()
    const report = lazyReportSink(next.sink)
    report.record(id('t1'), lazies)
    report.record(id('t1'), [])
    report.sink.emit(testEnd('t1', 'fail'))
    const [event] = next.events
    assert.equal(event?.type === 'test-end' && 'lazies' in event.result, false)
  })

  it('keeps only the latest recording of a test', () => {
    const next = collect()
    const report = lazyReportSink(next.sink)
    report.record(id('t1'), [])
    report.record(id('t1'), lazies)
    report.sink.emit(testEnd('t1', 'fail'))
    const [event] = next.events
    assert.equal(event?.type === 'test-end' && event.result.lazies, lazies)
  })
})
