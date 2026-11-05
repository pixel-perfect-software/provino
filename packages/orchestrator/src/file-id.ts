// D23: the coordinator assigns each file its id and the worker's core takes it (`FileJob.fileId`).
// The formula is core's own for a runtime used standalone, so a file's id is the same either way.
import { hash } from 'node:crypto'
import { relative, sep } from 'node:path'
import type { TaskId } from '@provino/types'

/**
 * A file's task id: a SHA-1 over `<project>\0<path>`, cut to 10 hex characters. `relativePath` is
 * the file's path relative to the project's root, with POSIX separators. The id is stable across
 * runs and workers, and every task id in the file derives from it.
 * @public
 */
export function fileIdOf(project: string, relativePath: string): TaskId {
  return hash('sha1', `${project}\0${relativePath}`).slice(0, 10) as TaskId
}

/**
 * `file` relative to `rootDir`, with `/` separators on every platform: the form task ids,
 * reporters and the results cache know a file by (and what `fileIdOf` takes).
 * @public
 */
export function relativePosix(rootDir: string, file: string): string {
  return relative(rootDir, file).split(sep).join('/')
}
