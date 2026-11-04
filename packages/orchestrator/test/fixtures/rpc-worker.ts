// A raw RPC peer, not a `startWorker`: it serves `hang` (never answers), `die` (exits the process)
// and `ping`, so a test can leave a coordinator call pending when the worker goes away.
import { createRpc, type RpcPort } from '@provino/rpc'
import type { RpcCall, RpcReply, WorkerMain } from '@provino/types'

export interface PeerMethods {
  ping(): number
  hang(): Promise<void>
  die(code: number): void
}

const main: WorkerMain = (port) => {
  createRpc<PeerMethods, Record<never, never>>(
    port as unknown as RpcPort<RpcCall<Record<never, never>> | RpcReply<PeerMethods>>,
    {
      ping: () => 1,
      hang: () => new Promise<void>(() => {}),
      // Only for forks and threads: an inline worker shares the coordinator's process.
      die: (code) => process.exit(code),
    },
  )
  port.send({ t: 'ready' })
}
export default main
