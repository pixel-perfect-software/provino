import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { ProvinoConfigInput } from '@provino/types'
import { findConfigInDirectory, findConfigUpward } from './discover.ts'
import { makeTempDir, rejectsWith, type TempDir } from './internal/test-support.ts'
import { loadProjects, type ResolvedConfig, resolveProjects } from './projects.ts'

const ENVIRONMENTS = { node: { module: 'file:///env/node.mjs', export: 'nodeEnvironment' } }

describe('resolveProjects', () => {
  let temp: TempDir
  before(async () => {
    temp = await makeTempDir()
    await temp.write('package.json', '{"type":"module"}')
    await temp.write('packages/a/x.txt', '')
    await temp.write(
      'packages/b/provino.config.mjs',
      "export default { name: 'bee', include: ['t/*.js'] }\n",
    )
    await temp.write(
      'packages/c/provino.config.mjs',
      "export default { root: 'src', timeouts: { test: 70 } }\n",
    )
    await temp.write('packages/c/src/x.txt', '')
    await temp.write('packages/node_modules/skip/x.txt', '')
    await temp.write('packages/.hidden/x.txt', '')
    await temp.write('single/provino.config.mjs', 'export default {}\n')
  })
  after(() => temp.dispose())

  const resolveIn = (input: ProvinoConfigInput): Promise<ResolvedConfig> =>
    resolveProjects(input, {
      configPath: join(temp.dir, 'provino.config.mjs'),
      dialects: [],
      environments: ENVIRONMENTS,
      ci: false,
    })

  test('a config with no projects is the one project, with its run defaults', async () => {
    const config = await resolveIn({ name: 'solo', pool: 'inline', maxWorkers: 3 })
    assert.deepEqual(
      config.projects.map((p) => p.name),
      ['solo'],
    )
    assert.equal(config.root, undefined)
    assert.equal(config.pool, 'inline')
    assert.equal(config.maxWorkers, 3)
  })

  test('an empty projects list is the config itself', async () => {
    assert.equal((await resolveIn({ projects: [] })).projects.length, 1)
  })

  test('inline projects, a directory and a glob run in the config’s order', async () => {
    const config = await resolveIn({
      projects: [
        { name: 'inline', root: 'single', include: ['x/*.js'], timeouts: { test: 5 } },
        './single',
        'packages/*',
      ],
    })
    assert.deepEqual(
      config.projects.map((p) => p.name),
      ['inline', 'single', 'a', 'bee', 'c'],
    )
    assert.equal(config.root, temp.dir)
    const [inline, single, a, bee, c] = config.projects
    assert.equal(inline?.rootDir, join(temp.dir, 'single'))
    assert.deepEqual(inline?.include, ['x/*.js'])
    assert.equal(inline?.policy.core.timeouts.test, 5)
    assert.equal(single?.rootDir, join(temp.dir, 'single'))
    assert.equal(a?.rootDir, join(temp.dir, 'packages/a'))
    assert.deepEqual(bee?.include, ['t/*.js'])
    // Each project has its own config: c's root and timeouts are its own, a's are the defaults.
    assert.equal(c?.rootDir, join(temp.dir, 'packages/c/src'))
    assert.equal(c?.policy.core.timeouts.test, 70)
    assert.notEqual(a?.policy.core.timeouts.test, 70)
  })

  test('a glob never enters node_modules or a dot directory, and ** goes down', async () => {
    const names = (await resolveIn({ projects: ['packages/**'] })).projects.map((p) => p.rootDir)
    assert.ok(names.includes(join(temp.dir, 'packages/a')))
    assert.ok(!names.some((path) => path.includes('node_modules') || path.includes('.hidden')))
  })

  test('a path to a config file is its directory’s project', async () => {
    const config = await resolveIn({ projects: ['packages/b/provino.config.mjs'] })
    assert.deepEqual(
      config.projects.map((p) => p.name),
      ['bee'],
    )
  })

  test('the top-level keys are not inherited', async () => {
    const config = await resolveIn({ include: ['top/*.js'], projects: [{ name: 'p' }] })
    assert.notDeepEqual(config.projects[0]?.include, ['top/*.js'])
  })

  test('duplicate names are CONFIG_INVALID', async () => {
    const error = await rejectsWith(
      resolveIn({ projects: [{ name: 'p' }, { name: 'p' }] }),
      'CONFIG_INVALID',
    )
    assert.match(error.message, /"p"/)
  })

  test('unnamed inline projects are not duplicates', async () => {
    assert.equal((await resolveIn({ projects: [{}, {}] })).projects.length, 2)
  })

  test('a glob that matches nothing, and a missing path, are CONFIG_INVALID', async () => {
    await rejectsWith(resolveIn({ projects: ['nothing/*'] }), 'CONFIG_INVALID')
    await rejectsWith(resolveIn({ projects: ['./missing'] }), 'CONFIG_INVALID')
  })

  test('a project takes no key of the whole run, and no projects of its own: they are unknown to it', async () => {
    await rejectsWith(resolveIn({ projects: [{ projects: ['x'] } as never] }), 'CONFIG_UNKNOWN_KEY')
    await rejectsWith(resolveIn({ projects: [{ pool: 'forks' } as never] }), 'CONFIG_UNKNOWN_KEY')
    await rejectsWith(resolveIn({ projects: [{ maxWorkers: 2 } as never] }), 'CONFIG_UNKNOWN_KEY')
  })

  test('a typo inside an inline project is CONFIG_UNKNOWN_KEY', async () => {
    await rejectsWith(
      resolveIn({ projects: [{ envirnoment: 'node' } as never] }),
      'CONFIG_UNKNOWN_KEY',
    )
  })

  test('a typo in a project directory’s own config names its key', async () => {
    await temp.write('bad/provino.config.mjs', 'export default { globls: true }\n')
    await rejectsWith(resolveIn({ projects: ['bad'] }), 'CONFIG_UNKNOWN_KEY')
  })

  test('loadProjects reads the file, a function export included', async () => {
    const path = await temp.write(
      'fn/provino.config.mjs',
      'export default (env) => ({ projects: [{ name: env.command }], maxWorkers: 2 })\n',
    )
    const config = await loadProjects(path, { dialects: [], environments: ENVIRONMENTS, ci: false })
    assert.deepEqual(
      config.projects.map((p) => p.name),
      ['run'],
    )
    assert.equal(config.maxWorkers, 2)
  })
})

