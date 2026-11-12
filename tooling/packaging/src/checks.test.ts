// The planted cases of `pnpm hygiene`'s cheap checks (T1.6, T10.4's agent half): each one fails
// on a seeded violation, and the real repo passes.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  changesetsSince,
  checkChangesetIgnore,
  missingChangesets,
  parseChangeset,
  readChangesetConfig,
} from './changesets.ts'
import { umbrellaDependencyProblems } from './hygiene.ts'
import { installScriptProblems } from './install-scripts.ts'
import type { PackageManifest } from './package-json.ts'
import { lintReleaseWorkflow } from './release-lint.ts'
import { ROOT, readWorkspacePackages, type WorkspacePackage } from './workspace.ts'

function pkg(name: string, parts: Partial<PackageManifest> = {}, rel = `packages/${name}`) {
  const manifest: PackageManifest = {
    name,
    version: '0.0.0',
    private: false,
    type: 'module',
    exports: {},
    bin: {},
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

describe('release workflow lint (T10.4)', () => {
  const template = readFileSync(join(ROOT, 'tooling/packaging/templates/release.yml'), 'utf8')

  test('the draft passes', () => {
    assert.deepEqual(lintReleaseWorkflow(template, { draft: true }), [])
  })

  test('the draft without --dry-run is not a draft, but passes as a release', () => {
    const live = template.replace('--provenance --dry-run', '--provenance')
    assert.equal(lintReleaseWorkflow(live, { draft: true }).length, 1)
    assert.deepEqual(lintReleaseWorkflow(live, { draft: false }), [])
  })

  const planted: readonly (readonly [string, (text: string) => string, RegExp])[] = [
    ['no id-token: write', (t) => t.replace('      id-token: write\n', ''), /no `id-token: write`/],
    [
      'an NPM_TOKEN secret',
      (t) =>
        t.replace(
          '      - run: pnpm build',
          `      - run: pnpm build\n        env:\n          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}`,
        ),
      /npm token or a secret/,
    ],
    [
      'NODE_AUTH_TOKEN',
      (t) =>
        t.replace(
          '          node-version: 24',
          `          node-version: 24\n          token: \${{ secrets.NODE_AUTH_TOKEN }}`,
        ),
      /npm token or a secret/,
    ],
    [
      'a plain npm publish',
      (t) => t.replace('npm stage publish', 'npm publish'),
      /publishes other than with `npm stage publish`/,
    ],
    [
      'a pnpm publish beside the staged one',
      (t) => `${t}      - run: pnpm publish -r --provenance --dry-run\n`,
      /publishes other than with `npm stage publish`/,
    ],
    ['no provenance', (t) => t.replace(' --provenance', ''), /without --provenance/],
    [
      'a self-hosted runner',
      (t) => t.replace('runs-on: ubuntu-24.04', 'runs-on: self-hosted'),
      /not a GitHub-hosted runner/,
    ],
    [
      'a pull_request trigger',
      (t) => t.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  pull_request:\n'),
      /triggers on a pull request/,
    ],
    [
      'no publish step at all',
      (t) => t.replace(/ *- run: for tarball.*\n/, ''),
      /no `npm stage publish` step/,
    ],
  ]
  for (const [name, mutate, expected] of planted) {
    test(`fails on ${name}`, () => {
      const problems = lintReleaseWorkflow(mutate(template), { draft: true })
      assert.ok(
        problems.some((problem) => expected.test(problem)),
        `${expected}: ${problems.join('; ')}`,
      )
    })
  }

  test('reads comments as comments: an NPM_TOKEN named in one is not a token', () => {
    assert.deepEqual(
      lintReleaseWorkflow(
        `${template}# there is no NPM_TOKEN secret, and npm publish is banned\n`,
        {
          draft: true,
        },
      ),
      [],
    )
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
    const changes = [
      { package: 'provino', reports: ['etc/provino.api.md'] },
      { package: '@provino/types', reports: ['etc/types.api.md'] },
    ]
    assert.deepEqual(missingChangesets(changes, []), ['provino', '@provino/types'])
    assert.deepEqual(
      missingChangesets(changes, [parseChangeset('x.md', '---\n"provino": patch\n---\n')]),
      ['@provino/types'],
    )
    assert.deepEqual(
      missingChangesets(changes, [
        parseChangeset('x.md', '---\n"provino": patch\n"@provino/types": minor\n---\n'),
      ]),
      [],
    )
  })

  test('only changesets added since the base count, and untracked ones do', () => {
    const repo = mkdtempSync(join(tmpdir(), 'changesets-'))
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
        {
          cwd: repo,
          encoding: 'utf8',
        },
      )
    git('init', '-q', '--initial-branch=main')
    mkdirSync(join(repo, '.changeset'))
    writeFileSync(join(repo, '.changeset/old.md'), '---\n"provino": patch\n---\n')
    writeFileSync(join(repo, '.changeset/config.json'), '{}')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD').trim()
    assert.deepEqual(changesetsSince(repo, base), [])
    writeFileSync(join(repo, '.changeset/committed.md'), '---\n"@provino/types": minor\n---\n')
    git('add', '.')
    git('commit', '-q', '-m', 'add one')
    writeFileSync(join(repo, '.changeset/untracked.md'), '---\n"provino": minor\n---\n')
    writeFileSync(join(repo, '.changeset/README.md'), '# not a changeset\n')
    assert.deepEqual(
      changesetsSince(repo, base).map((changeset) => [changeset.file, changeset.bumps]),
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
})

describe('the umbrella lists what it bundles (T1.10)', () => {
  test('the real workspace agrees', () => {
    assert.deepEqual(umbrellaDependencyProblems(readWorkspacePackages()), [])
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
