// T12.9's installer with a fake package manager: the plan for each manager, the environment, the
// tree fingerprint, `installRepo` and the offline re-install. No network, no real install.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { HarnessError } from '../errors.ts'
import { compareStrings } from '../internal/guards.ts'
import { digestFile } from './fetch.ts'
import {
  findNodeModules,
  fingerprintTree,
  installEnv,
  installPlan,
  installRepo,
  readInstallRecord,
  reinstallOffline,
} from './install.ts'
import { repoPaths } from './paths.ts'
import {
  type Call,
  fakeDeps,
  finished,
  makeRepo,
  makeSubject,
  tempDir,
  writeTree,
} from './test-support.ts'

const NOW = () => new Date('2026-11-12T10:00:00Z')

function hasCode(code: string) {
  return (error: unknown) => error instanceof HarnessError && error.code === code
}

/** A work directory with an "extracted" tree for the repository, as `corpus fetch` leaves one. */
async function workWithTree(repo = makeRepo(), files: Record<string, string> = {}) {
  const work = await tempDir('install')
  const paths = repoPaths(work, repo)
  await writeTree(paths.src, { 'package.json': '{}', 'package-lock.json': '{}', ...files })
  await writeFile(paths.srcMarker, `${repo.sha}\n`)
  return { work, paths }
}

/** What a fake install puts in `node_modules`: the runner at `version`. */
async function installRunner(src: string, version: string, name = 'jest'): Promise<void> {
  await writeTree(path.join(src, 'node_modules', name), {
    'package.json': JSON.stringify({ name, version, bin: { [name]: 'bin.js' } }),
    'bin.js': '',
  })
}

test('the online install environment is an allowlist inside the work directory, scripts off', () => {
  const paths = repoPaths('/work', makeRepo())
  const env = installEnv({
    paths,
    offline: false,
    inherited: { HTTPS_PROXY: 'http://proxy:3128', AWS_SECRET: 'x', HOME: '/Users/me' },
    nodeDir: '/node/bin',
  })
  assert.equal(env.HOME, '/work/demo/home')
  assert.equal(env.PATH, '/node/bin:/usr/bin:/bin:/usr/sbin:/sbin')
  assert.equal(env.npm_config_ignore_scripts, 'true')
  assert.equal(env.YARN_ENABLE_SCRIPTS, 'false')
  assert.equal(env.npm_config_cache, '/work/demo/cache/npm')
  assert.equal(env.HTTPS_PROXY, 'http://proxy:3128', 'the proxy passes through when online')
  assert.equal(env.NODE_USE_ENV_PROXY, '1')
  assert.equal(env.AWS_SECRET, undefined)
  assert.equal(env.npm_config_offline, undefined)
})

test('the offline environment has no proxy and tells each tool the network is off', () => {
  const env = installEnv({
    paths: repoPaths('/work', makeRepo()),
    offline: true,
    inherited: { HTTPS_PROXY: 'http://proxy:3128' },
  })
  assert.equal(env.HTTPS_PROXY, undefined)
  assert.equal(env.NODE_USE_ENV_PROXY, undefined)
  assert.equal(env.npm_config_offline, 'true')
  assert.equal(env.COREPACK_ENABLE_NETWORK, '0')
  assert.equal(env.YARN_ENABLE_NETWORK, 'false')
})

test('pnpm at a pinned version runs through corepack, frozen, scripts off, store in the work dir', async () => {
  const repo = makeRepo({
    install: { name: 'pnpm', version: '12.4.2', lockfile: 'pnpm-lock.yaml' },
  })
  const plan = installPlan(repo, { workRoot: '/work', offline: false })
  assert.equal(plan.command, 'corepack')
  assert.deepEqual(plan.args, [
    'pnpm@12.4.2',
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--store-dir',
    '/work/demo/cache/pnpm-store',
  ])
  assert.equal(plan.cwd, '/work/demo/src')
  assert.deepEqual(plan.manager, { name: 'pnpm', version: '12.4.2' })
})

test('pnpm adds --offline when offline, at the manifest version and no other', async () => {
  const repo = makeRepo({
    install: { name: 'pnpm', version: '9.15.9', lockfile: 'pnpm-lock.yaml' },
  })
  const plan = installPlan(repo, { workRoot: '/work', offline: true })
  assert.deepEqual(plan.manager, { name: 'pnpm', version: '9.15.9' })
  assert.equal(plan.args[0], 'pnpm@9.15.9')
  assert.ok(plan.args.includes('--offline'))
})

