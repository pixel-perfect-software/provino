// The public API of @provino/reporters/html.
import { type HtmlReporterOptions, htmlReporter } from '@provino/reporters/html'
import type { Reporter } from '@provino/types'
import { expectTypeOf } from 'expect-type'

const options: HtmlReporterOptions = { outputFile: 'report.html' }

expectTypeOf(htmlReporter(options)).toEqualTypeOf<Reporter>()
expectTypeOf(htmlReporter).parameters.toEqualTypeOf<[HtmlReporterOptions]>()
expectTypeOf<HtmlReporterOptions['outputFile']>().toEqualTypeOf<string>()
expectTypeOf<HtmlReporterOptions['now']>().toEqualTypeOf<(() => number) | undefined>()
expectTypeOf<HtmlReporterOptions['wallClock']>().toEqualTypeOf<(() => number) | undefined>()

expectTypeOf<HtmlReporterOptions['seed']>().toEqualTypeOf<number | undefined>()
expectTypeOf<HtmlReporterOptions['sample']>().toEqualTypeOf<true | undefined>()

const full: HtmlReporterOptions = {
  outputFile: 'out/report.html',
  now: () => 0,
  wallClock: Date.now,
  seed: 7,
  sample: true,
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
// @ts-expect-error the root is the run's own (`run:start` names it): it is not an option
const withRoot: HtmlReporterOptions = { outputFile: 'r.html', root: '/project' }
// @ts-expect-error a seed is a number
const seedText: HtmlReporterOptions = { outputFile: 'r.html', seed: '7' }
// @ts-expect-error `sample` can only be `true`: leaving it out is a real run
const notSample: HtmlReporterOptions = { outputFile: 'r.html', sample: false }

void [full, numberFile, noFile, withStream, clockValue, clockText, withRoot, seedText, notSample]
