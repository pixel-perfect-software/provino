import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildStream, DEFAULT_SPEC, specForTests, streamEvents } from './stream.ts'

const SMALL = { ...DEFAULT_SPEC, files: 64 }

test('the default stream is 16 workers, 2,000 files of 25 tests', () => {
  assert.equal(DEFAULT_SPEC.workers, 16)
  assert.equal(DEFAULT_SPEC.files * DEFAULT_SPEC.testsPerFile, 50_000)
  assert.equal(specForTests(200_000).files, 8000)
})

test('two builds of a seed are equal, another seed differs', () => {
  const a = buildStream(SMALL)
  const b = buildStream(SMALL)
  assert.deepEqual(a.events, b.events)
  assert.notDeepEqual(a.events, buildStream({ ...SMALL, seed: 2 }).events)
})

test('the counts agree with the events', () => {
  const stream = buildStream(SMALL)
  const names = (name: string): number =>
    stream.events.filter((event) => event.name === name).length
  assert.equal(stream.counts.files, 64)
  assert.equal(stream.counts.tests, 64 * 25)
  assert.equal(names('file:start'), 64)
  assert.equal(names('file:end'), 64)
  assert.equal(names('task:end'), stream.counts.tests)
  assert.equal(names('task:start'), stream.counts.tests)
  assert.equal(names('run:start'), 1)
  assert.equal(names('run:end'), 1)
  assert.equal(names('console'), stream.counts.consoles)
  assert.equal(stream.counts.events, stream.events.length)
  assert.equal(stream.events[0]?.name, 'run:start')
  assert.equal(stream.events.at(-1)?.name, 'run:end')
  const failed = stream.events.filter(
    (event) =>
      event.name === 'task:end' &&
      event.args[1].type === 'test-end' &&
      event.args[1].result.state === 'fail',
  )
  assert.equal(failed.length, stream.counts.failures)
})

test('a fixed failure count is exact however long the stream', () => {
  for (const files of [40, 160]) {
    const stream = buildStream({ ...DEFAULT_SPEC, files, failures: 7 })
    assert.equal(stream.counts.failures, 7)
  }
})

test('workers take files in waves and their events interleave', () => {
  const stream = buildStream({ ...SMALL, files: 32 })
  const firstEnd = stream.events.findIndex((event) => event.name === 'file:end')
  const startsBefore = stream.events
    .slice(0, firstEnd)
    .filter((event) => event.name === 'file:start')
  assert.equal(startsBefore.length, 16)
  const workers = startsBefore.map((event) => (event.name === 'file:start' ? event.args[1] : -1))
  assert.deepEqual(
    workers,
    Array.from({ length: 16 }, (_, i) => i),
  )
  // The first tests of different files alternate.
  const taskStarts = stream.events
    .slice(0, firstEnd)
    .filter((event) => event.name === 'task:start')
    .slice(0, 3)
    .map((event) => (event.name === 'task:start' ? event.args[0].fileId : ''))
  assert.equal(new Set(taskStarts).size, 3)
})

test('every test has its attempt and hook events, and a file with console writes has the three kinds', () => {
  const stream = buildStream({ ...SMALL, consoleRate: 1 })
  const names = (name: string): number =>
    stream.events.filter((event) => event.name === name).length
  assert.equal(names('test:attempt-start'), stream.counts.tests)
  assert.equal(names('test:attempt-end'), stream.counts.tests)
  assert.equal(names('hook:start'), stream.counts.tests)
  assert.equal(names('hook:end'), stream.counts.tests)
  assert.equal(stream.counts.consoles, 64 * 3)
})

test('the generator and the prebuilt stream are the same events', () => {
  assert.deepEqual([...streamEvents(SMALL)], buildStream(SMALL).events)
})
