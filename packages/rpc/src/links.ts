// Message links: one ordered, structured-clone channel per worker, over whatever the transport
// has (a `MessagePort`, a fork's IPC channel seen from either end, a `Worker`). Every link queues
// messages that arrive while nobody listens and hands them, in order, to the next listener; it
// closes once, and drops sends after it closed.
import type { ChildProcess, Serializable } from 'node:child_process'
import type { MessagePort, Transferable, Worker } from 'node:worker_threads'
import type { LinkClosed, MessageLink } from '@provino/types'
import { RpcError } from './errors.ts'

const CLOSED: LinkClosed = Object.freeze({ type: 'closed' })

/** A send that fails once the channel is going away is dropped; the link's exit reports it. */
const ignoreSendError = (): void => {}

/** What a link needs from the channel under it. */
interface Channel {
  post(message: unknown, transfer: readonly ArrayBuffer[] | undefined): void
  /** Subscribes once, for the link's lifetime. */
  listen(onMessage: (message: unknown) => void, onClose: () => void): void
  close(): void
}

function createLink<Out, In>(channel: Channel): MessageLink<Out, In> {
  const listeners = new Set<(message: In) => void>()
  const exitListeners = new Set<(cause: LinkClosed) => void>()
  /** Messages nobody has taken yet, oldest first. Short: it fills only while nobody listens. */
  const queue: In[] = []
  let drainScheduled = false
  let closed = false

  /** Delivers queued messages, in order, while someone listens. */
  const pump = (): void => {
    while (queue.length > 0 && listeners.size > 0 && !closed) {
      const message = queue.shift() as In
      // A copy: a listener added or removed while this message is delivered doesn't change who gets it.
      for (const listener of [...listeners]) listener(message)
    }
  }
  const onClose = (): void => {
    if (closed) return
    closed = true
    queue.length = 0
    listeners.clear()
    for (const listener of exitListeners) listener(CLOSED)
    exitListeners.clear()
  }
  channel.listen((message) => {
    // Every protocol message is an object. Anything else on the channel (a test's own
    // `process.send(null)`) is dropped rather than handed to listeners that read `.t`.
    if (closed || typeof message !== 'object' || message === null) return
    queue.push(message as In)
    if (!drainScheduled) pump()
  }, onClose)

  return {
    send(message, transfer) {
      if (!closed) channel.post(message, transfer)
    },
    onMessage(listener) {
      if (closed) return () => {}
      listeners.add(listener)
      if (queue.length > 0 && !drainScheduled) {
        // Delivered after `onMessage` returns, in order, before any message that arrives later
        // (those come as macrotasks, and wait behind the scheduled drain).
        drainScheduled = true
        queueMicrotask(() => {
          drainScheduled = false
          pump()
        })
      }
      return () => {
        listeners.delete(listener)
      }
    },
    onExit(listener) {
      if (closed) {
        listener(CLOSED)
        return () => {}
      }
      exitListeners.add(listener)
      return () => {
        exitListeners.delete(listener)
      }
    },
    close() {
      if (closed) return
      channel.close()
      onClose()
    },
  }
}

/**
 * A link over a `MessagePort`: a thread's `parentPort`, or either end of a `MessageChannel`.
 * Closing it closes the port, which closes the other end too.
 * @public
 */
export function messagePortLink<Out, In>(port: MessagePort): MessageLink<Out, In> {
  return createLink({
    post: (message, transfer) => port.postMessage(message, transfer as readonly Transferable[]),
    listen(onMessage, onClose) {
      port.on('message', onMessage)
      port.once('close', onClose)
    },
    close: () => port.close(),
  })
}

/**
 * A link from a forked child to its parent, over `process.send`. The fork must use
 * `serialization: 'advanced'` (as `forksTransport` does): JSON would turn a `Map`, a `Date` or a
 * `bigint` into something else. Closing it disconnects the IPC
 * channel once every message sent so far has been written (a disconnect cancels queued writes),
 * so the child can exit once nothing else keeps it alive; `process` emits `disconnect` then.
 * @public
 */
export function processLink<Out, In>(proc: NodeJS.Process): MessageLink<Out, In> {
  const send = proc.send?.bind(proc)
  if (send === undefined) throw new RpcError('RPC_CLOSED', 'This process has no IPC channel')
  let unwritten = 0
  let closing = false
  const disconnect = (): void => {
    if (proc.connected) proc.disconnect()
  }
  // A send that fails once the channel is going away is dropped; `disconnect` reports it.
  const written = (): void => {
    unwritten--
    if (closing && unwritten === 0) disconnect()
  }
  return createLink({
    post: (message) => {
      if (!proc.connected) return
      // A send that throws (a value advanced serialization can't write) was never queued.
      send(message, undefined, undefined, written)
      unwritten++
    },
    listen(onMessage, onClose) {
      proc.on('message', onMessage)
      proc.once('disconnect', onClose)
    },
    close: () => {
      closing = true
      if (unwritten === 0) disconnect()
    },
  })
}

/**
 * A link from the parent to a forked child, over `child.send`; the fork must use
 * `serialization: 'advanced'`. It closes when the IPC channel
 * disconnects, which happens after every message the child sent has arrived; a child's `exit`
 * can come before its last messages are read, so the link doesn't close on it. A send that
 * fails once the channel is going away is dropped: the link's exit is what reports it.
 * @public
 */
export function childProcessLink<Out, In>(child: ChildProcess): MessageLink<Out, In> {
  return createLink({
    post: (message) => {
      if (child.connected) child.send(message as Serializable, ignoreSendError)
    },
    listen(onMessage, onClose) {
      child.on('message', onMessage)
      child.once('disconnect', onClose)
    },
    close: () => {
      if (child.connected) child.disconnect()
    },
  })
}

/**
 * A link from the parent to a worker thread. It closes when the thread exits; closing it doesn't
 * stop the thread (the transport terminates it).
 * @public
 */
export function workerLink<Out, In>(worker: Worker): MessageLink<Out, In> {
  return createLink({
    post: (message, transfer) => worker.postMessage(message, transfer as readonly Transferable[]),
    listen(onMessage, onClose) {
      worker.on('message', onMessage)
      worker.once('exit', onClose)
    },
    close: () => {},
  })
}
