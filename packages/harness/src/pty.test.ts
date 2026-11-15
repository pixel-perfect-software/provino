import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { HarnessError } from './errors.ts'
import {
  exitCodeOf,
  groupExists,
  PTY_PYTHON,
  PTY_RELAY,
  type PtyProcess,
  spawnPiped,
  spawnPty,
} from './pty.ts'

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
    await pty.waitFor((output) => {
      const at = output.indexOf('READY')
      return at === -1 ? -1 : at + 'READY'.length
    })
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

test('the exit settles when the child ends while a grandchild still holds the terminal', {
  timeout: 20_000,
}, async () => {
  const pty = await start('holder')
  let holder = 0
  try {
    await pty.waitFor('READY')
    holder = Number(/HOLDER (\d+)/.exec(pty.output())?.[1])
    assert.ok(holder > 0)
    pty.write('q')
    // The master stays open (the grandchild has the terminal), so only waitpid can see this.
    assert.equal((await pty.exit).exitCode, 3)
  } finally {
    await finish(pty)
  }
  assert.equal(pidAlive(holder), false, 'the grandchild went with the child group')
})

test('a process a signal ended has 128 plus the signal as its exit code', () => {
  assert.equal(exitCodeOf({ exitCode: 3, signal: null }), 3)
  assert.equal(exitCodeOf({ exitCode: null, signal: 'SIGKILL' }), 137)
  assert.equal(exitCodeOf({ exitCode: null, signal: 'SIGTERM' }), 143)
  assert.equal(exitCodeOf({ exitCode: null, signal: null }), null)
})

test('a piped child gets no terminal, one stream for stdout and stderr, and its exit code', {
  timeout: 20_000,
}, async () => {
  const pty = await spawnPiped([process.execPath, CHILD], base)
  try {
    await pty.waitFor('READY tty=false')
    pty.write('q')
    const exit = await pty.exit
    assert.equal(exit.exitCode, 3)
    assert.match(pty.output(), /key:"q"/)
  } finally {
    await finish(pty)
  }
})

test('kill ends a piped child that ignores SIGTERM, and its grandchild', {
  timeout: 20_000,
}, async () => {
  const pty = await spawnPiped([process.execPath, CHILD, 'stubborn'], base)
  let grandchild = 0
  try {
    await pty.waitFor('READY')
    grandchild = Number(/GRANDCHILD (\d+)/.exec(pty.output())?.[1])
    assert.ok(grandchild > 0)
    assert.equal(pty.childPgid, pty.relayPgid, 'one group: there is no relay')
  } finally {
    await finish(pty)
  }
  assert.equal((await pty.exit).killed, true)
  assert.equal(pidAlive(grandchild), false, 'the grandchild is gone')
})

test('no python3 is HARNESS_PTY_UNAVAILABLE, not a skip', { timeout: 10_000 }, async () => {
  await assert.rejects(
    spawnPty([process.execPath, CHILD], { ...base, python: '/nonexistent/python3' }),
    (error: unknown) => error instanceof HarnessError && error.code === 'HARNESS_PTY_UNAVAILABLE',
  )
})

test('the relay\u2019s write helper reports a closed end instead of raising (no terminal needed)', () => {
  // The relay's `put`, cut out of its source and run on a pipe whose reader is gone: a write the
  // child's closed terminal or a gone harness would refuse (EPIPE here, EIO on a terminal).
  const start = PTY_RELAY.indexOf('def put(')
  const end = PTY_RELAY.indexOf('gone = False')
  assert.ok(start !== -1 && end > start, 'the relay has a put helper')
  const script = [
    'import os, signal',
    'signal.signal(signal.SIGPIPE, signal.SIG_IGN)',
    PTY_RELAY.slice(start, end),
    'r, w = os.pipe()',
    'assert put(w, b"x") is True',
    'os.close(r)',
    'assert put(w, b"x") is False',
    'print("ok")',
  ].join('\n')
  const result = spawnSync(PTY_PYTHON, ['-I', '-c', script], { encoding: 'utf8' })
  assert.equal(result.stdout.trim(), 'ok', result.stderr)
})
