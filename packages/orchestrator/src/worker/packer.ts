// The worker's event packer (T9.4). Events are cut into packs at the end of each macrotask or at
// 64 events, whichever comes first (build-plan §6, which overrides Track 9's 100 ms). Packs are
// numbered and acked cumulatively; at most 8 wait for an ack, and later packs queue behind them in
// order, which bounds what a slow coordinator holds. Nothing is coalesced: every event is a
// distinct transition reporters see (one event model, §6), so the pack itself is the batching.
import * as timers from 'node:timers'
import type { WorkerEvent, WorkerToCoordinator } from '@provino/types'

// Taken once, at load: fake timers installed later by a test file can't stall the flush.
const nativeSetImmediate = timers.setImmediate
const nativeClearImmediate = timers.clearImmediate
const nativeSetTimeout = timers.setTimeout
const nativeClearTimeout = timers.clearTimeout

/**
 * A pack on the wire.
 * @public
 */
export type PackMessage = Extract<WorkerToCoordinator, { readonly t: 'pack' }>

/**
 * When the packer cuts a pack that hasn't filled: at the end of the current macrotask (the
 * default, §6), or after a fixed interval (Track 9's 100 ms, kept for comparison).
 * @public
 */
export type PackSchedule = 'macrotask' | { readonly intervalMs: number }

/**
 * Options for `createPacker`.
 * @public
 */
export interface PackerOptions {
  /** Events per pack. Default 64. */
  readonly maxEvents?: number
  /** Packs sent and not yet acked before later ones wait. Default 8. */
  readonly maxPacksInFlight?: number
  /** Default `'macrotask'`. */
  readonly schedule?: PackSchedule
}

/**
 * Batches a worker's events into packs. It is an `EventSink`: `emit` never blocks, so the core
 * keeps running while the window is full, and its events wait in order.
 * @public
 */
export interface Packer {
  emit(event: WorkerEvent): void
  /** The coordinator has handled every pack up to `pack`. */
  ack(pack: number): void
  /** Resolves once every event emitted so far has been sent. */
  flush(): Promise<void>
  /** Resolves when fewer than `maxPacksInFlight` packs await an ack. */
  writable(): Promise<void>
  /** Packs sent and not yet acked. */
  readonly inFlight: number
}

/**
 * Creates a packer that sends its packs with `send`.
 * @public
 */
export function createPacker(
  send: (message: PackMessage) => void,
  options: PackerOptions = {},
): Packer {
  const maxEvents = options.maxEvents ?? 64
  const maxInFlight = options.maxPacksInFlight ?? 8
  const schedule = options.schedule ?? 'macrotask'
  let buffer: WorkerEvent[] = []
  /** Cut packs not sent yet, oldest first. */
  const waiting: WorkerEvent[][] = []
  /** The number the next sent pack gets; also how many have been sent. */
  let nextPack = 0
  let lastAcked = -1
  let timer: { readonly cancel: () => void } | undefined
  const flushWaiters: { readonly upTo: number; readonly resolve: () => void }[] = []
  const writableWaiters: (() => void)[] = []

  const inFlight = (): number => nextPack - 1 - lastAcked

  const pump = (): void => {
    while (waiting.length > 0 && inFlight() < maxInFlight) {
      const events = waiting.shift() as WorkerEvent[]
      send({ t: 'pack', pack: nextPack++, events })
    }
    for (let i = flushWaiters.length - 1; i >= 0; i--) {
      const waiter = flushWaiters[i] as (typeof flushWaiters)[number]
      if (nextPack >= waiter.upTo) {
        flushWaiters.splice(i, 1)
        waiter.resolve()
      }
    }
    if (inFlight() < maxInFlight) for (const resolve of writableWaiters.splice(0)) resolve()
  }

  const cut = (): void => {
    timer?.cancel()
    timer = undefined
    if (buffer.length === 0) return
    waiting.push(buffer)
    buffer = []
    pump()
  }

  const arm = (): void => {
    if (timer !== undefined) return
    if (schedule === 'macrotask') {
      const handle = nativeSetImmediate(cut)
      timer = { cancel: () => nativeClearImmediate(handle) }
    } else {
      const handle = nativeSetTimeout(cut, schedule.intervalMs)
      timer = { cancel: () => nativeClearTimeout(handle) }
    }
  }

  return {
    emit(event) {
      buffer.push(event)
      if (buffer.length >= maxEvents) cut()
      else arm()
    },
    ack(pack) {
      if (pack <= lastAcked) return
      lastAcked = Math.min(pack, nextPack - 1)
      pump()
    },
    flush() {
      cut()
      const upTo = nextPack + waiting.length
      if (nextPack >= upTo) return Promise.resolve()
      return new Promise((resolve) => flushWaiters.push({ upTo, resolve }))
    },
    writable() {
      if (inFlight() < maxInFlight) return Promise.resolve()
      return new Promise((resolve) => writableWaiters.push(resolve))
    },
    get inFlight() {
      return inFlight()
    },
  }
}
