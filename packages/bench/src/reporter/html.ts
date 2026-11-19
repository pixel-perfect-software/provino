// The `html` leg of `bench:reporter` (B26 Phase 5, D145): what the HTML report costs at `run:end`
// and how big the page is. The synthetic stream (`stream.ts`: 25 tests a file, the fixture's
// failure shapes) is played through the reporter's handlers, untimed, and then `run:end` (the
// build of the page and its atomic write into `$TMPDIR`) is timed, against a reporter whose
// `run:end` does nothing, the two interleaved with the first side alternating and one round
// discarded. The page's size is read from the file. Two variants: every test passing (bars
// `--max-html-ms 50 --max-html-kb 400`) and the stream's own failure rate, 1% of the tests
// (`--max-html-failures-kb 1024`). `local`.
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { htmlReporter } from '@provino/reporters/html'
import { median } from '../stats.ts'
import type { HtmlResult, HtmlVariant } from './report.ts'
import { deliver, noopReporter } from './legs.ts'
import { buildStream, DEFAULT_SPEC, type StreamEvent } from './stream.ts'

function collect(): void {
  ;(globalThis as { gc?: () => void }).gc?.()
}

/** One variant: `rounds` interleaved rounds of the HTML reporter against the silent one. */
async function measure(
  name: HtmlVariant['name'],
  files: number,
  failureRate: number,
  rounds: number,
  dir: string,
): Promise<HtmlVariant> {
  const stream = buildStream({ ...DEFAULT_SPEC, files, failureRate })
  const end = stream.events[stream.events.length - 1] as StreamEvent
  const body = stream.events.slice(0, -1)
  const outputFile = join(dir, `${name}.html`)
  const times: Record<'html' | 'silent', number[]> = { html: [], silent: [] }
  let bytes = 0
  for (let round = 0; round < rounds + 1; round++) {
    // The first side alternates, so neither always runs on the warmer heap.
    const order = round % 2 === 0 ? (['silent', 'html'] as const) : (['html', 'silent'] as const)
    for (const subject of order) {
      let tick = 0
      const reporter =
        subject === 'html'
          ? htmlReporter({ outputFile, now: () => ++tick, wallClock: () => 0 })
          : noopReporter()
      for (const event of body) deliver(reporter, event)
      collect()
      const start = performance.now()
      await deliver(reporter, end)
      const ms = performance.now() - start
      if (round > 0) times[subject].push(ms) // round 0 warms the code
      if (subject === 'html') bytes = (await stat(outputFile)).size
    }
  }
  const htmlMs = median(times.html)
  const noopMs = median(times.silent)
  return {
    name,
    tests: stream.counts.tests,
    failures: stream.counts.failures,
    noopMs,
    htmlMs,
    buildMs: htmlMs - noopMs,
    kb: bytes / 1024,
  }
}

/** `html`: both variants of the stream at `files` files, `rounds` interleaved rounds each. */
export async function runHtmlLeg(files: number, rounds: number): Promise<HtmlResult> {
  const dir = await mkdtemp(join(tmpdir(), 'provino-bench-html-'))
  try {
    const variants: HtmlVariant[] = [
      await measure('passing', files, 0, rounds, dir),
      await measure('failures', files, DEFAULT_SPEC.failureRate, rounds, dir),
    ]
    return { files, rounds, variants }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
