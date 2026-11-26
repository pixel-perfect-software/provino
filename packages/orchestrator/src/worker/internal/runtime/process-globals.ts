// What a worker installs process-wide, set aside for a worker that starts inside another one's
// process. An inline or in-band pool runs its worker in the coordinator's process, and that process
// can itself be a worker's: a test that calls `run()` or `runJestCommand` under Provino (the outer
// worker) on a project that goes in band. The outer worker holds its slots (`PROCESS_SLOTS`), its
// process error listeners and its console capture for its whole life, so the inner one would find
// the matcher slot taken (`EXPECT_SLOT_TAKEN`), delete the API and lazy slots it replaced instead of
// giving them back, and have its files' uncaught errors charged to the outer worker's test. So the
// inner worker takes each off as it starts and puts it back, exactly as found, once it has stopped:
// the slots (`setAsideOuterSlots`: first in the runner's `boot`, last in its `stop`), the error
// listeners (`listenInPlaceOfOuter`: swapped with the runner's own in one step each way, so the
// process is never left without one, and only when slots were set aside) and the console
// (`setAsideOuterConsole` in `console.ts`, `startWorker`'s, around its own capture). A worker alone in
// its process pays one own-property read per slot.
//
// **A stopped worker's slots are no one's to adopt.** An inline worker killed while a file runs on
// (a file can't be cancelled until T5.12) is reported gone once the transport's teardown bound
// passes, while its stop still waits behind the file, so the next worker in the process can boot
// beside its slots. The runner marks the slot values it installed as stopped (`markSlotsStopped`, a
// registered `WeakSet` both copies of this code share) when its link closes (`WorkerRunner.abandon`)
// and again as it stops; `setAsideOuterSlots` leaves a stopped value where it is, so that next
// worker fails loudly with `EXPECT_SLOT_TAKEN`, sets nothing aside and so takes none of the error
// listeners, and a restore never puts a stopped value back. Inside an outer worker the same holds:
// until the killed worker's stop finally runs, the outer worker's later tests see that worker's
// slots and listeners, not their own.
//
// While an inner worker lives, the outer worker's test that started it is awaiting the run; a test
// of the outer worker running concurrently beside it sees the inner worker's slots (its `expect`
// state, lazy runtime and API), has an uncaught error charged by the inner worker, and its console
// calls reach the outer capture as direct writes to the process's streams (no level, still its own
// task's). A limit, not handled: nothing tells the two apart in one process. Two inline runs that
// overlap in one process are not supported either.
import { MATCHERS_SLOT } from '@provino/expect'
import { LAZY_RUNTIME_SLOT } from '@provino/lazy'

/**
 * `@provino/api`'s `PROVINO_API_SLOT`, written here because the worker node reaches `@provino/api`
 * by ref only (the native runtime's module-scope factory): a registered symbol is the same value
 * wherever it is made.
 */
const API_SLOT: unique symbol = Symbol.for('provino.api')

/**
 * Every process-global slot a worker's boot installs: the matcher slot (the runner's
 * `installMatchersSlot`), the lazy runtime (`installLazyRuntime`) and the native API (the module
 * scope's factory). A worker inside another one's process sets these aside; a slot left off the list
 * would be taken over instead (`test/runtime-runner.test.ts` fails on one).
 * @beta
 */
export const PROCESS_SLOTS: readonly symbol[] = [MATCHERS_SLOT, LAZY_RUNTIME_SLOT, API_SLOT]

/** The registered key of the set of slot values whose worker has stopped or lost its link. */
const STOPPED_SLOTS: unique symbol = Symbol.for('provino.worker.stoppedSlots')

function stoppedSlots(): WeakSet<object> | undefined {
  const found: unknown = Reflect.get(globalThis, STOPPED_SLOTS)
  return found instanceof WeakSet ? found : undefined
}

function isStopped(value: unknown): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false
  return stoppedSlots()?.has(value) === true
}

/**
 * What each slot of `PROCESS_SLOTS` holds on `target` now (`undefined` for a free one), in order.
 * @internal
 */
export function slotValues(target: object = globalThis): readonly unknown[] {
  return PROCESS_SLOTS.map((key) => Reflect.getOwnPropertyDescriptor(target, key)?.value)
}

/**
 * Marks `values` (a worker's own slot values) as no one's to adopt: `setAsideOuterSlots` leaves
 * them in place and never puts one back.
 * @internal
 */
export function markSlotsStopped(values: readonly unknown[]): void {
  let stopped = stoppedSlots()
  for (const value of values) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) continue
    if (stopped === undefined) {
      stopped = new WeakSet()
      Reflect.defineProperty(globalThis, STOPPED_SLOTS, { value: stopped, configurable: true })
    }
    stopped.add(value)
  }
}

/**
 * Takes every slot of `PROCESS_SLOTS` that `target` holds for a live worker off it, and returns
 * the function that puts each back with the descriptor it had, unless its worker has stopped since.
 * `undefined` when none was taken: the worker is alone in its process. A non-configurable slot
 * (Jest's own `expect` defines the matcher slot so) and a stopped worker's slot stay, so
 * `installMatchersSlot` refuses them.
 * @internal
 */
export function setAsideOuterSlots(target: object = globalThis): (() => void) | undefined {
  const held: Array<readonly [symbol, PropertyDescriptor]> = []
  for (const key of PROCESS_SLOTS) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
    if (descriptor?.configurable !== true || isStopped(descriptor.value)) continue
    held.push([key, descriptor])
    Reflect.deleteProperty(target, key)
  }
  if (held.length === 0) return undefined
  return () => {
    for (const [key, descriptor] of held) {
      if (!isStopped(descriptor.value)) Reflect.defineProperty(target, key, descriptor)
    }
  }
}

/** The events `@provino/core`'s `captureProcessErrors` listens for. */
const PROCESS_ERROR_EVENTS = [
  'uncaughtException',
  'unhandledRejection',
  'rejectionHandled',
] as const

/** The part of `process` `listenInPlaceOfOuter` uses. */
type ListenerTarget = Pick<
  NodeJS.EventEmitter,
  'rawListeners' | 'removeAllListeners' | 'prependListener'
>

/**
 * Takes the listeners `target` has for the process error events off, then calls `listen` (the
 * runner's `captureProcessErrors`), so the inner worker's are the only ones, as in a process of its
 * own. The function it returns removes the inner worker's (`listen`'s own undo) and, in the same
 * step, puts the outer ones back ahead of any added since, in their order. A `listen` that throws
 * puts them back before the error goes on.
 * @internal
 */
export function listenInPlaceOfOuter(target: ListenerTarget, listen: () => () => void): () => void {
  const taken = PROCESS_ERROR_EVENTS.map(
    (event) => [event, target.rawListeners(event) as Array<(...args: unknown[]) => void>] as const,
  )
  for (const event of PROCESS_ERROR_EVENTS) target.removeAllListeners(event)
  const putBack = (): void => {
    for (const [event, listeners] of taken) {
      for (const listener of listeners.toReversed()) target.prependListener(event, listener)
    }
  }
  let stop: () => void
  try {
    stop = listen()
  } catch (error) {
    putBack()
    throw error
  }
  return () => {
    try {
      stop()
    } finally {
      putBack()
    }
  }
}
