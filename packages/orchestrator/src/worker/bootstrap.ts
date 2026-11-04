// The main module of every forked or threaded worker: connect to the parent, load the worker
// entry (the coordinator passes it as `argv[2]` to a fork and in `workerData` to a thread), and
// hand it the port. Once the entry is done and the link has closed, the worker exits on purpose,
// so a handle a test leaked can't keep it alive, and a worker whose coordinator died doesn't
// linger. Importing this module starts a worker; nothing imports it.
import { once } from 'node:events'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { messagePortLink, processLink } from '@provino/rpc'
import type { WorkerMain, WorkerPort } from '@provino/types'
import { flushStdio } from './stdio.ts'

const entry: unknown = isMainThread ? process.argv[2] : (workerData as { entry?: unknown })?.entry
if (typeof entry !== 'string') throw new TypeError('The worker bootstrap needs an entry module URL')
if (!isMainThread && parentPort === null) throw new TypeError('A worker thread has no parentPort')

const port: WorkerPort =
  isMainThread || parentPort === null ? processLink(process) : messagePortLink(parentPort)
const closed = new Promise<void>((resolve) => port.onExit(() => resolve()))
const loaded: unknown = await import(entry)
const main = (loaded as { readonly default?: unknown }).default
if (typeof main !== 'function')
  throw new TypeError(`The worker entry ${entry} has no default-exported function`)

await (main as WorkerMain)(port)
await closed
// A fork's link disconnects only after its last message is written.
if (isMainThread && process.connected) await once(process, 'disconnect')
await flushStdio()
process.exit(0)
