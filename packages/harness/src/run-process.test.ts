import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type ProcessOptions, runProcess } from './run-process.ts'

// The children are inline scripts run by this same Node. They print READY once they are set up,
// and the tests abort the deadline on that signal, so nothing here depends on how fast a machine
// starts a process.

// Alive until killed, but a stray one (a failing test) ends itself after 20 s.
const SPIN_FOREVER = 'setInterval(() => {}, 1000); setTimeout(() => process.exit(9), 20000)'

/** A child and a grandchild in its process group; each prints a line when it is sent SIGTERM. */
const GROUP = `
const { spawn } = require('node:child_process')
process.on('SIGTERM', () => { console.log('CHILD-TERM'); process.exit(0) })
const grand = spawn(process.execPath, ['-e', ${JSON.stringify(
  `process.on('SIGTERM', () => { console.log('GRAND-TERM'); process.exit(0) }); console.log('GRAND-UP'); ${SPIN_FOREVER}`,
)}], { stdio: ['ignore', 'inherit', 'inherit'] })
console.log('READY ' + process.pid + ' ' + grand.pid)
${SPIN_FOREVER}
`

function abortOn(marker: string): { signal: AbortSignal; onOutput: (chunk: string) => void } {
  const controller = new AbortController()
  let seen = ''
  return {
    signal: controller.signal,
    onOutput: (chunk) => {
      seen += chunk
      if (seen.includes(marker)) controller.abort()
    },
  }
}

const baseOptions = { cwd: process.cwd(), env: process.env }

/** `node <args>`: the children here are inline scripts run by this same Node. */
const runNode = (args: readonly string[], options: ProcessOptions) =>
  runProcess(process.execPath, args, options)

test('a process that exits on its own reports its exit code and output', {
  timeout: 15_000,
}, async () => {
  const result = await runNode(
    ['-e', "console.log('out'); console.error('err'); process.exit(3)"],
    {
      ...baseOptions,
      deadline: new AbortController().signal,
    },
  )
  assert.equal(result.exitCode, 3)
  assert.equal(result.timedOut, false)
  assert.equal(result.signal, null)
  assert.match(result.output, /out/)
  assert.match(result.output, /err/)
})

test('the deadline terminates the whole process group, not only the child', {
  timeout: 15_000,
}, async () => {
  const { signal, onOutput } = abortOn('GRAND-UP')
  const result = await runNode(['-e', GROUP], {
    ...baseOptions,
    deadline: signal,
    onOutput,
    stdioGraceMs: 60_000,
  })
  assert.equal(result.timedOut, true)
  assert.match(result.output, /CHILD-TERM/)
  assert.match(result.output, /GRAND-TERM/, 'the grandchild in the group was signalled too')
})

test('a child that ignores SIGTERM is killed after the grace period', {
  timeout: 15_000,
}, async () => {
  const { signal, onOutput } = abortOn('READY')
  const result = await runNode(
    [
      '-e',
      `process.on('SIGTERM', () => console.log('IGNORED')); console.log('READY'); ${SPIN_FOREVER}`,
    ],
    { ...baseOptions, deadline: signal, onOutput, killGraceMs: 20 },
  )
  assert.equal(result.timedOut, true)
  assert.equal(result.signal, 'SIGKILL')
  assert.match(result.output, /IGNORED/)
})

test('a deadline that is already past still ends the run', { timeout: 15_000 }, async () => {
  const result = await runNode(['-e', SPIN_FOREVER], {
    ...baseOptions,
    deadline: AbortSignal.abort(),
    killGraceMs: 20,
  })
  assert.equal(result.timedOut, true)
})

test('a detached grandchild that keeps the output pipes open does not hold the run', {
  timeout: 15_000,
}, async () => {
  const script = `
    const { spawn } = require('node:child_process')
    const grand = spawn(process.execPath, ['-e', ${JSON.stringify(SPIN_FOREVER)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })
    grand.unref()
    console.log('GRANDCHILD ' + grand.pid)
  `
  let seen = ''
  try {
    const result = await runNode(['-e', script], {
      ...baseOptions,
      deadline: new AbortController().signal,
      stdioGraceMs: 50,
      onOutput: (chunk) => {
        seen += chunk
      },
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.timedOut, false)
  } finally {
    // Read from the live output, so the grandchild is ended even if the run never settled.
    const pid = /GRANDCHILD (\d+)/.exec(seen)?.[1]
    if (pid !== undefined) process.kill(Number(pid), 'SIGKILL')
  }
})

test('a timed-out run does not wait for a detached grandchild that holds the pipes', {
  timeout: 15_000,
}, async () => {
  const script = `
    const { spawn } = require('node:child_process')
    const grand = spawn(process.execPath, ['-e', ${JSON.stringify(SPIN_FOREVER)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })
    grand.unref()
    console.log('GRANDCHILD ' + grand.pid)
    ${SPIN_FOREVER}
  `
  const controller = new AbortController()
  let seen = ''
  try {
    const result = await runNode(['-e', script], {
      ...baseOptions,
      deadline: controller.signal,
      stdioGraceMs: 50,
      onOutput: (chunk) => {
        seen += chunk
        if (seen.includes('GRANDCHILD')) controller.abort()
      },
    })
    assert.equal(result.timedOut, true)
    assert.equal(result.signal, 'SIGTERM')
  } finally {
    const pid = /GRANDCHILD (\d+)/.exec(seen)?.[1]
    if (pid !== undefined) process.kill(Number(pid), 'SIGKILL')
  }
})

test('the output tail keeps the end of long output', { timeout: 15_000 }, async () => {
  const result = await runNode(['-e', "process.stdout.write('x'.repeat(10000) + 'END')"], {
    ...baseOptions,
    deadline: new AbortController().signal,
  })
  assert.equal(result.output.length, 4_000)
  assert.ok(result.output.endsWith('END'))
})

test('keepStreams keeps all of stdout and all of stderr, each on its own', {
  timeout: 15_000,
}, async () => {
  const script = "process.stdout.write('o'.repeat(5000) + 'OUT'); process.stderr.write('ERR')"
  const kept = await runNode(['-e', script], {
    ...baseOptions,
    deadline: new AbortController().signal,
    keepStreams: true,
  })
  assert.equal(kept.streams?.stdout, `${'o'.repeat(5000)}OUT`)
  assert.equal(kept.streams?.stderr, 'ERR')
  const plain = await runNode(['-e', script], {
    ...baseOptions,
    deadline: new AbortController().signal,
  })
  assert.equal('streams' in plain, false)
})
