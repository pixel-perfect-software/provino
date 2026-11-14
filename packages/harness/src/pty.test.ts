import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HarnessError } from './errors.ts'
import { groupExists, type PtyProcess, spawnPty } from './pty.ts'

const CHILD = new URL('./internal/pty-echo-child.ts', import.meta.url).pathname
const base = { cwd: process.cwd(), env: process.env }

async function start(...args: string[]): Promise<PtyProcess> {
  return spawnPty([process.execPath, CHILD, ...args], base)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Kills both groups and asserts neither has a member left (the processes rule). */
async function finish(pty: PtyProcess): Promise<void> {
  await pty.kill()
  assert.equal(groupExists(pty.childPgid), false, 'the terminal child group is gone')
  assert.equal(groupExists(pty.relayPgid), false, 'the relay group is gone')
}

test('a key typed at the terminal is echoed by the child, which sees a 40x120 terminal', {
  timeout: 20_000,
}, async () => {
  const pty = await start()
  try {
    const mark = await pty.waitFor('READY')
    assert.match(pty.output(), /READY tty=true size=120x40/)
    pty.write('p')
    await pty.waitFor('key:"p"', mark)
    assert.ok(pty.childPgid > 0)
    assert.notEqual(pty.childPgid, pty.relayPgid, 'the child leads a session of its own')
  } finally {
    await finish(pty)
  }
})

test('the exit code is the child, and waitFor rejects once the child has ended', {
  timeout: 20_000,
}, async () => {
  const pty = await start()
  try {
    await pty.waitFor((output) => output.includes('READY'))
    pty.write('q')
    const exit = await pty.exit
    assert.equal(exit.exitCode, 3)
    assert.equal(exit.killed, false)
    await assert.rejects(
      pty.waitFor('never printed'),
      (error: unknown) => error instanceof HarnessError && error.code === 'HARNESS_WATCH_FAILED',
    )
  } finally {
    await finish(pty)
  }
})

test('Ctrl-C arrives as a key, and a clean exit is code 0', { timeout: 20_000 }, async () => {
  const pty = await start()
  try {
    await pty.waitFor('READY')
    pty.write('\u0003')
    assert.equal((await pty.exit).exitCode, 0)
  } finally {
    await finish(pty)
  }
})

test('kill ends a child that ignores SIGTERM and its grandchild, both groups probed', {
  timeout: 20_000,
}, async () => {
  const pty = await start('stubborn')
  let grandchild = 0
  try {
    await pty.waitFor('READY')
    grandchild = Number(/GRANDCHILD (\d+)/.exec(pty.output())?.[1])
    assert.ok(grandchild > 0)
    assert.equal(groupExists(pty.childPgid), true)
  } finally {
    await finish(pty)
  }
  assert.equal(pidAlive(grandchild), false, 'the grandchild is gone')
})

test('an abort of the deadline ends both groups and a pending waitFor rejects', {
  timeout: 20_000,
}, async () => {
  const controller = new AbortController()
  const pty = await spawnPty([process.execPath, CHILD], { ...base, deadline: controller.signal })
  try {
    await pty.waitFor('READY')
    const waiting = pty.waitFor('never printed')
    controller.abort()
    await assert.rejects(waiting, HarnessError)
    assert.equal((await pty.exit).killed, true)
  } finally {
    await finish(pty)
  }
})

test('no python3 is HARNESS_PTY_UNAVAILABLE, not a skip', { timeout: 10_000 }, async () => {
  await assert.rejects(
    spawnPty([process.execPath, CHILD], { ...base, python: '/nonexistent/python3' }),
    (error: unknown) => error instanceof HarnessError && error.code === 'HARNESS_PTY_UNAVAILABLE',
  )
})
