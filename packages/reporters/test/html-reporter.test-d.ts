// The public API of @provino/reporters/html.
import { type HtmlReporterOptions, htmlReporter } from '@provino/reporters/html'
import type { Reporter } from '@provino/types'
import { expectTypeOf } from 'expect-type'

const options: HtmlReporterOptions = { outputFile: 'report.html' }

expectTypeOf(htmlReporter(options)).toEqualTypeOf<Reporter>()
expectTypeOf(htmlReporter).parameters.toEqualTypeOf<[HtmlReporterOptions]>()
expectTypeOf<HtmlReporterOptions['outputFile']>().toEqualTypeOf<string>()
expectTypeOf<HtmlReporterOptions['root']>().toEqualTypeOf<string | undefined>()
expectTypeOf<HtmlReporterOptions['now']>().toEqualTypeOf<(() => number) | undefined>()
expectTypeOf<HtmlReporterOptions['wallClock']>().toEqualTypeOf<(() => number) | undefined>()

const full: HtmlReporterOptions = {
  outputFile: 'out/report.html',
  root: '/project',
  now: () => 0,
  wallClock: Date.now,
}

// @ts-expect-error `outputFile` is a path: a number is not one
const numberFile: HtmlReporterOptions = { outputFile: 1 }
// @ts-expect-error the page is never written to a stream, so `outputFile` is required
const noFile: HtmlReporterOptions = {}
// @ts-expect-error there is no `stream` option: the report is a file
const withStream: HtmlReporterOptions = { outputFile: 'r.html', stream: process.stdout }
// @ts-expect-error `now` is a function, not a number
const clockValue: HtmlReporterOptions = { outputFile: 'r.html', now: 0 }
// @ts-expect-error a clock returns milliseconds, not a string
const clockText: HtmlReporterOptions = { outputFile: 'r.html', now: () => '0' }
// @ts-expect-error `root` is a directory path
const rootNumber: HtmlReporterOptions = { outputFile: 'r.html', root: 1 }

void [full, numberFile, noFile, withStream, clockValue, clockText, rootNumber]
