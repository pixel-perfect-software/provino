import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { makeTempDir, type TempDir } from './internal/test-support.ts'
import { type ResolvedProject, resolveProject } from './resolve.ts'
import { pruneTransformCache, withTransformCache } from './transform-cache.ts'

describe('the transform cache, coordinator side (T3.6)', () => {
  let temp: TempDir
  let project: ResolvedProject
  before(async () => {
    temp = await makeTempDir()
    project = await resolveProject(
      {},
      {
        configPath: join(temp.dir, 'provino.config.mjs'),
        dialects: [],
        environments: { node: { module: 'file:///env/node.mjs', export: 'nodeEnvironment' } },
        ci: false,
      },
    )
  })
  after(() => temp.dispose())

  test('hands the directory to the workers and leaves the original project alone', () => {
    const dir = join(temp.dir, 'cache', 't')
    const prepared = withTransformCache(project, dir)
    assert.equal(prepared.config.loader.cacheDir, dir)
    // The workers get the transform package's code hash, so none of them reads that package again.
    assert.match(prepared.config.loader.codeIdentity ?? '', /^[0-9a-f]{16}$/)
    assert.equal(project.config.loader.cacheDir, undefined)
    assert.equal(prepared.rootDir, project.rootDir)
    assert.ok(existsSync(join(dir, 'CACHEDIR.TAG')))
  })

  test('wipes the directory when the lockfile changed since it was filled', () => {
    const dir = join(temp.dir, 'wipe', 't')
    writeFileSync(join(temp.dir, 'pnpm-lock.yaml'), 'one')
    withTransformCache(project, dir)
    mkdirSync(join(dir, 'ab'), { recursive: true })
    writeFileSync(join(dir, 'ab', 'entry'), 'x')
    withTransformCache(project, dir)
    assert.ok(existsSync(join(dir, 'ab', 'entry')), 'same lockfile: kept')
    writeFileSync(join(temp.dir, 'pnpm-lock.yaml'), 'two')
    withTransformCache(project, dir)
    assert.equal(existsSync(join(dir, 'ab', 'entry')), false, 'new lockfile: wiped')
    assert.equal(readFileSync(join(dir, 'CACHEDIR.TAG'), 'utf8').startsWith('Signature:'), true)
  })

  test('a wipe that cannot finish means no transform cache for the run, and says so', async () => {
    const parent = join(temp.dir, 'locked')
    const dir = join(parent, 't')
    mkdirSync(join(dir, 'ab'), { recursive: true })
    writeFileSync(join(dir, 'ab', 'entry'), 'x')
    writeFileSync(join(dir, 'lockfile-hash'), 'a hash the lockfile no longer has')
    // A read-only parent: the directory's contents go, the directory itself can't be removed.
    chmodSync(parent, 0o555)
    const warnings: string[] = []
    const onWarning = (warning: Error): void => {
      if ((warning as NodeJS.ErrnoException).code === 'PROVINO_TRANSFORM_CACHE_STALE') {
        warnings.push(warning.message)
      }
    }
    process.on('warning', onWarning)
    try {
      const prepared = withTransformCache(project, dir)
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(prepared.config.loader.cacheDir, undefined)
      assert.equal(warnings.length, 1)
    } finally {
      process.off('warning', onWarning)
      chmodSync(parent, 0o755)
    }
  })

  test('pruning a missing directory is not an error', () => {
    pruneTransformCache(join(temp.dir, 'nowhere'))
  })
})
