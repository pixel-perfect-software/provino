import assert from 'node:assert/strict'
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { defineDialect } from '@provino/policy'
import type { Dialect, ProvinoConfigInput } from '@provino/types'
import { findConfigInDirectory, findConfigUpward } from './discover.ts'
import { makeTempDir, pipe, rejectsWith, type TempDir } from './internal/test-support.ts'
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
    await temp.write('inline/x.txt', '')
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
        { name: 'inline', root: 'inline', include: ['x/*.js'], timeouts: { test: 5 } },
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
    assert.equal(inline?.rootDir, join(temp.dir, 'inline'))
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
    const star = (await resolveIn({ projects: ['packages/*'] })).projects.map((p) => p.rootDir)
    assert.ok(star.includes(join(temp.dir, 'packages/a')))
    assert.ok(!star.some((path) => path.includes('node_modules') || path.includes('.hidden')))
    const deep = (await resolveIn({ projects: ['**/src'] })).projects.map((p) => p.rootDir)
    assert.deepEqual(deep, [join(temp.dir, 'packages/c/src')])
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
      resolveIn({
        projects: [
          { name: 'p', root: 'single' },
          { name: 'p', root: 'packages' },
        ],
      }),
      'CONFIG_INVALID',
    )
    assert.match(error.message, /"p"/)
  })

  test('unnamed inline projects are not duplicates', async () => {
    assert.equal(
      (await resolveIn({ projects: [{ root: 'single' }, { root: 'packages' }] })).projects.length,
      2,
    )
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

describe('resolveProjects: loadDialects (B27e)', () => {
  let temp: TempDir
  before(async () => {
    temp = await makeTempDir()
    await temp.write('package.json', '{"type":"module"}')
    await temp.write('packages/a/provino.config.mjs', "export default { include: ['*.js'] }\n")
    await temp.write('packages/b/x.txt', '')
    await temp.write('named/provino.config.mjs', "export default { dialect: 'pipe' }\n")
    await temp.write('optioned/provino.config.mjs', 'export default { pipe: {} }\n')
  })
  after(() => temp.dispose())

  /** `resolveProjects` with a loader that counts its calls. */
  async function resolveCounting(
    input: ProvinoConfigInput,
    load: () => Promise<readonly Dialect[]> = async () => [pipe],
  ): Promise<{ readonly config: ResolvedConfig; readonly calls: number }> {
    let calls = 0
    const config = await resolveProjects(input, {
      configPath: join(temp.dir, 'provino.config.mjs'),
      dialects: [],
      loadDialects: () => {
        calls++
        return load()
      },
      environments: ENVIRONMENTS,
      ci: false,
    })
    return { config, calls }
  }

  test('a config of native projects (directories, a glob, inline) never calls it', async () => {
    const { config, calls } = await resolveCounting({
      include: ['top/*.js'],
      projects: ['packages/*', { name: 'inline', include: ['i/*.js'] }],
    })
    assert.equal(calls, 0)
    assert.deepEqual(
      config.projects.map((p) => p.dialect),
      [null, null, null],
    )
  })

  test('a project that names a dialect it lacks gets it, and the others stay native', async () => {
    const { config, calls } = await resolveCounting({ projects: ['packages/a', 'named'] })
    assert.equal(calls, 1)
    assert.deepEqual(
      config.projects.map((p) => p.dialect?.name ?? null),
      [null, 'pipe'],
    )
    assert.equal(config.projects[1]?.policy.report.displaySeparator, ' | ')
  })

  test("a dialect's options key loads it, and so does a top-level dialect", async () => {
    assert.equal((await resolveCounting({ projects: ['optioned'] })).calls, 1)
    const top = await resolveCounting({ dialect: 'pipe' as never })
    assert.equal(top.calls, 1)
    assert.equal(top.config.projects[0]?.dialect?.name, 'pipe')
  })

  test('several projects that need it call it once', async () => {
    const { calls } = await resolveCounting({
      projects: ['named', 'optioned', { name: 'i', dialect: 'pipe' as never }],
    })
    assert.equal(calls, 1)
  })

  test("a config's own dialects list never calls it", async () => {
    const { calls } = await resolveCounting({ dialects: [pipe], dialect: 'pipe' as never })
    assert.equal(calls, 0)
  })

  test('a name the loaded dialects lack is still CONFIG_UNKNOWN_DIALECT, a typo CONFIG_UNKNOWN_KEY', async () => {
    await rejectsWith(resolveCounting({ dialect: 'nope' as never }), 'CONFIG_UNKNOWN_DIALECT')
    await rejectsWith(resolveCounting({ inclde: [] } as ProvinoConfigInput), 'CONFIG_UNKNOWN_KEY')
  })

  test('a rejection reached from a sub-config is CONFIG_LOAD_FAILED, the loader called once', async () => {
    const reason = new Error('not installed')
    let calls = 0
    const error = await rejectsWith(
      resolveProjects(
        { projects: ['packages/a', 'named', 'optioned'] },
        {
          configPath: join(temp.dir, 'provino.config.mjs'),
          dialects: [],
          loadDialects: () => {
            calls++
            return Promise.reject(reason)
          },
          environments: ENVIRONMENTS,
          ci: false,
        },
      ),
      'CONFIG_LOAD_FAILED',
    )
    assert.equal(error.cause, reason)
    assert.equal(calls, 1)
  })

  test('a loader that throws synchronously is CONFIG_LOAD_FAILED and is still called once', async () => {
    const reason = new Error('sync')
    let calls = 0
    const error = await rejectsWith(
      resolveProjects(
        { projects: ['named', 'optioned'] },
        {
          configPath: join(temp.dir, 'provino.config.mjs'),
          dialects: [],
          loadDialects: () => {
            calls++
            throw reason
          },
          environments: ENVIRONMENTS,
          ci: false,
        },
      ),
      'CONFIG_LOAD_FAILED',
    )
    assert.equal(error.cause, reason)
    assert.equal(calls, 1)
  })

  test('a loader that resolves something other than an array is CONFIG_LOAD_FAILED', async () => {
    const error = await rejectsWith(
      resolveCounting(
        { dialect: 'pipe' as never },
        async () => pipe as unknown as readonly Dialect[],
      ),
      'CONFIG_LOAD_FAILED',
    )
    assert.ok(error.cause instanceof TypeError, String(error.cause))
  })

  test('a name the caller already gave keeps the eager entry over the loaded one', async () => {
    const other: Dialect = defineDialect({
      name: 'pipe',
      version: '2',
      policy: { report: { displaySeparator: ' - ' } },
    })
    const dash: Dialect = defineDialect({ name: 'dash', version: '1', policy: {} })
    let calls = 0
    const config = await resolveProjects(
      { dialect: 'pipe' as never, dash: {} } as ProvinoConfigInput,
      {
        configPath: join(temp.dir, 'provino.config.mjs'),
        dialects: [pipe],
        loadDialects: async () => {
          calls++
          return [other, dash]
        },
        environments: ENVIRONMENTS,
        ci: false,
      },
    )
    assert.equal(calls, 1)
    assert.equal(config.projects[0]?.policy.report.displaySeparator, ' | ')
  })

  test('a dialect only the loader gives is never detected, even with a detect that always fits', async () => {
    const sniff: Dialect = defineDialect({
      name: 'sniff',
      version: '1',
      policy: { report: { displaySeparator: ' ~ ' } },
      detect: () => 100,
    })
    const { config, calls } = await resolveCounting(
      { sniff: {} } as ProvinoConfigInput,
      async () => [sniff],
    )
    assert.equal(calls, 1)
    assert.equal(config.projects[0]?.dialect, null)
  })

  test('a loader that rejects is CONFIG_LOAD_FAILED with its error as cause', async () => {
    const reason = new Error('not installed')
    const error = await rejectsWith(
      resolveCounting({ dialect: 'pipe' as never }, () => Promise.reject(reason)),
      'CONFIG_LOAD_FAILED',
    )
    assert.equal(error.cause, reason)
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

describe('projects globs (D199: tinyglobby)', () => {
  let temp: TempDir
  let linked: string
  before(async () => {
    temp = await makeTempDir()
    await temp.write('real/packages/a/x.txt', '')
    await temp.write('real/packages/b/x.txt', '')
    await temp.write('real/packages/bee/x.txt', '')
    await temp.write('real/packages/a/node_modules/dep/x.txt', '')
    linked = join(temp.dir, 'linked')
    await symlink(join(temp.dir, 'real'), linked)
  })
  after(() => temp.dispose())

  const names = async (projects: readonly string[], base = join(temp.dir, 'real')) => {
    const config = await resolveProjects(
      { projects },
      {
        configPath: join(base, 'provino.config.mjs'),
        dialects: [],
        environments: ENVIRONMENTS,
        ci: false,
      },
    )
    return config.projects.map((project) => project.name)
  }

  test('a config reached through a symlinked path still finds its directories', async () => {
    assert.deepEqual(await names(['packages/*'], linked), ['a', 'b', 'bee'])
  })

  test('braces and classes match as a glob says', async () => {
    assert.deepEqual(await names(['packages/{a,bee}']), ['a', 'bee'])
    assert.deepEqual(await names(['packages/[ab]']), ['a', 'b'])
  })

  test('an entry starting with ! leaves out what the globs matched', async () => {
    assert.deepEqual(await names(['packages/*', '!packages/b*']), ['a'])
  })

  test('a glob never matches the config’s own directory', async () => {
    const found = await names(['**'])
    assert.ok(!found.includes('real'), found.join())
  })

  test('two projects with one root are CONFIG_INVALID', async () => {
    const error = await rejectsWith(names(['packages/a', 'packages/a']), 'CONFIG_INVALID')
    assert.match(error.message, /packages\/a/)
  })
})
