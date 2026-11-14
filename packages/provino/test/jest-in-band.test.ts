// T9.9 (B23d, A3): `provino jest` runs in band as Jest does. `-i` and Jest's own rule (`shouldRunInBand`:
// one file, one worker, or a few files that were fast last time, and no `workerIdleMemoryLimit`)
// put the files in the bin's own process; a test there still has its console buffered per file and
// printed under the file's header, and sees a global the global setup set (`cli/global-setup-globals-*`,
// in `global-setup.test.ts`). The text is held to the lines Jest 30.5.2 kept for the same projects.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { JEST, noColorEnv, provinoRun } from './live-jest.ts'
import { loadFixture, materialize, underRoot } from './recorded.ts'
import { startCli } from './support.ts'

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** The lines of `text` the recording kept (its `keepLines`), with each timing taken out. */
function kept(text: string, keepLines: string): string[] {
  const keep = new RegExp(keepLines)
  return text
    .split('\n')
    .filter((line) => keep.test(line))
    .map((line) => line.replace(/ \((?:<dur>|\d+(?:\.\d+)? ms)\)$/, ''))
}

describe('-i prints what Jest 30.5.2 printed for the same project', () => {
  for (const [id, extra] of [
    ['cli/run-in-band-console', []],
    ['cli/report-default', ['-i']],
    ['cli/report-verbose', ['-i']],
  ] as const) {
    it(`${id}: the kept lines and the exit code are Jest's`, async () => {
      const fixture = await loadFixture(id)
      const project = await materialize(fixture)
      try {
        const { keepLines } = fixture.manifest.run ?? { keepLines: undefined }
        assert.ok(keepLines !== undefined, `${id} keeps lines`)
        const argv = fixture.manifest.run?.argv?.jest ?? []
        const ended = await startCli(
          [
            'jest',
            `--config=${join(project.root, 'jest.config.json')}`,
            '--ci',
            ...argv,
            ...extra.filter((flag) => !argv.includes(flag)),
          ],
          { cwd: project.root },
        ).result()
        assert.equal(ended.code, fixture.golden.observed?.exitCode, ended.stderr)
        assert.deepEqual(
          kept(underRoot(ended.stderr, project.root), keepLines),
          kept(fixture.golden.observed?.stderr ?? '', keepLines),
        )
      } finally {
        await project.dispose()
      }
    })
  }
})

/** A project of `files` test files that each note their process id in `pids.txt`. */
async function noting(
  files: number,
  config: Readonly<Record<string, unknown>> = {},
  /** What each file notes: its process id, or (`thread`) also whether it runs on the main thread. */
  what: 'pid' | 'thread' = 'pid',
): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'provino-in-band-')))
  made.push(root)
  await writeFile(join(root, 'package.json'), '{"type":"commonjs"}\n')
  await writeFile(
    join(root, 'jest.config.json'),
    JSON.stringify({ rootDir: root, testMatch: ['<rootDir>/tests/*.test.js'], ...config }),
  )
  await mkdir(join(root, 'tests'))
  for (let index = 0; index < files; index++) {
    await writeFile(
      join(root, 'tests', `f${index}.test.js`),
      `test('notes its process', () => {\n  require('node:fs').appendFileSync(${JSON.stringify(join(root, 'pids.txt'))}, process.pid + ${what === 'thread' ? "(require('node:worker_threads').isMainThread ? '' : ':thread') + " : ''}'\\n')\n})\n`,
    )
  }
  return root
}

/** Runs the bin on `root`; whether every file ran in the bin's own process. */
async function ranInBand(root: string, flags: readonly string[]): Promise<boolean> {
  const live = startCli(['jest', `--config=${join(root, 'jest.config.json')}`, ...flags], {
    cwd: root,
  })
  const ended = await live.result()
  assert.equal(ended.code, 0, ended.stderr)
  const pids = (await readFile(join(root, 'pids.txt'), 'utf8')).trim().split('\n')
  const own = String(live.child.pid)
  assert.ok(
    pids.every((pid) => pid === own) || pids.every((pid) => pid !== own),
    `a run is in band or it is not: ${pids.join(' ')} (the bin is ${own})`,
  )
  return pids.every((pid) => pid === own)
}

/** Runs real Jest 30.5.2 on `root`; whether every file ran in Jest's own process. */
async function jestRanInBand(root: string, flags: readonly string[]): Promise<boolean> {
  const child = spawn(
    process.execPath,
    [JEST, `--config=${join(root, 'jest.config.json')}`, ...flags],
    { cwd: root, env: noColorEnv(), stdio: 'ignore' },
  )
  const [code] = await once(child, 'close')
  assert.equal(code, 0)
  const pids = (await readFile(join(root, 'pids.txt'), 'utf8')).trim().split('\n')
  await rm(join(root, 'pids.txt'))
  return pids.every((pid) => pid === String(child.pid))
}

