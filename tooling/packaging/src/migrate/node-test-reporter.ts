// A `node --test` reporter: one JSON line (a `ReporterLine`) per finished test or suite, which
// `recordsFromReporter` turns into the baseline. Written to the file `--test-reporter-destination`
// names.
import type { ReporterLine } from './node-test-compare.ts'

/** The fields of a Node test event this reporter reads. */
interface EventData {
  readonly nesting?: number
  readonly name?: string
  readonly file?: string
  readonly skip?: unknown
  readonly todo?: unknown
  readonly details?: { readonly type?: string }
}

/** @internal */
export default async function* reporter(
  source: AsyncIterable<{ readonly type: string; readonly data: unknown }>,
): AsyncGenerator<string> {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    const data = event.data as EventData
    const line: ReporterLine = {
      pass: event.type === 'test:pass',
      nesting: data.nesting ?? 0,
      name: data.name ?? '',
      file: data.file ?? '',
      suite: data.details?.type === 'suite',
      skip: Boolean(data.skip),
      todo: Boolean(data.todo),
    }
    yield `${JSON.stringify(line)}\n`
  }
}
