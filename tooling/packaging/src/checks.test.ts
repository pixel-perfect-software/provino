// The planted cases of `pnpm hygiene`'s cheap checks (T1.6, T10.4's agent half): each one fails
// on a seeded violation, and the real repo passes.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  changesetsSince,
  checkChangesetFixed,
  checkChangesetIgnore,
  missingChangesets,
  parseChangeset,
  readChangesetConfig,
} from './changesets.ts'
import { hygiene, inlinedPackages, umbrellaDependencyProblems } from './hygiene.ts'
import { installScriptProblems } from './install-scripts.ts'
import type { PackageManifest } from './package-json.ts'
import { lintReleaseWorkflow } from './release-lint.ts'
import { repository, scratchDir, writeFiles } from './test-support.ts'
import { ROOT, readWorkspacePackages, type WorkspacePackage } from './workspace.ts'

function pkg(name: string, parts: Partial<PackageManifest> = {}, rel = `packages/${name}`) {
  const manifest: PackageManifest = {
    name,
    version: '0.0.0',
    private: false,
    type: 'module',
    exports: {},
    bin: {},
    publishBin: {},
    files: [],
    scripts: {},
    dependencies: {},
    devDependencies: {},
    peerDependencies: {},
    optionalDependencies: {},
    ...parts,
  }
  const out: WorkspacePackage = { dir: join(ROOT, rel), rel, manifest }
  return out
}

describe('install-script ban (T10.4)', () => {
  test('the workspace has none', () => {
    assert.deepEqual(installScriptProblems(readWorkspacePackages()), [])
  })

  test('preinstall, install and postinstall each fail, in any package, private or not, and the root', () => {
    for (const script of ['preinstall', 'install', 'postinstall']) {
      assert.deepEqual(
        installScriptProblems([pkg('a', { scripts: { [script]: 'node build.js' } })]),
        [`packages/a/package.json has a "${script}" script: Provino ships no install scripts`],
      )
    }
    assert.equal(
      installScriptProblems([pkg('b', { private: true, scripts: { postinstall: 'x' } })]).length,
      1,
    )
    assert.equal(
      installScriptProblems([pkg('root', { scripts: { postinstall: 'x' } }, '.')]).length,
      1,
    )
  })

  test('other lifecycle scripts are not install scripts', () => {
    assert.deepEqual(
      installScriptProblems([pkg('a', { scripts: { prepare: 'x', prepack: 'y', build: 'z' } })]),
      [],
    )
  })
})