test('npm goes through corepack at the manifest version, with no default of our own', async () => {
  const online = installPlan(makeRepo(), { workRoot: '/work', offline: false })
  assert.equal(online.command, 'corepack')
  assert.deepEqual(online.args, [
    'npm@11.19.1',
    'ci',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ])
  assert.deepEqual(online.manager, { name: 'npm', version: '11.19.1' })
  const pinned = installPlan(
    makeRepo({ install: { name: 'npm', version: '10.9.2', lockfile: 'package-lock.json' } }),
    { workRoot: '/work', offline: true },
  )
  assert.equal(pinned.command, 'corepack')
  assert.deepEqual(pinned.args.slice(0, 2), ['npm@10.9.2', 'ci'])
  assert.ok(pinned.args.includes('--offline'))
})

test('Yarn classic is frozen with scripts off, Berry is immutable', async () => {
  const classic = installPlan(
    makeRepo({ install: { name: 'yarn', version: '1.22.22', lockfile: 'yarn.lock' } }),
    { workRoot: '/work', offline: true },
  )
  assert.deepEqual(classic.args.slice(0, 5), [
    'yarn@1.22.22',
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--non-interactive',
  ])
  assert.ok(classic.args.includes('--offline'))
  const berry = installPlan(
    makeRepo({ install: { name: 'yarn', version: '4.5.0', lockfile: 'yarn.lock' } }),
    { workRoot: '/work', offline: false },
  )
  assert.deepEqual(berry.args, ['yarn@4.5.0', 'install', '--immutable'])
})

test("the manifest's extra install flags are appended, and one that is not a flag is refused", async () => {
  const ok = installPlan(
    makeRepo({
      install: {
        name: 'npm',
        version: '11.19.1',
        lockfile: 'package-lock.json',
        args: ['--legacy-peer-deps'],
      },
    }),
    { workRoot: '/work', offline: false },
  )
  assert.equal(ok.args.at(-1), '--legacy-peer-deps')
  assert.throws(
    () =>
      installPlan(
        makeRepo({
          install: {
            name: 'npm',
            version: '11.19.1',
            lockfile: 'package-lock.json',
            args: ['; rm -rf /'],
          },
        }),
        { workRoot: '/work', offline: false },
      ),
    hasCode('HARNESS_CORPUS_MANIFEST_INVALID'),
  )
})

test('findNodeModules finds the root and each package, never inside .git', async () => {
  const dir = await tempDir('nm')
  await writeTree(dir, {
    'node_modules/a/index.js': '',
    'packages/p/node_modules/b/index.js': '',
    '.git/node_modules/c/index.js': '',
  })
  assert.deepEqual(
    (await findNodeModules(dir)).map((found) => path.relative(dir, found)),
    ['node_modules', 'packages/p/node_modules'],
  )
})

test('the fingerprint covers node_modules content, symlink targets and nothing else', async () => {
  const dir = await tempDir('fp')
  await writeTree(dir, { 'node_modules/a/index.js': 'one', 'src/app.js': 'unrelated' })
  const first = await fingerprintTree(dir)
  assert.equal(first.hash, (await fingerprintTree(dir)).hash, 'stable')
  await writeFile(path.join(dir, 'src/app.js'), 'changed')
  assert.equal(
    (await fingerprintTree(dir)).hash,
    first.hash,
    'files outside node_modules do not count',
  )
  await writeFile(path.join(dir, 'node_modules/.modules.yaml'), `t: ${Date.now()}`)
  assert.equal((await fingerprintTree(dir)).hash, first.hash, 'a volatile file does not count')
  await writeFile(path.join(dir, 'node_modules/a/index.js'), 'two')
  const edited = await fingerprintTree(dir)
  assert.notEqual(edited.hash, first.hash)
  await symlink('a', path.join(dir, 'node_modules/link'))
  const linked = await fingerprintTree(dir)
  assert.notEqual(linked.hash, edited.hash)
  assert.equal(linked.files, edited.files + 1)
  await rm(path.join(dir, 'node_modules/link'))
  await symlink('b', path.join(dir, 'node_modules/link'))
  assert.notEqual((await fingerprintTree(dir)).hash, linked.hash, 'the link target counts')
})

