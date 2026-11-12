import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

  test('pruning a missing directory is not an error', () => {
    pruneTransformCache(join(temp.dir, 'nowhere'))
  })
})
