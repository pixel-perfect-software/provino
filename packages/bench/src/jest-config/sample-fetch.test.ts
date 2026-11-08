// The fetch step's two failure modes: a consumer that exits before the producer is done (`tar`
// failing on a bad tarball while `curl` still writes) is one failed repository, not an EPIPE that
// crashes the run, and both exit codes are read after both processes have ended; and a directory
// holding another commit's tree is emptied before the new tarball goes in, so files the new commit
// deleted don't survive. No network: the commands are small Node programs.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pipeProcesses, prepareRepoDir } from './sample-fetch.ts'

const dir = mkdtempSync(join(tmpdir(), 'provino-sample-fetch-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const node = (script: string) => ({ command: process.execPath, args: ['-e', script] })

/** Writes 64 MiB to stdout, far more than a pipe holds, then exits 0. */
const FLOOD = node(
  "const chunk = Buffer.alloc(1 << 20); let left = 64; const go = () => { while (left > 0) { left--; if (!process.stdout.write(chunk)) return process.stdout.once('drain', go) } }; go()",
)

test('a consumer that exits early is a failure, not an EPIPE crash', async () => {
  const outcome = await pipeProcesses(FLOOD, node('process.exit(3)'))
  assert.equal(outcome.consumer, 3)
  // The producer was cut off: a signal, or a non-zero exit from writing to a closed pipe.
  assert.notEqual(outcome.producer, 0)
})

test('both exit codes are read after both processes end', async () => {
  // Explicit signals, not a timer: the consumer writes its pid to a flag file at end of input and
  // exits; the producer, its output already ended, exits only once that pid is gone. So the
  // producer ends after the consumer, by itself (it isn't stopped: its output had ended).
  const flag = join(dir, 'consumer-pid')
  const outcome = await pipeProcesses(
    node(
      `const fs = require('node:fs'); process.stdout.end('x'); const gone = (pid) => { try { process.kill(pid, 0); return false } catch { return true } }; const wait = () => { const text = fs.existsSync(${JSON.stringify(flag)}) ? fs.readFileSync(${JSON.stringify(flag)}, 'utf8') : ''; if (text !== '' && gone(Number(text))) process.exit(5); else setImmediate(wait) }; wait()`,
    ),
    node(
      `process.stdin.resume(); process.stdin.on('end', () => { require('node:fs').writeFileSync(${JSON.stringify(flag)}, String(process.pid)); process.exit(0) })`,
    ),
  )
  assert.deepEqual([outcome.producer, outcome.consumer], [5, 0])
})

test('a successful pipe reports 0 and 0', async () => {
  const outcome = await pipeProcesses(
    node("process.stdout.write('hello')"),
    node(
      "let s = ''; process.stdin.on('data', (c) => { s += c }); process.stdin.on('end', () => process.exit(s === 'hello' ? 0 : 9))",
    ),
  )
  assert.deepEqual([outcome.producer, outcome.consumer], [0, 0])
})

test("another commit's tree is removed before the new one goes in", () => {
  const dest = join(dir, 'repo')
  mkdirSync(join(dest, 'src'), { recursive: true })
  writeFileSync(join(dest, '.provino-fetched'), 'old-sha\n')
  writeFileSync(join(dest, 'src', 'deleted-in-new.js'), '')
  assert.equal(prepareRepoDir(dest, 'new-sha'), 'fetch')
  assert.equal(existsSync(join(dest, 'src', 'deleted-in-new.js')), false)
  assert.equal(existsSync(dest), true)
})

test('a tree of this commit is kept as it is', () => {
  const dest = join(dir, 'same')
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, '.provino-fetched'), 'sha\n')
  writeFileSync(join(dest, 'kept.js'), 'x')
  assert.equal(prepareRepoDir(dest, 'sha'), 'fetched')
  assert.equal(readFileSync(join(dest, 'kept.js'), 'utf8'), 'x')
})
