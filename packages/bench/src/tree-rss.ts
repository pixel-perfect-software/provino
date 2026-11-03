import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { BenchError } from './errors.ts'
import { hasCode } from './internal/guards.ts'
import { inParallel } from './internal/in-parallel.ts'

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
 * Reads the process table once: at least the sampled process and its descendants, with their
 * current RSS (a `ps` reader returns every process). Rejects with
 * `BENCH_PROCESS_TABLE_UNAVAILABLE` when the platform won't list processes.
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
 * How long a `ps` call may take before it is killed. A normal call takes tens of milliseconds.
 */
const PS_TIMEOUT_MS = 5000

/**
 * Makes a reader that lists processes with one call of `command` (`ps` on macOS and other
 * non-Linux systems). The argument list is `ps`'s BSD/POSIX form. A call that takes longer than
 * `timeoutMs` is killed and counts as a failed read, so a stuck `ps` can't hold up
 * `RssSampler.stop()`. `command` and `timeoutMs` are test seams.
 * @public
 */
export function createPsReader(
  command = 'ps',
  timeoutMs: number = PS_TIMEOUT_MS,
): ProcessTableReader {
  return async () => {
    try {
      const { stdout } = await execFileAsync(command, ['-A', '-o', 'pid=,ppid=,rss='], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
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
 * The most `/proc/<pid>/status` files `createProcReader` reads at once.
 */
const PROC_READ_CONCURRENCY = 16

/**
 * Settings for `createProcReader`. Every one is a test seam.
 * @public
 */
export interface ProcReaderOptions {
  /** Default `/proc`. */
  readonly procRoot?: string
  /** Default `PROC_READ_CONCURRENCY`. */
  readonly concurrency?: number
  /**
   * Called with each `status` file that could not be read, other than one whose process ended
   * since `/proc` was listed.
   */
  readonly onFailure?: (error: unknown) => void
}

/**
 * Makes a Linux reader of the tree below `rootPid` that remembers what it read. Each call lists
 * `/proc` once, reads `status` only for processes it has not seen and for the members of the tree
 * (their RSS and parent change), and forgets processes that are gone, so a quiet machine with
 * thousands of processes costs one directory listing and a handful of reads per call. At most
 * `concurrency` reads run at once. A process that ends mid-read is skipped; any other failed read
 * goes to `onFailure`, and an unreadable process is not retried until it ends. A process that is
 * not in the tree is assumed to keep its parent, which only a reparenting into the tree (under a
 * subreaper) would break. `rootPid` need not be alive: its surviving descendants still count.
 * Rejects with `BENCH_PROCESS_TABLE_UNAVAILABLE` when `/proc` can't be listed.
 * @public
 */
export function createProcReader(rootPid: number, options?: ProcReaderOptions): ProcessTableReader {
  const procRoot = options?.procRoot ?? '/proc'
  const concurrency = options?.concurrency ?? PROC_READ_CONCURRENCY
  // Every live process seen so far with its last good read, or `undefined` if it never read.
  const known = new Map<number, ProcessEntry | undefined>()

  const readStatus = async (pid: number): Promise<void> => {
    try {
      const entry = parseProcStatus(await readFile(join(procRoot, String(pid), 'status'), 'utf8'))
      if (entry === undefined) throw new Error(`${procRoot}/${pid}/status has no Pid or PPid line`)
      known.set(pid, entry)
    } catch (error) {
      if (hasCode(error, 'ENOENT') || hasCode(error, 'ESRCH')) {
        known.delete(pid)
        return
      }
      if (!known.has(pid)) known.set(pid, undefined)
      options?.onFailure?.(error)
    }
  }
  const table = (): ProcessEntry[] => [...known.values()].filter((entry) => entry !== undefined)

  return async () => {
    let names: string[]
    try {
      names = await readdir(procRoot)
    } catch (cause) {
      throw new BenchError('BENCH_PROCESS_TABLE_UNAVAILABLE', `${procRoot} is not readable`, {
        cause,
      })
    }
    const live = new Set<number>()
    for (const name of names) if (/^\d+$/.test(name)) live.add(Number(name))
    for (const pid of known.keys()) if (!live.has(pid)) known.delete(pid)

    const unseen = [...live].filter((pid) => !known.has(pid))
    await inParallel(unseen, concurrency, readStatus)
    const justRead = new Set(unseen)
    const members = processTree(table(), rootPid).filter((entry) => !justRead.has(entry.pid))
    await inParallel(
      members.map((entry) => entry.pid),
      concurrency,
      readStatus,
    )
    return processTree(table(), rootPid)
  }
}

/**
 * The reader for this platform: `/proc` on Linux (`createProcReader`, with `onFailure`), `ps`
 * elsewhere.
 * @public
 */
export function createDefaultReader(
  rootPid: number,
  onFailure: (error: unknown) => void = () => {},
): ProcessTableReader {
  return process.platform === 'linux' ? createProcReader(rootPid, { onFailure }) : createPsReader()
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
  /**
   * Reads that failed: whole-table reads, and on Linux each `/proc/<pid>/status` that could not be
   * read (a process that ended is not a failure). If every table read failed, `peakMib` is
   * `undefined`.
   */
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
  /**
   * Milliseconds from the start to the first read, and from the end of one read to the start of
   * the next. Default 25.
   */
  readonly intervalMs?: number
  /** Default: the platform's reader for the sampled tree. */
  readonly read?: ProcessTableReader
}

/**
 * Samples the tree RSS of `rootPid` every 25 ms and keeps the peak. The first read comes one
 * interval after the start, so the sampler does no work while the process is being spawned. Reads
 * never overlap: the next is scheduled with `setTimeout` only after the previous one finishes. A
 * read that fails counts as a failure and sampling carries on. Without `options.read` the platform
 * reader is used (`createDefaultReader`), and its per-process read failures count too.
 * @public
 */
export function startRssSampler(rootPid: number, options?: RssSamplerOptions): RssSampler {
  const intervalMs = options?.intervalMs ?? 25
  let peakMib: number | undefined
  let samples = 0
  let failures = 0
  let lastError: unknown
  const noteFailure = (error: unknown): void => {
    failures += 1
    lastError = error
  }
  const read = options?.read ?? createDefaultReader(rootPid, noteFailure)
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let inFlight: Promise<void> = Promise.resolve()

  const arm = (): void => {
    timer = setTimeout(() => {
      inFlight = sample()
    }, intervalMs)
    timer.unref()
  }
  const sample = async (): Promise<void> => {
    try {
      const mib = sumTreeRssMib(await read(), rootPid)
      samples += 1
      if (mib > 0 && (peakMib === undefined || mib > peakMib)) peakMib = mib
    } catch (error) {
      noteFailure(error)
    }
    if (!stopped) arm()
  }
  arm()

  return {
    async stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      await inFlight
      return { peakMib, samples, failures, lastError }
    },
  }
}
