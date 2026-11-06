import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ignoreBrokenPipe } from './broken-pipe.ts'

const MODULE_URL = pathToFileURL(fileURLToPath(new URL('./broken-pipe.ts', import.meta.url))).href

// A child whose stdout reader is destroyed before it writes (it waits for its stdin to end, which
// the parent does after destroying the pipe), then writes many lines. Resolves to the exit code.
function writeToClosedPipe(guarded: boolean): Promise<{ code: number | null; stderr: string }> {
  const guard = guarded
    ? `const { ignoreBrokenPipe } = await import(${JSON.stringify(MODULE_URL)}); ignoreBrokenPipe(process.stdout)`
    : ''
  const script = `
    ${guard}
    process.stdin.resume()
    process.stdin.on('end', () => {
      for (let i = 0; i < 2000; i++) process.stdout.write('line ' + i + '\\n')
    })
  `
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stderr }))
    child.stdout.destroy()
    child.stdin.end()
  })
}

test('a stream guarded with ignoreBrokenPipe survives a reader that closed', async () => {
  const guarded = await writeToClosedPipe(true)
  assert.equal(guarded.code, 0, guarded.stderr)
})

test('without the guard the same writes kill the process with EPIPE', async () => {
  const bare = await writeToClosedPipe(false)
  assert.notEqual(bare.code, 0)
  assert.match(bare.stderr, /EPIPE/)
})

test('ignoreBrokenPipe swallows EPIPE but not any other error', () => {
  const stream = new PassThrough()
  ignoreBrokenPipe(stream)
  stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
  const other = Object.assign(new Error('no space'), { code: 'ENOSPC' })
  assert.throws(() => stream.emit('error', other), /no space/)
  assert.throws(() => stream.emit('error', new Error('plain')), /plain/)
})
