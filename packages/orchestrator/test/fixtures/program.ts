// The console-order property's programs: seeded sequences of runtime events, console calls (every
// printing method, nested groups), direct stream writes, current-task changes and asynchronous
// gaps, with bursts long enough to cut 64-event packs inside one macrotask. The worker runs a
// program; the test models what it must produce.
import type { TaskId, WorkerEvent } from '@provino/types'
import { gap, int, pick, type Random, seeded } from './random.ts'

export type ConsoleMethod =
  | 'log'
  | 'info'
  | 'debug'
  | 'warn'
  | 'error'
  | 'dir'
  | 'count'
  | 'assert'
  | 'table'
  | 'group'
  | 'groupEnd'

export type Op =
  | { readonly op: 'event'; readonly n: number }
  | { readonly op: 'console'; readonly method: ConsoleMethod; readonly args: readonly unknown[] }
  | { readonly op: 'write'; readonly stream: 'stdout' | 'stderr'; readonly text: string }
  | { readonly op: 'task'; readonly id: TaskId | null }
  | { readonly op: 'gap'; readonly how: 'microtask' | 'immediate' | 'timeout' }

const METHODS: readonly ConsoleMethod[] = [
  'log',
  'info',
  'debug',
  'warn',
  'error',
  'dir',
  'count',
  'assert',
  'table',
  'group',
]

function step(
  random: Random,
  seed: number,
  n: number,
  depth: { value: number },
  quiet: boolean,
): Op {
  const roll = random()
  if (roll < 0.35) return { op: 'event', n }
  if (roll < 0.7) {
    const method = depth.value > 0 && random() < 0.15 ? 'groupEnd' : pick(random, METHODS)
    if (method === 'group') depth.value++
    if (method === 'groupEnd') depth.value--
    return { op: 'console', method, args: argsFor(method, seed, n, random) }
  }
  if (roll < 0.82) {
    const text = random() < 0.5 ? `w${n}\n` : `w${n}`
    return { op: 'write', stream: random() < 0.5 ? 'stdout' : 'stderr', text }
  }
  if (roll < 0.9 || quiet) {
    return {
      op: 'task',
      id: random() < 0.25 ? null : (`test-${seed}-${int(random, 0, 5)}` as TaskId),
    }
  }
  return {
    op: 'gap',
    how: pick(random, ['microtask', 'microtask', 'immediate', 'immediate', 'timeout'] as const),
  }
}

function argsFor(
  method: ConsoleMethod,
  seed: number,
  n: number,
  random: Random,
): readonly unknown[] {
  switch (method) {
    case 'dir':
      return [{ n, nested: { list: [n, `${n}`] } }]
    case 'count':
      return [`count-${seed}-${n % 3}`] // per program, so counts don't carry across programs
    case 'assert':
      return [random() >= 0.7, `assert ${n}`]
    case 'table':
      return [[{ n, s: `r${n}` }]]
    case 'group':
      return random() < 0.5 ? [`group ${n}`] : []
    case 'groupEnd':
      return []
    default:
      return random() < 0.5 ? [`%s is %d`, `v${n}`, n] : [`plain ${n}`, { n }]
  }
}

/** The program for one seed. Groups are closed at the end, so programs don't affect each other. */
export function program(seed: number): readonly Op[] {
  const random = seeded(seed)
  const ops: Op[] = []
  const depth = { value: 0 }
  const length = int(random, 1, 220)
  let n = 0
  while (ops.length < length) {
    // A burst: many writes with no gap, crossing the 64-event cut inside one macrotask.
    const burst = random() < 0.08 ? int(random, 64, 150) : 1
    for (let i = 0; i < burst; i++) ops.push(step(random, seed, n++, depth, burst > 1))
  }
  for (; depth.value > 0; depth.value--) ops.push({ op: 'console', method: 'groupEnd', args: [] })
  ops.push({ op: 'task', id: null })
  return ops
}

export function eventFor(n: number): WorkerEvent {
  return {
    type: 'annotation',
    testId: `e${n}` as TaskId,
    message: `m${n}`,
    kind: 'op',
    location: null,
    t: 0,
  }
}

/** Runs a program in a worker. */
export async function run(
  ops: readonly Op[],
  target: {
    readonly emit: (event: WorkerEvent) => void
    readonly console: Console
    readonly streams: {
      readonly stdout: { write(text: string): unknown }
      readonly stderr: { write(text: string): unknown }
    }
    readonly setTask: (id: TaskId | null) => void
  },
): Promise<void> {
  for (const op of ops) {
    switch (op.op) {
      case 'event':
        target.emit(eventFor(op.n))
        break
      case 'console':
        ;(target.console[op.method] as (...args: unknown[]) => void)(...op.args)
        break
      case 'write':
        target.streams[op.stream].write(op.text)
        break
      case 'task':
        target.setTask(op.id)
        break
      case 'gap':
        await gap(op.how)
        break
      default:
        op satisfies never
    }
  }
}
