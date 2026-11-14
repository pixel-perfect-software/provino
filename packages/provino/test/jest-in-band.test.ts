// T9.9 (B23d, A3): `provino jest` runs in band as Jest does. `-i` and Jest's own rule (`shouldRunInBand`:
// one file, one worker, or a few files that were fast last time, and no `workerIdleMemoryLimit`)
// put the files in the bin's own process; a test there still has its console buffered per file and
// printed under the file's header, and sees a global the global setup set (`cli/global-setup-globals-*`,
// in `global-setup.test.ts`). The text is held to the lines Jest 30.5.2 kept for the same projects.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
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
      `test('notes its process', () => {\n  require('node:fs').appendFileSync(${JSON.stringify(join(root, 'pids.txt'))}, process.pid + '\\n')\n})\n`,
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

describe('which runs go in band (Jest `shouldRunInBand`, the policy `orchestrator.inBand`)', () => {
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