describe('which runs go in band (Jest `shouldRunInBand`, the policy `orchestrator.inBand`)', () => {
  it('--workerThreads leaves a single file in band, as live Jest does (shouldRunInBand never reads it)', async () => {
    // A worker thread has the bin's pid: the file also notes whether it is on the main thread.
    const root = await noting(1, {}, 'thread')
    const flags = ['--workerThreads', '-w', '2']
    assert.equal(await jestRanInBand(root, flags), true, 'Jest runs it in band')
    assert.equal(await ranInBand(root, flags), true)
  })

  it('-i runs every file in the bin', async () => {
    assert.equal(await ranInBand(await noting(3), ['-i']), true)
  })

  it('a single file runs in band whatever -w says', async () => {
    assert.equal(await ranInBand(await noting(1), ['-w', '2']), true)
  })

  it('one worker runs in band', async () => {
    assert.equal(await ranInBand(await noting(3), ['-w', '1']), true)
  })

  it('several files and several workers run in workers on a first run (no time is known)', async () => {
    assert.equal(await ranInBand(await noting(3), ['-w', '2']), false)
  })

  it('a few fast files run in band on the next run, once the results cache has a time for them', async () => {
    const root = await noting(3)
    assert.equal(await ranInBand(root, ['-w', '2']), false)
    await rm(join(root, 'pids.txt'))
    assert.equal(await ranInBand(root, ['-w', '2']), true)
  })

  it('--no-cache keeps the next run out of band: there is no time to read', async () => {
    const root = await noting(3)
    assert.equal(await ranInBand(root, ['-w', '2', '--no-cache']), false)
    await rm(join(root, 'pids.txt'))
    assert.equal(await ranInBand(root, ['-w', '2', '--no-cache']), false)
  })

  it('a workerIdleMemoryLimit keeps even a single file in a worker', async () => {
    const root = await noting(1, { workerIdleMemoryLimit: 1_000_000_000 })
    assert.equal(await ranInBand(root, ['-w', '2']), false)
  })
})

describe('the live parity suites run in the mode Jest runs them in', () => {
  it('provinoRun runs a single-file project in band, in this process, as Jest runs it in its own', async () => {
    const root = await noting(1)
    const ended = await provinoRun(root)
    assert.equal(ended.code, 0, ended.stderr)
    const pids = (await readFile(join(root, 'pids.txt'), 'utf8')).trim().split('\n')
    assert.deepEqual(pids, [String(process.pid)])
  })
})

describe('a reporter that logs in band', () => {
  it('a custom reporter’s console.log in onTestResult under -i is printed on stdout, as live Jest prints it', async () => {
    const root = await noting(2)
    await writeFile(
      join(root, 'reporter.js'),
      "module.exports = class {\n  onTestResult(_test, result) {\n    console.log('reporter heard ' + require('node:path').basename(result.testFilePath))\n  }\n}\n",
    )
    const config = JSON.parse(await readFile(join(root, 'jest.config.json'), 'utf8')) as object
    await writeFile(
      join(root, 'jest.config.json'),
      JSON.stringify({ ...config, reporters: ['default', '<rootDir>/reporter.js'] }),
    )
    // The order of the two files is the sequencer's, not what is held here.
    const heard = (stdout: string): string[] =>
      stdout
        .split('\n')
        .filter((line) => line.startsWith('reporter heard'))
        .sort()
    const jest = spawn(process.execPath, [JEST, '-c', 'jest.config.json', '-i'], {
      cwd: root,
      env: noColorEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let jestOut = ''
    jest.stdout.on('data', (chunk: Buffer) => {
      jestOut += chunk.toString()
    })
    const [jestCode] = await once(jest, 'close')
    assert.equal(jestCode, 0)
    assert.deepEqual(heard(jestOut), ['reporter heard f0.test.js', 'reporter heard f1.test.js'])
    const ended = await startCli(['jest', '-c', 'jest.config.json', '-i'], { cwd: root }).result()
    assert.equal(ended.code, 0, ended.stderr)
    assert.deepEqual(heard(ended.stdout), heard(jestOut))
  })
})

describe('showStatus is the run’s own in-band decision', () => {
  it('a reporter hears showStatus false on the run that goes in band by its fast files, as live Jest’s does', async () => {
    const root = await noting(3)
    await writeFile(
      join(root, 'reporter.js'),
      `module.exports = class {\n  onRunStart(_results, options) {\n    require('node:fs').appendFileSync(${JSON.stringify(join(root, 'status.txt'))}, String(options.showStatus) + '\\n')\n  }\n}\n`,
    )
    const config = JSON.parse(await readFile(join(root, 'jest.config.json'), 'utf8')) as object
    await writeFile(
      join(root, 'jest.config.json'),
      JSON.stringify({ ...config, reporters: ['default', '<rootDir>/reporter.js'] }),
    )
    const statuses = async (): Promise<string[]> => {
      const text = await readFile(join(root, 'status.txt'), 'utf8')
      await rm(join(root, 'status.txt'))
      return text.trim().split('\n')
    }
    // Two runs each: the first has no timings and runs in workers, the second finds every file fast.
    const flags = ['-w', '2']
    assert.equal(await jestRanInBand(root, flags), false)
    assert.equal(await jestRanInBand(root, flags), true)
    const jest = await statuses()
    assert.deepEqual(jest, ['true', 'false'])
    assert.equal(await ranInBand(root, flags), false)
    await rm(join(root, 'pids.txt'))
    assert.equal(await ranInBand(root, flags), true)
    await rm(join(root, 'pids.txt'))
    assert.deepEqual(await statuses(), jest)
  })
})
