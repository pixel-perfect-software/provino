import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BenchError } from '../errors.ts'
import {
  type FirstFrameResult,
  type FramesResult,
  type HandlersResult,
  type HeapResult,
  handlerKind,
  legLine,
  parseReporterFlags,
  REPORTER_LEGS,
  reporterFailures,
  type SlowSinkResult,
} from './report.ts'

function usageError(argv: string[], pattern: RegExp): void {
  assert.throws(
    () => parseReporterFlags(argv),
    (error) =>
      error instanceof BenchError && error.code === 'BENCH_USAGE' && pattern.test(error.message),
  )
}

test('no legs named is every leg; legs and bars parse', () => {
  assert.deepEqual(parseReporterFlags([]).legs, REPORTER_LEGS)
  assert.deepEqual(parseReporterFlags(['all']).legs, REPORTER_LEGS)
  const flags = parseReporterFlags([
    'heap',
    'frames',
    'heap',
    '--tests',
    '1000',
    '--max-handler-us',
    '1',
    '--min-slow-ratio',
    '0.98',
  ])
  assert.deepEqual(flags.legs, ['heap', 'frames'])
  assert.equal(flags.tests, 1000)
  assert.equal(flags.maxHandlerUs, 1)
  assert.equal(flags.minSlowRatio, 0.98)
  assert.equal(flags.maxFrameP99Ms, undefined)
})

test('the replay rate and the slow-sink write time parse, with their defaults', () => {
  const defaults = parseReporterFlags([])
  assert.equal(defaults.rate, 5000)
  assert.equal(defaults.writeMs, 5)
  const flags = parseReporterFlags(['slow-sink', '--rate', '2500', '--write-ms', '0'])
  assert.equal(flags.rate, 2500)
  assert.equal(flags.writeMs, 0)
  usageError(['--rate', '0'], /--rate needs a positive whole number/)
  usageError(['--write-ms', 'slow'], /--write-ms needs a number/)
})

test('bad usage: unknown and later legs, bad numbers, unknown flags', () => {
  usageError(['nope'], /unknown leg "nope"/)
  usageError(['e2e'], /Phase 3/)
  usageError(['html'], /Phase 5/)
  usageError(['--tests', '0'], /--tests needs a positive whole number/)
  usageError(['--rounds', '1.5'], /--rounds/)
  usageError(['--max-handler-us', 'fast'], /--max-handler-us needs a number/)
  usageError(['--bogus'], /Unknown option/i)
})

const handlers = (medianUs: number): HandlersResult => ({
  kinds: [
    { kind: 'task:end', calls: 10, medianUs, p99Us: 9 },
    { kind: 'run:start', calls: 1, medianUs: 900, p99Us: 900 },
    { kind: 'run:end', calls: 1, medianUs: 900, p99Us: 900 },
  ],
  timerFloorUs: 0.05,
  events: 11,
})
const flags = parseReporterFlags([
  '--max-handler-us',
  '1',
  '--max-frame-p99-ms',
  '2',
  '--max-heap-mb',
  '4',
  '--max-heap-growth-mb',
  '0.5',
  '--min-slow-ratio',
  '0.98',
  '--max-first-frame-ms',
  '50',
])
const frames = (p99Ms: number): FramesResult => ({
  frames: 1000,
  medianMs: 0.1,
  p99Ms,
  maxMs: p99Ms,
  bytesPerFrame: 900,
})
const heap = (smallMb: number, growthMb: number): HeapResult => ({
  smallTests: 50_000,
  largeTests: 200_000,
  smallMb,
  largeMb: smallMb + growthMb,
  growthMb,
  rounds: 3,
})
const slow = (ratio: number): SlowSinkResult => ({
  fastPerSec: 1e6,
  slowPerSec: 1e6 * ratio,
  ratio,
  ratioWithEnd: ratio,
  slowWriteMs: 5,
  testsPerSec: 5000,
  fastWaitMedianMs: 0.1,
  fastWaitP99Ms: 0.5,
  slowWaitMedianMs: 0.2,
  slowWaitP99Ms: 6,
  rounds: 3,
})
const first = (medianMs: number): FirstFrameResult => ({ samples: 30, medianMs, maxMs: medianMs })

test('every bar passes at its limit and fails past it; the per-run handlers are exempt', () => {
  assert.deepEqual(
    reporterFailures(
      {
        handlers: handlers(1),
        frames: frames(2),
        heap: heap(4, 0.5),
        slowSink: slow(0.98),
        firstFrame: first(50),
      },
      flags,
    ),
    [],
  )
  const missed = reporterFailures(
    {
      handlers: handlers(1.2),
      frames: frames(2.5),
      heap: heap(5, 0.9),
      slowSink: slow(0.9),
      firstFrame: first(60),
    },
    flags,
  )
  assert.equal(missed.length, 6)
  assert.match(missed[0] as string, /handler task:end median/)
  assert.ok(!missed.some((text) => text.includes('run:start')))
  assert.match(missed.join('\n'), /frame p99/)
  assert.match(missed.join('\n'), /retained heap/)
  assert.match(missed.join('\n'), /heap growth/)
  assert.match(missed.join('\n'), /slow-sink/)
  assert.match(missed.join('\n'), /first frame/)
})

test('a NaN reading misses its bar instead of passing', () => {
  assert.equal(reporterFailures({ frames: frames(Number.NaN) }, flags).length, 1)
  assert.equal(reporterFailures({ slowSink: slow(Number.NaN) }, flags).length, 1)
  assert.equal(reporterFailures({ handlers: handlers(Number.NaN) }, flags).length, 1)
})

test('a bar that is not set is not checked', () => {
  assert.deepEqual(
    reporterFailures({ frames: frames(99), slowSink: slow(0.1) }, parseReporterFlags([])),
    [],
  )
})

test('a miss never prints equal to its limit', () => {
  const [text] = reporterFailures({ frames: frames(2.0004) }, flags)
  assert.match(text as string, /2\.0004 ms is over 2 ms/)
})

test('handlerKind takes medians and p99 in µs from ns', () => {
  const kind = handlerKind(
    'task:end',
    Array.from({ length: 100 }, (_, i) => (i + 1) * 10),
  )
  assert.equal(kind.calls, 100)
  assert.equal(kind.medianUs, 0.505)
  assert.ok(Math.abs(kind.p99Us - 0.9901) < 1e-9)
})

test('every leg line is labelled local with the Node it ran on', () => {
  const parsed: unknown = JSON.parse(legLine('frames', 'v24.0.0', { medianMs: 0.2 }))
  assert.deepEqual(parsed, { label: 'local', leg: 'frames', node: 'v24.0.0', medianMs: 0.2 })
})