describe('release workflow lint (T10.4, D162, D163)', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8')
  const PUBLISH = 'pnpm -r publish --access public --no-git-checks --provenance --tag "$DIST_TAG"'
  const PINNED_CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'

  test('the real workflow passes', () => {
    assert.ok(workflow.includes(PUBLISH), 'the publish command this file plants against changed')
    assert.deepEqual(lintReleaseWorkflow(workflow, { draft: false }), [])
  })

  test('a workflow that calls itself a draft must publish with --dry-run, and passes with it', () => {
    const problems = lintReleaseWorkflow(workflow, { draft: true })
    assert.equal(problems.length, 1)
    assert.match(problems[0] ?? '', /a draft must not publish/)
    const dry = workflow.replace(PUBLISH, `${PUBLISH} --dry-run`)
    assert.deepEqual(lintReleaseWorkflow(dry, { draft: true }), [])
    assert.deepEqual(lintReleaseWorkflow(dry, { draft: false }), [])
  })

  const planted: readonly (readonly [string, (text: string) => string, RegExp])[] = [
    ['no id-token: write', (t) => t.replace(/^ *id-token: write.*\n/m, ''), /no `id-token: write`/],
    [
      'no tag trigger',
      (t) => t.replace('    tags: ["v*"]\n', '    branches: [main]\n'),
      /does not start from a pushed `v\*` tag/,
    ],
    [
      'an NPM_TOKEN secret',
      (t) =>
        t.replace(
          '      - name: Publish the packages\n',
          `      - name: Publish the packages\n        env:\n          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}\n`,
        ),
      /npm token or a secret/,
    ],
    [
      'NODE_AUTH_TOKEN',
      (t) =>
        t.replace(
          '          node-version-file: .tool-versions\n',
          `          node-version-file: .tool-versions\n          token: \${{ secrets.NODE_AUTH_TOKEN }}\n`,
        ),
      /npm token or a secret/,
    ],
    [
      'a plain npm publish',
      (t) => t.replace('pnpm -r publish', 'npm publish'),
      /publishes other than with `pnpm -r publish`/,
    ],
    [
      'npm stage publish: D75 allows npm only inside install-matrix.yml',
      (t) => t.replace('pnpm -r publish', 'npm stage publish'),
      /runs npm, which D75 allows only in install-matrix\.yml/,
    ],
    [
      'npm, npx, yarn or bun for anything else',
      (t) =>
        t.replace(
          '      - run: pnpm typecheck',
          '      - run: npx tsdown && yarn build && bun x y',
        ),
      /runs npm, which D75 allows only in install-matrix\.yml/,
    ],
    [
      'a block-form npx',
      (t) =>
        t.replace(
          '      - run: pnpm typecheck',
          '      - run: |\n          pnpm typecheck\n          npx tsdown',
        ),
      /runs npm, which D75 allows only in install-matrix\.yml: npx tsdown/,
    ],
    [
      'a block-form yarn, after &&',
      (t) =>
        t.replace(
          '      - run: pnpm typecheck',
          '      - run: |\n          pnpm typecheck\n          cd packages/x && yarn build',
        ),
      /runs npm, which D75 allows only in install-matrix\.yml: cd packages\/x && yarn build/,
    ],
    [
      'a block-form npm in a subshell',
      (t) =>
        t.replace(
          '      - run: pnpm typecheck',
          '      - run: |\n          v=$(npm --version)\n          pnpm typecheck',
        ),
      /runs npm, which D75 allows only in install-matrix\.yml: v=\$\(npm --version\)/,
    ],
    [
      'the staged publish B21e drafted',
      (t) => t.replace('pnpm -r publish', 'pnpm -r stage publish'),
      /stages the publish, which D163 replaced/,
    ],
    [
      'a publish that is not recursive',
      (t) => t.replace('pnpm -r publish', 'pnpm publish'),
      /is not recursive/,
    ],
    [
      'a second publish beside it',
      (t) => `${t}      - run: pnpm publish --access public --provenance\n`,
      /publish is not recursive/,
    ],
    ['no --access public', (t) => t.replace(' --access public', ''), /has no --access public/],
    ['no --no-git-checks', (t) => t.replace(' --no-git-checks', ''), /has no --no-git-checks/],
    ['no provenance', (t) => t.replace(' --provenance', ''), /has no --provenance/],
    ['no --tag', (t) => t.replace(' --tag "$DIST_TAG"', ''), /has no --tag/],
    [
      '--force, which would republish a version',
      (t) => t.replace(PUBLISH, `${PUBLISH} --force`),
      /republishes versions already on npm/,
    ],
    [
      'a self-hosted runner',
      (t) => t.replace('runs-on: ubuntu-latest', 'runs-on: self-hosted'),
      /not a GitHub-hosted runner/,
    ],
    [
      'a pull_request trigger',
      (t) => t.replace('on:\n  push:\n', 'on:\n  pull_request:\n  push:\n'),
      /triggers on a pull request/,
    ],
    [
      'no publish step at all',
      (t) => t.replace(/ *run: pnpm -r publish.*\n/, ''),
      /no `pnpm -r publish` step/,
    ],
    [
      'an action pinned to a tag',
      (t) => t.replace(PINNED_CHECKOUT, 'actions/checkout@v4'),
      /action not pinned to a commit SHA/,
    ],
    [
      'an action pinned to a branch',
      (t) =>
        t.replace(
          'pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413',
          'pnpm/action-setup@main',
        ),
      /action not pinned to a commit SHA: - uses: pnpm\/action-setup@main/,
    ],
    [
      'a restored cache',
      (t) =>
        t.replace(
          '      - run: pnpm install --frozen-lockfile\n',
          '      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0\n        with:\n          path: .turbo/cache\n          key: k\n      - run: pnpm install --frozen-lockfile\n',
        ),
      /restores a cache/,
    ],
    [
      'a cache input',
      (t) =>
        t.replace(
          '          package-manager-cache: false\n',
          '          package-manager-cache: false\n          cache: pnpm\n',
        ),
      /a cache input/,
    ],
    [
      'pnpm/action-setup with its cache on',
      (t) => t.replace(/^( {10}version: .*\n)/m, '$1          cache: true\n'),
      /a cache input/,
    ],
    [
      'setup-node with its own package-manager cache',
      (t) => t.replace('          package-manager-cache: false\n', ''),
      /setup-node without `package-manager-cache: false`/,
    ],
    [
      'a checkout that keeps the token',
      (t) => t.replace('          persist-credentials: false\n', ''),
      /checkout without `persist-credentials: false`/,
    ],
  ]
  for (const [name, mutate, expected] of planted) {
    test(`fails on ${name}`, () => {
      const mutated = mutate(workflow)
      assert.notEqual(mutated, workflow, 'the plant changed nothing: its target text moved')
      const problems = lintReleaseWorkflow(mutated, { draft: false })
      assert.ok(
        problems.some((problem) => expected.test(problem)),
        `${expected}: ${problems.join('; ')}`,
      )
    })
  }

  test('pnpm publish in each of its direct spellings passes', () => {
    for (const command of [
      'pnpm -r publish --access public --no-git-checks --provenance --tag rc',
      'pnpm --recursive publish --access public --no-git-checks --provenance --tag rc',
      'pnpm publish -r --access public --no-git-checks --provenance --tag "$DIST_TAG"',
      'pnpm -r publish --access=public --no-git-checks --provenance --tag latest',
    ]) {
      assert.deepEqual(
        lintReleaseWorkflow(workflow.replace(PUBLISH, command), { draft: false }),
        [],
      )
    }
  })

  test('a manager named as a value is not a command: an action input, an action, a step name', () => {
    const text = workflow.replace(
      '          package-manager-cache: false\n',
      '          package-manager-cache: false\n          registry-url: https://registry.npmjs.org\n          always-auth: npm\n',
    )
    assert.deepEqual(lintReleaseWorkflow(text, { draft: false }), [])
    const named = workflow.replace(
      '      - run: pnpm typecheck',
      '      - name: npm is not run here\n        run: pnpm typecheck',
    )
    assert.deepEqual(lintReleaseWorkflow(named, { draft: false }), [])
  })

  test('the workflow publishes with pnpm and has no npm in a line that is not a comment (D75)', () => {
    assert.doesNotMatch(
      workflow.replace(/^\s*#.*\n/gm, '').replace(/\s#\s.*$/gm, ''),
      /\bnpm\b|\bnpx\b|\byarn\b|\bbunx?\b|pack:all/,
    )
  })

  test('reads comments as comments: an NPM_TOKEN named in one is not a token', () => {
    assert.deepEqual(
      lintReleaseWorkflow(
        `${workflow}# there is no NPM_TOKEN secret, and npm publish is banned\n`,
        {
          draft: false,
        },
      ),
      [],
    )
  })

  test('the section fails when the workflow is missing, and passes on the real one', async () => {
    const empty = scratchDir('release', { 'package.json': '{"name":"x","version":"0.0.0"}' })
    mkdirSync(join(empty, 'packages'))
    mkdirSync(join(empty, 'tooling'))
    const [missing] = await hygiene({
      root: empty,
      base: 'HEAD',
      updateApi: false,
      only: ['release'],
    })
    assert.match(missing?.problems.join('\n') ?? '', /release\.yml does not exist/)
    const [real] = await hygiene({ root: ROOT, base: 'HEAD', updateApi: false, only: ['release'] })
    assert.deepEqual(real?.problems, [])
  })
})

