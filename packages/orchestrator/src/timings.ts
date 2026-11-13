// T9.6: `provino.timings.json`, the committed file of how long each test file takes. It drives
// `--shard` (shard cuts by predicted time, `shard.ts`), and `--update-timings` writes it back. The
// shape is Bun's `--timings` file: `{ "version": 1, "files": { "<path>": <ms> } }`. A path is
// relative to the run's root, with `/`; the file's keys are sorted and its times whole
// milliseconds, so two runs that measure the same thing write the same bytes and a diff in a pull
// request shows only what changed.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TimingsFile } from '@provino/types'
import { OrchestratorError } from './errors.ts'
import { byText, isRecord, messageOf } from './util.ts'

/** The file's name at the root of a run, where `--shard` and `--update-timings` look for it. */
export const TIMINGS_FILE_NAME = 'provino.timings.json'

function bad(file: string, why: string, cause?: unknown): OrchestratorError {
  return new OrchestratorError(
    'ORCH_BAD_TIMINGS',
    `${file} is not a Provino timings file: ${why}. It should look like {"version":1,"files":{"a.test.ts":120}}; delete it, or regenerate it with --update-timings`,
    cause === undefined ? undefined : { cause },
  )
}

/**
 * The timings in `text`, which was read from `file` (named in an error). Throws
 * `ORCH_BAD_TIMINGS` for anything but a version 1 file whose `files` map paths to finite times of
 * 0 ms or more: a timings file that is only partly right would shard differently on each machine
 * that read it differently, which loses test files.
 * @public
 */
export function parseTimings(text: string, file: string): TimingsFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (cause) {
    throw bad(file, `it is not JSON (${messageOf(cause)})`, cause)
  }
  if (!isRecord(data)) throw bad(file, 'its top level is not an object')
  if (data.version !== 1) {
    throw bad(file, `its version is ${JSON.stringify(data.version)}, and only version 1 is known`)
  }
  if (!isRecord(data.files)) throw bad(file, '"files" is not an object')
  const files: Record<string, number> = {}
  for (const [path, time] of Object.entries(data.files)) {
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
      throw bad(
        file,
        `the time of ${JSON.stringify(path)} is not a number of milliseconds, 0 or more`,
      )
    }
    files[path] = time
  }
  return { version: 1, files }
}

/**
 * The timings file at `file`, or `undefined` when there is none (a missing file is the normal
 * first run). A file that is there and wrong throws `ORCH_BAD_TIMINGS`; one that can't be read for
 * another reason throws that error.
 * @public
 */
export async function readTimings(file: string): Promise<TimingsFile | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw bad(file, `it could not be read (${messageOf(error)})`, error)
  }
  return parseTimings(text, file)
}

/**
 * `existing` with `measured` on top: a file this run ran takes its new time, every other entry
 * stays (a shard, or a filtered run, only measured some of the files). `keep`, when given, is the
 * run's whole file set, which drops the entries of files that no longer exist.
 * @public
 */
export function mergeTimings(
  existing: TimingsFile | undefined,
  measured: ReadonlyMap<string, number>,
  keep?: ReadonlySet<string>,
): TimingsFile {
  const files: Record<string, number> = {}
  for (const [path, time] of Object.entries(existing?.files ?? {})) {
    if (keep === undefined || keep.has(path)) files[path] = time
  }
  for (const [path, time] of measured) files[path] = Math.round(time)
  return { version: 1, files }
}

/**
 * The file's text: keys in code unit order, one file to a line, a final newline. Whole
 * milliseconds.
 * @public
 */
export function formatTimings(timings: TimingsFile): string {
  const lines = Object.entries(timings.files)
    .toSorted(([a], [b]) => byText(a, b))
    .map(([path, time]) => `    ${JSON.stringify(path)}: ${Math.round(time)}`)
  const files = lines.length === 0 ? '{}' : `{\n${lines.join(',\n')}\n  }`
  return `{\n  "version": 1,\n  "files": ${files}\n}\n`
}

/**
 * Writes `timings` to `file`, creating its directory: a temporary file and a rename, so a reader
 * (another shard's job in the same workspace) never sees half a file.
 * @public
 */
export async function writeTimings(file: string, timings: TimingsFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temporary, formatTimings(timings))
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
