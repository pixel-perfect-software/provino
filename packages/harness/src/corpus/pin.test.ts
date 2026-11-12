// `corpus pin` with a fake `gh` and a fake `curl`: a new pin, one that agrees, one that moved, an
// ambiguous SHA, and the text staying unchanged when anything fails.
import assert from 'node:assert/strict'
import { cp, readFile, rm } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { HarnessError } from '../errors.ts'
import { runProcess } from '../run-process.ts'
import { sha256OfFile } from './fetch.ts'
import { defaultManifestPath } from './manifest.ts'
import { inferManagerVersion, pinManifest, resolveCommit } from './pin.ts'
import { type Call, fakeDeps, finished, makeTarball, tempDir } from './test-support.ts'

// The parser insists on the whole manifest's shape (R6's 5 repositories), so the tests start from
// the committed one and unpin two of its entries: `a` (a pilot repository) and `b` (not).
const A = 'jest-extended'
const B = 'jest'
const manifest = JSON.parse(await readFile(defaultManifestPath(), 'utf8')) as {
  repos: Record<string, unknown>[]
}
const real = (id: string) => {
  const found = manifest.repos.find((repo) => repo.id === id)
  if (found === undefined) throw new Error(`no repo ${id}`)
  return found as Record<string, unknown> & { f5Sha: string; repo: string }
}
const SHA_A = `${real(A).f5Sha}${'1'.repeat(33)}`
const SHA_B = `${real(B).f5Sha}${'2'.repeat(33)}`
const PINS = ['sha', 'commitDate', 'tarballSha256']

let root = ''
let fixture = ''
let tarSha = ''
before(async () => {
  root = await tempDir('pin')
  fixture = await makeTarball(root, { LICENSE: 'MIT License', 'package-lock.json': '{}' })
  tarSha = await sha256OfFile(fixture)
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The committed entry with its pin removed, and `extra` set. */
function entry(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const copy = { ...real(id) }
  for (const key of PINS) delete copy[key]
  return { ...copy, ...extra }
}

/** The committed manifest with the entries in `replaced` swapped in (by id). */
function manifestText(...replaced: Record<string, unknown>[]): string {
  const repos = manifest.repos.map(
    (repo) => replaced.find((candidate) => candidate.id === repo.id) ?? repo,
  )
  return `${JSON.stringify({ schemaVersion: 1, repos }, null, 2)}\n`
}

const key = (id: string) => `repos/${real(id).repo}/commits/${real(id).f5Sha}`

/** `gh api repos/owner/<id>/commits/<short>` answers from `answers`; curl serves the fixture. */
function deps(answers: Record<string, string | number>) {
  return fakeDeps(async (call: Call) => {
    if (call.command === 'gh') {
      const repo = call.args[1] ?? ''
      const given = answers[repo]
      if (given === undefined || typeof given === 'number') {
        return finished(typeof given === 'number' ? given : 1, '', 'HTTP 422: ambiguous')
      }
      return finished(0, given)
    }
    if (call.command === 'curl') {
      await cp(fixture, call.args[call.args.indexOf('-o') + 1] ?? '')
      return finished(0)
    }
    return undefined
  })
}

const answer = (sha: string) => JSON.stringify({ sha, date: '2026-10-30T07:41:25Z' })
const DATE = '2026-10-30T07:41:25Z'
const only = (...ids: string[]) => ({ kind: 'ids', ids }) as const

test('resolveCommit reads the sha and date gh prints', async () => {
  const resolved = await resolveCommit(
    real(A).repo,
    real(A).f5Sha,
    deps({ [key(A)]: answer(SHA_A) }),
  )
  assert.deepEqual(resolved, { sha: SHA_A, date: DATE })
})

test('resolveCommit refuses an ambiguous SHA, a non-JSON answer and a sha that does not extend the short one', async () => {
  const rejected = (error: unknown) =>
    error instanceof HarnessError && error.code === 'HARNESS_CORPUS_PIN_FAILED'
  const resolve = (answers: Record<string, string | number>) =>
    resolveCommit(real(A).repo, real(A).f5Sha, deps(answers))
  await assert.rejects(resolve({}), rejected)
  await assert.rejects(resolve({ [key(A)]: 'not json' }), rejected)
  await assert.rejects(resolve({ [key(A)]: answer(SHA_B) }), /does not start with it/)
  await assert.rejects(
    resolve({ [key(A)]: JSON.stringify({ sha: 'short', date: 'x' }) }),
    /unexpected API answer/,
  )
})

test('a new entry gets its sha, date and tarball hash; the result parses as a manifest', async () => {
  const work = await tempDir('pin-new')
  const changes: string[] = []
  const result = await pinManifest(manifestText(entry(A)), 'm.json', {
    selection: only(A),
    workRoot: work,
    deps: deps({ [key(A)]: answer(SHA_A) }),
    onChange: (change) => changes.push(`${change.id}:${change.outcome}`),
  })
  assert.deepEqual(result.failures, [])
  assert.deepEqual(changes, [`${A}:new`])
  const pinned = JSON.parse(result.text).repos.find((repo: { id: string }) => repo.id === A)
  assert.equal(pinned.sha, SHA_A)
  assert.equal(pinned.commitDate, DATE)
  assert.equal(pinned.tarballSha256, tarSha)
})

test('an entry whose pin the API and tarball agree with is "same" and the text is unchanged', async () => {
  const work = await tempDir('pin-same')
  const text = manifestText(entry(A, { sha: SHA_A, commitDate: DATE, tarballSha256: tarSha }))
  const result = await pinManifest(text, 'm.json', {
    selection: only(A),
    workRoot: work,
    deps: deps({ [key(A)]: answer(SHA_A) }),
  })
  assert.deepEqual(result.changes, [{ id: A, outcome: 'same' }])
  assert.equal(result.text, text)
})

test('a pin that moved is reported, never replaced, and the text stays as it was', async () => {
  const work = await tempDir('pin-moved')
  const text = manifestText(
    entry(A, { sha: `${real(A).f5Sha}${'3'.repeat(33)}`, commitDate: DATE }),
  )
  const result = await pinManifest(text, 'm.json', {
    selection: only(A),
    workRoot: work,
    deps: deps({ [key(A)]: answer(SHA_A) }),
  })
  assert.equal(result.text, text)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]?.id, A)
  assert.match(result.failures[0]?.error.message ?? '', /never replaced silently/)
})