test('installRepo runs the frozen install, checks the runner version and writes install.json', async () => {
  const repo = makeRepo()
  const { work, paths } = await workWithTree(repo)
  const deps = fakeDeps(async (call: Call) => {
    if (call.command === 'du') return finished(0, `2048\t${paths.dir}\n`)
    await installRunner(paths.src, '30.5.2')
    return finished(0, 'done', '', { wallMs: 1234 })
  })
  const record = await installRepo(repo, { workRoot: work, deps, now: NOW })
  assert.equal(record.id, 'demo')
  assert.equal(record.wallMs, 1234)
  assert.equal(record.installedAt, '2026-11-12T10:00:00.000Z')
  assert.deepEqual(record.runnerVersions, { demo: '30.5.2' })
  assert.equal(record.diskMb, 2)
  assert.equal(record.command[0], 'corepack')
  assert.deepEqual(record.packageManager, { name: 'npm', version: '11.19.1' })
  assert.ok(record.fingerprintFiles >= 2)
  const install = deps.calls.find((call) => call.command === 'corepack')
  assert.equal(install?.options.cwd, paths.src)
  assert.equal(install?.options.env.npm_config_ignore_scripts, 'true')
  assert.deepEqual(await readInstallRecord(repo, work), record)
})

test('installRepo needs the extracted tree of this commit, and a lockfile to freeze', async () => {
  const repo = makeRepo()
  const work = await tempDir('install-none')
  await assert.rejects(
    installRepo(repo, { workRoot: work, deps: fakeDeps(() => finished(0)) }),
    hasCode('HARNESS_CORPUS_NOT_INSTALLED'),
  )
  const { install: _dropped, ...rest } = repo
  const noLock = { ...rest, install: { name: 'npm' as const, version: '11.19.1' } }
  await assert.rejects(
    installRepo(noLock, { workRoot: work, deps: fakeDeps(() => finished(0)) }),
    /commits no lockfile/,
  )
  const { work: other, paths } = await workWithTree(repo)
  await writeFile(paths.srcMarker, `${'9'.repeat(40)}\n`)
  await assert.rejects(
    installRepo(repo, { workRoot: other, deps: fakeDeps(() => finished(0)) }),
    /no extracted tree at/,
  )
})

test('a package manager that exits non-zero, or times out, is HARNESS_CORPUS_INSTALL_FAILED', async () => {
  const repo = makeRepo()
  const { work } = await workWithTree(repo)
  await assert.rejects(
    installRepo(repo, { workRoot: work, deps: fakeDeps(() => finished(1, '', 'ERESOLVE')) }),
    (error: unknown) =>
      hasCode('HARNESS_CORPUS_INSTALL_FAILED')(error) && String(error).includes('ERESOLVE'),
  )
  await assert.rejects(
    installRepo(repo, {
      workRoot: work,
      deps: fakeDeps(() => finished(null, '', '', { timedOut: true })),
    }),
    /timed out/,
  )
})

test('an installed runner that differs from the manifest fails the install and writes no record', async () => {
  const repo = makeRepo()
  const { work, paths } = await workWithTree(repo)
  const deps = fakeDeps(async () => {
    await installRunner(paths.src, '29.0.0')
    return finished(0)
  })
  await assert.rejects(
    installRepo(repo, { workRoot: work, deps }),
    /demo: jest 29.0.0 is installed, the manifest says 30.5.2/,
  )
  assert.equal(await readInstallRecord(repo, work), undefined)
})

test('a missing runner is reported with the subject it belongs to', async () => {
  const repo = makeRepo({ subjects: [makeSubject({ id: 'demo-a' })] })
  const { work } = await workWithTree(repo)
  await assert.rejects(
    installRepo(repo, { workRoot: work, deps: fakeDeps(() => finished(0)) }),
    /demo-a: .*jest is not installed/s,
  )
})

test('rebuild packages run with scripts on after the frozen install', async () => {
  const repo = makeRepo({
    install: { name: 'pnpm', version: '12.4.2', lockfile: 'pnpm-lock.yaml' },
    rebuild: ['esbuild'],
  })
  const { work, paths } = await workWithTree(repo)
  const deps = fakeDeps(async (call: Call) => {
    if (call.command === 'du') return finished(0, '1\tx')
    await installRunner(paths.src, '30.5.2')
    return finished(0, '', '', { wallMs: 10 })
  })
  const record = await installRepo(repo, { workRoot: work, deps, now: NOW })
  const [frozen, rebuild] = deps.calls.filter((call) => call.command !== 'du')
  assert.equal(frozen?.command, 'corepack', 'the install itself needs the network')
  assert.equal(frozen?.options.env.npm_config_ignore_scripts, 'true')
  // The rebuild runs the package's own scripts, so it runs under the sandbox.
  assert.equal(rebuild?.command, '/usr/bin/sandbox-exec')
  assert.deepEqual(rebuild?.args.slice(2), ['corepack', 'pnpm@12.4.2', 'rebuild', 'esbuild'])
  assert.equal(rebuild?.options.env.npm_config_ignore_scripts, 'false')
  assert.equal(record.wallMs, 20, 'the rebuild counts toward the install time')
})

