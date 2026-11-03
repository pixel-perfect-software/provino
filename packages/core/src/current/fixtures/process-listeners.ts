// Child process for propagation cases 20 and 21 (`propagation.test.ts`): which test a process
// listener sees for a rejection left unhandled in A, and for an exception thrown by A's timer
// while B runs. It prints one JSON object and exits.
import type { Frame, TaskId } from '@provino/types'
import { currentTest } from '../current-test.ts'

const frame = (name: string): Frame => ({
  test: null,
  hook: null,
  fileId: name as TaskId,
  attempt: 0,
  repeat: 0,
})
const seen = (): string => currentTest.get()?.fileId ?? '-'
const results: Record<string, string> = {}
const rejected = Promise.withResolvers<void>()
const thrown = Promise.withResolvers<void>()

process.on('unhandledRejection', () => {
  results.unhandledRejection = seen()
  rejected.resolve()
})
process.on('uncaughtException', () => {
  results.uncaughtException = seen()
  thrown.resolve()
})

currentTest.run(frame('A'), () => {
  void Promise.reject(new Error('left unhandled in A'))
  setTimeout(() => {
    throw new Error("thrown by A's timer")
  }, 5)
})
// B is running when both listeners fire: it waits on their signals, not on time.
await currentTest.run(frame('B'), () => Promise.all([rejected.promise, thrown.promise]))
process.stdout.write(JSON.stringify(results))
