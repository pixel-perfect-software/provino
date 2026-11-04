// T9.3's check over real workers: calls still pending when the transport dies reject with the
// WorkerExit as their cause, and so does every call made after.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { connectWorker } from '@provino/orchestrator'
import { createRpc, RpcError, type RpcPort } from '@provino/rpc'
import type { RpcCall, RpcReply, WorkerExit } from '@provino/types'
import type { PeerMethods } from './fixtures/rpc-worker.ts'
import { factoryFor, fixture, initFor, job } from './support.ts'

type None = Record<never, never>

/** The coordinator's RPC to the test peer, which serves its own schema rather than WorkerMethods. */
async function peer(kind: 'forks' | 'threads' | 'inline') {
  const transport = await factoryFor(kind, { entry: fixture('rpc-worker.ts') }).create(
    initFor(kind),
  )
  const client = createRpc<None, PeerMethods>(
    transport as unknown as RpcPort<RpcCall<PeerMethods> | RpcReply<None>>,
    {},
  )
  return { transport, client }
}

function rejectsClosedWith(cause: WorkerExit) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof RpcError)
    assert.equal(error.code, 'RPC_CLOSED')
    assert.deepEqual(error.cause, cause)
    return true
  }
}

for (const kind of ['forks', 'threads'] as const) {
  describe(`${kind}: pending calls when the worker dies`, () => {
    it('reject with the WorkerExit cause, and later calls do too', async () => {
      const { client } = await peer(kind)
      assert.equal(await client.ping(), 1)
      const pending = [client.hang(), client.hang()]
      void client.die(7).catch(() => {})
      const exit: WorkerExit = { type: 'exit', code: 7 }
      for (const call of pending) await assert.rejects(call, rejectsClosedWith(exit))
      await assert.rejects(client.ping(), rejectsClosedWith(exit))
    })

    it('reject with the signal when the worker is killed', async () => {
      const { transport, client } = await peer(kind)
      const pending = client.hang()
      await client.ping()
      await transport.terminate(true)
      await assert.rejects(
        pending,
        rejectsClosedWith(
          kind === 'forks'
            ? { type: 'signal', signal: 'SIGKILL', likelyOom: false }
            : { type: 'exit', code: 1 },
        ),
      )
    })
  })
}

describe('inline: pending calls when the link closes', () => {
  it('reject with the WorkerExit cause', async () => {
    const { transport, client } = await peer('inline')
    const pending = client.hang()
    await client.ping()
    await transport.terminate(true)
    await assert.rejects(pending, rejectsClosedWith({ type: 'exit', code: 0 }))
  })
})

describe('connectWorker after a worker dies', () => {
  it('rejects the running file and WorkerMethods calls with the WorkerExit', async () => {
    const transport = await factoryFor('forks', { entry: fixture('isolation-worker.ts') }).create(
      initFor('forks'),
    )
    const connection = connectWorker(transport, {
      methods: {
        resolveSnapshotPath: async (file) => file,
        writeSnapshot: async () => {},
        readTimings: async () => undefined,
      },
      onEvents: () => {},
    })
    assert.ok((await connection.worker.memoryUsage()) > 0)
    const exit: WorkerExit = { type: 'exit', code: 3 }
    await assert.rejects(connection.run(job('exit3')), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'ORCH_WORKER_EXITED')
      assert.deepEqual((error as Error).cause, exit)
      return true
    })
    await assert.rejects(connection.worker.memoryUsage(), rejectsClosedWith(exit))
  })
})
