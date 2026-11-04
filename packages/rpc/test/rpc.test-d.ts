// T1.9 / T9.3: `createRpc` infers client signatures, and a schema that can't cross a thread (a
// callback argument, a class result) is a compile error.
import { createRpc, type RpcError, type RpcHandlers, type RpcPort } from '@provino/rpc'
import type {
  CoordinatorMethods,
  RpcCall,
  RpcClient,
  RpcReply,
  Transport,
  WorkerMethods,
  WorkerPort,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

declare const transport: Transport
declare const port: WorkerPort
declare const coordinatorHandlers: RpcHandlers<CoordinatorMethods>

// The coordinator serves CoordinatorMethods over its Transport and calls WorkerMethods.
const toWorker = createRpc<CoordinatorMethods, WorkerMethods>(transport, coordinatorHandlers)
expectTypeOf(toWorker).toEqualTypeOf<RpcClient<WorkerMethods>>()
expectTypeOf(toWorker.memoryUsage).toEqualTypeOf<() => Promise<number>>()

// The worker serves WorkerMethods over its port and calls CoordinatorMethods.
const toCoordinator = createRpc<WorkerMethods, CoordinatorMethods>(port, { memoryUsage: () => 1 })
expectTypeOf(toCoordinator.readTimings).toEqualTypeOf<
  (file: string) => Promise<number | undefined>
>()
expectTypeOf(toCoordinator.resolveSnapshotPath).returns.toEqualTypeOf<Promise<string>>()
// @ts-expect-error readTimings takes a file path
void toCoordinator.readTimings(1)
// @ts-expect-error not a coordinator method
void toCoordinator.fetchModule('x')

// A handler may answer synchronously or with a promise; it must return the method's result type.
createRpc<WorkerMethods, CoordinatorMethods>(port, { memoryUsage: async () => 1 })
// @ts-expect-error memoryUsage returns a number
createRpc<WorkerMethods, CoordinatorMethods>(port, { memoryUsage: () => 'big' })
// @ts-expect-error every local method needs a handler
createRpc<WorkerMethods, CoordinatorMethods>(port, {})

// The orientation must match the port: a worker's schemas don't fit the coordinator's transport.
// @ts-expect-error the transport sends coordinator-to-worker messages
createRpc<WorkerMethods, CoordinatorMethods>(transport, { memoryUsage: () => 1 })

interface TakesCallback {
  subscribe(listener: () => void): void
}
interface ReturnsClass {
  open(): Promise<URL>
}
interface TakesSymbol {
  tag(key: symbol): void
}
/** A port of exactly the right type, so only the schema can make a call fail. */
declare function portFor<Local, Remote>(): RpcPort<RpcCall<Remote> | RpcReply<Local>>
interface Clean {
  ping(at: Date, tags: ReadonlySet<string>): Promise<ReadonlyMap<string, bigint>>
}
createRpc<Clean, WorkerMethods>(portFor<Clean, WorkerMethods>(), { ping: async () => new Map() })
// @ts-expect-error a method taking `() => void` fails RpcSchema
createRpc<TakesCallback, WorkerMethods>(portFor<TakesCallback, WorkerMethods>(), {
  subscribe: () => {},
})
// @ts-expect-error the remote side's schema is checked too
createRpc<WorkerMethods, TakesCallback>(portFor<WorkerMethods, TakesCallback>(), {
  memoryUsage: () => 1,
})
// @ts-expect-error a class instance result can't cross a thread
createRpc<ReturnsClass, WorkerMethods>(portFor<ReturnsClass, WorkerMethods>(), {
  open: async () => new URL('file:///'),
})
// @ts-expect-error a symbol argument can't cross a thread
createRpc<TakesSymbol, WorkerMethods>(portFor<TakesSymbol, WorkerMethods>(), { tag: () => {} })

// A rejection carries a stable code.
declare const error: RpcError
expectTypeOf(error.code).toEqualTypeOf<
  'RPC_CLOSED' | 'RPC_REMOTE_ERROR' | 'RPC_UNKNOWN_METHOD' | 'RPC_UNCLONABLE'
>()
