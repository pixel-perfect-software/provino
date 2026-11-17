// One process of the `first-frame` leg: it runs on a pty (stdout is a terminal), builds the `provino`
// reporter, sends `run:start` and the start of 16 files, and prints how long it took from the
// `run:start` handler to the end of the first frame's write.
import { GLYPHS, provinoReporter } from '@provino/reporters/live'
import { SAMPLE_PREFIX } from '../internal/limits.ts'
import { DEFAULT_SPEC, streamEvents } from './stream.ts'

let firstFrameEnd: number | undefined
const stream = {
  write(chunk: string): boolean {
    const written = process.stdout.write(chunk)
    firstFrameEnd ??= performance.now()
    return written
  },
  fd: 1,
}
const reporter = provinoReporter({
  stream,
  live: true,
  colour: true,
  columns: process.stdout.columns ?? 120,
  glyphs: GLYPHS.emoji,
  hyperlinks: false,
  cwd: '/project',
})

const spec = { ...DEFAULT_SPEC, files: 64 }
const events = streamEvents(spec)
const first = events.next().value
const starts: (typeof first)[] = []
for (let i = 0; i < spec.workers * 2; i++) {
  const event = events.next().value
  if (event !== undefined && event.name === 'file:start') starts.push(event)
}
if (first === undefined || first.name !== 'run:start')
  throw new Error('the stream starts with run:start')

const begin = performance.now()
await reporter['run:start']?.(first.args[0], first.args[1])
for (const event of starts) {
  if (event?.name === 'file:start') await reporter['file:start']?.(event.args[0], event.args[1])
}
// The frame is drawn on the timer's first turn; wait for it.
while (firstFrameEnd === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 1))
reporter.terminal.restore()
process.stdout.write(
  `\n${SAMPLE_PREFIX}${JSON.stringify({ firstFrameMs: firstFrameEnd - begin })}\n`,
)
process.exit(0)
