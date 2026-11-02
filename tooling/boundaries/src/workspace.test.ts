import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'
import { loadManifest } from './manifest.ts'
import { MANIFEST_PATH, ROOT } from './paths.ts'
import { manifestOf, scratchDir } from './test-support.ts'
import { matches } from './text.ts'
import {
  checkWorkspace,
  ignoredDirs,
  pluginSuppressions,
  readWorkspace,
  type Workspace,
  type WorkspacePackage,
  workspaceRoots,
} from './workspace.ts'

const m = manifestOf({
  '@provino/types': { dir: 'packages/types', layer: 0, runsIn: 'types', deps: [], slices: [] },
  '@provino/core': {
    dir: 'packages/core',
    layer: 3,
    runsIn: 'worker',
    deps: ['@provino/types'],
    slices: [],
  },
  '@provino/native-*': {
    dir: 'packages/native-*',
    layer: 1,
    runsIn: 'both',
    deps: [],
    slices: [],
  },
})

const YAML =
  'packages:\n  - packages/*\n\ncatalog:\n  "@typescript/typescript6": 6.0.2\n\npackageExtensions:\n  dependency-cruiser@18:\n    dependencies:\n      typescript: npm:@typescript/typescript6@6.0.2\n'

function pkg(
  overrides: Partial<WorkspacePackage> & Pick<WorkspacePackage, 'dir' | 'name'>,
): WorkspacePackage {
  return {
    deps: [],
    exports: { '.': { 'provino-source': './src/index.ts', types: './dist/index.d.ts' } },
    testScript: undefined,
    unitTests: 0,
    hasTsconfig: true,
    hasTypeTests: false,
    files: [],
    ...overrides,
  }
}

function ws(packages: readonly WorkspacePackage[], extra: Partial<Workspace> = {}): Workspace {
  return {
    roots: ['packages'],
    packages,
    unreadable: [],
    sourceProjects: new Set(packages.map((p) => p.dir)),
    typeTestProjects: new Set(packages.map((p) => `${p.dir}/test`)),
    pnpmWorkspaceYaml: YAML,
    ...extra,
  }
}

const rules = (problems: readonly { rule: string }[]): string[] => problems.map((p) => p.rule)

describe('the real workspace', () => {
  test('matches the real manifest and the repo conventions', async () => {
    const manifest = await loadManifest(MANIFEST_PATH)
    const workspace = await readWorkspace(ROOT)
    assert.deepEqual(checkWorkspace(manifest, workspace), [])
    assert.deepEqual(ignoredDirs(ROOT, manifest), [])
    assert.deepEqual(await pluginSuppressions(ROOT, workspace), [])
  })

  test('reads its roots from pnpm-workspace.yaml', async () => {
    assert.deepEqual((await readWorkspace(ROOT)).roots, ['packages', 'tooling'])
  })
})

