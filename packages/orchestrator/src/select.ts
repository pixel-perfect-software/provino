// U2/T11.13: a command line's file filters over the files a project's rules found. Jest's are
// regular expressions (`TestPathPatterns`, jest-pattern 30.5.2) tested on the path, or exact paths
// (`--runTestsByPath`); the other kinds are Vitest's (T11.16).
import { isAbsolute, relative, resolve } from 'node:path'
import type { FileFilter } from '@provino/types'
import type { DiscoveredFile } from './discover.ts'
import { OrchestratorError } from './errors.ts'

/**
 * Where a filter's paths start.
 * @public
 */
export interface SelectOptions {
  /** The project root: a regex filter that is not an absolute path sees the path relative to it. */
  readonly rootDir: string
  /** Where an exact path (`--runTestsByPath`) that is relative starts: the process's directory. */
  readonly cwd: string
}

/**
 * A pattern as Jest tests it: case-insensitive, and a leading `./` anchors it to the start of the
 * path relative to the root (jest-pattern's "special case: ./foo.spec.js should match
 * /^foo.spec.js/ after stripping root dir"). POSIX separators only: Windows is not supported yet.
 */
function toRegex(pattern: string): RegExp {
  const source = pattern.replace(/^\.\//, '^')
  try {
    return new RegExp(source, 'i')
  } catch (cause) {
    throw new OrchestratorError(
      'ORCH_BAD_PATTERN',
      `the test path pattern ${JSON.stringify(pattern)} is not a valid regular expression`,
      { cause },
    )
  }
}

/**
 * The files `filters` keep, in their order. No filter keeps every file. Regular-expression filters
 * are Jest's `TestPathPatterns`: a file is kept when any of them matches its path relative to the
 * root (its absolute path, for a pattern that is itself absolute) or its absolute path
 * (`TestPathPatternsExecutor.isMatch`). Exact-path filters (`--runTestsByPath`) keep the file at each resolved path, and
 * take over: Jest ignores its patterns then. A filter of another kind is not built yet
 * (`ORCH_NOT_IMPLEMENTED`, T11.16).
 * @public
 */
export function selectFiles(
  files: readonly DiscoveredFile[],
  filters: readonly FileFilter[],
  options: SelectOptions,
): readonly DiscoveredFile[] {
  if (filters.length === 0) return files
  for (const filter of filters) {
    if (filter.kind !== 'regex' && filter.kind !== 'path') {
      throw new OrchestratorError(
        'ORCH_NOT_IMPLEMENTED',
        `a ${filter.kind} file filter is not supported yet (T11.16)`,
      )
    }
  }
  const exact = filters.filter((filter) => filter.kind === 'path')
  if (exact.length > 0) {
    const wanted = new Set(exact.map((filter) => resolve(options.cwd, filter.value)))
    return files.filter((file) => wanted.has(file.path))
  }
  const patterns = filters.map((filter) => ({
    regex: toRegex(filter.value),
    absolute: isAbsolute(filter.value),
  }))
  return files.filter((file) => {
    const relativePath = relative(options.rootDir, file.path)
    // The absolute path always counts; the path from the root only for a pattern that is not
    // itself absolute.
    return patterns.some(
      ({ regex, absolute }) => regex.test(file.path) || (!absolute && regex.test(relativePath)),
    )
  })
}