describe('changesets (T1.6)', () => {
  test('parses the packages a changeset names', () => {
    const changeset = parseChangeset(
      '.changeset/a.md',
      '---\n"provino": minor\n\'@provino/types\': patch\n---\n\nNotes: "x": major\n',
    )
    assert.deepEqual(changeset.bumps, { provino: 'minor', '@provino/types': 'patch' })
    assert.deepEqual(parseChangeset('.changeset/b.md', 'no front matter').bumps, {})
  })

  test('a changed @public signature with no changeset naming its package is missing one', () => {
    const changes = new Map([
      ['provino', ['etc/provino.api.md', 'etc/provino-node.api.md']],
      ['@provino/types', ['etc/types.api.md']],
    ])
    assert.deepEqual(missingChangesets(changes, []), [
      'provino changed a @public signature (etc/provino.api.md, etc/provino-node.api.md) with no changeset: run `pnpm changeset` and name it',
      '@provino/types changed a @public signature (etc/types.api.md) with no changeset: run `pnpm changeset` and name it',
    ])
    assert.deepEqual(
      missingChangesets(changes, [parseChangeset('x.md', '---\n"provino": patch\n---\n')]),
      [
        '@provino/types changed a @public signature (etc/types.api.md) with no changeset: run `pnpm changeset` and name it',
      ],
    )
    assert.deepEqual(
      missingChangesets(changes, [
        parseChangeset('x.md', '---\n"provino": patch\n"@provino/types": minor\n---\n'),
      ]),
      [],
    )
  })

  test('only changesets added since the base count, and untracked ones do', () => {
    const { dir, git } = repository({
      '.changeset/old.md': '---\n"provino": patch\n---\n',
      '.changeset/config.json': '{}',
    })
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    assert.deepEqual(changesetsSince(dir, base), [])
    writeFiles(dir, { '.changeset/committed.md': '---\n"@provino/types": minor\n---\n' })
    git('add', '.')
    git('commit', '-q', '-m', 'add one')
    writeFiles(dir, {
      '.changeset/untracked.md': '---\n"provino": minor\n---\n',
      '.changeset/README.md': '# not a changeset\n',
    })
    assert.deepEqual(
      changesetsSince(dir, base).map((changeset) => [changeset.file, changeset.bumps]),
      [
        ['.changeset/committed.md', { '@provino/types': 'minor' }],
        ['.changeset/untracked.md', { provino: 'minor' }],
      ],
    )
  })

  test('the config ignores exactly the private packages', () => {
    const packages = readWorkspacePackages()
    assert.deepEqual(checkChangesetIgnore(readChangesetConfig(ROOT).ignore, packages), [])
    // A private package that isn't ignored, a published one that is, and a name that isn't a package.
    assert.deepEqual(
      checkChangesetIgnore(
        ['@provino/core', 'ghost'],
        [pkg('@provino/core'), pkg('@provino/bench', { private: true })],
      ),
      [
        '@provino/core is published but in .changeset/config.json "ignore"',
        '@provino/bench is private but not in .changeset/config.json "ignore"',
        '"ignore" names ghost, which is not a workspace package',
      ],
    )
  })

  test('fixed is one group of exactly the published packages (D164)', () => {
    const packages = readWorkspacePackages()
    const { fixed } = readChangesetConfig(ROOT)
    assert.deepEqual(checkChangesetFixed(fixed, packages), [])
    const published = packages.filter((p) => p.rel !== '.' && !p.manifest.private)
    assert.equal(fixed[0]?.length, published.length)
    assert.equal(published.length, 22)

    const workspace = [
      pkg('@provino/core'),
      pkg('@provino/types'),
      pkg('@provino/bench', { private: true }),
    ]
    const both = ['@provino/core', '@provino/types']
    assert.deepEqual(checkChangesetFixed([both], workspace), [])
    // No group, and two groups: a release would not be one version.
    const one = '.changeset/config.json "fixed" must be one group of every published package'
    assert.deepEqual(checkChangesetFixed([], workspace), [`${one}, and has 0 groups`])
    assert.deepEqual(checkChangesetFixed([['@provino/core'], ['@provino/types']], workspace), [
      `${one}, and has 2 groups`,
    ])
    // A published package left out, a private one put in, a name that isn't a package, a repeat.
    assert.deepEqual(checkChangesetFixed([['@provino/core']], workspace), [
      '@provino/types is published but not in .changeset/config.json "fixed"',
    ])
    assert.deepEqual(checkChangesetFixed([[...both, '@provino/bench']], workspace), [
      '@provino/bench is private but in .changeset/config.json "fixed"',
    ])
    assert.deepEqual(checkChangesetFixed([[...both, 'ghost']], workspace), [
      '"fixed" names ghost, which is not a workspace package',
    ])
    assert.deepEqual(checkChangesetFixed([[...both, '@provino/core']], workspace), [
      '"fixed" names a package twice',
    ])
  })

  test('a config with no ignore list or no fixed groups is an error, not a pass', () => {
    const read = (config: string) => {
      const root = scratchDir('changeset-config', { '.changeset/config.json': config })
      return () => readChangesetConfig(root)
    }
    assert.throws(read('{"fixed":[[]]}'), /no "ignore" list/)
    assert.throws(read('{"ignore":[]}'), /no "fixed" list of groups/)
    assert.throws(read('{"ignore":[],"fixed":["provino"]}'), /no "fixed" list of groups/)
    // An entry that is not a name makes the list malformed, not shorter.
    assert.throws(read('{"ignore":["a",1],"fixed":[["b"]]}'), /no "ignore" list/)
    assert.throws(read('{"ignore":[],"fixed":[["b",123]]}'), /no "fixed" list of groups/)
    assert.deepEqual(read('{"ignore":["a"],"fixed":[["b","c"]]}')(), {
      ignore: ['a'],
      fixed: [['b', 'c']],
    })
  })

  test('the changeset-config section fails on a repo whose fixed group is not the published set', async () => {
    const root = scratchDir('changeset-section', {
      'package.json': '{"name":"root","private":true}',
      'packages/a/package.json': '{"name":"a","version":"0.0.0"}',
      'packages/b/package.json': '{"name":"b","version":"0.0.0"}',
      'tooling/c/package.json': '{"name":"c","version":"0.0.0","private":true}',
      '.changeset/config.json': '{"ignore":["c"],"fixed":[["a"]]}',
    })
    const [result] = await hygiene({
      root,
      base: 'HEAD',
      updateApi: false,
      only: ['changeset-config'],
    })
    assert.deepEqual(result?.problems, ['b is published but not in .changeset/config.json "fixed"'])
    const [real] = await hygiene({
      root: ROOT,
      base: 'HEAD',
      updateApi: false,
      only: ['changeset-config'],
    })
    assert.deepEqual(real?.problems, [])
  })
})

