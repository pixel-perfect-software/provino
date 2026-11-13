// Reading cachegrind's output files (valgrind's "Cachegrind Output File Format"): optional `desc:`
// lines, a `cmd:` line, an `events:` line naming the columns, `fl=`/`fn=` lines and per-line counts,
// and a closing `summary:` line with one total per event. Newer valgrinds may write `totals:` too;
// `summary:` wins when both are there. Only the header and the totals are read: the guard compares
// whole-process instruction counts (`Ir`), not per-function ones. Pure, so the tests can feed it
// files written to the format without valgrind.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BenchError } from '../errors.ts'

/**
 * One output file's header and totals.
 * @public
 */
export interface CachegrindProfile {
  /** The command that ran, as the `cmd:` line gives it; `undefined` when the file has none. */
  readonly cmd: string | undefined
  /** The event names, in column order (`Ir` alone under `--cache-sim=no`). */
  readonly events: readonly string[]
  /** One total per event, in the same order. */
  readonly totals: readonly number[]
}

/**
 * The event that counts executed instructions.
 * @public
 */
export const INSTRUCTION_EVENT = 'Ir'

function parseError(source: string, message: string): BenchError {
  return new BenchError('BENCH_CACHEGRIND_OUTPUT', `${source}: ${message}`)
}

/**
 * Parses one cachegrind output file. `source` names it in errors. Throws `BENCH_CACHEGRIND_OUTPUT`
 * when there is no `events:` line, no `summary:`/`totals:` line, or a total that is not a whole
 * number, or when the totals and the events differ in number.
 * @public
 */
export function parseCachegrind(text: string, source = 'cachegrind output'): CachegrindProfile {
  let cmd: string | undefined
  let events: string[] | undefined
  let summary: string | undefined
  let totals: string | undefined
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line.startsWith('cmd:')) cmd ??= line.slice('cmd:'.length).trim()
    else if (line.startsWith('events:')) {
      events = line.slice('events:'.length).trim().split(/\s+/).filter(Boolean)
    } else if (line.startsWith('summary:')) summary = line.slice('summary:'.length)
    else if (line.startsWith('totals:')) totals = line.slice('totals:'.length)
  }
  if (events === undefined || events.length === 0) throw parseError(source, 'no events: line')
  const counts = summary ?? totals
  if (counts === undefined) throw parseError(source, 'no summary: line (did the run finish?)')
  const values = counts.trim().split(/\s+/).filter(Boolean)
  if (values.length !== events.length) {
    throw parseError(
      source,
      `${events.length} events (${events.join(' ')}) but ${values.length} totals`,
    )
  }
  const parsed = values.map((value) => {
    const number = Number(value)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) {
      throw parseError(source, `the total ${JSON.stringify(value)} is not a whole number`)
    }
    return number
  })
  return { cmd, events, totals: parsed }
}

/**
 * The instructions a profile counted (its `Ir` total). Throws `BENCH_CACHEGRIND_OUTPUT` when the
 * file did not count instructions.
 * @public
 */
export function instructionsOf(profile: CachegrindProfile, source = 'cachegrind output'): number {
  const column = profile.events.indexOf(INSTRUCTION_EVENT)
  const total = profile.totals[column]
  if (column === -1 || total === undefined) {
    throw parseError(source, `no ${INSTRUCTION_EVENT} event (events: ${profile.events.join(' ')})`)
  }
  return total
}

/**
 * The instructions of a whole run: `--trace-children=yes` writes one file per process
 * (`cachegrind.out.<pid>`), and the run's count is their sum. Throws `BENCH_CACHEGRIND_OUTPUT`
 * when there is no file.
 * @public
 */
export function totalInstructions(
  files: readonly { readonly name: string; readonly text: string }[],
): number {
  if (files.length === 0) throw parseError('cachegrind', 'the run wrote no output file')
  let total = 0
  for (const { name, text } of files) total += instructionsOf(parseCachegrind(text, name), name)
  return total
}

/**
 * Reads every `cachegrind.out.*` file in `dir` (one run's output directory).
 * @public
 */
export async function readCachegrindDir(
  dir: string,
): Promise<{ readonly name: string; readonly text: string }[]> {
  const names = (await readdir(dir)).filter((name) => name.startsWith('cachegrind.out.')).sort()
  return Promise.all(
    names.map(async (name) => ({ name, text: await readFile(join(dir, name), 'utf8') })),
  )
}
