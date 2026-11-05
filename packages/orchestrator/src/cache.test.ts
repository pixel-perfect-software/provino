// The results cache: a round trip, versioning, and every way the file can be missing or wrong.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { FileHistory } from '@provino/types'
import { createResultsCache, defaultCacheDir } from './cache.ts'

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-cache-')))
  made.push(dir)
  return dir
}

const history = (durationMs: number, failed = false): FileHistory => ({
  durationMs,
  failed,
  tests: 3,
  at: 1_700_000_000_000,
})

describe('createResultsCache', () => {
  it('has the default directory under node_modules/.cache/provino', () => {
    assert.equal(
      defaultCacheDir(join('root', 'app')),
      join('root', 'app', 'node_modules', '.cache', 'provino'),
    )
  })

  it('round-trips what was recorded through results.json', async () => {
    const dir = await scratch()
    const cache = createResultsCache(dir)
    cache.record('web', 'a.test.ts', history(12.5, true))
    cache.record('web', 'sub/b.test.ts', history(3))
    cache.record('api', 'a.test.ts', history(99))
    await cache.write()

    const next = createResultsCache(dir)
    assert.deepEqual(next.get('web', 'a.test.ts'), history(12.5, true))
    assert.deepEqual(next.get('web', 'sub/b.test.ts'), history(3))
    assert.deepEqual(next.get('api', 'a.test.ts'), history(99))
    assert.equal(next.get('api', 'b.test.ts'), undefined)
    assert.equal(next.get('other', 'a.test.ts'), undefined)
  })

  it('writes version 2 with the projects keyed by name and path', async () => {
    const dir = await scratch()
    const cache = createResultsCache(dir)
    cache.record('', 'a.test.ts', history(1))
    await cache.write()
    const written: unknown = JSON.parse(await readFile(join(dir, 'results.json'), 'utf8'))
    assert.deepEqual(written, { version: 2, projects: { '': { 'a.test.ts': history(1) } } })
  })

  it('creates the directory, and leaves no temporary file behind', async () => {
    const dir = join(await scratch(), 'node_modules', '.cache', 'provino')
    const cache = createResultsCache(dir)
    cache.record('p', 'a.test.ts', history(1))
    await cache.write()
    assert.deepEqual(await readdir(dir), ['results.json'])
  })

  it('keeps the history of files a run did not touch when it writes', async () => {
    const dir = await scratch()
    const first = createResultsCache(dir)
    first.record('p', 'old.test.ts', history(5))
    await first.write()
    const second = createResultsCache(dir)
    second.record('p', 'new.test.ts', history(7))
    await second.write()
    const third = createResultsCache(dir)
    assert.deepEqual(third.get('p', 'old.test.ts'), history(5))
    assert.deepEqual(third.get('p', 'new.test.ts'), history(7))
  })

  it('keeps what a run that overlapped wrote: two caches opened from one file, each with its own entry', async () => {
    const dir = await scratch()
    const seed = createResultsCache(dir)
    seed.record('p', 'seed.test.ts', history(9))
    await seed.write()

    // Both runs read `results.json` before either one writes.
    const first = createResultsCache(dir)
    const second = createResultsCache(dir)
    first.record('p', 'a.test.ts', history(1))
    second.record('p', 'b.test.ts', history(2))
    await first.write()
    await second.write()

    const merged = createResultsCache(dir)
    assert.deepEqual(merged.get('p', 'a.test.ts'), history(1), 'the first run’s entry survives')
    assert.deepEqual(merged.get('p', 'b.test.ts'), history(2))
    assert.deepEqual(merged.get('p', 'seed.test.ts'), history(9))
  })

  it('lets its own entry win over the disk’s for the same file', async () => {
    const dir = await scratch()
    const first = createResultsCache(dir)
    const second = createResultsCache(dir)
    first.record('p', 'a.test.ts', history(1))
    second.record('p', 'a.test.ts', history(2))
    await first.write()
    await second.write()
    assert.deepEqual(createResultsCache(dir).get('p', 'a.test.ts'), history(2))
  })

  it('reads the file again when it writes: a file that went bad since is empty, not an error', async () => {
    const dir = await scratch()
    const seed = createResultsCache(dir)
    seed.record('p', 'seed.test.ts', history(9))
    await seed.write()
    const cache = createResultsCache(dir)
    cache.record('p', 'a.test.ts', history(1))
    await writeFile(join(dir, 'results.json'), '{"version":2,"projects":')
    await cache.write()
    const next = createResultsCache(dir)
    assert.deepEqual(next.get('p', 'a.test.ts'), history(1))
    assert.equal(next.get('p', 'seed.test.ts'), undefined, 'unreadable history is no history')
  })

  it('writes the same file again without duplicating or losing anything', async () => {
    const dir = await scratch()
    const cache = createResultsCache(dir)
    cache.record('p', 'a.test.ts', history(1))
    await cache.write()
    await cache.write()
    assert.deepEqual(createResultsCache(dir).get('p', 'a.test.ts'), history(1))
  })

  it('prune drops the project’s entries for files that are not kept, from memory and from the disk', async () => {
    const dir = await scratch()
    const seed = createResultsCache(dir)
    seed.record('p', 'kept.test.ts', history(1))
    seed.record('p', 'gone.test.ts', history(2))
    seed.record('q', 'gone.test.ts', history(3))
    await seed.write()

    const cache = createResultsCache(dir)
    cache.prune('p', new Set(['kept.test.ts', 'new.test.ts']))
    assert.equal(cache.get('p', 'gone.test.ts'), undefined)
    assert.deepEqual(cache.get('p', 'kept.test.ts'), history(1))
    cache.record('p', 'new.test.ts', history(4))
    await cache.write()

    const next = createResultsCache(dir)
    assert.equal(next.get('p', 'gone.test.ts'), undefined, 'a file that is gone has no history')
    assert.deepEqual(next.get('p', 'kept.test.ts'), history(1))
    assert.deepEqual(next.get('p', 'new.test.ts'), history(4))
    assert.deepEqual(next.get('q', 'gone.test.ts'), history(3), 'another project is untouched')
  })

  it('prune also drops what another run wrote to the disk for a file that is not kept', async () => {
    const dir = await scratch()
    const cache = createResultsCache(dir)
    cache.prune('p', new Set(['kept.test.ts']))
    const other = createResultsCache(dir)
    other.record('p', 'stale.test.ts', history(5))
    other.record('p', 'kept.test.ts', history(6))
    await other.write()
    await cache.write()
    const next = createResultsCache(dir)
    assert.equal(next.get('p', 'stale.test.ts'), undefined)
    assert.deepEqual(next.get('p', 'kept.test.ts'), history(6))
  })

  it('prune with no files kept empties the project, and leaves no empty project behind', async () => {
    const dir = await scratch()
    const seed = createResultsCache(dir)
    seed.record('p', 'a.test.ts', history(1))
    seed.record('q', 'b.test.ts', history(2))
    await seed.write()
    const cache = createResultsCache(dir)
    cache.prune('p', new Set())
    await cache.write()
    const written: unknown = JSON.parse(await readFile(join(dir, 'results.json'), 'utf8'))
    assert.deepEqual(written, { version: 2, projects: { q: { 'b.test.ts': history(2) } } })
  })

  it('reads the file once: a later change on disk is not seen', async () => {
    const dir = await scratch()
    const first = createResultsCache(dir)
    first.record('p', 'a.test.ts', history(1))
    await first.write()
    const reader = createResultsCache(dir)
    const other = createResultsCache(dir)
    other.record('p', 'a.test.ts', history(2))
    await other.write()
    assert.deepEqual(reader.get('p', 'a.test.ts'), history(1))
  })

  it('is empty when there is no directory or no file', async () => {
    const dir = await scratch()
    assert.equal(createResultsCache(join(dir, 'missing')).get('p', 'a.test.ts'), undefined)
    await mkdir(join(dir, 'empty'))
    assert.equal(createResultsCache(join(dir, 'empty')).get('p', 'a.test.ts'), undefined)
  })

  it('is empty, not an error, when the file is corrupt or of another version', async () => {
    const dir = await scratch()
    const entry = { 'a.test.ts': history(1) }
    for (const text of [
      '{"version":2,"projects":{"p":',
      '',
      'null',
      '[]',
      JSON.stringify({ version: 1, projects: { p: entry } }),
      JSON.stringify({ projects: { p: entry } }),
      JSON.stringify({ version: 2 }),
      JSON.stringify({ version: 2, projects: [] }),
    ]) {
      await writeFile(join(dir, 'results.json'), text)
      assert.equal(createResultsCache(dir).get('p', 'a.test.ts'), undefined, text)
    }
  })

  it('drops a bad entry and keeps the good ones', async () => {
    const dir = await scratch()
    await writeFile(
      join(dir, 'results.json'),
      JSON.stringify({
        version: 2,
        projects: {
          p: {
            'good.test.ts': history(4),
            'no-duration.test.ts': { failed: false, tests: 1, at: 0 },
            'text.test.ts': 'slow',
          },
          q: 'not files',
        },
      }),
    )
    const cache = createResultsCache(dir)
    assert.deepEqual(cache.get('p', 'good.test.ts'), history(4))
    assert.equal(cache.get('p', 'no-duration.test.ts'), undefined)
    assert.equal(cache.get('p', 'text.test.ts'), undefined)
    assert.equal(cache.get('q', 'x'), undefined)
  })

  it('replaces a corrupt file when it writes', async () => {
    const dir = await scratch()
    await writeFile(join(dir, 'results.json'), 'not json')
    const cache = createResultsCache(dir)
    cache.record('p', 'a.test.ts', history(1))
    await cache.write()
    assert.deepEqual(createResultsCache(dir).get('p', 'a.test.ts'), history(1))
  })

  it('rejects from write when the directory cannot be created, and leaves nothing behind', async () => {
    const dir = await scratch()
    await writeFile(join(dir, 'file'), '')
    const cache = createResultsCache(join(dir, 'file', 'inside'))
    cache.record('p', 'a.test.ts', history(1))
    await assert.rejects(cache.write())
    assert.deepEqual(await readdir(dir), ['file'])
  })
})
