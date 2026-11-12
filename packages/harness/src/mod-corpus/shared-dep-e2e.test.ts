// T2.6's next-file case through a worker (B13d Q2, D53): two test files in one forked worker, the
// first mocking a package that another package requires, the second not. Both runners give the
// second file the real module, so no policy value rests on it and no golden holds it (the fixture
// format traces one file); this is Provino's own check. Each file runs first in one of the two
// runs, so neither order is left to chance.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { test } from 'node:test'
import { run } from 'provino/node'

const PACKAGES: Readonly<Record<string, string>> = {
  'node_modules/pkg-b/package.json':
    '{ "name": "pkg-b", "version": "1.0.0", "main": "index.js" }\n',
  'node_modules/pkg-b/index.js': "exports.who = 'real-b'\n",
  'node_modules/pkg-a/package.json':
    '{ "name": "pkg-a", "version": "1.0.0", "main": "index.js" }\n',
  'node_modules/pkg-a/index.js': "exports.bWho = require('pkg-b').who\n",
  'node_modules/pkg-c/package.json':
    '{ "name": "pkg-c", "version": "1.0.0", "main": "index.js" }\n',
  'node_modules/pkg-c/index.js': "exports.aSeesB = require('pkg-a').bWho\n",
}

const MOCKING = `
jest.mock('pkg-b', () => ({ who: 'mock-b' }))
test('the mocked package reaches the packages that require it', () => {
  expect(require('pkg-a').bWho).toBe('mock-b')
  expect(require('pkg-c').aSeesB).toBe('mock-b')
})
`

const PLAIN = `
test('the next file sees the real package', () => {
  expect(require('pkg-a').bWho).toBe('real-b')
  expect(require('pkg-c').aSeesB).toBe('real-b')
})
`

function sink(): Writable {
  return new Writable({
    write(_chunk: unknown, _encoding, done) {
      done()
    },
  })
}

/** `padded` names the file made the larger one: the sequencer may run large files first, so size and name are varied apart. */
async function runTwoFiles(mockingFirst: boolean, padded: 'mocking' | 'plain'): Promise<void> {
  const pad = `// ${'x'.repeat(2000)}\n`
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'provino-shared-dep-')))
  try {
    const files: Record<string, string> = {
      ...PACKAGES,
      'a.test.js':
        (mockingFirst ? MOCKING : PLAIN) +
        ((mockingFirst ? 'mocking' : 'plain') === padded ? pad : ''),
      'b.test.js':
        (mockingFirst ? PLAIN : MOCKING) +
        ((mockingFirst ? 'plain' : 'mocking') === padded ? pad : ''),
      'provino.config.mjs': `export default ${JSON.stringify({ dialect: 'jest', include: ['*.test.js'] })}\n`,
    }
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await writeFile(path.join(root, file), text)
    }
    const stderr: string[] = []
    const { exitCode } = await run({
      config: path.join(root, 'provino.config.mjs'),
      cwd: root,
      pool: 'forks',
      maxWorkers: 1,
      cache: false,
      ci: true,
      reporters: ['default'],
      stdout: sink(),
      stderr: new Writable({
        write(chunk: unknown, _encoding, done) {
          stderr.push(String(chunk))
          done()
        },
      }),
      signal: AbortSignal.timeout(60_000),
    })
    assert.equal(exitCode, 0, stderr.join(''))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

for (const mockingFirst of [true, false]) {
  for (const padded of ['mocking', 'plain'] as const) {
    test(`one worker: the mocking file sees the mock through pkg-a, the other file the real one (mocking ${mockingFirst ? 'first' : 'second'} by name, ${padded} file larger)`, {
      timeout: 90_000,
    }, async () => {
      await runTwoFiles(mockingFirst, padded)
    })
  }
}
