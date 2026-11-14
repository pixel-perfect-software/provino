// T9.9 (B23d, A3): a run goes in band when asked (`runInBand`), when the policy's `orchestrator.inBand`
// says so for the files that are left after the filters (`fileFilter` included), and never when a
// memory limit asks for workers. In band is the inline pool: the files run in this process, and a
// test's `console` still reaches the reporters as events. `inBand` is Jest's numbers here, a policy
// value; the neutral policy has none (`single: false`, `fastFileCount: 0`).
import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import type { ResolvedProject } from '@provino/config'
import { createResultsCache, type RunProjectOptions, runProjects } from '@provino/orchestrator'
import { createReporterBus } from '@provino/reporters'
import type { ConsoleEntry, PolicyOverrides, Reporter } from '@provino/types'
import { Collect, runtimeProject, trackedProjects } from './support.ts'

const makeProject = trackedProjects()

const JEST_NUMBERS: NonNullable<PolicyOverrides['orchestrator']> = {
  inBand: { single: true, fastFileCount: 20, slowMs: 1000 },
}

/** A test file that notes its process id in `pids.txt` next to it. */
const noting = (dir: string): string =>
  `require('node:fs').appendFileSync(${JSON.stringify(`${dir}/pids.txt`)}, process.pid + '\\n')\ntest('notes', () => {})\n`

async function pidsOf(dir: string): Promise<string[]> {
  const text = await readFile(`${dir}/pids.txt`, 'utf8').catch(() => '')
  await rm(`${dir}/pids.txt`, { force: true })
  return text.split('\n').filter(Boolean)
}

const inBand = (pids: readonly string[]): boolean =>
  pids.every((pid) => pid === String(process.pid))

async function run(
  project: ResolvedProject,
  options: Partial<RunProjectOptions> = {},
  reporter?: Reporter,
): Promise<void> {
  await runProjects([project], {
    bus: createReporterBus(reporter === undefined ? [] : [reporter]),
    stderr: new Collect(),
    cache: false,
    ...options,
  })
}

