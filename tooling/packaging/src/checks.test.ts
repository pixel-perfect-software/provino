// The planted cases of `pnpm hygiene`'s cheap checks (T1.6, T10.4's agent half): each one fails
// on a seeded violation, and the real repo passes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'provino'
import {
  changesetsSince,
  checkChangesetFixed,
  checkChangesetIgnore,
  missingChangesets,
  parseChangeset,
  readChangesetConfig,
} from './changesets.ts'
import {
  addOnProblems,
  hygiene,
  inlinedPackages,
  RELEASE_WORKFLOW,
  type Section,
  umbrellaDependencyProblems,
} from './hygiene.ts'
import { installScriptProblems } from './install-scripts.ts'
import type { PackageManifest } from './package-json.ts'
import { activeLines, lintReleaseWorkflow } from './release-lint.ts'
import { repository, scratchDir, writeFiles } from './test-support.ts'
import { publicPackages, ROOT, readWorkspacePackages, type WorkspacePackage } from './workspace.ts'

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

/** Runs one hygiene section on `root` and returns what it found. */
async function section(root: string, name: Section): Promise<readonly string[]> {
  const [result] = await hygiene({ root, base: 'HEAD', updateApi: false, only: [name] })
  return result?.problems ?? []
}

describe('release workflow lint (T10.4, D162, D163)', () => {
  const workflow = readFileSync(join(ROOT, RELEASE_WORKFLOW), 'utf8')
  const PUBLISH = 'pnpm -r publish --access public --no-git-checks --provenance --tag "$DIST_TAG"'
  const PINNED_CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
  const NPM = /runs npm, which D75 allows only in install-matrix\.yml/
  const NOT_DIRECT = /publishes other than with `pnpm -r publish`/
  const NOT_TAG_ONLY = /does not start from a pushed `v\*` tag alone/
  const TAGS = '    tags: ["v*"]\n'

  /** A plant that adds `extra` right after the first `anchor`. */
  const insertAfter = (anchor: string, extra: string) => (t: string) =>
    t.replace(anchor, `${anchor}${extra}`)
  /** A step that runs `commands`: one on its line, several as a block, in place of the typecheck. */
  const runStep = (...commands: string[]) =>
    commands.length === 1
      ? `      - run: ${commands[0]}`
      : `      - run: |\n${commands.map((command) => `          ${command}`).join('\n')}`
  const replaceTypecheck =
    (...commands: string[]) =>
    (t: string) =>
      t.replace('      - run: pnpm typecheck', runStep(...commands))

  test('the real workflow passes, and names its publish command only on that line', () => {
    assert.deepEqual(lintReleaseWorkflow(workflow), [])
    // The plants replace the first occurrence of `pnpm -r publish`: a comment must not name it.
    assert.equal(workflow.split('pnpm -r publish').length - 1, 1)
    assert.equal(activeLines(workflow).filter((line) => line.includes(PUBLISH)).length, 1)
  })

  const planted: readonly (readonly [string, (text: string) => string, RegExp])[] = [
    ['no id-token: write', (t) => t.replace(/^ *id-token: write.*\n/m, ''), /no `id-token: write`/],
    [
      'a branch trigger in place of the tag',
      (t) => t.replace(TAGS, '    branches: [main]\n'),
      NOT_TAG_ONLY,
    ],
    ['branches beside the tags', insertAfter(TAGS, '    branches: [main]\n'), NOT_TAG_ONLY],
    ['a second tag pattern', (t) => t.replace('["v*"]', '["v*", "release-*"]'), NOT_TAG_ONLY],
    [
      'a second tag pattern in the block-list form',
      (t) => t.replace(TAGS, '    tags:\n      - "v*"\n      - "release-*"\n'),
      NOT_TAG_ONLY,
    ],
    [
      'workflow_dispatch before the push',
      (t) => t.replace('on:\n  push:\n', 'on:\n  workflow_dispatch:\n  push:\n'),
      NOT_TAG_ONLY,
    ],
    ['workflow_dispatch after the tags', insertAfter(TAGS, '  workflow_dispatch:\n'), NOT_TAG_ONLY],
    ['a one-line on:', (t) => t.replace(`on:\n  push:\n${TAGS}`, 'on: push\n'), NOT_TAG_ONLY],
    [
      'an NPM_TOKEN secret',
      insertAfter(
        '      - name: Publish the packages\n',
        `        env:\n          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}\n`,
      ),
      /npm token or a secret/,
    ],
    [
      'NODE_AUTH_TOKEN',
      insertAfter(
        '          node-version-file: .tool-versions\n',
        `          token: \${{ secrets.NODE_AUTH_TOKEN }}\n`,
      ),
      /npm token or a secret/,
    ],
    ['a plain npm publish', (t) => t.replace('pnpm -r publish', 'npm publish'), NOT_DIRECT],
    [
      'npm stage publish: D75 allows npm only inside install-matrix.yml',
      (t) => t.replace('pnpm -r publish', 'npm stage publish'),
      NPM,
    ],
    [
      'the staged publish B21e drafted',
      (t) => t.replace('pnpm -r publish', 'pnpm -r stage publish'),
      NOT_DIRECT,
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
      insertAfter(
        '      - run: pnpm install --frozen-lockfile\n',
        '      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0\n        with:\n          path: .turbo/cache\n          key: k\n',
      ),
      /restores a cache/,
    ],
    [
      'a cache input',
      insertAfter('          package-manager-cache: false\n', '          cache: pnpm\n'),
      /a cache input/,
    ],
    [
      'pnpm/action-setup with its cache on',
      insertAfter(
        'pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0\n',
        '        with:\n          cache: true\n',
      ),
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
    // npm, npx, yarn and bun in each command position: one line, a block, after &&, in a subshell.
    ...(
      [
        ['npx, yarn and bun in one line', ['npx tsdown && yarn build && bun x y'], NPM],
        ['a block-form npx', ['pnpm typecheck', 'npx tsdown'], /install-matrix\.yml: npx tsdown$/],
        [
          'a block-form yarn, after &&',
          ['pnpm typecheck', 'cd packages/x && yarn build'],
          /install-matrix\.yml: cd packages\/x && yarn build$/,
        ],
        [
          'a block-form npm in a subshell',
          ['v=$(npm --version)', 'pnpm typecheck'],
          /install-matrix\.yml: v=\$\(npm --version\)$/,
        ],
      ] as const
    ).map(([name, commands, expected]) => [name, replaceTypecheck(...commands), expected] as const),
  ]
  for (const [name, mutate, expected] of planted) {
    test(`fails on ${name}`, () => {
      const mutated = mutate(workflow)
      assert.notEqual(mutated, workflow, 'the plant changed nothing: its target text moved')
      const problems = lintReleaseWorkflow(mutated)
      assert.ok(
        problems.some((problem) => expected.test(problem)),
        `${expected}: ${problems.join('; ')}`,
      )
    })
  }

  test('the tag trigger in the block-list form passes', () => {
    const block = workflow.replace(TAGS, '    tags:\n      - "v*"\n')
    assert.notEqual(block, workflow)
    assert.deepEqual(lintReleaseWorkflow(block), [])
  })

  test('pnpm publish in each of its direct spellings passes', () => {
    for (const command of [
      'pnpm -r publish --access public --no-git-checks --provenance --tag rc',
      'pnpm --recursive publish --access public --no-git-checks --provenance --tag rc',
      'pnpm publish -r --access public --no-git-checks --provenance --tag "$DIST_TAG"',
      'pnpm -r publish --access=public --no-git-checks --provenance --tag latest',
    ]) {
      assert.deepEqual(lintReleaseWorkflow(workflow.replace(PUBLISH, command)), [])
    }
  })

  test('a manager named as a value is not a command: an action input, a step name', () => {
    const input = insertAfter(
      '          package-manager-cache: false\n',
      '          registry-url: https://registry.npmjs.org\n          always-auth: npm\n',
    )
    assert.deepEqual(lintReleaseWorkflow(input(workflow)), [])
    const named = workflow.replace(
      '      - run: pnpm typecheck',
      '      - name: npm is not run here\n        run: pnpm typecheck',
    )
    assert.deepEqual(lintReleaseWorkflow(named), [])
  })

  test('reads comments as comments: an NPM_TOKEN named in one is not a token', () => {
    assert.deepEqual(
      lintReleaseWorkflow(`${workflow}# there is no NPM_TOKEN secret, and npm publish is banned\n`),
      [],
    )
  })

  test('the section fails when the workflow is missing', async () => {
    const empty = scratchDir('release', {
      'package.json': '{"name":"x","version":"0.0.0"}',
      'packages/.keep': '',
      'tooling/.keep': '',
    })
    assert.match((await section(empty, 'release')).join('\n'), /release\.yml does not exist/)
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
    assert.deepEqual(
      new Set(fixed[0]),
      new Set(publicPackages().map((published) => published.manifest.name)),
    )

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
    assert.deepEqual(await section(root, 'changeset-config'), [
      'b is published but not in .changeset/config.json "fixed"',
    ])
  })
})

describe('the umbrella lists what it bundles (T1.10)', () => {
  test('the real workspace agrees', () => {
    assert.deepEqual(umbrellaDependencyProblems(readWorkspacePackages()), [])
  })

  test("the inlined packages are provino's dev dependencies and what they depend on", () => {
    const names = inlinedPackages(readWorkspacePackages()).map((pkg) => pkg.manifest.name)
    for (const name of ['@provino/core', '@provino/env-jsdom']) {
      assert.ok(names.includes(name), name)
    }
    // B27f (D187): the dialects are add-ons, dev dependencies of provino but not inlined.
    for (const name of [
      '@provino/harness',
      'provino',
      '@provino/dialect-jest',
      '@provino/dialect-vitest',
    ]) {
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

  test('an add-on names provino as its workspace peer, has no engine dependency, and provino lists none (D187)', () => {
    const umbrella = pkg('provino', { devDependencies: { '@provino/dialect-jest': 'workspace:*' } })
    const good = pkg('@provino/dialect-jest', {
      dependencies: { 'pretty-format': '30.0.0' },
      devDependencies: { '@provino/core': 'workspace:*' },
      peerDependencies: { provino: 'workspace:*' },
    })
    assert.deepEqual(addOnProblems([umbrella, good], umbrella), [])
    // The real workspace holds to it.
    const real = readWorkspacePackages()
    const realUmbrella = real.find((p) => p.manifest.name === 'provino')
    assert.ok(realUmbrella !== undefined)
    assert.deepEqual(addOnProblems(real, realUmbrella), [])
    const planted = [
      pkg('@provino/dialect-jest', {
        dependencies: { '@provino/core': 'workspace:*' },
        peerDependencies: { provino: '^0.1.0' },
      }),
      pkg('@provino/dialect-vitest', { dependencies: { chai: '6.0.0' } }),
      pkg('@provino/stray', { peerDependencies: { provino: 'workspace:*' } }),
    ]
    const listing = pkg('provino', { dependencies: { '@provino/dialect-vitest': 'workspace:*' } })
    assert.deepEqual(addOnProblems([listing, ...planted], listing), [
      '@provino/stray names provino as a peer but is not an add-on (ADD_ONS)',
      '@provino/dialect-jest must name provino as a peer at workspace:* (got ^0.1.0)',
      '@provino/dialect-jest depends on @provino/core at run time: its engine comes from its provino peer',
      '@provino/dialect-vitest must name provino as a peer at workspace:* (got none)',
      'provino lists the add-on @provino/dialect-vitest at run time: it is installed beside provino',
    ])
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
