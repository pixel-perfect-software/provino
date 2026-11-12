// T12.9's fetcher with the real `tar` and a fake `curl`: download, reuse, mismatch, what a pin must
// find in the tarball, and the extraction with its left-out files. No network.
import assert from 'node:assert/strict'
import { cp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { HarnessError } from '../errors.ts'
import { runProcess } from '../run-process.ts'
import {
  diskUsageMb,
  ensureTarball,
  fetchRepo,
  sha256OfFile,
  tarballUrl,
  verifyEntries,
} from './fetch.ts'
import { repoPaths } from './paths.ts'
import {
  type Call,
  fakeDeps,
  finished,
  makeRepo,
  makeSubject,
  makeTarball,
  tempDir,
} from './test-support.ts'

const MIT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person\n'
const FILES = {
  LICENSE: MIT,
  'package-lock.json': '{}',
  'jest.config.js': 'module.exports = {}',
  'packages/a/package.json': '{}',
  'packages/a/jest.config.js': 'module.exports = {}',
  'src/a.test.js': 'test("a", () => {})',
  '.env': 'SECRET=1',
  '.vscode/settings.json': '{}',
  '.gitmodules': '',
}

let root = ''
let fixture = ''
let sha = ''
before(async () => {
  root = await tempDir('fetch')
  fixture = await makeTarball(root, FILES)
  sha = await sha256OfFile(fixture)
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A `curl` that "downloads" the fixture, and every other command run for real. */
function curlDeps(options: { fail?: boolean; serve?: string } = {}) {
  const real = { run: runProcess }
  return fakeDeps(async (call: Call) => {
    if (call.command !== 'curl') return undefined
    if (options.fail === true) return finished(22, '', 'curl: (22) 404')
    const out = call.args[call.args.indexOf('-o') + 1]
    assert.ok(out !== undefined)
    await cp(options.serve ?? fixture, out)
    return finished(0)
  }, real)
}

function repoFor(work: string, overrides = {}) {
  return {
    work,
    repo: makeRepo({
      tarballSha256: sha,
      subjects: [
        makeSubject({ config: ['jest.config.js'] }),
        makeSubject({
          id: 'demo-a',
          cwd: 'packages/a',
          config: ['packages/a/jest.config.js'],
        }),
      ],
      ...overrides,
    }),
  }
}

test('the tarball URL is codeload at the pinned commit', () => {
  assert.equal(
    tarballUrl({ repo: 'owner/demo', sha: 'a'.repeat(40) }),
    `https://codeload.github.com/owner/demo/tar.gz/${'a'.repeat(40)}`,
  )
})

test('ensureTarball downloads once, then reuses a file whose sha256 matches', async () => {
  const work = await tempDir('ensure')
  const { repo } = repoFor(work)
  const deps = curlDeps()
  const first = await ensureTarball(repo, { workRoot: work, expectedSha256: sha, deps })
  assert.equal(first.downloaded, true)
  assert.equal(first.sha256, sha)
  assert.equal(first.path, repoPaths(work, repo).tarball)
  const second = await ensureTarball(repo, { workRoot: work, expectedSha256: sha, deps })
  assert.equal(second.downloaded, false)
  assert.equal(deps.calls.filter((call) => call.command === 'curl').length, 1)
  // No partial file stays behind.
  await assert.rejects(stat(`${first.path}.partial`))
})

test('ensureTarball without a pin reuses whatever file is there', async () => {
  const work = await tempDir('ensure-bare')
  const { repo } = repoFor(work)
  const deps = curlDeps()
  await ensureTarball(repo, { workRoot: work, deps })
  const again = await ensureTarball(repo, { workRoot: work, deps })
  assert.equal(again.downloaded, false)
})

test('a file that no longer matches the pin is downloaded again', async () => {
  const work = await tempDir('ensure-stale')
  const { repo } = repoFor(work)
  await ensureTarball(repo, { workRoot: work, expectedSha256: sha, deps: curlDeps() })
  await writeFile(repoPaths(work, repo).tarball, 'corrupt')
  const deps = curlDeps()
  const result = await ensureTarball(repo, { workRoot: work, expectedSha256: sha, deps })
  assert.equal(result.downloaded, true)
  assert.equal(result.sha256, sha)
})

test('a download that differs from the pin is HARNESS_CORPUS_TARBALL_MISMATCH, never replaced silently', async () => {
  const work = await tempDir('ensure-mismatch')
  const { repo } = repoFor(work)
  await assert.rejects(
    ensureTarball(repo, { workRoot: work, expectedSha256: '1'.repeat(64), deps: curlDeps() }),
    (error: unknown) =>
      error instanceof HarnessError &&
      error.code === 'HARNESS_CORPUS_TARBALL_MISMATCH' &&
      error.message.includes(sha),
  )
})

test('a failed curl is HARNESS_CORPUS_FETCH_FAILED and leaves no partial file', async () => {
  const work = await tempDir('ensure-curl')
  const { repo } = repoFor(work)
  await assert.rejects(
    ensureTarball(repo, { workRoot: work, deps: curlDeps({ fail: true }) }),
    (error: unknown) =>
      error instanceof HarnessError &&
      error.code === 'HARNESS_CORPUS_FETCH_FAILED' &&
      error.message.includes('404'),
  )
  await assert.rejects(stat(`${repoPaths(work, repo).tarball}.partial`))
})

test('verifyEntries names the lockfile, directory and config a tarball lacks', () => {
  const { repo } = repoFor('/unused')
  const entries = new Set(['package-lock.json', 'jest.config.js', 'packages/a/package.json'])
  assert.deepEqual(verifyEntries(repo, entries), [
    'subject demo-a: no runner config packages/a/jest.config.js',
  ])
  assert.deepEqual(verifyEntries(repo, new Set()), [
    'no lockfile package-lock.json',
    'subject demo: no runner config jest.config.js',
    'subject demo-a: no directory packages/a',
    'subject demo-a: no runner config packages/a/jest.config.js',
  ])
})

test('fetchRepo extracts the tree without the left-out files and lists them', async () => {
  const work = await tempDir('fetch-ok')
  const { repo } = repoFor(work)
  const result = await fetchRepo(repo, { workRoot: work, deps: curlDeps() })
  assert.deepEqual(result.problems, [])
  assert.equal(result.downloaded, true)
  assert.equal(result.src, repoPaths(work, repo).src)
  assert.deepEqual(result.leftOut, ['.env', '.gitmodules', '.vscode', '.vscode/settings.json'])
  const src = repoPaths(work, repo).src
  assert.equal(await readFile(path.join(src, 'src/a.test.js'), 'utf8'), 'test("a", () => {})')
  for (const gone of ['.env', '.gitmodules', '.vscode']) {
    await assert.rejects(stat(path.join(src, gone)), gone)
  }
  assert.equal((await readFile(repoPaths(work, repo).srcMarker, 'utf8')).trim(), repo.sha)
})

test('a second fetch of the same commit leaves the extracted tree alone', async () => {
  const work = await tempDir('fetch-twice')
  const { repo } = repoFor(work)
  const deps = curlDeps()
  await fetchRepo(repo, { workRoot: work, deps })
  const marker = path.join(repoPaths(work, repo).src, 'edited-by-install.txt')
  await writeFile(marker, 'x')
  const again = await fetchRepo(repo, { workRoot: work, deps })
  assert.equal(again.downloaded, false)
  assert.equal(await readFile(marker, 'utf8'), 'x', 'the tree was not re-extracted')
  assert.equal(deps.calls.filter((call) => call.args.includes('-xzf')).length, 1)
})

test('another commit in src is replaced before the new one is extracted', async () => {
  const work = await tempDir('fetch-moved')
  const { repo } = repoFor(work)
  const deps = curlDeps()
  await fetchRepo(repo, { workRoot: work, deps })
  const paths = repoPaths(work, repo)
  await writeFile(paths.srcMarker, `${'9'.repeat(40)}\n`)
  await writeFile(path.join(paths.src, 'stale.txt'), 'old')
  await fetchRepo(repo, { workRoot: work, deps })
  await assert.rejects(stat(path.join(paths.src, 'stale.txt')))
  assert.equal((await readFile(paths.srcMarker, 'utf8')).trim(), repo.sha)
})

test('verifyOnly checks the tarball and extracts nothing', async () => {
  const work = await tempDir('fetch-verify')
  const { repo } = repoFor(work)
  const result = await fetchRepo(repo, { workRoot: work, deps: curlDeps(), verifyOnly: true })
  assert.deepEqual(result.problems, [])
  assert.equal(result.src, undefined)
  await assert.rejects(stat(repoPaths(work, repo).src))
})

test('a tarball that lacks what the manifest says reports problems and extracts nothing', async () => {
  const work = await tempDir('fetch-problems')
  const { repo } = repoFor(work, {
    install: { name: 'npm', lockfile: 'missing-lock.json' },
  })
  const result = await fetchRepo(repo, { workRoot: work, deps: curlDeps() })
  assert.deepEqual(result.problems, ['no lockfile missing-lock.json'])
  assert.equal(result.src, undefined)
  await assert.rejects(stat(repoPaths(work, repo).src))
})

test('a licence that is not MIT, or no licence, is a problem', async () => {
  const dir = await tempDir('fetch-licence')
  const other = await makeTarball(dir, { ...FILES, LICENSE: 'All rights reserved.\n' })
  const work = await tempDir('fetch-licence-work')
  const otherSha = await sha256OfFile(other)
  const { repo } = repoFor(work, { tarballSha256: otherSha })
  const wrong = await fetchRepo(repo, { workRoot: work, deps: curlDeps({ serve: other }) })
  assert.deepEqual(wrong.problems, ['LICENSE does not read as the MIT licence'])
  const { LICENSE: _gone, ...without } = FILES
  const none = await makeTarball(await tempDir('fetch-nolicence'), without)
  const work2 = await tempDir('fetch-licence-work2')
  const bare = repoFor(work2, { tarballSha256: await sha256OfFile(none) }).repo
  const missing = await fetchRepo(bare, { workRoot: work2, deps: curlDeps({ serve: none }) })
  assert.deepEqual(missing.problems, ['no licence file at the root'])
})

test('a per-package licence is accepted when the root has none (date-fns)', async () => {
  const { LICENSE: _gone, ...rest } = FILES
  const tarball = await makeTarball(await tempDir('fetch-pkg-licence'), {
    ...rest,
    'pkgs/core/LICENSE.md': MIT,
  })
  const work = await tempDir('fetch-pkg-licence-work')
  const repo = repoFor(work, { tarballSha256: await sha256OfFile(tarball) }).repo
  const result = await fetchRepo(repo, {
    workRoot: work,
    deps: curlDeps({ serve: tarball }),
    verifyOnly: true,
  })
  assert.deepEqual(result.problems, [])
})

test('a tar that cannot list the file is HARNESS_CORPUS_FETCH_FAILED', async () => {
  const work = await tempDir('fetch-badtar')
  const { repo } = repoFor(work)
  const junk = path.join(work, 'junk.tar.gz')
  await writeFile(junk, 'not a tarball')
  await assert.rejects(
    fetchRepo(
      { ...repo, tarballSha256: await sha256OfFile(junk) },
      {
        workRoot: work,
        deps: curlDeps({ serve: junk }),
      },
    ),
    (error: unknown) =>
      error instanceof HarnessError && error.code === 'HARNESS_CORPUS_FETCH_FAILED',
  )
})

test('diskUsageMb reads du -sk, and says undefined when it cannot', async () => {
  const dir = await tempDir('du')
  const ok = fakeDeps(() => finished(0, `5120\t${dir}\n`))
  assert.equal(await diskUsageMb(dir, ok), 5)
  const garbled = fakeDeps(() => finished(0, 'nope'))
  assert.equal(await diskUsageMb(dir, garbled), undefined)
  const broken: Parameters<typeof diskUsageMb>[1] = {
    run: () => Promise.reject(new Error('no du')),
  }
  assert.equal(await diskUsageMb(dir, broken), undefined)
})
