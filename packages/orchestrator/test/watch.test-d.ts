// The watch session's public API (B23c, T9.11): the session, its run options, the watcher, the
// coalescer, and what the pool gained for a session.
import type { ResolvedProject } from '@provino/config'
import {
  type ChangeSource,
  type CoalesceClock,
  type Coalescer,
  createCoalescer,
  createWatcher,
  createWatchSession,
  type FileRequest,
  type Pool,
  type WatchEvent,
  type Watcher,
  type WatchFunction,
  type WatchRunOptions,
  type WatchSession,
} from '@provino/orchestrator'
import type { ReporterBus, RunSummary, WorkerKey } from '@provino/types'
import { expectTypeOf } from 'expect-type'

declare const bus: ReporterBus
declare const project: ResolvedProject
declare const session: WatchSession

expectTypeOf(createWatchSession).returns.toEqualTypeOf<Promise<WatchSession>>()
expectTypeOf(session.run).parameter(0).toEqualTypeOf<WatchRunOptions>()
expectTypeOf(session.run).returns.toEqualTypeOf<Promise<RunSummary>>()
expectTypeOf(session.close).returns.toEqualTypeOf<Promise<void>>()
expectTypeOf<WatchSession['running']>().toEqualTypeOf<boolean>()
void createWatchSession([project], { pool: { kind: 'forks' }, perDirectory: true })
void session.run({ bus, selection: { kind: 'related', paths: ['/p/a.ts'] } })
// @ts-expect-error a session's run is interrupted through the session, not by a signal of its own
void session.run({ bus, signal: new AbortController().signal })
// @ts-expect-error the pool is the session's: a run can't name its own
void session.run({ bus, pool: { kind: 'inline' } })
// @ts-expect-error open handles are read after every worker stops, which a session never does
void session.run({ bus, detectOpenHandles: true })
// @ts-expect-error a list of projects, not one
void createWatchSession(project)

const source: ChangeSource = (sink) => {
  sink.event({ kind: 'change', path: '/p/a.ts', mtimeMs: 1 })
  return { close: () => {} }
}
void createWatchSession([project], { changes: source })
// @ts-expect-error an unlink's mtime is `undefined`, never left out
const noMtime: WatchEvent = { kind: 'unlink', path: '/p/a.ts' }
// @ts-expect-error the kinds are add, change and unlink
const renamed: WatchEvent = { kind: 'rename', path: '/p/a.ts', mtimeMs: 1 }

const clock: CoalesceClock = { schedule: () => () => {} }
expectTypeOf(createCoalescer({ emit: () => {}, clock })).toEqualTypeOf<Coalescer>()
// @ts-expect-error a clock's `schedule` returns its cancel
const badClock: CoalesceClock = { schedule: () => 1 }

expectTypeOf(createWatcher).returns.toEqualTypeOf<Promise<Watcher>>()
const fakeWatch: WatchFunction = () => ({ close: () => {} })
void createWatcher({
  roots: ['/p'],
  keeps: () => true,
  onEvent: () => {},
  onError: () => {},
  watch: fakeWatch,
})
// @ts-expect-error a watcher needs somewhere to send its events
void createWatcher({ roots: ['/p'], keeps: () => true })

expectTypeOf<Pool['interrupt']>().toEqualTypeOf<
  (options?: { readonly keepRunning?: boolean }) => void
>()
expectTypeOf<Pool['retire']>().toEqualTypeOf<(which: (key: WorkerKey) => boolean) => void>()
expectTypeOf<NonNullable<FileRequest['staleModules']>>().toEqualTypeOf<
  (workerId: number) => readonly string[]
>()
void [noMtime, renamed, badClock]
