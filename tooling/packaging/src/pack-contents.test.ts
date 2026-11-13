// The planted cases of the tarball contents check: every public tarball holds a README.md and a
// LICENSE, and one whose built code holds vendored sources also holds THIRD_PARTY_NOTICES.md, the
// same file as the repository's.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { packPackage } from './pack.ts'
import {
  NOTICES_FILE,
  noticesCoverageProblems,
  packContentProblems,
  vendoredSourcesInDist,
} from './pack-contents.ts'
import { readManifest } from './package-json.ts'
import { scratchDir } from './test-support.ts'
import type { WorkspacePackage } from './workspace.ts'

const NOTICES = '# Third-party notices\n\nCopied from Jest.\n'

/** What rolldown writes before a module's code: its path. */
const VENDORED_DIST = [
  '// ../dialect-jest/src/runtime/vendor/jest-expect/matchers.ts',
  'export const matchers = {}',
  '',
  '// src/own.ts',
  'export const own = 1',
  '',
].join('\n')

const PLAIN_DIST = '// src/own.ts\nexport const own = 1\n'

/** A package in a temp directory, to be packed for real. */
function plantedPackage(
  files: Readonly<Record<string, string>>,
  fileField: readonly string[] = ['dist'],
): WorkspacePackage {
  const manifest = {
    name: '@provino/planted',
    version: '1.0.0',
    type: 'module',
    files: fileField,
  }
  const dir = scratchDir('contents', { 'package.json': JSON.stringify(manifest), ...files })
  return { dir, rel: 'planted', manifest: readManifest(dir) }
}

/** A directory standing in for the repository root, holding the notices. */
function root(files: Readonly<Record<string, string>> = { [NOTICES_FILE]: NOTICES }): string {
  return scratchDir('contents-root', files)
}

function problemsOf(pkg: WorkspacePackage, rootDir: string): readonly string[] {
  const packed = packPackage(pkg, join(scratchDir('contents-out'), 'packs'))
  return packContentProblems(pkg, packed, rootDir)
}

describe('vendoredSourcesInDist', () => {
  test('finds the vendored modules in the built JavaScript and no others', () => {
    const pkg = plantedPackage({
      'dist/index.js': VENDORED_DIST,
      'dist/nested/more.js': '// ../snapshot/src/vendor/natural-compare.ts\nexport {}\n',
      'dist/plain.js': PLAIN_DIST,
      // Declarations name types, not code: not read.
      'dist/index.d.ts': '// ../x/src/vendor/types-only.ts\nexport {}\n',
    })
    assert.deepEqual(vendoredSourcesInDist(join(pkg.dir, 'dist')).toSorted(), [
      '../dialect-jest/src/runtime/vendor/jest-expect/matchers.ts',
      '../snapshot/src/vendor/natural-compare.ts',
    ])
  })

  test('a package with no dist has none', () => {
    assert.deepEqual(vendoredSourcesInDist(join(plantedPackage({}).dir, 'dist')), [])
  })
})

describe('tarball contents (README.md, LICENSE, notices)', () => {
  test('a tarball with no README.md fails, naming it', () => {
    const pkg = plantedPackage({ LICENSE: 'MIT', 'dist/index.js': PLAIN_DIST })
    const problems = problemsOf(pkg, root())
    assert.equal(problems.length, 1, problems.join('\n'))
    assert.match(problems[0] ?? '', /@provino\/planted: the tarball has no README\.md/)
  })

  test('a tarball with no LICENSE fails, naming it', () => {
    const pkg = plantedPackage({ 'README.md': '# planted', 'dist/index.js': PLAIN_DIST })
    const problems = problemsOf(pkg, root())
    assert.equal(problems.length, 1, problems.join('\n'))
    assert.match(problems[0] ?? '', /@provino\/planted: the tarball has no LICENSE/)
  })

  test('vendored code with no notices in the tarball fails, naming the file and the notices', () => {
    const pkg = plantedPackage({
      'README.md': '# planted',
      LICENSE: 'MIT',
      'dist/index.js': VENDORED_DIST,
      // In the package directory but not in `files`: it does not ship.
      [NOTICES_FILE]: NOTICES,
    })
    const problems = problemsOf(pkg, root())
    assert.equal(problems.length, 1, problems.join('\n'))
    assert.match(problems[0] ?? '', /@provino\/planted: .*vendored.*THIRD_PARTY_NOTICES\.md/s)
    assert.match(problems[0] ?? '', /jest-expect\/matchers\.ts/)
  })

  test('a notices file that is not the repository’s fails', () => {
    const pkg = plantedPackage(
      {
        'README.md': '# planted',
        LICENSE: 'MIT',
        'dist/index.js': VENDORED_DIST,
        [NOTICES_FILE]: `${NOTICES}\nAn old copy.\n`,
      },
      ['dist', NOTICES_FILE],
    )
    const problems = problemsOf(pkg, root())
    assert.equal(problems.length, 1, problems.join('\n'))
    assert.match(problems[0] ?? '', /@provino\/planted: THIRD_PARTY_NOTICES\.md differs/)
  })

  test('every file present, and the notices the repository’s, passes', () => {
    const pkg = plantedPackage(
      {
        'README.md': '# planted',
        LICENSE: 'MIT',
        'dist/index.js': VENDORED_DIST,
        [NOTICES_FILE]: NOTICES,
      },
      ['dist', NOTICES_FILE],
    )
    assert.deepEqual(problemsOf(pkg, root()), [])
  })

  test('a package with no vendored code needs no notices', () => {
    const pkg = plantedPackage({
      'README.md': '# planted',
      LICENSE: 'MIT',
      'dist/index.js': PLAIN_DIST,
    })
    assert.deepEqual(problemsOf(pkg, root()), [])
  })
})

describe('notices coverage', () => {
  const upstream = '# Vendored upstream\n'

  test('a vendor directory with an UPSTREAM.md the notices do not name fails', () => {
    const dir = root({
      [NOTICES_FILE]: `${NOTICES}\n\`packages/a/src/vendor/\` is copied from Jest.\n`,
      'packages/a/src/vendor/UPSTREAM.md': upstream,
      'packages/b/src/vendor/x/UPSTREAM.md': upstream,
    })
    const problems = noticesCoverageProblems(dir)
    assert.equal(problems.length, 1, problems.join('\n'))
    assert.match(problems[0] ?? '', /packages\/b\/src\/vendor\/x/)
  })

  test('every directory named passes, and node_modules and dist are not searched', () => {
    const dir = root({
      [NOTICES_FILE]: `${NOTICES}\npackages/a/src/vendor/ and packages/b/src/vendor/x/jsdom-keys.ts\n`,
      'packages/a/src/vendor/UPSTREAM.md': upstream,
      'packages/b/src/vendor/x/UPSTREAM.md': upstream,
      'packages/a/node_modules/dep/vendor/UPSTREAM.md': upstream,
      'packages/a/dist/vendor/UPSTREAM.md': upstream,
    })
    assert.deepEqual(noticesCoverageProblems(dir), [])
  })
})