test('a repository with nothing to rebuild writes no sandbox profile for its online install', async () => {
  const repo = makeRepo()
  const { work, paths } = await workWithTree(repo)
  const deps = fakeDeps(async (call: Call) => {
    if (call.command === 'du') return finished(0, '1\tx')
    await installRunner(paths.src, '30.5.2')
    return finished(0)
  })
  await installRepo(repo, { workRoot: work, deps, now: NOW })
  assert.equal(
    deps.calls.some((call) => call.command === '/usr/bin/sandbox-exec'),
    false,
  )
  await assert.rejects(readFile(path.join(paths.dir, 'sandbox.sb')), { code: 'ENOENT' })
})

test('a failing rebuild names the package', async () => {
  const repo = makeRepo({ rebuild: ['sharp'] })
  const { work, paths } = await workWithTree(repo)
  let count = 0
  const deps = fakeDeps(async () => {
    count += 1
    if (count === 1) {
      await installRunner(paths.src, '30.5.2')
      return finished(0)
    }
    return finished(1, '', 'gyp ERR')
  })
  await assert.rejects(installRepo(repo, { workRoot: work, deps }), /rebuilding sharp exited 1/)
})

test('readInstallRecord is undefined for no file or a malformed one', async () => {
  const repo = makeRepo()
  const { work, paths } = await workWithTree(repo)
  assert.equal(await readInstallRecord(repo, work), undefined)
  await mkdir(paths.dir, { recursive: true })
  await writeFile(paths.installRecord, JSON.stringify({ id: 'demo' }))
  assert.equal(await readInstallRecord(repo, work), undefined)
})

/** Installs through the fake, so there is a record to re-install against. */
async function installed(repo = makeRepo()) {
  const { work, paths } = await workWithTree(repo)
  const files = { 'node_modules/dep/index.js': 'one' }
  const reinstall = async (content = files['node_modules/dep/index.js']) => {
    await installRunner(paths.src, '30.5.2')
    await writeTree(paths.src, { 'node_modules/dep/index.js': content })
  }
  const first = fakeDeps(async (call: Call) => {
    if (call.command === 'du') return finished(0, '1\tx')
    await reinstall()
    return finished(0)
  })
  const record = await installRepo(repo, { workRoot: work, deps: first, now: NOW })
  return { repo, work, paths, record, reinstall }
}

test('the offline re-install deletes node_modules, runs in the sandbox and checks the fingerprint', async () => {
  const { repo, work, paths, record, reinstall } = await installed()
  const seen: Call[] = []
  const deps = fakeDeps(async (call: Call) => {
    seen.push(call)
    await assert.rejects(
      readFile(path.join(paths.src, 'node_modules/dep/index.js')),
      'deleted first',
    )
    await reinstall()
    return finished(0, '', '', { wallMs: 77 })
  })
  const outcome = await reinstallOffline(repo, { workRoot: work, deps, now: NOW })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.fingerprint, record.fingerprint)
  assert.equal(outcome.wallMs, 77)
  const call = seen[0]
  assert.equal(call?.command, '/usr/bin/sandbox-exec')
  assert.equal(call?.args[0], '-f')
  assert.equal(call?.args[2], 'corepack')
  assert.ok(call?.args.includes('--offline'))
  assert.equal(call?.options.env.npm_config_offline, 'true')
  const stored = await readInstallRecord(repo, work)
  assert.equal(stored?.offline?.ok, true)
})

test('an offline re-install that gives another tree fails, and the record says so', async () => {
  const { repo, work, reinstall } = await installed()
  const deps = fakeDeps(async () => {
    await reinstall('two')
    return finished(0)
  })
  await assert.rejects(
    reinstallOffline(repo, { workRoot: work, deps, now: NOW }),
    /gave another tree/,
  )
  assert.equal((await readInstallRecord(repo, work))?.offline?.ok, false)
})

test('an offline re-install whose package manager fails reports its output', async () => {
  const { repo, work } = await installed()
  await assert.rejects(
    reinstallOffline(repo, {
      workRoot: work,
      deps: fakeDeps(() => finished(1, '', 'ENOTCACHED')),
      now: NOW,
    }),
    /exited 1:\nENOTCACHED/,
  )
})

test('the offline re-install needs an install record first', async () => {
  const repo = makeRepo()
  const { work } = await workWithTree(repo)
  await assert.rejects(
    reinstallOffline(repo, { workRoot: work, deps: fakeDeps(() => finished(0)) }),
    hasCode('HARNESS_CORPUS_NOT_INSTALLED'),
  )
})

