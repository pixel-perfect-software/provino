// `runCommand` against execa 5.1.1 itself (jest-changed-files' own copy, in-process, D27): the
// message of a command past `maxBuffer`, the code every failure carries, and a cancelled command
// that is killed and reaped.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { test } from 'provino'
import { CANCELLED, runCommand, SCM_COMMAND_FAILED } from './exec.ts'

type Execa = (
  file: string,
  args: readonly string[],
  options: { cwd: string; maxBuffer?: number },
) => Promise<{ stdout: string }>

const core = createRequire(fileURLToPath(import.meta.resolve('jest-cli'))).resolve('@jest/core')
const changedFiles = createRequire(core).resolve('jest-changed-files')
const execa = createRequire(changedFiles)('execa') as Execa

/** A command that writes far more than the limit, and would go on writing. */
const FLOOD = [
  '-c',
  'while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done',
]

test('a command past maxBuffer fails with execa’s message, and is killed', async () => {
  const cwd = tmpdir()
  const expected = await execa('sh', FLOOD, { cwd, maxBuffer: 1000 }).then(
    () => assert.fail('execa resolved'),
    (error: Error & { shortMessage: string }) => error.shortMessage,
  )
  const got = await runCommand('sh', FLOOD, { cwd, maxBuffer: 1000 }).then(
    () => assert.fail('runCommand resolved'),
    (error: Error & { code: string }) => error,
  )
  assert.equal(got.code, SCM_COMMAND_FAILED)
  // execa's message is the short message, then the streams it had buffered (how much depends on
  // the chunks), so the two are compared on the short message.
  assert.equal(expected, `Command failed: sh ${FLOOD.join(' ')}\nmaxBuffer exceeded`)
  assert.ok(got.message.startsWith(`${expected}\n`), got.message.slice(0, 200))
})

test('a failing exit and a command that cannot start carry the code too', async () => {
  const exit = await runCommand('sh', ['-c', 'echo nope >&2; exit 3'], { cwd: tmpdir() }).then(
    () => assert.fail('resolved'),
    (error: Error & { code: string }) => error,
  )
  assert.equal(exit.code, SCM_COMMAND_FAILED)
  assert.equal(exit.message, 'Command failed with exit code 3: sh -c echo nope >&2; exit 3\nnope')
  const missing = await runCommand('provino-no-such-command', [], { cwd: tmpdir() }).then(
    () => assert.fail('resolved'),
    (error: Error & { code: string }) => error,
  )
  assert.equal(missing.code, SCM_COMMAND_FAILED)
  assert.match(missing.message, /^Command failed with ENOENT: provino-no-such-command/)
})

test('an aborted command is killed and reaped before it resolves CANCELLED', async () => {
  const stop = new AbortController()
  let pid: number | undefined
  const run = runCommand('sh', ['-c', 'echo $$; exec sleep 30'], {
    cwd: tmpdir(),
    signal: stop.signal,
    firstChunk: (chunk) => {
      pid = Number(chunk.trim())
      stop.abort()
      return false
    },
  })
  assert.equal(await run, CANCELLED)
  assert.ok(pid !== undefined && pid > 0)
  assert.throws(() => process.kill(pid as number, 0), { code: 'ESRCH' })
})
