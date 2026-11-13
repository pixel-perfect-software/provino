// Writes every input the legs read into the work directory, before anything is counted: the three
// suites, Spike A's loader fixture, the TS corpus and its import list. The directory is emptied
// first, so a run never reads what an earlier one left (the transform cache above all, which the
// `warm-fill` step then fills on the same built packages the legs run).
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BenchError } from '../errors.ts'
import { tsCorpusFiles } from '../generators/ts-corpus.ts'
import { hasCode } from '../internal/guards.ts'
import { writeLoaderFixture } from '../loader/fixture.ts'
import { parseSuiteName, writeSuite } from '../suites.ts'
import { WORK_PATHS } from './workloads.ts'

/**
 * The suites the T12.13 legs run.
 * @public
 */
export const GUARDED_SUITES: readonly ['app-50', 'mock-heavy-50', 'isolate-heavy'] = [
  'app-50',
  'mock-heavy-50',
  'isolate-heavy',
]

const IMPORT_LINE = /^import [^'\n]* from '([^']+)'$/gm

/**
 * The import specifiers of one corpus file, in source order: what the `resolve` leg asks for.
 * @public
 */
export function importsOf(source: string): string[] {
  return [...source.matchAll(IMPORT_LINE)].map((match) => match[1] ?? '')
}

/**
 * Left in a work directory this command made, so the next run knows it may empty it.
 * @public
 */
export const WORK_MARKER = '.provino-instructions'

/**
 * Refuses (`BENCH_USAGE`) a directory that exists, holds something and was not made by this
 * command: it is about to be emptied, and `--work-dir .` must not delete what is in it.
 * @public
 */
export async function assertEmptiable(work: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(work)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return
    throw error
  }
  if (names.length === 0 || names.includes(WORK_MARKER)) return
  throw new BenchError(
    'BENCH_USAGE',
    `--work-dir ${work} exists, is not empty and was not made by this command; it is emptied first, so name a new or empty directory`,
  )
}

/**
 * Empties `work` (one this command made, or an empty or new one: `BENCH_USAGE` for any other) and
 * writes every leg's input into it. Must run inside the bench package (the default work directory
 * is), so the suites and the corpus resolve `date-fns`, `lodash` and `zod` from its `node_modules`.
 * @public
 */
export async function prepareWork(work: string): Promise<void> {
  await assertEmptiable(work)
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true })
  await writeFile(join(work, WORK_MARKER), 'made by provino-bench instructions\n')
  for (const name of GUARDED_SUITES) {
    await writeSuite(parseSuiteName(name), join(work, WORK_PATHS.suites))
  }
  const fixture = join(work, WORK_PATHS.loaderFixture)
  await mkdir(fixture, { recursive: true })
  writeLoaderFixture(fixture, { heavy: false })
  const corpus = join(work, WORK_PATHS.tsCorpus)
  const requests: { importer: string; specifier: string; kind: 'import' }[] = []
  for (const file of tsCorpusFiles()) {
    const path = join(corpus, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.contents)
    for (const specifier of importsOf(file.contents)) {
      requests.push({ importer: path, specifier, kind: 'import' })
    }
  }
  await writeFile(join(work, WORK_PATHS.requests), `${JSON.stringify(requests, null, 1)}\n`)
}