test('a record of another commit, or of a tree extracted from another commit, is not installed', async () => {
  const { repo, work, paths } = await installed()
  assert.equal((await readInstallRecord(repo, work))?.sha, repo.sha)
  // A re-pin: the manifest names another commit while install.json is still the old one's.
  const moved = { ...repo, sha: `abcdef0${'2'.repeat(33)}` }
  assert.equal(await readInstallRecord(moved, work), undefined)
  // The record names this commit, but the extracted tree is another one (or has no marker).
  await writeFile(paths.srcMarker, `${moved.sha}\n`)
  assert.equal(await readInstallRecord(repo, work), undefined)
  await rm(paths.srcMarker)
  assert.equal(await readInstallRecord(repo, work), undefined)
})

test('fingerprintTree reads a bounded number of files at once and gives the same hash', async () => {
  const dir = await tempDir('fingerprint-pool')
  const files: Record<string, string> = {}
  for (let i = 0; i < 200; i++) files[`node_modules/pkg/f${i}.js`] = `file ${i}`
  await writeTree(dir, files)
  const expected = await fingerprintTree(dir)
  let open = 0
  let most = 0
  let calls = 0
  const limited = await fingerprintTree(dir, {
    concurrency: 8,
    digestFile: async (file) => {
      calls++
      open++
      most = Math.max(most, open)
      await new Promise((resolve) => setImmediate(resolve))
      open--
      const bytes = await readFile(file)
      return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    },
  })
  assert.equal(calls, 200)
  assert.ok(most <= 8, `${most} files were open at once`)
  assert.ok(most > 1, 'they are read in parallel')
  assert.deepEqual(limited, expected)
})

test('the offline re-install rebuilds the same packages, so the fingerprints agree', async () => {
  const repo = makeRepo({ rebuild: ['sharp'] })
  const { work, paths } = await workWithTree(repo)
  const install = async (call: Call) => {
    if (call.command === 'du') return finished(0, '1\tx')
    await installRunner(paths.src, '30.5.2')
    // The rebuild's own output, which only the rebuild step makes.
    if (call.args.includes('rebuild')) {
      await writeTree(paths.src, { 'node_modules/sharp/build/sharp.node': 'binary' })
    }
    return finished(0)
  }
  const record = await installRepo(repo, { workRoot: work, deps: fakeDeps(install), now: NOW })
  const seen: Call[] = []
  const outcome = await reinstallOffline(repo, {
    workRoot: work,
    deps: fakeDeps((call) => {
      seen.push(call)
      return install(call)
    }),
    now: NOW,
  })
  assert.equal(outcome.fingerprint, record.fingerprint)
  assert.equal(outcome.ok, true)
  assert.equal(seen.length, 2, 'the install and one rebuild')
  assert.equal(seen[1]?.command, '/usr/bin/sandbox-exec', 'the rebuild is sandboxed too')
  assert.ok(seen[1]?.args.includes('rebuild'))
})

test('fingerprintTree gives the hash the stat-and-stream version gave, small files and large alike', async () => {
  const dir = await tempDir('fingerprint-same')
  await writeTree(dir, {
    'node_modules/a/index.js': 'small',
    'node_modules/a/empty.js': '',
    'node_modules/b/big.bin': 'x'.repeat(5000),
  })
  await symlink('index.js', path.join(dir, 'node_modules/a/link.js'))
  // The previous implementation: the size from `stat`, the hash from a stream, every file.
  const lines: string[] = []
  for (const file of ['a/index.js', 'a/empty.js', 'b/big.bin']) {
    const full = path.join(dir, 'node_modules', file)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(full)) hash.update(chunk as Buffer)
    lines.push(`f\0node_modules/${file}\0${(await stat(full)).size}\0${hash.digest('hex')}`)
  }
  lines.push('l\0node_modules/a/link.js\0index.js', 'd\0node_modules/a', 'd\0node_modules/b')
  const expected = createHash('sha256')
  for (const line of lines.toSorted(compareStrings)) expected.update(`${line}\n`)
  const hex = expected.digest('hex')
  assert.equal((await fingerprintTree(dir)).hash, hex)
  // A small-file limit under 5000 sends big.bin down the streaming branch.
  const streamed = await fingerprintTree(dir, {
    digestFile: (file) => digestFile(file, 100),
  })
  assert.equal(streamed.hash, hex)
  assert.equal(streamed.files, 6)
})