test('a tarball that differs from the pinned hash is a failure, not a new pin', async () => {
  const work = await tempDir('pin-tar')
  const text = manifestText(entry(A, { tarballSha256: '9'.repeat(64) }))
  const result = await pinManifest(text, 'm.json', {
    selection: only(A),
    workRoot: work,
    deps: deps({ [key(A)]: answer(SHA_A) }),
  })
  assert.equal(result.text, text)
  assert.equal(result.failures[0]?.error.code, 'HARNESS_CORPUS_TARBALL_MISMATCH')
})

test('one repository failing does not stop the others, but nothing is written', async () => {
  const work = await tempDir('pin-partial')
  const text = manifestText(entry(A), entry(B))
  const result = await pinManifest(text, 'm.json', {
    selection: only(A, B),
    workRoot: work,
    deps: deps({ [key(A)]: answer(SHA_A) }),
  })
  assert.deepEqual(
    result.changes.map((change) => change.id),
    [A],
  )
  assert.deepEqual(
    result.failures.map((failure) => failure.id),
    [B],
  )
  assert.equal(result.text, text, 'a half-pinned manifest is never returned')
})

test('the selection decides which entries are pinned', async () => {
  const work = await tempDir('pin-select')
  const text = manifestText(entry(A))
  const pilot = await pinManifest(text, 'm.json', {
    selection: { kind: 'pilot' },
    workRoot: work,
    // Only A is unpinned; every other pilot repository is complete and asked about too.
    deps: deps({ [key(A)]: answer(SHA_A) }),
  })
  assert.ok(
    pilot.failures.every((failure) => failure.id !== B),
    'B is not in the pilot, so it is not asked about',
  )
  assert.ok(pilot.changes.some((change) => change.id === A))
  const ids = await pinManifest(text, 'm.json', {
    selection: only(A),
    workRoot: work,
    deps: deps({ [key(A)]: answer(SHA_A) }),
  })
  assert.deepEqual(
    ids.changes.map((change) => change.id),
    [A],
  )
})

test('a manifest with no repos array, or an entry with no id, is HARNESS_CORPUS_MANIFEST_INVALID', async () => {
  const work = await tempDir('pin-invalid')
  const options = { selection: only(A), workRoot: work, deps: deps({}) }
  await assert.rejects(
    pinManifest('{}', 'm.json', options),
    (error: unknown) =>
      error instanceof HarnessError && error.code === 'HARNESS_CORPUS_MANIFEST_INVALID',
  )
  await assert.rejects(
    pinManifest(JSON.stringify({ repos: [{ repo: 'x/y' }] }), 'm.json', options),
    /has no id or repo/,
  )
})

test('an entry with no f5Sha cannot be resolved', async () => {
  const work = await tempDir('pin-nof5')
  const { f5Sha: _dropped, ...bare } = entry(A)
  const result = await pinManifest(manifestText(bare), 'm.json', {
    selection: only(A),
    workRoot: work,
    deps: deps({}),
  })
  assert.match(result.failures[0]?.error.message ?? '', /no f5Sha/)
})

