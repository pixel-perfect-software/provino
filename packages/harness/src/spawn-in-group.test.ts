import assert from 'node:assert/strict'
import { type ChildProcess, type StdioOptions, spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { exitOnSignals, spawnInGroup } from './spawn-in-group.ts'

// The children are inline scripts run by this same Node. They print READY once they are set up,
// and the tests act on that signal, so nothing here depends on how fast a machine starts a
// process. A stray child (a failing test) ends itself after 20 s.
const SPIN_FOREVER = 'setInterval(() => {}, 1000); setTimeout(() => process.exit(9), 20000)'

const SPAWN_IN_GROUP_URL = pathToFileURL(
  new URL('./spawn-in-group.ts', import.meta.url).pathname,
).href

const base = { cwd: process.cwd(), env: process.env }
const PIPED: StdioOptions = ['ignore', 'pipe', 'pipe']
const node = (script: string): [string, string[]] => [process.execPath, ['-e', script]]

/** Collects a child's stdout, and settles `until` the first time `marker` has been printed. */
function watch(child: ChildProcess, marker: string): { seen: () => string; ready: Promise<void> } {
  let text = ''
  const ready = new Promise<void>((resolve) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
      if (text.includes(marker)) resolve()
    })
  })
  return { seen: () => text, ready }
}

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

/** A child that starts a grandchild in its own group and prints both pids. */
const GROUP = `
const { spawn } = require('node:child_process')
process.on('SIGTERM', () => process.exit(0))
const grand = spawn(process.execPath, ['-e', ${JSON.stringify(SPIN_FOREVER)}], { stdio: 'ignore' })
console.log('READY ' + process.pid + ' ' + grand.pid)
${SPIN_FOREVER}
`

test('a process that exits on its own reports its exit code, with its group gone', {
  timeout: 15_000,
}, async () => {
  const { exited } = spawnInGroup(...node('process.exit(3)'), {
    ...base,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const exit = await exited
  assert.equal(exit.exitCode, 3)
  assert.equal(exit.signal, null)
  assert.equal(exit.timedOut, false)
  assert.deepEqual(exit.problems, [])
  assert.equal(typeof exit.endedAt, 'number')
})

test('the stdio is the caller’s: a spare fd can carry data back', { timeout: 15_000 }, async () => {
  const { child, exited } = spawnInGroup(...node("require('node:fs').writeSync(3, 'from fd 3')"), {
    ...base,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  })
  const fd3 = child.stdio[3]
  assert.ok(fd3, 'fd 3 is a pipe')
  const closed = once(fd3, 'close')
  let text = ''
  fd3.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8')
  })
  await exited
  await closed
  assert.equal(text, 'from fd 3')
})

test('the deadline ends the whole group, and exited waits until nothing is left', {
  timeout: 15_000,
}, async () => {
  const controller = new AbortController()
  const { child, exited } = spawnInGroup(...node(GROUP), {
    ...base,
    stdio: PIPED,
    deadline: controller.signal,
  })
  const output = watch(child, 'READY')
  await output.ready
  controller.abort()
  const exit = await exited
  const [, childPid, grandPid] = /READY (\d+) (\d+)/.exec(output.seen()) ?? []
  assert.equal(exit.timedOut, true)
  assert.equal(exit.exitCode, 0)
  assert.equal(isGone(Number(childPid)), true)
  assert.equal(isGone(Number(grandPid)), true, 'the grandchild in the group was ended too')
})

test('a child that ignores SIGTERM is killed once the grace period is over', {
  timeout: 15_000,
}, async () => {
  const controller = new AbortController()
  const { child, exited } = spawnInGroup(
    ...node(`process.on('SIGTERM', () => {}); console.log('READY'); ${SPIN_FOREVER}`),
    { ...base, stdio: PIPED, deadline: controller.signal, killGraceMs: 20 },
  )
  await watch(child, 'READY').ready
  controller.abort()
  const exit = await exited
  assert.equal(exit.timedOut, true)
  assert.equal(exit.signal, 'SIGKILL')
})

test('a deadline that is already past ends the run', { timeout: 15_000 }, async () => {
  const { exited } = spawnInGroup(...node(SPIN_FOREVER), {
    ...base,
    stdio: ['ignore', 'ignore', 'ignore'],
    deadline: AbortSignal.abort(),
    killGraceMs: 20,
  })
  assert.equal((await exited).timedOut, true)
})

