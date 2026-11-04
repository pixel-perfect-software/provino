// The worker half's public types: what a runner may define.
import {
  createRuntimeRunner,
  type FileContext,
  type WorkerContext,
  WorkerError,
  type WorkerErrorCode,
  type WorkerRunner,
} from '@provino/orchestrator/worker'
import main from '@provino/orchestrator/worker/main'
import type { WorkerMain } from '@provino/types'
import { expectTypeOf } from 'expect-type'

// The real runtime is a runner, and its entry is a `WorkerMain`.
expectTypeOf(createRuntimeRunner).parameters.toEqualTypeOf<[]>()
expectTypeOf(createRuntimeRunner).returns.toEqualTypeOf<WorkerRunner>()
expectTypeOf(main).toEqualTypeOf<WorkerMain>()

// Its errors carry a code from a closed set.
expectTypeOf<WorkerError['code']>().toEqualTypeOf<WorkerErrorCode>()
expectTypeOf<WorkerErrorCode>().toEqualTypeOf<
  | 'ORCH_BAD_CONFIG'
  | 'ORCH_BAD_ENVIRONMENT'
  | 'ORCH_BAD_GLOBALS'
  | 'ORCH_NOT_STARTED'
  | 'ORCH_NO_ACTIVE_FILE'
>()
expectTypeOf(WorkerError).toExtend<new (code: WorkerErrorCode, message: string) => Error>()
// @ts-expect-error a code outside the set
new WorkerError('ORCH_WORKER_EXITED', 'the coordinator’s codes are not the worker’s')
// @ts-expect-error the runtime takes no options: the project arrives in the worker's init
createRuntimeRunner({})

// `stop` is optional, takes the worker's context, and may be async.
expectTypeOf<WorkerRunner['stop']>().toEqualTypeOf<
  ((context: WorkerContext) => void | Promise<void>) | undefined
>()
expectTypeOf<FileContext>().toExtend<WorkerContext>()

const minimal: WorkerRunner = { runFile: async () => undefined }
const stopping: WorkerRunner = {
  runFile: async () => undefined,
  stop: async (context) => {
    expectTypeOf(context).toEqualTypeOf<WorkerContext>()
  },
}
const stoppingSync: WorkerRunner = { runFile: async () => undefined, stop: () => {} }
const badStop: WorkerRunner = {
  runFile: async () => undefined,
  // @ts-expect-error stop is a teardown that takes the worker's context
  stop: (_context: string) => {},
}
const returnsValue: WorkerRunner = {
  runFile: async () => undefined,
  // @ts-expect-error a stop that returns a value (not void or a promise of void)
  stop: () => 1,
}

export { badStop, minimal, returnsValue, stopping, stoppingSync }
