// B27d, acceptance row 7: the config keys reach the worker. The test files use the Jest dialect's
// globals, since the native API is B27b's; every key under test is the neutral config's own. The
// last block is a native project (no dialect), whose files import from `provino`.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'provino'
import { run } from 'provino/node'
import {
  Collect,
  nativeProject,
  notedPids,
  type ProjectFiles,
  QUIET_ENV,
  trackedProjects,
} from './support.ts'

const makeProject = trackedProjects()

async function runConfig(
  files: ProjectFiles,
  config: string,
  options: { readonly pool?: 'forks' | 'threads' | 'inline' } = {},
) {
  const project = await makeProject(files, config)
  const stderr = new Collect()
  const result = await run({
    config: project.config,
    stdout: new Collect(),
    stderr,
    env: QUIET_ENV,
    ...options,
  })
  return { ...result, stderr: stderr.text, project }
}

const SOURCE_PACKAGE = {
  'node_modules/cond-pkg/package.json': JSON.stringify({
    name: 'cond-pkg',
    exports: { 'provino-source': './src.js', default: './built.js' },
  }),
  'node_modules/cond-pkg/src.js': "module.exports = 'src'\n",
  'node_modules/cond-pkg/built.js': "module.exports = 'built'\n",
}

describe('provino.config keys reach the worker', () => {
  it('timeouts.test is the default, and a 50 ms one fails a test that never settles', async () => {
    const ran = await runConfig(
      { 'tests/hang.test.js': "test('hangs', () => new Promise(() => {}))\n" },
      "export default { dialect: 'jest', include: ['tests/**/*.test.js'], timeouts: { test: 50 } }\n",
    )
    assert.equal(ran.exitCode, 1, ran.stderr)
    assert.match(ran.stderr, /Exceeded timeout of 50 ms/)
  })

  it('resolve.conditions adds provino-source to the environment’s', async () => {
    const files = {
      ...SOURCE_PACKAGE,
      'tests/c.test.js': "test('c', () => { expect(require('cond-pkg')).toBe('src') })\n",
    }
    const without = await runConfig(
      files,
      "export default { dialect: 'jest', include: ['tests/**/*.test.js'] }\n",
    )
    assert.equal(without.exitCode, 1, 'without the condition the default export is taken')
    const ran = await runConfig(
      files,
      "export default { dialect: 'jest', include: ['tests/**/*.test.js'], resolve: { conditions: ['provino-source'] } }\n",
    )
    assert.equal(ran.exitCode, 0, ran.stderr)
  })

  it('resolve.aliases and a tsconfig paths entry map specifiers', async () => {
    const ran = await runConfig(
      {
        'lib/x.js': "module.exports = 'x'\n",
        'tsx/m.js': "module.exports = 'm'\n",
        'tsconfig.test.json': JSON.stringify({
          compilerOptions: { paths: { '#t/*': ['./tsx/*'] } },
        }),
        'tests/a.test.js':
          "test('a', () => { expect(require('@lib/x')).toBe('x'); expect(require('#t/m')).toBe('m') })\n",
      },
      `export default { dialect: 'jest', include: ['tests/**/*.test.js'],
        resolve: { aliases: { '@lib/*': './lib/*' }, tsconfig: './tsconfig.test.json' } }\n`,
    )
    assert.equal(ran.exitCode, 0, ran.stderr)
  })

  it('a package specifier in setupFiles runs before the tests', async () => {
    const ran = await runConfig(
      {
        'node_modules/setup-pkg/package.json': '{"name":"setup-pkg","main":"./index.js"}',
        'node_modules/setup-pkg/index.js': 'globalThis.__pkgSetup = true\n',
        'tests/a.test.js': "test('a', () => { expect(globalThis.__pkgSetup).toBe(true) })\n",
      },
      "export default { dialect: 'jest', include: ['tests/**/*.test.js'], setupFiles: ['setup-pkg'] }\n",
    )
    assert.equal(ran.exitCode, 0, ran.stderr)
  })

  it('a setupFiles package that does not resolve is exit 2, naming the entry', async () => {
    const ran = await runConfig(
      { 'tests/a.test.js': "test('a', () => {})\n" },
      "export default { dialect: 'jest', include: ['tests/**/*.test.js'], setupFiles: ['no-such-pkg'] }\n",
    )
    assert.equal(ran.exitCode, 2)
    assert.match(ran.stderr, /setupFiles\[0\]/)
  })

  it('environmentOptions reach the environment', async () => {
    const ran = await runConfig(
      {
        'tests/a.test.js':
          "test('a', () => { expect(window.location.href).toBe('http://example.test/') })\n",
      },
      `export default { dialect: 'jest', include: ['tests/**/*.test.js'], environment: 'jsdom', isolation: 'registry',
        environmentOptions: { url: 'http://example.test/' } }\n`,
    )
    assert.equal(ran.exitCode, 0, ran.stderr)
  })

  it('pool is the default for a run that names none, and the run’s own option wins', async () => {
    const files = (name: string) => (dir: string) => ({
      'tests/a.test.js': `test('a', () => { require('node:fs').writeFileSync(${JSON.stringify(`${dir}/${name}.pid`)}, String(process.pid)) })\n`,
    })
    const config =
      "export default { dialect: 'jest', include: ['tests/**/*.test.js'], pool: 'inline', maxWorkers: 1 }\n"
    const inline = await runConfig(files('inline'), config)
    assert.equal(inline.exitCode, 0, inline.stderr)
    assert.equal(await readFile(inline.project.path('inline.pid'), 'utf8'), String(process.pid))

    const forked = await runConfig(files('forked'), config, { pool: 'forks' })
    assert.equal(forked.exitCode, 0, forked.stderr)
    assert.notEqual(await readFile(forked.project.path('forked.pid'), 'utf8'), String(process.pid))
    assert.ok(existsSync(forked.project.path('forked.pid')))
  })
})

// A native project (no dialect) names a DOM environment and no `isolation`: the default is
// `registry` (D207), and the environment's exact global restore keeps one file's DOM state from the
// next. Both files have one source and run on one worker (a worker that leaked a global would be
// replaced, and its successor would pass either way), so the second file's clean start is the proof.
describe('a native project with a DOM environment and no isolation', () => {
  const DOM = `import { appendFileSync } from 'node:fs'
import { expect, test } from 'provino'

test('the window starts clean, and the file leaves a mark on it', () => {
  appendFileSync(new URL('../workers.pids', import.meta.url), \`\${process.pid}\\n\`)
  expect(window).toBe(globalThis)
  expect(window.leaked).toBeUndefined()
  window.leaked = true
})
`

  it('jsdom runs two files green on one worker, the second on a window the first left clean', async () => {
    const dir = await nativeProject(
      { 'tests/a.test.ts': DOM, 'tests/b.test.ts': DOM },
      "export default { include: ['tests/**/*.test.ts'], environment: 'jsdom' }\n",
    )
    const stderr = new Collect()
    const ran = await run({
      config: 'provino.config.mjs',
      cwd: dir,
      stdout: new Collect(),
      stderr,
      env: QUIET_ENV,
      pool: 'forks',
      maxWorkers: 1,
    })
    assert.equal(ran.exitCode, 0, stderr.text)
    assert.deepEqual(
      ran.summary?.files.map((f) => f.state),
      ['pass', 'pass'],
    )
    const pids = await notedPids(join(dir, 'workers.pids'))
    assert.equal(pids.length, 2)
    assert.equal(new Set(pids).size, 1, `two workers: ${pids.join(', ')}`)
  })
})