describe('config discovery (D196)', () => {
  let temp: TempDir
  before(async () => {
    temp = await makeTempDir()
    await temp.write('repo/.git/HEAD', '')
    await temp.write('repo/provino.config.ts', '')
    await temp.write('repo/pkg/a/b/x.txt', '')
    await temp.write('repo/pkg/own/provino.config.mjs', '')
    await temp.write('repo/pkg/own/deep/x.txt', '')
    await temp.write('outer/provino.config.js', '')
    await temp.write('outer/ws/pnpm-workspace.yaml', '')
    await temp.write('outer/ws/pkg/x.txt', '')
  })
  after(() => temp.dispose())

  test('the working directory’s own config wins, else the nearest parent’s', async () => {
    assert.equal(
      await findConfigUpward(join(temp.dir, 'repo/pkg/own/deep')),
      join(temp.dir, 'repo/pkg/own/provino.config.mjs'),
    )
    assert.equal(
      await findConfigUpward(join(temp.dir, 'repo/pkg/a/b')),
      join(temp.dir, 'repo/provino.config.ts'),
    )
  })

  test('the walk stops at a directory with .git or pnpm-workspace.yaml, after looking in it', async () => {
    assert.equal(await findConfigUpward(join(temp.dir, 'outer/ws/pkg')), undefined)
    assert.equal(
      await findConfigUpward(join(temp.dir, 'repo')),
      join(temp.dir, 'repo/provino.config.ts'),
    )
  })

  test('findConfigInDirectory looks only in the directory', async () => {
    assert.equal(await findConfigInDirectory(join(temp.dir, 'repo/pkg')), undefined)
    assert.equal(
      await findConfigInDirectory(join(temp.dir, 'outer')),
      join(temp.dir, 'outer/provino.config.js'),
    )
  })
})
