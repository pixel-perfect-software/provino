// A `node --test` reporter: one JSON line per finished test or suite, which `record.ts` turns
// into the baseline. Written to the file `--test-reporter-destination` names.

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
    yield `${JSON.stringify({
      pass: event.type === 'test:pass',
      nesting: data.nesting ?? 0,
      name: data.name ?? '',
      file: data.file ?? '',
      suite: data.details?.type === 'suite',
      skip: Boolean(data.skip),
      todo: Boolean(data.todo),
    })}\n`
  }
}
