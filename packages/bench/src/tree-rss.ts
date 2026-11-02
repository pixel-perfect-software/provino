import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { BenchError } from './errors.ts'

const execFileAsync = promisify(execFile)

/**
 * One row of the process table.
 * @public
 */
export interface ProcessEntry {
  readonly pid: number
  readonly ppid: number
  /** Resident set size in KiB. */
  readonly rssKib: number
}

/**
 * Reads the whole process table once. Rejects with `BENCH_PROCESS_TABLE_UNAVAILABLE` when the
 * platform won't list processes.
 * @public
 */
export type ProcessTableReader = () => Promise<readonly ProcessEntry[]>

/**
 * Parses `ps -A -o pid=,ppid=,rss=` output (RSS in KiB). Lines that aren't three whole numbers
 * are skipped.
 * @public
 */
export function parsePsOutput(text: string): readonly ProcessEntry[] {
  const entries: ProcessEntry[] = []
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 3) continue
    const [pid, ppid, rssKib] = fields.map(Number)
    if (pid === undefined || ppid === undefined || rssKib === undefined) continue
    if (![pid, ppid, rssKib].every(Number.isSafeInteger)) continue
    entries.push({ pid, ppid, rssKib })
  }
  return entries
}

/**
 * Parses a Linux `/proc/<pid>/status` file into a process entry. Kernel threads have no `VmRSS`
 * line and count as 0 KiB. Returns `undefined` when the file has no `Pid` or `PPid`.
 * @public
 */
export function parseProcStatus(text: string): ProcessEntry | undefined {
  const field = (name: string): number | undefined => {
    const match = new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)
    return match?.[1] === undefined ? undefined : Number(match[1])
  }
  const pid = field('Pid')
  const ppid = field('PPid')
  if (pid === undefined || ppid === undefined) return undefined
  return { pid, ppid, rssKib: field('VmRSS') ?? 0 }
}

/**
 * The process with `rootPid` and every process descended from it, found by walking parent links.
 * A root missing from the table (it already exited) still yields its descendants.
 * @public
 */
export function processTree(
  table: readonly ProcessEntry[],
  rootPid: number,
): readonly ProcessEntry[] {
  const children = new Map<number, ProcessEntry[]>()
  const byPid = new Map<number, ProcessEntry>()
  for (const entry of table) {
    byPid.set(entry.pid, entry)
    const siblings = children.get(entry.ppid)
    if (siblings === undefined) children.set(entry.ppid, [entry])
    else siblings.push(entry)
  }
  const tree: ProcessEntry[] = []
  const seen = new Set<number>([rootPid])
  const root = byPid.get(rootPid)
  if (root !== undefined) tree.push(root)
  const queue = [rootPid]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      tree.push(child)
      queue.push(child.pid)
    }
  }
  return tree
}

/**
 * RSS in MiB summed over `rootPid` and all its descendants in a process table.
 * @public
 */
export function sumTreeRssMib(table: readonly ProcessEntry[], rootPid: number): number {
  let kib = 0
  for (const entry of processTree(table, rootPid)) kib += entry.rssKib
  return kib / 1024
}

/**
 * Makes a reader that lists processes with one call of `command` (`ps` on macOS and other
 * non-Linux systems). The argument list is `ps`'s BSD/POSIX form; `command` is a test seam.
 * @public
 */
export function createPsReader(command = 'ps'): ProcessTableReader {
  return async () => {
    try {
      const { stdout } = await execFileAsync(command, ['-A', '-o', 'pid=,ppid=,rss='], {
        maxBuffer: 64 * 1024 * 1024,
      })
      return parsePsOutput(stdout)
    } catch (cause) {
      throw new BenchError(
        'BENCH_PROCESS_TABLE_UNAVAILABLE',
        `${command} could not list processes`,
        {
          cause,
        },
      )
    }
  }
}

/**
 * Reads the process table on macOS and other non-Linux systems with one `ps` call.
 * @public
 */
export const readPsTable: ProcessTableReader = createPsReader()

/**
 * Reads the process table on Linux from `/proc/<pid>/status`, one small file per process.
 * Processes that exit mid-read are skipped. `procRoot` is a test seam.
 * @public
 */
export async function readProcTable(procRoot = '/proc'): Promise<readonly ProcessEntry[]> {
  let names: string[]
  try {
    names = (await readdir(procRoot)).filter((name) => /^\d+$/.test(name))
  } catch (cause) {
    throw new BenchError('BENCH_PROCESS_TABLE_UNAVAILABLE', `${procRoot} is not readable`, {
      cause,
    })
  }
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        return parseProcStatus(await readFile(join(procRoot, name, 'status'), 'utf8'))
      } catch {
        return undefined
      }
    }),
  )
  return entries.filter((entry): entry is ProcessEntry => entry !== undefined)
}

/**
 * The platform's process table reader: `/proc` on Linux, `ps` elsewhere.
 * @public
 */
export const readProcessTable: ProcessTableReader = () =>
  process.platform === 'linux' ? readProcTable() : readPsTable()

/**
 * RSS in MiB summed over `rootPid` and its descendants right now.
 * @public
 */
export async function treeRss(
  rootPid: number,
  read: ProcessTableReader = readProcessTable,
): Promise<number> {
  return sumTreeRssMib(await read(), rootPid)
}

/**
 * What a sampler saw once stopped.
 * @public
 */
export interface RssSample {
  /** The largest tree RSS in MiB, or `undefined` if no sample saw the process. */
  readonly peakMib: number | undefined
  /** Table reads that succeeded. */
  readonly samples: number
  /** Table reads that failed. If every read failed, `peakMib` is `undefined`. */
  readonly failures: number
  /** The last read failure, if any. */
  readonly lastError: unknown
}

/**
 * A running sampler.
 * @public
 */
export interface RssSampler {
  /** Stops sampling, waits for any read in flight, and reports the peak. */
  stop(): Promise<RssSample>
}

/**
 * Sampler settings.
 * @public
 */
export interface RssSamplerOptions {
  /** Milliseconds between the end of one read and the start of the next. Default 25. */
  readonly intervalMs?: number
  readonly read?: ProcessTableReader
}

/**
 * Samples the tree RSS of `rootPid` every 25 ms and keeps the peak. Reads never overlap: the next
 * is scheduled with `setTimeout` only after the previous one finishes. A read that fails counts
 * as a failure and sampling carries on.
 * @public
 */
export function startRssSampler(rootPid: number, options?: RssSamplerOptions): RssSampler {
  const intervalMs = options?.intervalMs ?? 25
  const read = options?.read ?? readProcessTable
  let peakMib: number | undefined
  let samples = 0
  let failures = 0
  let lastError: unknown
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let inFlight: Promise<void> = Promise.resolve()

  const sample = async (): Promise<void> => {
    try {
      const mib = await treeRss(rootPid, read)
      samples += 1
      if (mib > 0 && (peakMib === undefined || mib > peakMib)) peakMib = mib
    } catch (error) {
      failures += 1
      lastError = error
    }
    if (!stopped) {
      timer = setTimeout(() => {
        inFlight = sample()
      }, intervalMs)
      timer.unref()
    }
  }
  inFlight = sample()

  return {
    async stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      await inFlight
      return { peakMib, samples, failures, lastError }
    },
  }
}
