// Isolation `none` keeps one environment for a worker, and a docblock that names another kind
// switches it for that file (B17c): the files below run in one worker, in path order, and each sees
// the environment its docblock (or the project's default) names, with the previous one gone from
// the global.
import assert from 'node:assert/strict'
import { mkdir, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { spawnCli, trackedProjects } from './support.ts'

const makeProject = trackedProjects()

const require = createRequire(fileURLToPath(new URL('../../harness/package.json', import.meta.url)))

const isDom = (expected: boolean, docblock = ''): string =>
  `${docblock}test('document is ${expected ? 'defined' : 'undefined'}', () => {\n  expect(typeof document).toBe('${expected ? 'object' : 'undefined'}')\n})\n`

describe('a docblock under isolation none', () => {
  it('switches the worker environment for the file that names it, and back', async () => {
    const project = await makeProject(
      {
        'tests/a.test.js': isDom(false),
        'tests/b.test.js': isDom(true, '/**\n * @jest-environment jsdom\n */\n'),
        'tests/c.test.js': isDom(false),
        'tests/d.test.js': isDom(true, '/**\n * @jest-environment jsdom\n */\n'),
        'tests/e.test.js': isDom(true, '/**\n * @jest-environment jsdom\n */\n'),
      },
      "export default { dialect: 'jest', include: ['tests/**/*.test.js'], isolation: 'none', environment: 'node' }\n",
    )
    await mkdir(join(project.dir, 'node_modules'), { recursive: true })
    await symlink(
      dirname(require.resolve('jest-environment-jsdom/package.json')),
      join(project.dir, 'node_modules', 'jest-environment-jsdom'),
    )
    const ended = await spawnCli(['run', '--config', project.config, '--maxWorkers', '1'], {
      cwd: project.dir,
    })
    assert.equal(ended.code, 0, `${ended.stdout}\n${ended.stderr}`)
    assert.match(`${ended.stdout}${ended.stderr}`, /5 passed/)
  })
})
