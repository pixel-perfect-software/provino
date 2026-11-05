// T9.4's second check, a property test: console order matches event order. Each case is a seeded
// program interleaving runtime events, console calls, direct stream writes, current-task changes
// and asynchronous gaps; the coordinator must receive exactly the program's sequence (order,
// text, stream, level and task), with Node's own formatting. A plain `Console` in this process
// models the expected text. A failure names its seed; replay it alone with
// `PROVINO_SEED=<seed> node --test --conditions=provino-source packages/orchestrator/test/console-order.test.ts`
// (Turbo doesn't pass the variable through).
import assert from 'node:assert/strict'
import { Console } from 'node:console'
import { describe, it } from 'node:test'
import { connectWorker, transportFor } from '@provino/orchestrator'
import type { PoolKind, TaskId, WorkerEvent } from '@provino/types'
import { type Op, program } from './fixtures/program.ts'
import { gap, int, seeded } from './fixtures/random.ts'
import { fixture, initFor, job, methods } from './support.ts'

type Seen =
  | { readonly kind: 'event'; readonly n: number }
  | {
      readonly kind: 'console'
      readonly stream: 'stdout' | 'stderr'
      readonly level: string | null
      readonly text: string
      readonly taskId: TaskId | null
    }

/** What a program must produce, in order. */
function expected(ops: readonly Op[]): Seen[] {
  const out: Seen[] = []
  let task: TaskId | null = null
  let level: string | null = null
  const sink = (stream: 'stdout' | 'stderr') =>
    ({
      write(text: string) {
        if (text !== '') out.push({ kind: 'console', stream, level, text, taskId: task })
        return true
      },
    }) as unknown as NodeJS.WritableStream
  const reference = new Console({
    stdout: sink('stdout'),
    stderr: sink('stderr'),
    ignoreErrors: false,
  })
  for (const op of ops) {
    switch (op.op) {
      case 'event':
        out.push({ kind: 'event', n: op.n })
        break
      case 'console':
        level = op.method
        ;(reference[op.method] as (...args: unknown[]) => void)(...op.args)
        level = null
        break
      case 'write':
        if (op.text !== '')
          out.push({ kind: 'console', stream: op.stream, level: null, text: op.text, taskId: task })
        break
      case 'task':
        task = op.id
        break
      case 'gap':
        break
      default:
        op satisfies never
    }
  }
  return out
}

function seen(event: WorkerEvent): Seen {
  if (event.type === 'annotation') return { kind: 'event', n: Number(event.testId.slice(1)) }
  if (event.type === 'console') {
    const { stream, level, text, taskId } = event
    return { kind: 'console', stream, level, text, taskId }
  }
  throw new Error(`unexpected ${event.type} event`)
}

const only = process.env.PROVINO_SEED === undefined ? undefined : Number(process.env.PROVINO_SEED)

const CASES: readonly {
  readonly kind: PoolKind
  readonly entry: string
  readonly cases: number
}[] = [
  { kind: 'inline', entry: 'program-worker-inline.ts', cases: 300 },
  { kind: 'forks', entry: 'program-worker.ts', cases: 25 },
  { kind: 'threads', entry: 'program-worker.ts', cases: 25 },
]

describe('console order matches event order', () => {
  for (const { kind, entry, cases } of CASES) {
    it(`${kind}: ${only === undefined ? cases : 1} seeded programs`, async () => {
      const transport = await transportFor(kind, { entry: fixture(entry) }).create(initFor(kind))
      const random = seeded(kind.length)
      let received: WorkerEvent[] = []
      const connection = connectWorker(transport, {
        methods,
        // Ack after a varying number of turns, so the window sometimes fills.
        async onEvents(events) {
          received.push(...events)
          for (let i = int(random, 0, 3); i > 0; i--) await gap('immediate')
        },
      })
      const seeds = only === undefined ? Array.from({ length: cases }, (_, i) => 1000 + i) : [only]
      try {
        for (const seed of seeds) {
          received = []
          await connection.run(job(`program:${seed}`))
          assert.deepEqual(received.map(seen), expected(program(seed)), `seed ${seed} (${kind})`)
        }
      } finally {
        await transport.terminate(false)
      }
    })
  }
})