test('timeoutMs ends a run that outlasts it', { timeout: 15_000 }, async () => {
  const { exited } = spawnInGroup(...node(SPIN_FOREVER), {
    ...base,
    stdio: ['ignore', 'ignore', 'ignore'],
    timeoutMs: 1,
    killGraceMs: 20,
  })
  const exit = await exited
  assert.equal(exit.timedOut, true)
  assert.notEqual(exit.signal, null)
})

test('a member left behind by a process that exited is killed, and exited waits for it', {
  timeout: 15_000,
}, async () => {
  const { child, exited } = spawnInGroup(
    ...node(`
      const grand = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(SPIN_FOREVER)}], { stdio: 'ignore' })
      console.log('READY ' + grand.pid)
      process.exit(0)
    `),
    { ...base, stdio: PIPED, killGraceMs: 20 },
  )
  const output = watch(child, 'READY')
  const exit = await exited
  const grandPid = Number(/READY (\d+)/.exec(output.seen())?.[1])
  assert.equal(exit.exitCode, 0)
  assert.equal(exit.timedOut, false)
  assert.equal(isGone(grandPid), true)
})

test('a process that can’t be started rejects exited, and leaves no hook behind', {
  timeout: 15_000,
}, async () => {
  const hooks = process.listenerCount('exit')
  const { exited } = spawnInGroup('/definitely/not/a/command', [], {
    ...base,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  await assert.rejects(exited, (error: unknown) => error instanceof Error && 'code' in error)
  assert.equal(process.listenerCount('exit'), hooks)
})

test('the library installs no signal handler, and removes its exit hook when it is done', {
  timeout: 15_000,
}, async () => {
  const before = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'].map((name) => process.listenerCount(name))
  const { exited } = spawnInGroup(...node(''), { ...base, stdio: ['ignore', 'ignore', 'ignore'] })
  assert.equal(process.listenerCount('exit'), before[3] === undefined ? 1 : before[3] + 1)
  await exited
  const after = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'].map((name) => process.listenerCount(name))
  assert.deepEqual(after, before)
})

test('its exit hook runs before the listeners that were there first', {
  timeout: 15_000,
}, async () => {
  // A caller's cleanup (the recorder removing its work directory) must not run while the group it
  // started is still alive, so the group is killed first.
  const earlier = (): void => undefined
  process.on('exit', earlier)
  try {
    const { exited } = spawnInGroup(...node(''), { ...base, stdio: ['ignore', 'ignore', 'ignore'] })
    const listeners = process.listeners('exit')
    assert.ok(listeners.indexOf(earlier) > 0, 'the hook of the group is registered ahead of it')
    await exited
  } finally {
    process.off('exit', earlier)
  }
})

test('if this process exits first, the group it started is killed', {
  timeout: 15_000,
}, async () => {
  // The parent starts a group, announces it and exits. The grandchild shares the parent's stdout,
  // so the pipe closes only when the grandchild is gone: no waiting on a clock.
  const parent = spawn(
    process.execPath,
    [
      '-e',
      `
      import(${JSON.stringify(SPAWN_IN_GROUP_URL)}).then(({ spawnInGroup }) => {
        spawnInGroup(process.execPath, ['-e', ${JSON.stringify(SPIN_FOREVER)}], {
          cwd: process.cwd(), env: process.env, stdio: ['ignore', 'inherit', 'inherit'],
        })
        console.log('READY')
        setImmediate(() => process.exit(0))
      })
    `,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  let started = ''
  parent.stdout?.on('data', (chunk: Buffer) => {
    started += chunk.toString('utf8')
  })
  await once(parent.stdout ?? parent, 'close')
  assert.match(started, /READY/)
})

for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
] as const) {
  test(`exitOnSignals turns ${signal} into a normal exit with code ${code}`, {
    timeout: 15_000,
  }, async () => {
    assert.equal(typeof exitOnSignals, 'function')
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
        import(${JSON.stringify(SPAWN_IN_GROUP_URL)}).then(({ exitOnSignals }) => {
          exitOnSignals()
          console.log('READY')
          ${SPIN_FOREVER}
        })
      `,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    await watch(child, 'READY').ready
    child.kill(signal)
    const [exitCode, killedBy] = await once(child, 'exit')
    assert.equal(exitCode, code)
    assert.equal(killedBy, null)
  })
}
