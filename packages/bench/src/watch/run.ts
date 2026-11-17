// `bench:watch`'s runs (T9.11): the tree written into a hermetic git repository, and a watch
// session of one subject driven through its saves. The session is started with no terminal (no
// keys), each runner prints nothing (stdout is ignored; the probe reporter's lines come on fd 3),
// and each save replaces the leaf in one rename (a temp file beside it, written first), stamped just before the rename. The latency of a save is the
// first file start of the run it caused, less that stamp. The session keeps its pool by design
// (D19 governs kill-checks and published numbers, not this bar). Jest is run with
// `--watchman=false`, so both watch with their own file watchers.

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { runProcess, spawnInGroup } from '@provino/harness'
import { errorMessage } from '../internal/guards.ts'
import { type Subject, subjectArgs } from '../loader/subjects.ts'
import type { WatchTree } from './generate.ts'
import { type ProbeEvent, parseProbeLine, type WatchSubject } from './report.ts'
import { type Found, measureSaves, type SessionDriver } from './session.ts'

const PROBE = fileURLToPath(new URL('probe-reporter.ts', import.meta.url))

/** The date every commit gets, and the git config a runner's own git reads, as the harness's recorder. */
const GIT_DATE = '2026-01-01T00:00:00Z'
const GIT_CONFIG: readonly (readonly [string, string])[] = [
  ['user.name', 'provino'],
  ['user.email', 'provino@example.invalid'],
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
  ['init.defaultBranch', 'main'],
  ['core.excludesFile', '/dev/null'],
  ['core.hooksPath', '/dev/null'],
]

/** `env` with no `GIT_*` of this machine's and the hermetic ones: no config, no signing, fixed dates. */
export function hermeticEnv(root: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(base).filter(([name]) => !name.startsWith('GIT_')))
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: GIT_DATE,
    GIT_COMMITTER_DATE: GIT_DATE,
    GIT_CEILING_DIRECTORIES: dirname(root),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(GIT_CONFIG.length),
    ...Object.fromEntries(
      GIT_CONFIG.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  }
}

async function git(root: string, args: readonly string[]): Promise<void> {
  const result = await runProcess('git', args, {
    cwd: root,
    env: hermeticEnv(root, process.env),
    timeoutMs: 120_000,
  })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.exitCode}:\n${result.output}`)
  }
}

/**
 * Writes the tree and a Jest config into `root` (a directory that exists and sits in no repository)
 * and commits it all in a repository of its own. The config has no transform, so Jest reads the
 * files as they are; `provino jest` strips the types it reads, as it would anywhere.
 */
export async function writeWatchProject(root: string, tree: WatchTree): Promise<void> {
  const dirs = new Set<string>()
  for (const path of tree.files.keys()) dirs.add(dirname(join(root, path)))
  await Promise.all([...dirs].map((dir) => mkdir(dir, { recursive: true })))
  await writeFile(join(root, 'jest.config.json'), '{"testEnvironment":"node","transform":{}}\n')
  await writeFile(join(root, 'package.json'), '{"name":"watch-bench","private":true}\n')
  await Promise.all([...tree.files].map(([path, text]) => writeFile(join(root, path), text)))
  await git(root, ['init', '-q', '--template='])
  await mkdir(join(root, '.git', 'info'), { recursive: true })
  await writeFile(join(root, '.git', 'info', 'exclude'), 'node_modules/\n')
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-q', '-m', 'watch bench tree'])
}

/** The lines the probe wrote, as events a waiter can ask for. */
class Probe {
  readonly events: ProbeEvent[] = []
  #buffer = ''
  #waiters: Array<() => void> = []

  push(chunk: string): void {
    this.#buffer += chunk
    const lines = this.#buffer.split('\n')
    this.#buffer = lines.pop() ?? ''
    for (const line of lines) {
      const event = parseProbeLine(line)
      if (event !== undefined) this.events.push(event)
    }
    for (const wake of this.#waiters.splice(0)) wake()
  }

  /** The first event from index `from` that `matches` and the index after it; `undefined` once `signal` aborts. */
  async next(
    from: number,
    matches: (event: ProbeEvent) => boolean,
    signal: AbortSignal,
  ): Promise<Found | undefined> {
    for (;;) {
      const index = this.events.findIndex((event, at) => at >= from && matches(event))
      const event = this.events[index]
      if (event !== undefined) return { event, next: index + 1 }
      if (signal.aborted) return undefined
      await new Promise<void>((resolve) => {
        const done = (): void => {
          signal.removeEventListener('abort', done)
          resolve()
        }
        signal.addEventListener('abort', done, { once: true })
        this.#waiters.push(done)
      })
    }
  }
}

/** What one session needs. */
export interface SessionOptions {
  readonly subject: WatchSubject
  readonly root: string
  readonly tree: WatchTree
  readonly saves: number
  readonly settleMs: number
  /** How long the first run and each save's run may take. */
  readonly timeoutMs: number
}

const sleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs))

/**
 * Starts the subject's `--watch` in its own group and drives `measureSaves` over it: the leaf is
 * edited before the start (so the first run has a test), then the watcher is armed and `saves`
 * measured saves are made. Returns each save's latency in ms. The group is ended, and gone, before
 * this returns or throws.
 */
export async function runSession(options: SessionOptions): Promise<number[]> {
  const { subject, root, tree, saves, settleMs, timeoutMs } = options
  const leafPath = join(root, tree.leaf)
  await writeFile(leafPath, tree.leafText(1))

  const subjectId: Subject = subject
  const flags = [
    '--watch',
    `--reporters=${PROBE}`,
    ...(subject === 'jest' ? ['--watchman=false'] : []),
  ]
  const args = subjectArgs(subjectId, flags, undefined)
  const kill = new AbortController()
  const probe = new Probe()
  const stderr: string[] = []
  const { child, exited } = spawnInGroup(process.execPath, args, {
    cwd: root,
    env: { ...hermeticEnv(root, process.env), FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
    deadline: kill.signal,
  })
  child.stdio[2]?.on('data', (chunk: Buffer) => {
    stderr.push(chunk.toString())
    if (stderr.length > 50) stderr.shift()
  })
  child.stdio[3]?.on('data', (chunk: Buffer) => probe.push(chunk.toString()))
  // A runner that ends on its own ends the wait; the stderr tail is added once, below.
  const died = exited.then((exit) => {
    throw new Error(`${subject} exited ${exit.exitCode ?? exit.signal} before the session ended`)
  })
  died.catch(() => undefined)

  const driver: SessionDriver = {
    write: async (save, stamp) => {
      // One event for the watcher: the new text goes to a temp file beside the leaf first (its
      // extension is no module's), and the rename over the leaf is stamped.
      const temp = `${leafPath}.tmp`
      await writeFile(temp, tree.leafText(save))
      stamp(performance.timeOrigin + performance.now())
      await rename(temp, leafPath)
    },
    waitFor: async (kind, from, atLeast, ms, what) => {
      try {
        return await Promise.race([
          probe.next(
            from,
            (event) => event.kind === kind && event.at >= atLeast,
            AbortSignal.timeout(ms),
          ),
          died,
        ])
      } catch (error) {
        throw new Error(`${what}: ${errorMessage(error)}\n${stderr.join('').slice(-2000)}`)
      }
    },
    settle: sleep,
    count: () => probe.events.length,
  }
  try {
    return await measureSaves(driver, { saves, settleMs, timeoutMs })
  } finally {
    kill.abort()
    await exited
  }
}