describe('checkWorkspace', () => {
  test('a package missing from the manifest is reported', () => {
    const problems = checkWorkspace(m, ws([pkg({ dir: 'packages/extra', name: '@provino/extra' })]))
    assert.deepEqual(rules(problems), ['manifest-unknown-package'])
  })

  test('a package named differently from its manifest node is reported', () => {
    const problems = checkWorkspace(m, ws([pkg({ dir: 'packages/core', name: '@provino/kernel' })]))
    assert.deepEqual(rules(problems), ['manifest-name'])
  })

  test("a package.json dependency the manifest doesn't allow is reported", () => {
    const problems = checkWorkspace(
      m,
      ws([
        pkg({ dir: 'packages/types', name: '@provino/types', deps: ['@provino/core', 'some-lib'] }),
        pkg({ dir: 'packages/core', name: '@provino/core', deps: ['@provino/types'] }),
      ]),
    )
    assert.deepEqual(
      problems.map((p) => p.message),
      [
        "@provino/types depends on @provino/core in package.json, but the manifest doesn't allow it",
      ],
    )
  })

  test('a package.json dep on a package is allowed when the manifest allows one of its entries', () => {
    const entries = manifestOf({
      '@provino/snapshot': {
        dir: 'packages/snapshot',
        layer: 2,
        runsIn: 'both',
        deps: [],
        slices: [],
      },
      '@provino/snapshot/node': {
        dir: 'packages/snapshot/src/node',
        layer: 2,
        runsIn: 'coordinator',
        deps: [],
        slices: [],
      },
      '@provino/orchestrator': {
        dir: 'packages/orchestrator',
        layer: 5,
        runsIn: 'coordinator',
        deps: ['@provino/snapshot/node'],
        slices: [],
      },
    })
    const orchestrator = pkg({
      dir: 'packages/orchestrator',
      name: '@provino/orchestrator',
      deps: ['@provino/snapshot'],
    })
    assert.deepEqual(checkWorkspace(entries, ws([orchestrator])), [])
  })

  test('pattern nodes match their packages', () => {
    const problems = checkWorkspace(
      m,
      ws([pkg({ dir: 'packages/native-linux-x64', name: '@provino/native-linux-x64' })]),
    )
    assert.deepEqual(problems, [])
  })

  test('an exports entry without provino-source first is reported', () => {
    const exports = { '.': { types: './dist/index.d.ts', 'provino-source': './src/index.ts' } }
    const problems = checkWorkspace(
      m,
      ws([pkg({ dir: 'packages/core', name: '@provino/core', exports })]),
    )
    assert.deepEqual(rules(problems), ['workspace-exports'])
  })

  test('a package missing from either solution tsconfig is reported', () => {
    const core = pkg({ dir: 'packages/core', name: '@provino/core', hasTypeTests: true })
    const problems = checkWorkspace(
      m,
      ws([core], { sourceProjects: new Set(), typeTestProjects: new Set() }),
    )
    assert.deepEqual(rules(problems), ['workspace-tsconfig', 'workspace-tsconfig'])
  })

  test('a node --test script with no test files is reported', () => {
    const core = pkg({
      dir: 'packages/core',
      name: '@provino/core',
      testScript: 'node --test "src/**/*.test.ts"',
    })
    assert.deepEqual(rules(checkWorkspace(m, ws([core]))), ['workspace-tests'])
    assert.deepEqual(checkWorkspace(m, ws([{ ...core, unitTests: 1 }])), [])
  })

  test('an unreadable package.json is reported by path', () => {
    const problems = checkWorkspace(
      m,
      ws([], { unreadable: [{ dir: 'packages/core', error: 'Unexpected token' }] }),
    )
    assert.deepEqual(rules(problems), ['workspace-package-json'])
  })

  test('a placed dir outside the workspace roots is reported', () => {
    const outside = manifestOf({
      site: { dir: 'apps/site', layer: 'dev', runsIn: 'dev', deps: [], slices: [] },
    })
    assert.deepEqual(rules(checkWorkspace(outside, ws([]))), ['manifest-dir'])
  })

  test('the TypeScript 6 pin in packageExtensions must match the catalog', () => {
    const yaml = YAML.replace('typescript6@6.0.2', 'typescript6@6.0.9')
    assert.deepEqual(rules(checkWorkspace(m, ws([], { pnpmWorkspaceYaml: yaml }))), [
      'workspace-ts6-pin',
    ])
  })
})

describe('workspaceRoots', () => {
  test('reads <dir>/* globs, quoted or not', () => {
    assert.deepEqual(
      workspaceRoots('packages:\n  - packages/*\n  - "tooling/*"\n\ncatalog:\n  a: 1\n'),
      ['packages', 'tooling'],
    )
  })

  test('fails loudly on a glob it does not support', () => {
    assert.throws(() => workspaceRoots('packages:\n  - apps/**\n'), /only "<dir>\/\*" globs/)
  })
})

describe('repo hygiene checks', () => {
  async function gitRepo(files: Readonly<Record<string, string>>): Promise<string> {
    const dir = await scratchDir('ws', files)
    spawnSync('git', ['init', '-q'], { cwd: dir })
    return dir
  }

  test('a placed dir that git ignores is reported (Biome would never lint it)', async () => {
    const dir = await gitRepo({ '.gitignore': 'coverage/\n' })
    const coverage = manifestOf({
      '@provino/coverage': {
        dir: 'packages/coverage',
        layer: 2,
        runsIn: 'both',
        deps: [],
        slices: [],
      },
    })
    assert.deepEqual(rules(ignoredDirs(dir, coverage)), ['workspace-ignored-dir'])
  })

  test('a biome-ignore that silences the boundary lints is reported', async () => {
    const dir = await gitRepo({
      'packages/core/src/a.ts': "// biome-ignore lint/plugin: no\nexport const a = 'jest'\n",
      'packages/core/src/b.ts': '// biome-ignore-all lint: no\nexport {}\n',
      'packages/core/src/ok.ts':
        '// biome-ignore lint/suspicious/noExplicitAny: reason\nexport {}\n',
    })
    const files = ['src/a.ts', 'src/b.ts', 'src/ok.ts']
    const workspace = ws([pkg({ dir: 'packages/core', name: '@provino/core', files })])
    const problems = await pluginSuppressions(dir, workspace)
    assert.deepEqual(
      problems.map((p) => p.message.split(' ')[0]),
      ['packages/core/src/a.ts:1', 'packages/core/src/b.ts:1'],
    )
  })
})

test('matches: `*` is one path segment', () => {
  assert.ok(matches('packages/native-*', 'packages/native-darwin-arm64'))
  assert.ok(!matches('packages/native-*', 'packages/native-a/b'))
  assert.ok(matches('@provino/core', '@provino/core'))
  assert.ok(!matches('@provino/core', '@provino/core2'))
})
