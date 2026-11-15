// The coordinator of `watch-session.test.ts`, as a process of its own: a watch session over the
// project, made as `WATCH_SETUP` says and driven by the steps in `WATCH_STEPS` (both JSON, see
// `watch-steps.ts`), then closed. The changes come through the session's change source, fed here
// after each real edit on disk, and its coalescing window is a clock this script fires itself, so
// nothing waits on time. Right after `close()` it checks that no forked worker it noted is still
// running. What it saw is written to the output file as JSON; the test starts this in a process
// group of its own and sweeps it after.
//
// Arguments: the project directory, the pool kind, the output file.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { ResolvedProject } from '@provino/config'
import {
  type CoalesceClock,
  createWatchSession,
  type WatchEvent,
  type WatchSession,
} from '@provino/orchestrator'
import { createReporterBus } from '@provino/reporters'
import type { PoolKind, Reporter, ReporterBus } from '@provino/types'
import { isRunning, PID_RECORDING_ENTRY, runtimeProject } from '../support.ts'
import type { Output, RunReport, SessionSetup, Step } from './watch-steps.ts'

const [dir, kind, out] = process.argv.slice(2) as [string, PoolKind, string]
const steps = JSON.parse(process.env.WATCH_STEPS ?? '[]') as readonly Step[]
const setup = JSON.parse(process.env.WATCH_SETUP ?? '{}') as SessionSetup

let timers: (() => void)[] = []
const clock: CoalesceClock = {
  schedule(callback) {
    timers.push(callback)
    return () => {
      timers = timers.filter((timer) => timer !== callback)
    }
  },
}
const fire = (): void => {
  const due = timers
  timers = []
  for (const timer of due) timer()
}
let sink: { readonly event: (event: WatchEvent) => void } | undefined
let stderrText = ''
const stderr = new Writable({
  write(chunk: Buffer, _encoding, done) {
    stderrText += chunk.toString()
    done()
  },
})

const base = runtimeProject(dir, {
  policy: {
    orchestrator: {
      ...(setup.unhandledErrors === undefined ? {} : { unhandledErrors: setup.unhandledErrors }),
      ...(setup.extractor === undefined
        ? {}
        : { affected: { extractor: { module: setup.extractor, export: 'extractor' } } }),
    },
  },
})
const project: ResolvedProject =
  setup.isolation === undefined ? base : { ...base, isolation: setup.isolation }

const session: WatchSession = await createWatchSession([project], {
  cache: false,
  stderr,
  ...(kind === 'forks' ? { entry: PID_RECORDING_ENTRY } : {}),
  pool: { kind, maxWorkers: setup.maxWorkers ?? 1 },
  ...(setup.globalSetup === undefined
    ? {}
    : { globalSetup: { setup: [setup.globalSetup], teardown: [] } }),
  clock,
  changes: (given) => {
    sink = given
    return { close: () => {} }
  },
})

/** The noted pids of this coordinator's forked workers that are still running. */
function alivePids(): number[] {
  const file = join(tmpdir(), `provino-pids-${process.pid}`)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number).filter(isRunning)
}

const reports: RunReport[] = []
const batches: (readonly string[])[] = []
let closed = false
let heardAfterClose = 0
if (setup.throwingListener === true) {
  session.onChange(() => {
    throw new Error('a listener broke')
  })
}
session.onChange((batch) => {
  if (closed) heardAfterClose++
  batches.push(batch.map((event) => `${event.kind} ${event.path}`))
})

async function run(step: Extract<Step, { do: 'run' }>): Promise<RunReport> {
  const files: Record<string, string> = {}
  const workers: Record<string, number> = {}
  const errors: Record<string, readonly string[]> = {}
  const events: string[] = []
  let concurrent: RunReport['concurrent']
  let closing: Promise<void> | undefined
  const reporter: Reporter = {
    name: 'watch-coordinator',
    'run:start': () => void events.push('run:start'),
    'file:start': (file, workerId) => {
      workers[file.path] = workerId
    },
    'task:start': (task) => {
      // The explicit signals: the test named has started.
      if (task.name === step.interruptAt) session.interrupt()
      if (task.name === step.closeAt) {
        closed = true
        closing = session.close()
      }
    },
    'file:end': (result) => {
      events.push(`file:end ${result.file.path}`)
      files[result.file.path] = result.state
      if (result.errors.length > 0) errors[result.file.path] = result.errors.map((e) => e.message)
    },
    'run:end': () => void events.push('run:end'),
  }
  const inner = createReporterBus([reporter])
  let thrownOnce = false
  const bus: ReporterBus = {
    add: (more) => inner.add(more),
    emit(name, ...args) {
      const first = args[0] as { readonly file?: { readonly path?: string } } | undefined
      if (!thrownOnce && step.throwOn === `${name} ${first?.file?.path ?? ''}`) {
        thrownOnce = true
        return inner.emit(name, ...args).then(() => Promise.reject(new Error('the bus broke')))
      }
      return inner.emit(name, ...args)
    },
  }
  const going = session.run({
    bus,
    ...(step.fileFilters === undefined ? {} : { fileFilters: step.fileFilters }),
    ...(step.related === undefined
      ? {}
      : { selection: { kind: 'related', paths: step.related.map((path) => join(dir, path)) } }),
  })
  if (step.concurrent === true) {
    try {
      await session.run({ bus: createReporterBus([]) })
      concurrent = { code: 'none' }
    } catch (error) {
      concurrent = { code: (error as { code?: unknown }).code }
    }
  }
  const shared = { files, workers, errors, events }
  try {
    const summary = await going
    await closing
    return {
      ...shared,
      reason: summary.reason,
      unhandled: summary.unhandled.length,
      ...(concurrent === undefined ? {} : { concurrent }),
    }
  } catch (error) {
    await closing
    return {
      ...shared,
      reason: 'threw',
      unhandled: 0,
      thrown: { code: (error as { code?: unknown }).code, message: (error as Error).message },
    }
  }
}

try {
  for (const step of steps) {
    switch (step.do) {
      case 'write': {
        const path = join(dir, step.path)
        const existed = await stat(path).then(
          () => true,
          () => false,
        )
        await writeFile(path, step.text)
        const { mtimeMs } = await stat(path)
        sink?.event({ kind: existed ? 'change' : 'add', path, mtimeMs })
        break
      }
      case 'unlink': {
        const path = join(dir, step.path)
        await rm(path)
        sink?.event({ kind: 'unlink', path, mtimeMs: undefined })
        break
      }
      case 'flush':
        fire()
        break
      case 'close':
        closed = true
        await session.close()
        break
      case 'change-after-close': {
        sink?.event({ kind: 'change', path: join(dir, step.path), mtimeMs: Date.now() })
        fire()
        break
      }
      case 'run':
        reports.push(await run(step))
        break
      default:
        step satisfies never
    }
  }
} finally {
  closed = true
  await session.close()
}

const output: Output = {
  reports,
  batches,
  aliveAfterClose: kind === 'forks' ? alivePids() : [],
  heardAfterClose,
  stderr: stderrText,
}
writeFileSync(out, JSON.stringify(output))
