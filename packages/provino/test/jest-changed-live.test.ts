// T9.16: what the `changed/*` recordings can't carry, held to a live Jest 30.5.2 on the same temp
// tree: a project's own `dependencyExtractor` that adds to the default extractor's Set under `-o`,
// and `--onlyFailures` under `--no-cache` (Jest reads no history then). Both runners get the same
// environment: no output variables, colour off, CI on, and the harness's hermetic git.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, it } from 'provino'
import { commitAll, gitEnv, initRepo } from './hermetic-git.ts'
import { JEST, noColorEnv } from './live-jest.ts'
import { outputFree, spawnCli, withoutNodeNoise } from './support.ts'

const made: string[] = []
afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true })
})

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'provino-changed-live-')))
  made.push(root)
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}

interface Ended {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

const envFor = (root: string): Record<string, string> => ({
  CI: '1',
  NO_COLOR: '1',
  ...gitEnv(dirname(root)),
})

/** Live Jest in `root`, with a deadline. */
function liveJest(root: string, args: readonly string[]): Promise<Ended> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [JEST, ...args], {
      cwd: root,
      env: { ...outputFree(noColorEnv()), ...envFor(root) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const deadline = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(deadline)
      resolve({ code, stdout, stderr })
    })
  })
}

async function provino(root: string, args: readonly string[]): Promise<Ended> {
  const ended = await spawnCli(['jest', ...args], { cwd: root, env: envFor(root) })
  return { code: ended.code, stdout: ended.stdout, stderr: withoutNodeNoise(ended.stderr) }
}

/** The lines both runners' texts are compared on: no blank lines, no durations. */
const lines = (text: string): string =>
  text
    .split('\n')
    .filter((line) => line.trim() !== '' && !/ExperimentalWarning|--trace-warnings/.test(line))
    .map((line) => line.replaceAll(/ \(\d+(?:\.\d+)? m?s\)/g, ''))
    .join('\n')

describe('provino jest against a live Jest 30.5.2', () => {
  it('a dependencyExtractor that adds to the default Set reaches its test under -o', async () => {
    const root = await tree({
      'jest.config.json': JSON.stringify({
        dependencyExtractor: '<rootDir>/extractor.js',
        cacheDirectory: '<rootDir>/.jest-cache',
      }),
      // jest-haste-map's documented pattern: the default extractor's result is a Set.
      'extractor.js':
        "module.exports = { extract(code, filePath, defaultExtract) { const deps = defaultExtract(code); if (filePath.endsWith('a.test.js')) deps.add('./src/extra.js'); return deps } }\n",
      'a.test.js': "test('a', () => { expect(1).toBe(1) })\n",
      'b.test.js': "require('./src/other.js')\ntest('b', () => { expect(1).toBe(1) })\n",
      'src/extra.js': 'module.exports = 1\n',
      'src/other.js': 'module.exports = 2\n',
    })
    await initRepo(root)
    commitAll(root, 'base')
    await writeFile(join(root, 'src/extra.js'), 'module.exports = 3\n')
    const listed = async (run: typeof liveJest, out: string): Promise<readonly string[]> => {
      const ended = await run(root, ['--ci', '--listTests', '-o', '--json', `--outputFile=${out}`])
      assert.equal(ended.code, 0, ended.stderr)
      return (JSON.parse(await readFile(join(root, out), 'utf8')) as string[]).toSorted()
    }
    const expected = await listed(liveJest, 'jest.json')
    assert.deepEqual(expected, [join(root, 'a.test.js')])
    assert.deepEqual(await listed(provino, 'provino.json'), expected)
  })

  it('--onlyFailures under --no-cache reads no history, as Jest does', async () => {
    const root = await tree({
      'jest.config.json': JSON.stringify({ cacheDirectory: '<rootDir>/.jest-cache' }),
      'pass.test.js': "test('p', () => { expect(1).toBe(1) })\n",
      'fail.test.js': "test('f', () => { expect(1).toBe(2) })\n",
    })
    for (const run of [liveJest, provino]) {
      const first = await run(root, ['--ci'])
      assert.equal(first.code, 1, first.stderr)
    }
    // jest-test-sequencer reads its cache only when `config.cache` is on (L69): no failed file.
    const expected = await liveJest(root, ['--ci', '-f', '--no-cache'])
    const got = await provino(root, ['--ci', '-f', '--no-cache'])
    assert.equal(got.code, expected.code, got.stderr)
    assert.equal(lines(got.stdout), lines(expected.stdout))
    assert.equal(lines(got.stderr), lines(expected.stderr))
    assert.equal(lines(expected.stdout), 'No failed test found.')
  })
})

describe('provino jest selects once', () => {
  it('-o reads each file once for the message, the reporters and the run', async () => {
    const root = await tree({
      'jest.config.json': JSON.stringify({ dependencyExtractor: '<rootDir>/extractor.js' }),
      // Logs every file it reads: under --no-cache the edge cache can't hide a second selection.
      'extractor.js':
        "const fs = require('node:fs')\nmodule.exports = { extract(code, filePath, defaultExtract) { fs.appendFileSync(process.env.PROVINO_EXTRACT_LOG, filePath + '\\n'); return defaultExtract(code) } }\n",
      'a.test.js': "require('./src/a.js')\ntest('a', () => { expect(1).toBe(1) })\n",
      'b.test.js': "test('b', () => { expect(1).toBe(1) })\n",
      'src/a.js': 'module.exports = 1\n',
    })
    await initRepo(root)
    commitAll(root, 'base')
    await writeFile(join(root, 'src/a.js'), 'module.exports = 2\n')
    const log = join(root, 'extract.log')
    const ended = await spawnCli(['jest', '--ci', '-o', '--no-cache'], {
      cwd: root,
      env: { ...envFor(root), PROVINO_EXTRACT_LOG: log },
    })
    assert.equal(ended.code, 0, ended.stderr)
    assert.match(ended.stderr, /^PASS \.\/a\.test\.js/m)
    assert.doesNotMatch(ended.stderr, /b\.test\.js/)
    const reads = (await readFile(log, 'utf8')).split('\n').filter((line) => line !== '')
    assert.ok(reads.length > 0)
    assert.deepEqual(reads, [...new Set(reads)], `a file was read twice:\n${reads.join('\n')}`)
  })
})