describe('the umbrella lists what it bundles (T1.10)', () => {
  test('the real workspace agrees', () => {
    assert.deepEqual(umbrellaDependencyProblems(readWorkspacePackages()), [])
  })

  test("the inlined packages are provino's dev dependencies and what they depend on", () => {
    const names = inlinedPackages(readWorkspacePackages()).map((pkg) => pkg.manifest.name)
    for (const name of ['@provino/core', '@provino/dialect-jest', '@provino/env-jsdom']) {
      assert.ok(names.includes(name), name)
    }
    for (const name of ['@provino/harness', '@provino/dialect-vitest', 'provino']) {
      assert.ok(!names.includes(name), name)
    }
    const base = [
      pkg('provino', { devDependencies: { '@provino/a': 'workspace:*' } }),
      pkg('@provino/a', { dependencies: { '@provino/b': 'workspace:*' } }),
      pkg('@provino/b'),
      pkg('@provino/unused'),
    ]
    assert.deepEqual(
      inlinedPackages(base)
        .map((p) => p.manifest.name)
        .sort(),
      ['@provino/a', '@provino/b'],
    )
  })

  test('a dependency of an inlined package that the umbrella lacks, and one nothing needs, both fail', () => {
    const base = [
      pkg('provino', {
        devDependencies: { '@provino/core': 'workspace:*' },
        dependencies: { 'dead-weight': '1.0.0' },
      }),
      pkg('@provino/core', {
        dependencies: { '@provino/types': 'workspace:*', 'real-dep': '1.0.0' },
      }),
      pkg('@provino/types', { dependencies: { '@standard-schema/spec': '1.0.0' } }),
    ]
    assert.deepEqual(umbrellaDependencyProblems(base), [
      'provino inlines packages that need real-dep, but does not list it',
      'provino inlines packages that need @standard-schema/spec, but does not list it',
      'provino lists dead-weight, but no package it inlines needs it',
    ])
  })
})