describe('which runs go in band', () => {
  it('runInBand puts every file in this process, under a policy that has no numbers', async () => {
    const p = await makeProject({ 'a.test.js': '', 'b.test.js': '' })
    for (const name of ['a.test.js', 'b.test.js']) {
      await writeFile(p.path(name), noting(p.dir))
    }
    await run(runtimeProject(p.dir), { runInBand: true, pool: { kind: 'forks', maxWorkers: 2 } })
    const pids = await pidsOf(p.dir)
    assert.equal(pids.length, 2)
    assert.ok(inBand(pids), pids.join(' '))
  })

  it('the neutral policy keeps a single file in a worker', async () => {
    const p = await makeProject({ 'a.test.js': '' })
    await writeFile(p.path('a.test.js'), noting(p.dir))
    await run(runtimeProject(p.dir), { pool: { maxWorkers: 2 } })
    const pids = await pidsOf(p.dir)
    assert.equal(pids.length, 1)
    assert.ok(!inBand(pids), pids.join(' '))
  })

  it('Jest’s numbers: a single file goes in band, two files and two workers do not', async () => {
    const p = await makeProject({ 'a.test.js': '', 'b.test.js': '' })
    for (const name of ['a.test.js', 'b.test.js']) await writeFile(p.path(name), noting(p.dir))
    const project = runtimeProject(p.dir, { policy: { orchestrator: JEST_NUMBERS } })
    await run(project, { pool: { maxWorkers: 2 } })
    assert.ok(!inBand(await pidsOf(p.dir)), 'two files, two workers')
    await run(project, { pool: { maxWorkers: 1 } })
    assert.ok(inBand(await pidsOf(p.dir)), 'one worker')
  })

  it('is decided on what is left after the filters: a file filter that leaves one file puts the run in band', async () => {
    const p = await makeProject({ 'a.test.js': '', 'b.test.js': '' })
    for (const name of ['a.test.js', 'b.test.js']) await writeFile(p.path(name), noting(p.dir))
    const project = runtimeProject(p.dir, { policy: { orchestrator: JEST_NUMBERS } })
    const seen: string[][] = []
    await run(project, {
      pool: { maxWorkers: 2 },
      fileFilter: (_project, files) => {
        seen.push(files.map((file) => file.relativePath).sort())
        return files.filter((file) => file.relativePath === 'b.test.js')
      },
    })
    assert.deepEqual(seen, [['a.test.js', 'b.test.js']], 'asked once, with the project’s files')
    const pids = await pidsOf(p.dir)
    assert.equal(pids.length, 1)
    assert.ok(inBand(pids))
  })

  it('a fileFilter that rejects ends the run before anything starts', async () => {
    const p = await makeProject({ 'a.test.js': '' })
    const events: string[] = []
    await assert.rejects(
      run(
        runtimeProject(p.dir),
        {
          pool: { kind: 'forks' },
          fileFilter: () => Promise.reject(new Error('filter broke')),
        },
        { name: 'seen', 'run:start': () => void events.push('run:start') },
      ),
      /filter broke/,
    )
    assert.deepEqual(events, [])
  })

  it('a few fast files go in band once the results cache has their times, but not past 20 or a slow one', async () => {
    const p = await makeProject({ 'a.test.js': '', 'b.test.js': '' })
    for (const name of ['a.test.js', 'b.test.js']) await writeFile(p.path(name), noting(p.dir))
    const project = runtimeProject(p.dir, { policy: { orchestrator: JEST_NUMBERS } })
    const cache = createResultsCache(`${p.dir}/.cache`)
    await run(project, { cache, pool: { maxWorkers: 2 } })
    assert.ok(!inBand(await pidsOf(p.dir)), 'no time is known on the first run')
    await cache.write()
    await run(project, {
      cache: createResultsCache(`${p.dir}/.cache`),
      pool: { maxWorkers: 2 },
    })
    assert.ok(inBand(await pidsOf(p.dir)), 'every known time is under a second')
    // A numbers policy whose slow limit is 0 ms finds every time slow.
    const slow = runtimeProject(p.dir, {
      policy: { orchestrator: { inBand: { single: true, fastFileCount: 20, slowMs: 0 } } },
    })
    await run(slow, {
      cache: createResultsCache(`${p.dir}/.cache`),
      pool: { maxWorkers: 2 },
    })
    assert.ok(!inBand(await pidsOf(p.dir)), 'a slow file keeps it out')
  })

  it('a caller that names a pool kind turns off the policy’s own choice, not runInBand', async () => {
    const p = await makeProject({ 'a.test.js': '' })
    await writeFile(p.path('a.test.js'), noting(p.dir))
    const project = runtimeProject(p.dir, { policy: { orchestrator: JEST_NUMBERS } })
    await run(project, { pool: { kind: 'forks', maxWorkers: 2 } })
    assert.ok(!inBand(await pidsOf(p.dir)), 'forks was asked for')
    await run(project, { runInBand: true, pool: { kind: 'forks', maxWorkers: 2 } })
    assert.ok(inBand(await pidsOf(p.dir)), 'runInBand was asked for')
  })

  it('automaticInBand keeps the policy’s choice on beside a named kind, the pool for a run not in band', async () => {
    const p = await makeProject({ 'a.test.js': '', 'b.test.js': '' })
    await writeFile(p.path('a.test.js'), noting(p.dir))
    const project = runtimeProject(p.dir, {
      policy: { orchestrator: JEST_NUMBERS },
      include: ['a.test.js'],
    })
    await run(project, { pool: { kind: 'forks', automaticInBand: true, maxWorkers: 2 } })
    assert.ok(inBand(await pidsOf(p.dir)), 'one file: in band')
    await writeFile(p.path('b.test.js'), noting(p.dir))
    const two = runtimeProject(p.dir, { policy: { orchestrator: JEST_NUMBERS } })
    await run(two, { pool: { kind: 'forks', automaticInBand: true, maxWorkers: 2 } })
    assert.ok(!inBand(await pidsOf(p.dir)), 'two files, two workers: the named kind')
    await run(project, { pool: { automaticInBand: false, maxWorkers: 2 } })
    assert.ok(!inBand(await pidsOf(p.dir)), 'false turns the choice off with no kind')
  })

  it('a memory limit for the workers keeps even a single file in one', async () => {
    const p = await makeProject({ 'a.test.js': '' })
    await writeFile(p.path('a.test.js'), noting(p.dir))
    const project = runtimeProject(p.dir, { policy: { orchestrator: JEST_NUMBERS } })
    await run(project, {
      pool: { maxWorkers: 2, recycle: { memoryLimitBytes: 4_000_000_000 } },
    })
    assert.ok(!inBand(await pidsOf(p.dir)))
  })
})

describe('console in band', () => {
  const consoleOf = (events: ConsoleEntry[]): Reporter => ({
    name: 'console',
    console: (_file, event) => void events.push(event as unknown as ConsoleEntry),
  })

  it('a run asked to be in band captures a test’s console as events, and restores it after', async () => {
    const p = await makeProject({
      'a.test.js': "test('logs', () => { console.log('from the test') })\n",
    })
    const events: ConsoleEntry[] = []
    const before = globalThis.console
    await run(runtimeProject(p.dir), { runInBand: true }, consoleOf(events))
    assert.equal(globalThis.console, before, 'the global console is back')
    assert.deepEqual(
      events.map((event) => event.text.trim()),
      ['from the test'],
    )
  })

  it('an inline pool asked for as such captures nothing, as before (a caller owns stdout)', async () => {
    const p = await makeProject({
      'a.test.js': "test('logs', () => { console.log('not captured') })\n",
    })
    const events: ConsoleEntry[] = []
    const written: string[] = []
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      await run(runtimeProject(p.dir), { pool: { kind: 'inline' } }, consoleOf(events))
    } finally {
      process.stdout.write = write
    }
    assert.deepEqual(events, [])
  })
})
