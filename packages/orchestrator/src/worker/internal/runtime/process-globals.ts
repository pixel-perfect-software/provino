// What a worker installs process-wide, set aside for a worker that starts inside another one's
// process. An inline or in-band pool runs its worker in the coordinator's process, and that process
// can itself be a worker's: a test that calls `run()` or `runJestCommand` under Provino (the outer
// worker) on a project that goes in band. The outer worker holds its slots, its process error
// listeners and its console capture for its whole life, so the inner one would find the matcher
// slot taken (`EXPECT_SLOT_TAKEN`), delete the API and lazy slots it replaced instead of giving them
// back, and have its files' uncaught errors charged to the outer worker's test. So the inner worker
// takes each of them off as it starts and puts it back, exactly as it found it, once it has stopped:
// the slots (`setAsideOuterSlots`, first in the runner's `boot`, last in its `stop`), the error
// listeners (`listenInPlaceOfOuter`, swapped with the runner's own in one step each way, so the
// process is never left without one) and the console (`setAsideOuterConsole`, `startWorker`'s, around
// its own capture).
//
// A worker alone in its process pays one check per slot and one property read on `console`.
//
// While the inner worker lives, the outer worker's test that started it is awaiting the run; a test
// of the outer worker running concurrently beside it sees the inner worker's slots (its `expect`
// state, lazy runtime and API), has an uncaught error charged by the inner worker, and its console
// calls reach the outer capture as direct writes to the process's streams (no level, still its own
// task's). It is a limit, not handled: nothing tells the two apart in one process.
import { MATCHERS_SLOT } from '@provino/expect'
import { LAZY_RUNTIME_SLOT } from '@provino/lazy'

/**
 * `@provino/api`'s `PROVINO_API_SLOT`: the native runtime's module-scope factory installs it, and
 * this node reaches that factory by ref only, so the key is written here too (a registered symbol is
 * the same value wherever it is made).
 */
const API_SLOT: unique symbol = Symbol.for('provino.api')

/**
 * Every process-global slot a worker's boot installs: the matcher slot (the runner's
 * `installMatchersSlot`), the lazy runtime (`installLazyRuntime`) and the native API (the module
 * scope's factory).
 * @internal
 */
export const PROCESS_SLOTS: readonly symbol[] = [MATCHERS_SLOT, LAZY_RUNTIME_SLOT, API_SLOT]

/**
 * Takes every slot of `PROCESS_SLOTS` that `target` holds off it, and returns the function that
 * puts each back with the descriptor it had, whatever the slot holds by then (the inner worker's
 * `stop` has taken its own out). `undefined` when none was held: the worker is alone in its process.
 * A non-configurable slot (Jest's own `expect` defines the matcher slot so) can't be taken off and
 * stays, so `installMatchersSlot` still refuses it.
 * @internal
 */
export function setAsideOuterSlots(target: object = globalThis): (() => void) | undefined {
  let held: Array<readonly [symbol, PropertyDescriptor]> | undefined
  for (const key of PROCESS_SLOTS) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
    if (descriptor?.configurable !== true) continue
    held ??= []
    held.push([key, descriptor])
    Reflect.deleteProperty(target, key)
  }
  if (held === undefined) return undefined
  const found = held
  return () => {
    for (const [key, descriptor] of found) Reflect.defineProperty(target, key, descriptor)
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

/**
 * The registered key under which an installed console capture's front console holds the console it
 * replaced (`ConsoleCapture.install` with a target), so a worker inside another's process finds
 * the console that was there before the outer capture (the two workers are two copies of this code).
 * @internal
 */
export const REPLACED_CONSOLE: unique symbol = Symbol.for('provino.console.replaced')

/**
 * When `target.console` is another worker's capture, puts the console that capture replaced on
 * `target` and returns the function that puts the capture back; `undefined` otherwise.
 * @internal
 */
export function setAsideOuterConsole(
  target: { console: Console } = globalThis,
): (() => void) | undefined {
  const found = target.console
  const replaced: unknown = Reflect.get(found, REPLACED_CONSOLE)
  if (replaced === undefined) return undefined
  target.console = replaced as Console
  return () => {
    target.console = found
  }
}
