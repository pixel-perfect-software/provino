// T8.10: the coverage reports, written by `istanbul-reports` from one `istanbul-lib-report` context,
// as Jest's CoverageReporter writes them (`onRunComplete`: each reporter, in config order, with
// `maxCols` first and its own options over it). A report that writes to the console (`text`,
// `text-summary`, any report given no file) writes to the stream the caller names, not to
// `process.stdout`, so a caller decides where the text goes.
import type { CoverageMetric } from '@provino/types'
import type libCoverage from 'istanbul-lib-coverage'
import libReport from 'istanbul-lib-report'
import reports from 'istanbul-reports'
import { CoverageError } from '../errors.ts'

/**
 * Where a console report writes.
 * @public
 */
export interface ReportStream {
  write(text: string): unknown
}

/**
 * Options of `writeCoverageReports`.
 * @public
 */
export interface WriteReportsOptions {
  /** Reporter names with their options, in order (Istanbul's names, or a module a report loads). */
  readonly reporters: readonly (string | readonly [string, Readonly<Record<string, unknown>>])[]
  /** The absolute directory the file reports go to. */
  readonly directory: string
  readonly watermarks: { readonly [M in CoverageMetric]: readonly [number, number] }
  /** Where the console reports write, once every report has run. */
  readonly stdout: ReportStream
  /** Whether a console report colours its numbers by watermark. */
  readonly colour: boolean
  /** The source of a file (default: read from disk). */
  readonly sourceFinder?: (path: string) => string
}

/** ANSI codes `istanbul-lib-report`'s `ConsoleWriter` colours with, by watermark class. */
const COLOURS: Readonly<Record<string, string>> = { low: '31;1', medium: '33;1', high: '32;1' }

/** A content writer that keeps what a console report writes. */
function bufferWriter(buffer: { text: string }, colour: boolean): libReport.ContentWriter {
  // The type has no `write`; `istanbul-lib-report`'s own writers all have one, and the reports call it.
  const writer = {
    write(text: string) {
      buffer.text += text
    },
    println(text: string) {
      buffer.text += `${text}\n`
    },
    colorize(text: string, kind: string) {
      const code = COLOURS[kind]
      return colour && code !== undefined ? `\u001b[${code}m${text}\u001b[0m` : text
    },
    close() {},
  }
  return writer
}

/** The context's `FileWriter`, with the console (`null` or `-`) sent to `buffer`. */
function withConsole(
  context: libReport.Context,
  buffer: { text: string },
  colour: boolean,
): libReport.FileWriter {
  // `istanbul-lib-report` exports the class only as a type; the instance the context made has it.
  const FileWriter = Object.getPrototypeOf(context.writer)
    .constructor as typeof libReport.FileWriter
  class ConsoleToStream extends FileWriter {
    override writeFile(file: string | null): libReport.ContentWriter {
      return file === null || file === '-' ? bufferWriter(buffer, colour) : super.writeFile(file)
    }
    writerForDir(subdir: string): ConsoleToStream {
      return new ConsoleToStream(`${(this as unknown as { baseDir: string }).baseDir}/${subdir}`)
    }
  }
  return new ConsoleToStream(context.dir)
}

/**
 * Writes every report of `map`. A report that throws stops the rest and rejects with
 * `COVERAGE_REPORT_FAILED` (its error as `cause`), after the console text written so far went out.
 * @public
 */
export async function writeCoverageReports(
  map: libCoverage.CoverageMap,
  options: WriteReportsOptions,
): Promise<void> {
  const context = libReport.createContext({
    coverageMap: map,
    dir: options.directory,
    watermarks: {
      statements: [...options.watermarks.statements],
      functions: [...options.watermarks.functions],
      branches: [...options.watermarks.branches],
      lines: [...options.watermarks.lines],
    },
    ...(options.sourceFinder === undefined ? {} : { sourceFinder: options.sourceFinder }),
  })
  const buffer = { text: '' }
  // The context makes its writer on first read and keeps it in `data`; this one goes there first.
  ;(context as unknown as { data: { writer: libReport.FileWriter } }).data.writer = withConsole(
    context,
    buffer,
    options.colour,
  )
  let failure: unknown
  let failed = false
  try {
    for (const entry of options.reporters) {
      const [name, own] = typeof entry === 'string' ? [entry, {}] : entry
      reports.create(name as reports.ReportType, { ...own }).execute(context)
    }
  } catch (error) {
    failed = true
    failure = error
  }
  if (buffer.text !== '') await options.stdout.write(buffer.text)
  if (failed) {
    throw new CoverageError(
      'COVERAGE_REPORT_FAILED',
      `could not write the coverage reports: ${failure instanceof Error ? failure.message : String(failure)}`,
      { cause: failure },
    )
  }
}
