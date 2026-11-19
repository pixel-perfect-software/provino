import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BenchError } from '../errors.ts'
import {
  type FirstFrameResult,
  type FramesResult,
  type HandlersResult,
  type HeapResult,
  type HtmlResult,
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

test('e2e runs only when named, with its suites, runs and bars', () => {
  assert.ok(!(REPORTER_LEGS as readonly string[]).includes('e2e'), 'all leaves the suite runs out')
  const plain = parseReporterFlags(['e2e'])
  assert.deepEqual(plain.legs, ['e2e'])
  assert.deepEqual(plain.suites, ['app-500'])
  assert.equal(plain.runs, 7)
  const flags = parseReporterFlags([
    'e2e',
    '--suite',
    'app-500',
    '--suite',
    'mock-heavy-500',
    '--runs',
    '3',
    '--max-wall-ratio',
    '1.02',
    '--max-cpu-overhead',
    '0.02',
  ])
  assert.deepEqual(flags.suites, ['app-500', 'mock-heavy-500'])
  assert.equal(flags.runs, 3)
  assert.equal(flags.maxWallRatio, 1.02)
  assert.equal(flags.maxCpuOverhead, 0.02)
  usageError(['e2e', '--runs', '0'], /--runs needs a positive whole number/)
})

test('the e2e bars: the wall ratio and the CPU overhead, a NaN missing both', () => {
  const flags = parseReporterFlags([
    'e2e',
    '--max-wall-ratio',
    '1.02',
    '--max-cpu-overhead',
    '0.02',
  ])
  const suite = {
    suite: 'app-500',
    runs: 7,
    provinoMedianMs: 1000,
    agentMedianMs: 990,
    ratio: 1.0101,
    ratioLow: 1,
    ratioHigh: 1.02,
    provinoCpuMs: 101,
    agentCpuMs: 100,
    cpuOverhead: 0.01,
  }
  assert.deepEqual(reporterFailures({ e2e: [suite] }, flags), [])
  assert.equal(reporterFailures({ e2e: [{ ...suite, ratio: 1.03 }] }, flags).length, 1)
  assert.equal(reporterFailures({ e2e: [{ ...suite, cpuOverhead: 0.021 }] }, flags).length, 1)
  assert.equal(
    reporterFailures({ e2e: [{ ...suite, ratio: Number.NaN, cpuOverhead: Number.NaN }] }, flags)
      .length,
    2,
  )
})

test('the html leg runs only when named, with its own files, rounds and bars', () => {
  assert.deepEqual(parseReporterFlags([]).legs.includes('html' as never), false)
  assert.deepEqual(parseReporterFlags(['all']).legs.includes('html' as never), false)
  const defaults = parseReporterFlags(['html'])
  assert.deepEqual(defaults.legs, ['html'])
  assert.equal(defaults.files, 500)
  assert.equal(defaults.htmlRounds, 15)
  assert.equal(defaults.maxHtmlMs, undefined)
  const bars = parseReporterFlags([
    'html',
    '--files',
    '2000',
    '--html-rounds',
    '3',
    '--max-html-ms',
    '50',
    '--max-html-kb',
    '400',
    '--max-html-failures-kb',
    '1024',
  ])
  assert.equal(bars.files, 2000)
  assert.equal(bars.htmlRounds, 3)
  assert.deepEqual([bars.maxHtmlMs, bars.maxHtmlKb, bars.maxHtmlFailuresKb], [50, 400, 1024])
})

test('the html bars: the build in ms for both variants, 400 KB passing and 1,024 KB with failures', () => {
  const html = parseReporterFlags([
    'html',
    '--max-html-ms',
    '50',
    '--max-html-kb',
    '400',
    '--max-html-failures-kb',
    '1024',
  ])
  const variant = (
    name: 'passing' | 'failures',
    buildMs: number,
    kb: number,
  ): HtmlResult['variants'][number] => ({
    name,
    tests: 12_500,
    failures: name === 'passing' ? 0 : 125,
    noopMs: 0.01,
    htmlMs: buildMs + 0.01,
    buildMs,
    kb,
  })
  const result = (
    passing: HtmlResult['variants'][number],
    failures: HtmlResult['variants'][number],
  ) => ({ files: 500, rounds: 15, variants: [passing, failures] }) satisfies HtmlResult
  assert.deepEqual(
    reporterFailures(
      { html: result(variant('passing', 12, 300), variant('failures', 14, 700)) },
      html,
    ),
    [],
  )
  // Each bar names the variant it missed, and a value over its own bar is reported with decimals.
  const missed = reporterFailures(
    { html: result(variant('passing', 51, 401), variant('failures', 60, 1025)) },
    html,
  )
  assert.equal(missed.length, 4, missed.join('\n'))
  assert.ok(missed.some((text) => /html \(passing\) build .* is over 50 ms/.test(text)))
  assert.ok(missed.some((text) => /html \(passing\) size .* KB .* is over 400 KB/.test(text)))
  assert.ok(missed.some((text) => /html \(failures\) build .* is over 50 ms/.test(text)))
  assert.ok(missed.some((text) => /html \(failures\) size .* KB .* is over 1024 KB/.test(text)))
  // A size that is fine for the page with failures is not fine for the passing one.
  assert.equal(
    reporterFailures(
      { html: result(variant('passing', 1, 500), variant('failures', 1, 500)) },
      html,
    ).length,
    1,
  )
  // A bar that is not given is not checked, and a NaN misses.
  assert.deepEqual(
    reporterFailures(
      { html: result(variant('passing', 99, 9999), variant('failures', 99, 9999)) },
      parseReporterFlags([]),
    ),
    [],
  )
  assert.equal(
    reporterFailures(
      { html: result(variant('passing', Number.NaN, 1), variant('failures', 1, 1)) },
      html,
    ).length,
    1,
  )
})

test('bad usage: unknown legs, bad numbers, unknown flags', () => {
  usageError(['nope'], /unknown leg "nope"/)
  usageError(['--files', '0'], /--files needs a positive whole number/)
  usageError(['--max-html-ms', 'fast'], /--max-html-ms needs a number/)
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
