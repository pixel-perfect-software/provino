import { isAbsolute, join, relative, sep } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type {
  FileInfo,
  Reporter,
  ReportPolicy,
  SerializedError,
  SourceLocation,
} from '@provino/types'
import { createCollector } from '../internal/collect.ts'
import type { FileRecord } from '../normalized-json/build.ts'
import type { TextSink } from '../sink.ts'
import { formatError } from '../text/format.ts'

/**
 * Options for `githubActionsReporter`.
 * @public
 */
export interface GitHubActionsReporterOptions {
  readonly stream: TextSink
  /** The `report` slice: the separator that joins a test's `describe` titles and its own. */
  readonly report: ReportPolicy
  /**
   * The repository's root (`GITHUB_WORKSPACE`): annotation paths are relative to it, as GitHub
   * wants them. Default: the project root, which is right for a project at the repository's root.
   */
  readonly workspace?: string
}

/** A workflow command's data: `%`, carriage return and line feed escaped (`@actions/core`'s `escapeData`). */
function escapeData(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

/** A workflow command's property: as data, and `:` and `,` too (`escapeProperty`). */
function escapeProperty(text: string): string {
  return escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C')
}

/** `at fn (path:line:col)` or `at path:line:col`: where the frame is, or `undefined`. */
function frameLocation(frame: string): SourceLocation | undefined {
  const match = /(?:\(|\bat\s+)(?:async\s+)?(?:.*?\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(frame.trim())
  if (match === null) return undefined
  const [, file, line, column] = match
  if (file === undefined || line === undefined || column === undefined) return undefined
  return { file: file.replace(/^file:\/\//, ''), line: Number(line), column: Number(column) }
}

/** Where an error happened: its own `location`, else the first frame of its stack that isn't a library's. */
function errorLocation(error: SerializedError): SourceLocation | undefined {
  if (error.location !== undefined) return error.location
  for (const line of (error.stack ?? '').split('\n')) {
    if (!line.trim().startsWith('at ') || /node:|node_modules/.test(line)) continue
    const found = frameLocation(line)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The GitHub Actions reporter: an error annotation (`::error file=...,line=...,title=...::message`)
 * for each failed test, for a file that failed to run and for an error outside any file, as the
 * runner turns them into annotations on the run and the pull request's files. It prints nothing
 * else, so it runs beside another reporter. The annotation points at the line of the error's top
 * frame, else the test's own line, else just the file. Printed as each file ends.
 * @public
 */
export function githubActionsReporter(options: GitHubActionsReporterOptions): Reporter {
  const { stream, report } = options
  const { record, handlers } = createCollector()

  /** The path GitHub wants: relative to the workspace, with `/`. */
  function repositoryPath(file: string): string {
    const absolute = isAbsolute(file) ? file : join(record.root, file)
    const base = options.workspace ?? record.root
    return relative(base, absolute).split(sep).join('/')
  }

  function annotation(
    title: string,
    errors: readonly SerializedError[],
    fallback: SourceLocation | null,
    file: FileInfo | undefined,
  ): string {
    const [first] = errors
    const where = (first === undefined ? undefined : errorLocation(first)) ?? fallback ?? undefined
    const path = where?.file ?? file?.path
    const properties = [
      ...(path === undefined ? [] : [`file=${escapeProperty(repositoryPath(path))}`]),
      ...(where === undefined ? [] : [`line=${where.line}`, `col=${where.column}`]),
      `title=${escapeProperty(stripVTControlCharacters(title))}`,
    ].join(',')
    const message = errors.map((error) => formatError(error)).join('\n\n')
    return `::error ${properties}::${escapeData(stripVTControlCharacters(message))}\n`
  }

  function fileAnnotations(
    file: FileInfo,
    entry: FileRecord | undefined,
    own: readonly SerializedError[],
  ): string[] {
    const lines: string[] = []
    for (const test of entry?.tests.values() ?? []) {
      const result = entry?.results.get(test.id)
      const errors = [...(result?.errors ?? []), ...(entry?.late.get(test.id) ?? [])]
      if (errors.length === 0 || (result?.state !== 'fail' && !entry?.late.has(test.id))) continue
      lines.push(
        annotation(test.fullName.join(report.displaySeparator), errors, test.location, file),
      )
    }
    const fileErrors = [...own, ...(entry?.suiteErrors ?? []), ...(entry?.unhandled ?? [])]
    if (fileErrors.length > 0) lines.push(annotation(file.path, fileErrors, null, file))
    return lines
  }

  return {
    name: 'github-actions',

    ...handlers,

    async 'file:end'(result) {
      handlers['file:end'](result)
      const lines = fileAnnotations(
        result.file,
        record.files.get(result.file.fileId),
        result.errors,
      )
      record.files.delete(result.file.fileId)
      if (lines.length > 0) await stream.write(lines.join(''))
    },

    async error(error, origin) {
      handlers.error(error, origin)
      await stream.write(annotation(`Provino: ${origin} error`, [error], null, undefined))
    },

    async 'run:end'(summary) {
      const lines = summary.unhandled.map((error) =>
        annotation('Unhandled error', [error], null, undefined),
      )
      if (lines.length > 0) await stream.write(lines.join(''))
    },
  }
}
