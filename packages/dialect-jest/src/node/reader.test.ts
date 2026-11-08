// The config reader end to end (find → load → resolve) against real jest-config 30.5.2's
// `readConfigs`, for what only a whole run shows:
// - inline JSON (`--config '{…}'`) resolves against the directory it was found for, not the
//   process's working directory (its `projects` globs, the projects' parent directory);
// - Jest reads a root config again when its path is also a project (no `projects`, or `projects`
//   listing its own directory); ours loads the file once, so a config function runs once, but
//   normalizes it as often as Jest does, so the configs and the warnings are Jest's.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createJestConfigReader } from './index.ts'
import {
  captureWarnings,
  comparable,
  comparableWithout,
  inDirectory,
  loadOracle,
  ORACLE_ARGV,
  type Oracle,
  oracleRequireResolve,
  removeTree,
  type Tree,
  writeTree,
} from './internal/test-support.ts'

let oracle: Oracle
const trees: string[] = []
before(async () => {
  oracle = await loadOracle()
})
after(() => {
  for (const tree of trees) removeTree(tree)
})

function tree(files: Tree): string {
  const root = writeTree(files)
  trees.push(root)
  return root
}

interface Run {
  readonly configs: unknown
  readonly globalConfig: unknown
  readonly warnings: number
}

async function readWithOurs(root: string, explicit?: string): Promise<Run & { calls: number }> {
  Reflect.set(globalThis, '__provinoConfigCalls', 0)
  // No `cwd`: the reader must not need the process to be in the project.
  const reader = createJestConfigReader({
    requireResolve: oracleRequireResolve,
    ci: oracle.defaults.ci === true,
    seed: 0,
    ...(explicit === undefined ? { cwd: root } : {}),
  })
  const source = await reader.find(root, explicit)
  assert.ok(source !== undefined)
  const resolved = await reader.resolve(await reader.load(source), source)
  return {
    configs: comparable(resolved.value.configs),
    globalConfig: comparableWithout(resolved.value.globalConfig, ['seed']),
    warnings: resolved.diagnostics.length,
    calls: Number(Reflect.get(globalThis, '__provinoConfigCalls')),
  }
}

async function readWithJest(root: string, config?: string): Promise<Run & { calls: number }> {
  Reflect.set(globalThis, '__provinoConfigCalls', 0)
  const argv = { ...ORACLE_ARGV, _: [], ...(config === undefined ? {} : { config }) }
  const outcome = await inDirectory(root, () =>
    captureWarnings(() => oracle.readConfigs(argv, [root])),
  )
  if (outcome.error !== undefined) throw outcome.error
  const result = outcome.result as { configs: unknown; globalConfig: unknown }
  return {
    configs: comparable(result.configs),
    globalConfig: comparableWithout(result.globalConfig, ['seed']),
    warnings: outcome.warnings.length,
    calls: Number(Reflect.get(globalThis, '__provinoConfigCalls')),
  }
}

const COUNTING = (body: string) =>
  `module.exports = () => { globalThis.__provinoConfigCalls += 1; return ${body} }\n`

for (const fixture of [
  {
    name: 'no projects (Jest reads the root twice)',
    body: `{ testEnviroment: 'node' }`,
    jestCalls: 2,
  },
  {
    name: 'projects without the root (read once)',
    body: `{ testEnviroment: 'node', projects: ['<rootDir>/a'] }`,
    jestCalls: 1,
  },
  {
    name: 'projects listing the root (Jest reads it twice)',
    body: `{ testEnviroment: 'node', projects: ['<rootDir>', '<rootDir>/a'] }`,
    jestCalls: 2,
  },
]) {
  test(`the root config loads once, with Jest's configs and warnings: ${fixture.name}`, async () => {
    const root = tree({
      'jest.config.js': COUNTING(fixture.body),
      'a/jest.config.js': "module.exports = { displayName: 'a' }\n",
    })
    const theirs = await readWithJest(root)
    const ours = await readWithOurs(root)
    assert.equal(theirs.calls, fixture.jestCalls)
    assert.equal(ours.calls, 1)
    assert.equal(ours.warnings, theirs.warnings)
    assert.deepEqual(ours.configs, theirs.configs)
    assert.deepEqual(ours.globalConfig, theirs.globalConfig)
  })
}

test('inline JSON resolves against its directory, wherever the process runs', async () => {
  const root = tree({
    'packages/one/jest.config.js': "module.exports = { displayName: 'one' }\n",
    'packages/two/jest.config.js': "module.exports = { displayName: 'two' }\n",
  })
  const config = JSON.stringify({ projects: ['packages/*'], testTimeout: 1234 })
  assert.notEqual(process.cwd(), root)
  const theirs = await readWithJest(root, config)
  const ours = await readWithOurs(root, config)
  assert.deepEqual(ours.configs, theirs.configs)
  assert.deepEqual(ours.globalConfig, theirs.globalConfig)
  assert.equal((ours.configs as unknown[]).length, 2)
})
