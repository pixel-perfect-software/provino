// The worker half's public types: what a runner may define.
import type { FileContext, WorkerContext, WorkerRunner } from '@provino/orchestrator/worker'
import { expectTypeOf } from 'expect-type'

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