test('an id that names no repository, or only a subject, is HARNESS_USAGE and pins nothing', async () => {
  const work = await tempDir('pin-unknown')
  const text = manifestText(entry(A))
  const subject = manifest.repos.flatMap((repo) =>
    (repo.subjects as { id: string }[]).filter((candidate) => candidate.id !== repo.id),
  )[0]?.id
  assert.ok(subject !== undefined, 'the manifest has a subject whose id is not its repository')
  const fake = deps({ [key(A)]: answer(SHA_A) })
  for (const id of ['jset-extended', subject]) {
    await assert.rejects(
      pinManifest(text, 'm.json', { selection: only(A, id), workRoot: work, deps: fake }),
      (error: unknown) =>
        error instanceof HarnessError &&
        error.code === 'HARNESS_USAGE' &&
        error.message.includes(id),
    )
  }
  assert.deepEqual(fake.calls, [], 'nothing was asked of gh or curl')
})

const realTar = { run: runProcess }

const fails = (error: unknown) =>
  error instanceof HarnessError && error.code === 'HARNESS_CORPUS_PIN_FAILED'

test('inferManagerVersion reads packageManager (hash dropped) when it names the manager, else the lockfile marker', () => {
  const pm = (field: string) => JSON.stringify({ packageManager: field })
  assert.deepEqual(inferManagerVersion('pnpm', pm('pnpm@10.33.0+sha512.abc'), undefined), {
    version: '10.33.0',
    from: 'packageManager',
  })
  // zod: `nub@0.8.3` is not pnpm, so the lockfile decides.
  assert.deepEqual(inferManagerVersion('pnpm', pm('nub@0.8.3'), "lockfileVersion: '9.0'\n"), {
    version: '12.16.0',
    from: 'lockfile',
  })
  const marker = (name: string, lockfile: string) =>
    inferManagerVersion(name, '{}', lockfile).version
  assert.equal(marker('pnpm', "lockfileVersion: '6.0'\n"), '8.15.9')
  assert.equal(marker('npm', '{\n  "lockfileVersion": 3\n}'), '11.19.1')
  assert.equal(marker('npm', '{"lockfileVersion":2}'), '8.19.4')
  assert.equal(marker('yarn', '# THIS IS AN AUTOGENERATED FILE.\n# yarn lockfile v1\n'), '1.22.22')
  assert.equal(marker('yarn', '__metadata:\n  version: 8\n  cacheKey: 10c0\n'), '4.18.1')
})

test('inferManagerVersion fails, naming what to do, when nothing says the version', () => {
  assert.throws(() => inferManagerVersion('pnpm', '{}', "lockfileVersion: '99.0'\n"), fails)
  assert.throws(
    () => inferManagerVersion('npm', undefined, undefined),
    /set install\.version by hand/,
  )
  assert.throws(() => inferManagerVersion('npm', 'not json', undefined), fails)
})

test('a missing install.version is filled from the tarball, right after the name; one present is left alone', async () => {
  const lock = await makeTarball(await tempDir('pin-version'), {
    LICENSE: 'MIT License',
    'package.json': JSON.stringify({ packageManager: 'yarn@4.9.1+sha512.abc' }),
    'yarn.lock': '__metadata:\n  version: 8\n',
  })
  const lockSha = await sha256OfFile(lock)
  const serve = (file: string) =>
    fakeDeps(async (call: Call) => {
      if (call.command === 'gh') return finished(0, answer(SHA_A))
      if (call.command === 'curl') {
        await cp(file, call.args[call.args.indexOf('-o') + 1] ?? '')
        return finished(0)
      }
      return undefined
    }, realTar)
  const text = manifestText(
    entry(A, { tarballSha256: lockSha, install: { name: 'yarn', lockfile: 'yarn.lock' } }),
  )
  const result = await pinManifest(text, 'm.json', {
    selection: only(A),
    workRoot: await tempDir('pin-version-work'),
    deps: serve(lock),
  })
  assert.deepEqual(result.failures, [])
  const pinned = JSON.parse(result.text).repos.find((repo: { id: string }) => repo.id === A)
  assert.deepEqual(Object.entries(pinned.install), [
    ['name', 'yarn'],
    ['version', '4.9.1'],
    ['lockfile', 'yarn.lock'],
  ])
  // A second pin agrees and changes nothing: the version is not re-inferred.
  const again = await pinManifest(result.text, 'm.json', {
    selection: only(A),
    workRoot: await tempDir('pin-version-work2'),
    deps: serve(lock),
  })
  assert.equal(again.text, result.text)
  assert.deepEqual(again.changes, [{ id: A, outcome: 'same' }])
})

test('a repository whose version nothing implies stops for a report', async () => {
  const result = await pinManifest(
    manifestText(entry(A, { install: { name: 'yarn', lockfile: 'yarn.lock' } })),
    'm.json',
    {
      selection: only(A),
      workRoot: await tempDir('pin-noversion'),
      deps: deps({ [key(A)]: answer(SHA_A) }),
    },
  )
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0]?.error.message ?? '', /set install\.version by hand/)
})
